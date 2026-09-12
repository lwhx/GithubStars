/**
 * X 推文频道数据服务（自研抓取器，直连 x.com，不依赖第三方实例）。
 *
 * 数据管道：传输层（Electron 主进程 IPC 或 fullstack 服务端路由）代抓
 * https://x.com/<handle> 未登录主页 HTML → 解析页面内嵌的 React Flight
 * 数据（推文 ID 在 `client:VHdlZXQ6<base64>` 引用中解码，正文与链接实体
 * 在 `:details` 块内，发布时间由雪花 ID 推导）→ expanded_url 提取 GitHub
 * 仓库链接（复用周刊提取规则）→ 按 tweetId 去重增量合并 → 仓库详情补全
 * （GraphQL 批量优先，REST 逐仓回退）→ 独立 IndexedDB 持久化 → 按推文
 * 时间倒序分页切片。
 *
 * 源能力边界（2026-09 实测）：未登录主页每次返回每博主最新一小批推文、
 * 无历史翻页游标，因此"加载更多"是对累计缓存的分页，增量来自每次刷新
 * 重抓的最新批次；60 秒内重复刷新走缓存。纯浏览器（静态部署）受 CORS
 * 限制不可用，需桌面版或服务端模式。
 */

import type {
  DiscoveryChannelId,
  DiscoveryRepo,
  PaginatedDiscoveryRepositories,
  WeeklySyncStatus,
  XTweetFollow,
} from '../types';
import { logger } from './logger';
import { backend } from './backendAdapter';
import { fetchXTimelineViaDesktop } from './electronProxy';
import type { GitHubApiService } from './githubApi';
import { extractRepoFullNames } from './weeklyIssuesService';
import {
  xTweetStorage,
  type XStoredRepo,
  type XStoredTweet,
} from './xTweetStorage';

const X_TWEET_CHANNEL: DiscoveryChannelId = 'x-tweet';
/** 频道每页卡片数 */
export const X_TWEET_CARD_PAGE_SIZE = 20;
const HANDLE_THROTTLE_MS = 500;
const REST_ENRICH_THROTTLE_MS = 80;
/** 仓库详情的刷新周期：30 天内的快照视为新鲜 */
const REPO_DETAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 不可用仓库（404/私有）的重试周期 */
const UNAVAILABLE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** 60 秒内同步过则跳过刷新遍历（重复触发走缓存） */
const RECENT_SYNC_SKIP_MS = 60 * 1000;

type StatusCallback = ((status: WeeklySyncStatus | null) => void) | undefined;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isAbortError = (error: unknown): boolean =>
  (error instanceof Error && (error.name === 'AbortError' || error.message === 'Aborted')) ||
  (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError');

const isRateLimitError = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith('GitHub API rate limit exceeded');

const isTokenInvalidError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('token expired or invalid');

export const isValidXTweetHandle = (handle: string): boolean =>
  /^[A-Za-z0-9_]{1,15}$/.test(handle);

export type XTimelineTransport = (handle: string) => Promise<string>;

/**
 * 传输层：抓取 x.com 未登录主页 HTML。桌面端走主进程 IPC（跟随应用代理），
 * 失败时回退 fullstack 服务端路由；两者都不可用时抛错（纯浏览器模式不支持）。
 */
export const defaultXTimelineTransport: XTimelineTransport = async (handle) => {
  let desktopError: unknown = null;
  if (typeof window !== 'undefined' && window.electronAPI?.xFetchTimeline) {
    try {
      const html = await fetchXTimelineViaDesktop(handle);
      if (html !== null) return html;
    } catch (error) {
      desktopError = error;
    }
  }
  const backendUrl = backend.backendUrl;
  if (backendUrl) {
    const response = await fetch(`${backendUrl}/xtweet/profile/${encodeURIComponent(handle)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`服务端抓取 x.com 失败 (${response.status})`);
    }
    const data = await response.json();
    if (typeof data?.html === 'string') return data.html;
    throw new Error('服务端返回数据无效');
  }
  if (desktopError) throw desktopError;
  throw new Error('当前运行模式不支持 X 推文抓取：需要桌面版（Electron）或服务端模式');
};

/** 从 Flight 的 client 引用解码推文 ID（VHdlZXQ6… == base64("Tweet:<id>")） */
export function decodeTweetRef(ref: string): string | null {
  try {
    const decoded = atob(ref);
    const match = decoded.match(/^Tweet:(\d+)$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** 雪花 ID → 发布时间（Twitter epoch 1288834974657）。ID 超出 Number 安全范围，必须用 BigInt。 */
export function tweetSnowflakeToDate(tweetId: string): string {
  try {
    const ms = (BigInt(tweetId) >> 22n) + 1288834974657n;
    return new Date(Number(ms)).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** Flight 内嵌字符串是 JS 字面量（\n \" 转义），按 JSON 字符串语义还原。 */
const unescapeFlightString = (raw: string): string => {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
};

const TWEET_MARK_PATTERN = /client:(VHdlZXQ6[A-Za-z0-9+/=]+):(legacy|details|counts|views)/g;

/**
 * 解析 x.com 未登录主页 HTML 中的推文。每条推文的 `:details` 块内含
 * full_text 与链接实体；同一推文的引用在 Flight 图中重复出现，按 ID 去重。
 */
export function parseXTimelineHtml(html: string, handle: string): XStoredTweet[] {
  const tweets = new Map<string, XStoredTweet>();
  const marks = [...html.matchAll(TWEET_MARK_PATTERN)];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark[2] !== 'details') continue;
    const tweetId = decodeTweetRef(mark[1]);
    if (!tweetId || tweets.has(tweetId)) continue;
    const blockStart = (mark.index ?? 0) + mark[0].length;
    const blockEnd = i + 1 < marks.length ? (marks[i + 1].index ?? blockStart) : blockStart + 8000;
    const body = html.slice(blockStart, blockEnd);
    const fullText = body.match(/full_text:"((?:[^"\\]|\\.)*)"/);
    if (!fullText) continue;
    const content = unescapeFlightString(fullText[1]);
    const repoFullNames = [...new Set(
      [...body.matchAll(/expanded_url:"(https:\/\/github\.com\/[^"]+)"/g)]
        .map((m) => extractRepoFullNames(unescapeFlightString(m[1])))
        .flat(),
    )].map((fullName) => fullName.toLowerCase());
    tweets.set(tweetId, {
      tweetId,
      handle,
      displayName: handle,
      content,
      htmlUrl: `https://x.com/${handle}/status/${tweetId}`,
      createdAt: tweetSnowflakeToDate(tweetId),
      repoFullNames,
    });
  }
  return [...tweets.values()];
}

