/**
 * X 推文频道数据服务（按需分页抓取，仿 weeklyIssuesService）。
 *
 * 数据管道：RSSHub 兼容实例的 /twitter/user/:id 路由（count 路由参数控制
 * 每博主拉取条数）→ RSS 解析出推文 → 正文提取 GitHub 仓库链接（含仓库
 * 链接的推文为有效推文）→ 按 tweetId 去重增量合并（原贴取最新推文）→
 * 仓库详情补全（GraphQL 批量优先，REST 逐仓回退）→ 独立 IndexedDB 持久化
 * → 客户端按推文时间倒序 + 分页切片。
 *
 * 分页语义（不一次性取全量）：
 * - 首页（page 1 / 手动刷新）：对每位关注博主请求 count=每页条数 的最新
 *   时间线（增量，已知推文按 ID 跳过）；60 秒内同步过且水位覆盖当前关注
 *   列表则直接走缓存。
 * - 翻页（page N）：仅当缓存卡片不足该页所需时，对未取尽的博主请求
 *   count = N × 每页条数 的时间线（更深的历史），重叠部分由 ID 去重吸收；
 *   feed 返回条数不足请求数即视为该博主历史取尽。
 * - 每页返回累积前缀切片（前 page × 每页条数张卡片，调用方整体替换）：
 *   有效推文密度低时首页窗口可能没填满，加深拉取新增的卡片会落进已消费
 *   的窗口内，整体替换才能让它们现身（append 切片永远补不到）。
 * - 只有新触达的仓库才会调用 GitHub API 补详情；详情快照 30 天内免刷新。
 */

import type {
  DiscoveryChannelId,
  DiscoveryRepo,
  PaginatedDiscoveryRepositories,
  WeeklySyncStatus,
  XTweetFollow,
} from '../types';
import { logger } from './logger';
import type { GitHubApiService } from './githubApi';
import { extractRepoFullNames } from './weeklyIssuesService';
import {
  xTweetStorage,
  type XStoredRepo,
  type XStoredTweet,
  type XTweetSyncMeta,
} from './xTweetStorage';

const X_TWEET_CHANNEL: DiscoveryChannelId = 'x-tweet';
/** 每博主每页拉取的推文数（第 N 页请求 count = page × 该值，上限 100） */
export const X_TWEET_TWEETS_PER_BLOGGER = 20;
/** 频道每页卡片数（与 UI 的"加载更多"切片对齐） */
export const X_TWEET_CARD_PAGE_SIZE = 20;
/** Twitter API / RSSHub 的单次 count 上限 */
export const X_TWEET_MAX_TWEETS_PER_FETCH = 100;
const REST_ENRICH_THROTTLE_MS = 80;
const RSS_FETCH_THROTTLE_MS = 150;
const FETCH_TIMEOUT_MS = 20_000;
/** 仓库详情的刷新周期：30 天内的快照视为新鲜 */
const REPO_DETAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 不可用仓库（404/私有）的重试周期 */
const UNAVAILABLE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** 60 秒内同步过且水位覆盖当前关注列表则跳过首页刷新遍历 */
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

/** 从推文链接提取推文 ID（https://x.com/<handle>/status/<id>） */
export function extractTweetId(link: string): string | null {
  const match = link.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

const decodeEntities = (text: string): string => {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = text;
  return tempDiv.textContent || '';
};

/** 展示名：优先 RSS 作者字段，回退 @handle */
const pickDisplayName = (item: Element, handle: string): string => {
  const author = item.getElementsByTagName('dc:creator')[0]?.textContent
    || item.getElementsByTagName('author')[0]?.textContent
    || '';
  const decoded = decodeEntities(author).replace(/^@/, '').trim();
  return decoded || handle;
};

/**
 * 解析 RSSHub 的 X 用户时间线 feed。只保留能取到推文 ID 的条目；
 * 正文保留原始 HTML（渲染侧统一走 rehype-sanitize）。
 */
export function parseXTweetFeed(xml: string, handle: string): XStoredTweet[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('X feed XML parse error');
  }
  const tweets: XStoredTweet[] = [];
  for (const item of Array.from(doc.querySelectorAll('item'))) {
    const link = item.querySelector('link')?.textContent?.trim() || '';
    const tweetId = extractTweetId(link) || item.querySelector('guid')?.textContent?.trim() || '';
    if (!tweetId) continue;
    const content = item.querySelector('description')?.textContent?.trim() || '';
    const pubDate = item.querySelector('pubDate')?.textContent?.trim() || '';
    const parsedDate = pubDate ? Date.parse(pubDate) : NaN;
    tweets.push({
      tweetId,
      handle,
      displayName: pickDisplayName(item, handle),
      content,
      htmlUrl: link || `https://x.com/${handle}`,
      createdAt: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : new Date(0).toISOString(),
      repoFullNames: extractRepoFullNames(content).map((fullName) => fullName.toLowerCase()),
    });
  }
  return tweets;
}