/**
 * 处理一轮解析结果：新推文进内存映射并登记，推文涉及的仓库 upsert
 * （原贴指向发布时间最新的推文），返回本轮需要补全详情的仓库键。
 */
export function ingestFeedTweets(
  feed: XStoredTweet[],
  tweets: Map<string, XStoredTweet>,
  repos: Map<string, XStoredRepo>,
): { newTweets: XStoredTweet[]; pendingRepoKeys: Set<string> } {
  const newTweets: XStoredTweet[] = [];
  const pendingRepoKeys = new Set<string>();
  for (const tweet of feed) {
    if (tweets.has(tweet.tweetId)) continue;
    tweets.set(tweet.tweetId, tweet);
    newTweets.push(tweet);

    for (const key of tweet.repoFullNames) {
      const repo = repos.get(key);
      if (!repo) {
        repos.set(key, {
          fullName: key,
          detail: null,
          lastFetchedAt: '',
          sourceTweetId: tweet.tweetId,
          tweetCreatedAt: tweet.createdAt,
        });
      } else if (tweet.createdAt > repo.tweetCreatedAt) {
        repo.sourceTweetId = tweet.tweetId;
        repo.tweetCreatedAt = tweet.createdAt;
      }
      pendingRepoKeys.add(key);
    }
  }
  return { newTweets, pendingRepoKeys };
}

/** 需要补全/维护详情的仓库：新触达（从未拉过）、过期快照、到期重试的不可用仓库。 */
export function reposNeedingDetail(
  repos: Map<string, XStoredRepo>,
  touchedKeys: Set<string>,
  nowMs: number,
): XStoredRepo[] {
  const targets: XStoredRepo[] = [];
  for (const key of touchedKeys) {
    const repo = repos.get(key);
    if (!repo) continue;
    if (!repo.lastFetchedAt) {
      targets.push(repo);
    } else if (repo.detail) {
      if (nowMs - Date.parse(repo.lastFetchedAt) > REPO_DETAIL_TTL_MS) targets.push(repo);
    } else if (nowMs - Date.parse(repo.lastFetchedAt) > UNAVAILABLE_RETRY_MS) {
      targets.push(repo);
    }
  }
  return targets;
}

/** REST 逐仓补全回退路径（GraphQL 不可用时），限流/鉴权错误直接上抛中止本轮。 */
async function enrichReposViaRest(
  api: GitHubApiService,
  targets: XStoredRepo[],
  onStatus: StatusCallback,
  signal?: AbortSignal,
): Promise<void> {
  for (let i = 0; i < targets.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const repo = targets[i];
    const [owner, name] = repo.fullName.split('/');
    try {
      repo.detail = await api.getRepositoryDetails(owner, name, signal);
      repo.lastFetchedAt = new Date().toISOString();
    } catch (error) {
      if (isAbortError(error) || isRateLimitError(error) || isTokenInvalidError(error)) throw error;
      // 404/410/其他 4xx：标记不可用，到期重试（makeRequest 已做过网络/5xx 重试）
      logger.warn('xTweet', `Repo details unavailable: ${repo.fullName}`, error);
      repo.lastFetchedAt = new Date().toISOString();
    }
    onStatus?.({ phase: 'enriching', current: i + 1, total: targets.length });
    await sleep(REST_ENRICH_THROTTLE_MS);
  }
}

/** GraphQL 批量补全；部分批次失败时仅对未成功的仓库回退 REST。 */
async function enrichRepos(
  api: GitHubApiService,
  targets: XStoredRepo[],
  onStatus: StatusCallback,
  signal?: AbortSignal,
): Promise<void> {
  if (targets.length === 0) return;
  const total = targets.length;
  onStatus?.({ phase: 'enriching', current: 0, total });
  const fullNames = targets.map((repo) => repo.fullName);
  const appliedKeys = new Set<string>();
  try {
    const details = await api.graphqlFetchRepositories(fullNames, {
      signal,
      batchSize: 100,
      onBatchDone: (doneBatches) => {
        const done = Math.min(total, doneBatches * 100);
        onStatus?.({ phase: 'enriching', current: done, total });
      },
    });
    const fetchedAtIso = new Date().toISOString();
    for (const [key, detail] of details) {
      const repo = targets.find((repo) => repo.fullName.toLowerCase() === key);
      if (!repo) continue;
      if (detail !== undefined) appliedKeys.add(key);
      repo.lastFetchedAt = fetchedAtIso;
      if (detail) repo.detail = detail;
    }
  } catch (error) {
    if (isAbortError(error) || isRateLimitError(error) || isTokenInvalidError(error)) throw error;
    logger.warn('xTweet', 'GraphQL batch enrichment failed, falling back to REST', error);
  }
  const restTargets = targets.filter((repo) => !appliedKeys.has(repo.fullName.toLowerCase()));
  if (restTargets.length > 0) {
    await enrichReposViaRest(api, restTargets, onStatus, signal);
  }
}

/** 由已补全详情的仓库构建频道卡片（未补全详情的条目暂不展示）。 */
export function buildXTweetDiscoveryRepos(
  tweets: Map<string, XStoredTweet>,
  repos: Map<string, XStoredRepo>,
  handles: string[],
): DiscoveryRepo[] {
  const handleSet = new Set(handles.map((handle) => handle.toLowerCase()));
  const list: DiscoveryRepo[] = [];
  for (const repo of repos.values()) {
    if (!repo.detail) continue;
    const tweet = tweets.get(repo.sourceTweetId);
    if (!tweet || !handleSet.has(tweet.handle.toLowerCase())) continue;
    list.push({
      ...repo.detail,
      rank: 0,
      channel: X_TWEET_CHANNEL,
      platform: 'All',
      xTweet: {
        tweetId: tweet.tweetId,
        handle: tweet.handle,
        displayName: tweet.displayName,
        content: tweet.content,
        html_url: tweet.htmlUrl,
        createdAt: tweet.createdAt,
      },
    });
  }
  list.sort((a, b) => (b.xTweet?.createdAt ?? '').localeCompare(a.xTweet?.createdAt ?? ''));
  list.forEach((repo, index) => { repo.rank = index + 1; });
  return list;
}

let syncAbortController: AbortController | null = null;
let syncInFlight: Promise<void> | null = null;

/** 互斥执行：新请求中止上一轮并等待其落盘结算后再开新一轮。 */
async function runExclusiveSync(
  body: (signal: AbortSignal) => Promise<void>,
  onStatus: StatusCallback,
): Promise<void> {
  syncAbortController?.abort();
  // 等待被中止轮次完成落盘，避免旧快照覆盖新一轮刚写入的结果
  if (syncInFlight) await syncInFlight.catch(() => {});
  const controller = new AbortController();
  syncAbortController = controller;
  const run = body(controller.signal);
  syncInFlight = run.then(() => {}, () => {});
  try {
    await run;
  } finally {
    // 仅在仍持有同步权时清空状态，避免被中止的旧轮次清掉新一轮的进度显示
    if (syncAbortController === controller) {
      syncAbortController = null;
      onStatus?.(null);
    }
  }
}

const isRecentlySynced = (meta: { lastSyncedAt: string | null }): boolean =>
  meta.lastSyncedAt !== null
  && Number.isFinite(Date.parse(meta.lastSyncedAt))
  && Date.now() - Date.parse(meta.lastSyncedAt) < RECENT_SYNC_SKIP_MS;