/** 拉取单位博主的时间线 feed（RSSHub 路由参数 count 控制条数）。 */
async function fetchBloggerFeed(
  feedBaseUrl: string,
  handle: string,
  count: number,
  signal: AbortSignal | undefined,
): Promise<XStoredTweet[]> {
  const url = `${feedBaseUrl.replace(/\/+$/, '')}/twitter/user/${encodeURIComponent(handle)}/count=${count}`;
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('Aborted', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  const timeoutTimer = setTimeout(abort, FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/rss+xml, application/xml, text/xml' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`X feed fetch failed: ${response.status}`);
    }
    const text = await response.text();
    return parseXTweetFeed(text, handle);
  } finally {
    clearTimeout(timeoutTimer);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * 处理一轮 feed 结果：新推文进内存映射并登记，推文涉及的仓库 upsert
 * （原贴指向发布时间最新的推文），返回本轮需要补全详情的仓库。
 */
export function ingestFeedTweets(
  feed: XStoredTweet[],
  tweets: Map<string, XStoredTweet>,
  repos: Map<string, XStoredRepo>,
): { newTweets: XStoredTweet[]; pendingRepoKeys: Set<string> } {
  const newTweets: XStoredTweet[] = [];
  const pendingRepoKeys = new Set<string>();
  for (const tweet of feed) {
    const existing = tweets.get(tweet.tweetId);
    if (existing) continue;
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

const normalizeHandleKey = (handle: string): string => handle.trim().toLowerCase();

const isExhausted = (meta: XTweetSyncMeta, handleKey: string): boolean =>
  meta.exhaustedHandles.some((handle) => handle.toLowerCase() === handleKey);

/** 是否还有博主能拉到更深的历史（未取尽且水位未到单次 count 上限） */
const canDeepenAnyHandle = (meta: XTweetSyncMeta, handles: string[]): boolean =>
  handles.some((handle) => {
    const key = normalizeHandleKey(handle);
    return !isExhausted(meta, key) && (meta.fetchedCounts[key] ?? 0) < X_TWEET_MAX_TWEETS_PER_FETCH;
  });

/**
 * 首页是否需要刷新遍历：60 秒内同步过、实例地址未变、且水位已覆盖当前
 * 全部关注（新添加的关注还没拉过）时跳过，走缓存。
 */
export function shouldRefreshPage1(
  meta: XTweetSyncMeta,
  handles: string[],
  feedBaseUrl: string,
  nowMs: number,
): boolean {
  if (meta.feedBaseUrl !== feedBaseUrl) return true;
  if (!handles.every((handle) => normalizeHandleKey(handle) in meta.fetchedCounts)) return true;
  if (meta.lastSyncedAt === null || !Number.isFinite(Date.parse(meta.lastSyncedAt))) return true;
  return nowMs - Date.parse(meta.lastSyncedAt) >= RECENT_SYNC_SKIP_MS;
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

/**
 * 频道抓取入口（refreshChannel 调用）。按需分页：
 * - page 1：水位失效/有新关注/距上次同步超 60 秒时，增量拉取全部关注博主
 *   的最新时间线（每博主 count=每页条数）；
 * - page N：缓存卡片不足且仍有博主未取尽时，对未取尽的博主加深请求
 *   （count = page × 每页条数）；缓存充足时纯切片不触网。
 */
export async function syncXTweetChannel(
  api: GitHubApiService,
  page: number,
  follows: XTweetFollow[],
  feedBaseUrl: string,
  onStatus: StatusCallback,
): Promise<PaginatedDiscoveryRepositories> {
  const handles = [...new Set(follows.map((follow) => follow.handle).filter(Boolean).map((handle) => handle.trim()))];
  if (handles.length === 0) {
    return { repos: [], hasMore: false, nextPageIndex: page + 1, totalCount: 0 };
  }

  const targetCount = Math.min(page * X_TWEET_TWEETS_PER_BLOGGER, X_TWEET_MAX_TWEETS_PER_FETCH);
  const meta0 = await xTweetStorage.getSyncMeta();
  const needsPage1Sync = page <= 1 && shouldRefreshPage1(meta0, handles, feedBaseUrl, Date.now());
  const needsDeepen = page > 1
    && canDeepenAnyHandle(meta0, handles)
    && buildXTweetDiscoveryRepos(
        await xTweetStorage.getAllTweets(),
        await xTweetStorage.getAllRepos(),
        handles,
      ).length < page * X_TWEET_CARD_PAGE_SIZE;

  if (needsPage1Sync || needsDeepen) {
    await runExclusiveSync(async (signal) => {
      // 上一轮可能已落盘新数据，重读最新状态
      const meta = await xTweetStorage.getSyncMeta();
      const tweets = await xTweetStorage.getAllTweets();
      const repos = await xTweetStorage.getAllRepos();
      // 换实例后旧水位/取尽标记作废，从头拉取
      const baseUrlChanged = meta.feedBaseUrl !== feedBaseUrl;
      if (baseUrlChanged) {
        meta.fetchedCounts = {};
        meta.exhaustedHandles = [];
      }
      meta.feedBaseUrl = feedBaseUrl;

      // 首页刷新探测全部博主（含已取尽的——时间线可能有新推文，feed 返回
      // 拉满即自动解除取尽）；翻页只加深"未取尽且水位低于目标深度"的博主
      const fetchHandles = handles.filter((handle) => {
        if (page <= 1) return true;
        const key = normalizeHandleKey(handle);
        return !isExhausted(meta, key) && (meta.fetchedCounts[key] ?? 0) < targetCount;
      });

      const touchedRepoKeys = new Set<string>();
      let allFeedsFailed = fetchHandles.length > 0;
      let succeeded = 0;
      for (let i = 0; i < fetchHandles.length; i++) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const handle = fetchHandles[i];
        const key = normalizeHandleKey(handle);
        onStatus?.({ phase: 'syncing', current: succeeded, total: fetchHandles.length });
        try {
          const feed = await fetchBloggerFeed(feedBaseUrl, handle, targetCount, signal);
          const { newTweets, pendingRepoKeys } = ingestFeedTweets(feed, tweets, repos);
          for (const key of pendingRepoKeys) touchedRepoKeys.add(key);
          await xTweetStorage.saveTweets(newTweets);
          succeeded++;
          allFeedsFailed = false;
          // feed 条数不足请求数 → 该博主时间线已取尽；首页拉满则未取尽
          meta.fetchedCounts[key] = Math.max(meta.fetchedCounts[key] ?? 0, feed.length);
          if (feed.length < targetCount) {
            if (!meta.exhaustedHandles.includes(key)) meta.exhaustedHandles.push(key);
          } else {
            meta.exhaustedHandles = meta.exhaustedHandles.filter((h) => h.toLowerCase() !== key);
          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          // 单个博主失败（实例路由限流/账号不存在）不拖垮整轮，已有缓存照常展示
          logger.warn('xTweet', `Feed fetch failed for @${handle}`, error);
        }
        await sleep(RSS_FETCH_THROTTLE_MS);
      }
      if (allFeedsFailed && fetchHandles.length > 0) {
        throw new Error('X feed fetch failed: all followed accounts unavailable');
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
  const meta = await xTweetStorage.getSyncMeta();
  const accumulated = buildXTweetDiscoveryRepos(tweets, repos, handles);
  const windowEnd = page * X_TWEET_CARD_PAGE_SIZE;
  return {
    repos: accumulated.slice(0, windowEnd),
    hasMore: canDeepenAnyHandle(meta, handles) || accumulated.length > windowEnd,
    nextPageIndex: page + 1,
    totalCount: accumulated.length,
  };
}