/**
 * 频道抓取入口（refreshChannel 调用）：
 * - page 1（手动刷新/首次进入）：距上次同步超 60 秒时，逐博主重抓最新批次
 *   （增量，已知推文按 ID 跳过），新触达仓库批量补全详情；
 * - page N（加载更多）：缓存不足该页窗口且距上次同步超 60 秒时补一次刷新，
 *   否则纯切片；每页返回累积前缀（前 page × 20 张卡片，调用方整体替换），
 *   因为刷新新增的卡片会落进已消费的窗口内，append 切片永远补不到。
 */
export async function syncXTweetChannel(
  api: GitHubApiService,
  page: number,
  follows: XTweetFollow[],
  onStatus: StatusCallback,
  transport: XTimelineTransport = defaultXTimelineTransport,
): Promise<PaginatedDiscoveryRepositories> {
  const handles = [...new Set(
    follows.map((follow) => follow.handle).filter((handle) => isValidXTweetHandle(handle)),
  )];
  if (handles.length === 0) {
    return { repos: [], hasMore: false, nextPageIndex: page + 1, totalCount: 0 };
  }

  const windowEnd = page * X_TWEET_CARD_PAGE_SIZE;
  const meta0 = await xTweetStorage.getSyncMeta();
  const recent = isRecentlySynced(meta0);
  let needsSync = page <= 1 && !recent;
  if (!needsSync && page > 1 && !recent) {
    const [tweets, repos] = await Promise.all([
      xTweetStorage.getAllTweets(),
      xTweetStorage.getAllRepos(),
    ]);
    needsSync = buildXTweetDiscoveryRepos(tweets, repos, handles).length < windowEnd;
  }

  if (needsSync) {
    await runExclusiveSync(async (signal) => {
      // 上一轮可能已落盘新数据，重读最新状态
      const meta = await xTweetStorage.getSyncMeta();
      if (isRecentlySynced(meta)) return;
      const tweets = await xTweetStorage.getAllTweets();
      const repos = await xTweetStorage.getAllRepos();

      const touchedRepoKeys = new Set<string>();
      let succeeded = 0;
      let firstError: unknown = null;
      for (const handle of handles) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        onStatus?.({ phase: 'syncing', current: succeeded, total: handles.length });
        try {
          const html = await transport(handle);
          const parsed = parseXTimelineHtml(html, handle);
          const { newTweets, pendingRepoKeys } = ingestFeedTweets(parsed, tweets, repos);
          for (const key of pendingRepoKeys) touchedRepoKeys.add(key);
          await xTweetStorage.saveTweets(newTweets);
          succeeded++;
        } catch (error) {
          if (isAbortError(error)) throw error;
          // 单个博主失败（账号不存在/网络抖动）不拖垮整轮，已有缓存照常展示
          logger.warn('xTweet', `Timeline fetch failed for @${handle}`, error);
          firstError = firstError ?? error;
        }
        await sleep(HANDLE_THROTTLE_MS);
      }
      if (succeeded === 0 && handles.length > 0) {
        throw firstError instanceof Error
          ? firstError
          : new Error('X 推文抓取失败：所有博主的时间线均不可达');
      }
      meta.lastSyncedAt = new Date().toISOString();

      const enrichTargets = reposNeedingDetail(repos, touchedRepoKeys, Date.now());
      try {
        await enrichRepos(api, enrichTargets, onStatus, signal);
      } finally {
        // 中途限流/中止也不丢已获取的详情与新推文；水位同步落盘
        //（enrichTargets ⊆ touchedRepoKeys，只落盘本轮触达的仓库）
        await xTweetStorage.saveSyncBatch({
          tweets: [],
          repos: [...touchedRepoKeys]
            .map((key) => repos.get(key))
            .filter((repo): repo is XStoredRepo => Boolean(repo)),
          meta,
        });
      }
    }, onStatus);
  }

  const tweets = await xTweetStorage.getAllTweets();
  const repos = await xTweetStorage.getAllRepos();
  const accumulated = buildXTweetDiscoveryRepos(tweets, repos, handles);
  return {
    repos: accumulated.slice(0, windowEnd),
    hasMore: accumulated.length > windowEnd,
    nextPageIndex: page + 1,
    totalCount: accumulated.length,
  };
}

/** 设置弹窗"测试连接"：真实抓取一位博主主页并解析，返回可验证的结果。 */
export async function probeXTweetSource(
  handle: string,
  transport: XTimelineTransport = defaultXTimelineTransport,
): Promise<{ ok: boolean; tweetCount?: number; repoCount?: number; error?: string }> {
  if (!isValidXTweetHandle(handle)) {
    return { ok: false, error: '无效的用户名' };
  }
  try {
    const html = await transport(handle);
    const parsed = parseXTimelineHtml(html, handle);
    return {
      ok: true,
      tweetCount: parsed.length,
      repoCount: parsed.reduce((sum, tweet) => sum + tweet.repoFullNames.length, 0),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
