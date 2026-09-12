import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GitHubApiService, GitHubRepoDetailRead } from './githubApi';
import {
  decodeTweetRef,
  parseXTimelineHtml,
  tweetSnowflakeToDate,
  ingestFeedTweets,
  reposNeedingDetail,
  buildXTweetDiscoveryRepos,
  syncXTweetChannel,
  probeXTweetSource,
  X_TWEET_CARD_PAGE_SIZE,
  type XTimelineTransport,
} from './xTweetService';
import type { XStoredRepo, XStoredTweet, XTweetSyncMeta } from './xTweetStorage';
import type { XTweetFollow } from '../types';

/**
 * fixture 是从 x.com/geekbb 未登录主页真实响应中截取的 Flight 数据段
 * （含真实推文与 expanded_url 实体），解析器直接对着真实上游格式测。
 */
const REAL_TIMELINE_HTML = readFileSync(
  path.join(__dirname, '__fixtures__', 'x-timeline-geekbb.html'),
  'utf-8',
);

// 内存版存储替身（jsdom 无 IndexedDB）
const storage = vi.hoisted(() => {
  const tweetsStore = new Map<string, unknown>();
  const reposStore = new Map<string, unknown>();
  const metaRef = { current: { lastSyncedAt: null as string | null } };
  let failSyncBatchOnRepo: string | null = null;
  return {
    tweetsStore,
    reposStore,
    metaRef,
    setFailSyncBatchOnRepo(fullName: string | null) {
      failSyncBatchOnRepo = fullName;
    },
    failSyncBatchOnRepoNow: () => failSyncBatchOnRepo,
    reset() {
      tweetsStore.clear();
      reposStore.clear();
      metaRef.current = { lastSyncedAt: null };
      failSyncBatchOnRepo = null;
    },
  };
});

vi.mock('./xTweetStorage', () => ({
  xTweetStorage: {
    saveTweets: async (tweets: XStoredTweet[]) => {
      for (const tweet of tweets) storage.tweetsStore.set(tweet.tweetId, tweet);
    },
    getAllTweets: async () => new Map(storage.tweetsStore) as Map<string, XStoredTweet>,
    saveRepos: async (repos: XStoredRepo[]) => {
      for (const repo of repos) storage.reposStore.set(repo.fullName.toLowerCase(), repo);
    },
    getAllRepos: async () => new Map(storage.reposStore) as Map<string, XStoredRepo>,
    getSyncMeta: async () => ({ ...storage.metaRef.current }),
    saveSyncMeta: async (meta: XTweetSyncMeta) => {
      storage.metaRef.current = { ...meta };
    },
    saveSyncBatch: async (payload: { tweets: XStoredTweet[]; repos: XStoredRepo[]; meta: XTweetSyncMeta }) => {
      // 原子语义在真实现由单事务保证；替身以"先抛错后应用"模拟失败回滚
      if (storage.failSyncBatchOnRepoNow()
        && payload.repos.some((repo) => repo.fullName.toLowerCase() === storage.failSyncBatchOnRepoNow())) {
        throw new Error('sync batch tx failed');
      }
      for (const tweet of payload.tweets) storage.tweetsStore.set(tweet.tweetId, tweet);
      for (const repo of payload.repos) storage.reposStore.set(repo.fullName.toLowerCase(), repo);
      storage.metaRef.current = { ...payload.meta };
    },
    clearAll: async () => storage.reset(),
  },
}));

const makeDetail = (fullName: string): GitHubRepoDetailRead => ({
  id: fullName.length,
  name: fullName.split('/')[1],
  full_name: fullName,
  description: `desc of ${fullName}`,
  html_url: `https://github.com/${fullName}`,
  stargazers_count: 100,
  forks_count: 10,
  forks: 10,
  language: 'TypeScript',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  pushed_at: '2026-01-01T00:00:00Z',
  owner: { login: fullName.split('/')[0], avatar_url: `https://github.com/${fullName.split('/')[0]}.png` },
  topics: [],
} as unknown as GitHubRepoDetailRead);

const makeApi = (
  details: Map<string, GitHubRepoDetailRead | null>,
  graphqlError: Error | null = null,
): GitHubApiService => ({
  graphqlFetchRepositories: vi.fn(async (fullNames: string[]) => {
    if (graphqlError) throw graphqlError;
    const result = new Map<string, GitHubRepoDetailRead | null>();
    // 与真实 GraphQL 语义一致：不存在的仓库不产生键（而非显式 null），
    // 这样 REST 回退分支（restTargets）才可能被覆盖
    for (const fullName of fullNames) {
      const key = fullName.toLowerCase();
      if (details.has(key)) result.set(key, details.get(key) ?? null);
    }
    return result;
  }),
  getRepositoryDetails: vi.fn(async (owner: string, name: string) => {
    const detail = details.get(`${owner}/${name}`.toLowerCase());
    if (!detail) throw new Error(`404: ${owner}/${name}`);
    return detail;
  }),
} as unknown as GitHubApiService);

/** 传输替身：按 handle 返回预设 HTML（或抛错），记录每次调用 */
const stubTransport = (pages: Record<string, string | Error>): { transport: XTimelineTransport; calls: string[] } => {
  const calls: string[] = [];
  const transport: XTimelineTransport = async (handle) => {
    calls.push(handle);
    const page = pages[handle];
    if (page instanceof Error) throw page;
    return page ?? '<html></html>';
  };
  return { transport, calls };
};

const follows: XTweetFollow[] = [
  { handle: 'geekbb', addedAt: '2026-09-12T00:00:00.000Z' },
  { handle: 'ghost', addedAt: '2026-09-12T00:00:00.000Z' },
];

beforeEach(() => {
  storage.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decodeTweetRef', () => {
  it('解码 Flight 的 client 引用为推文 ID', () => {
    // base64("Tweet:2098629676495159496")
    expect(decodeTweetRef('VHdlZXQ6MjA5ODYyOTY3NjQ5NTE1OTQ5Ng==')).toBe('2098629676495159496');
    expect(decodeTweetRef('bm90LWEtdHdlZXQ=')).toBeNull();
    expect(decodeTweetRef('!!!not-base64!!!')).toBeNull();
  });
});

describe('tweetSnowflakeToDate', () => {
  it('从雪花 ID 推导发布时间（ID 超出 Number 安全范围，精度无损）', () => {
    // 已知样本：2098678373753225483 = 2026-09-12T07:41:30.518Z（Twitter epoch 1288834974657）
    expect(tweetSnowflakeToDate('2098678373753225483')).toBe('2026-09-12T07:41:30.518Z');
    // 与相邻雪花 ID 的时间差与 ID 差同向
    const later = tweetSnowflakeToDate('2098678373753225484');
    expect(Date.parse(later)).toBeGreaterThanOrEqual(Date.parse('2026-09-12T07:41:30.518Z'));
  });
});

describe('parseXTimelineHtml（真实 x.com 未登录主页 fixture）', () => {
  const tweets = () => parseXTimelineHtml(REAL_TIMELINE_HTML, 'geekbb');

  it('解析出顶层时间线的 5 条真实推文（精确 ID），嵌套引用推文不计入', () => {
    const parsed = tweets();
    // fixture 的 5 个顶层 TimelineTimelineEntry；2097971881596916185 是嵌套
    // 引用推文（其他作者），不得归属给 geekbb
    expect(new Set(parsed.map((t) => t.tweetId))).toEqual(new Set([
      '2098678373753225483',
      '2098629676495159496',
      '2098604072572162341',
      '2098581405253189796',
      '2098310980103200951',
    ]));
    expect(parsed.some((t) => t.tweetId === '2097971881596916185')).toBe(false);
    expect(parsed.every((t) => t.handle === 'geekbb')).toBe(true);
    expect(parsed.every((t) => t.htmlUrl.startsWith('https://x.com/geekbb/status/'))).toBe(true);
  });

  it('按雪花 ID 时间倒序（解析顺序无关）', () => {
    const parsed = tweets();
    const times = parsed.map((t) => Date.parse(t.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('从 expanded_url 实体提取 GitHub 仓库链接（geekbb 真实分享的仓库）', () => {
    const parsed = tweets();
    const allRepos = parsed.flatMap((t) => t.repoFullNames);
    expect(allRepos).toContain('obsidianmd/knap');
    expect(allRepos).toContain('zhihui-hu/one-ip');
    expect(allRepos).toContain('sumimakito/mac-duo');
  });

  it('还原正文的 \n 转义（Flight 字符串字面量）', () => {
    const parsed = tweets();
    const withNewline = parsed.find((t) => t.content.includes('\n\n'));
    expect(withNewline).toBeDefined();
  });

  it('非推文页（空 HTML）返回空数组', () => {
    expect(parseXTimelineHtml('<html><body>login wall</body></html>', 'geekbb')).toEqual([]);
  });
});

describe('ingestFeedTweets', () => {
  it('按 tweetId 去重；同仓库多推文时原贴指向最新推文', () => {
    const tweets = new Map<string, XStoredTweet>();
    const repos = new Map<string, XStoredRepo>();
    const make = (id: string, daysAgo: number) => ({
      tweetId: id,
      handle: 'geekbb',
      displayName: 'geekbb',
      content: 'repo https://github.com/a/one',
      htmlUrl: `https://x.com/geekbb/status/${id}`,
      createdAt: new Date(Date.now() - daysAgo * 86400_000).toISOString(),
      repoFullNames: ['a/one'],
    });
    const first = ingestFeedTweets([make('1', 5)], tweets, repos);
    expect(first.newTweets).toHaveLength(1);
    expect(ingestFeedTweets([make('1', 5)], tweets, repos).newTweets).toHaveLength(0);
    ingestFeedTweets([make('2', 1)], tweets, repos);
    expect(repos.get('a/one')!.sourceTweetId).toBe('2');
  });
});

describe('reposNeedingDetail', () => {
  it('新触达必补全；新鲜快照跳过；过期快照与到期不可用仓库重试', () => {
    const now = Date.now();
    const repos = new Map<string, XStoredRepo>();
    repos.set('a/new', { fullName: 'a/new', detail: null, lastFetchedAt: '', sourceTweetId: '1', tweetCreatedAt: '' });
    repos.set('a/fresh', { fullName: 'a/fresh', detail: makeDetail('a/fresh'), lastFetchedAt: new Date(now - 10 * 86400_000).toISOString(), sourceTweetId: '1', tweetCreatedAt: '' });
    repos.set('a/stale', { fullName: 'a/stale', detail: makeDetail('a/stale'), lastFetchedAt: new Date(now - 40 * 86400_000).toISOString(), sourceTweetId: '1', tweetCreatedAt: '' });
    repos.set('a/dead', { fullName: 'a/dead', detail: null, lastFetchedAt: new Date(now - 8 * 86400_000).toISOString(), sourceTweetId: '1', tweetCreatedAt: '' });
    const targets = reposNeedingDetail(repos, new Set(['a/new', 'a/fresh', 'a/stale', 'a/dead']), now);
    expect(targets.map((repo) => repo.fullName)).toEqual(['a/new', 'a/stale', 'a/dead']);
  });
});

describe('buildXTweetDiscoveryRepos', () => {
  it('只展示当前关注 + 已补全详情的仓库，按推文时间倒序并赋 rank', () => {
    const tweets = new Map<string, XStoredTweet>();
    const repos = new Map<string, XStoredRepo>();
    const make = (id: string, handle: string, daysAgo: number, repo: string) => ({
      tweetId: id,
      handle,
      displayName: handle,
      content: 'x',
      htmlUrl: `https://x.com/${handle}/status/${id}`,
      createdAt: new Date(Date.now() - daysAgo * 86400_000).toISOString(),
      repoFullNames: [repo],
    });
    ingestFeedTweets([make('1', 'alice', 1, 'a/one'), make('2', 'alice', 3, 'a/two')], tweets, repos);
    ingestFeedTweets([make('3', 'bob', 2, 'b/three')], tweets, repos);
    ingestFeedTweets([make('4', 'carol', 0, 'c/four')], tweets, repos);
    repos.set('a/two', { ...repos.get('a/two')!, detail: null });
    repos.set('b/three', { ...repos.get('b/three')!, detail: makeDetail('b/three') });
    repos.set('a/one', { ...repos.get('a/one')!, detail: makeDetail('a/one') });
    repos.set('c/four', { ...repos.get('c/four')!, detail: makeDetail('c/four') });

    const list = buildXTweetDiscoveryRepos(tweets, repos, ['alice', 'bob']);
    expect(list.map((repo) => repo.full_name)).toEqual(['a/one', 'b/three']);
    expect(list[0].rank).toBe(1);
    expect(list[0].channel).toBe('x-tweet');
    expect(list[0].xTweet?.handle).toBe('alice');
  });
});

describe('syncXTweetChannel', () => {
  it('首页逐博主真实抓取：解析推文、补全仓库详情、返回前缀切片', async () => {
    const { transport, calls } = stubTransport({ geekbb: REAL_TIMELINE_HTML, ghost: '<html></html>' });
    const api = makeApi(new Map([
      ['obsidianmd/knap', makeDetail('obsidianmd/knap')],
      ['zhihui-hu/one-ip', makeDetail('zhihui-hu/one-ip')],
      ['sumimakito/mac-duo', makeDetail('sumimakito/mac-duo')],
    ]));

    const result = await syncXTweetChannel(api, 1, follows.slice(0, 1), undefined, transport);
    expect(calls).toEqual(['geekbb']);
    // fixture 中 geekbb 的三条推文各含一个 GitHub 仓库链接 → 3 张卡片
    expect(result.repos.map((repo) => repo.full_name).sort())
      .toEqual(['obsidianmd/knap', 'sumimakito/mac-duo', 'zhihui-hu/one-ip']);
    expect(result.hasMore).toBe(false);
    expect(storage.metaRef.current.lastSyncedAt).not.toBeNull();
  });

  it('60 秒内重复刷新走缓存，不再调用传输层', async () => {
    const { transport, calls } = stubTransport({ geekbb: REAL_TIMELINE_HTML });
    const api = makeApi(new Map());
    await syncXTweetChannel(api, 1, follows.slice(0, 1), undefined, transport);
    const callsAfterFirst = calls.length;
    await syncXTweetChannel(api, 1, follows.slice(0, 1), undefined, transport);
    expect(calls.length).toBe(callsAfterFirst);
  });

  it('单个博主失败不拖垮整轮；全部失败才抛出传输层错误', async () => {
    const { transport } = stubTransport({
      geekbb: REAL_TIMELINE_HTML,
      ghost: new Error('x.com responded 404'),
    });
    const api = makeApi(new Map([['obsidianmd/knap', makeDetail('obsidianmd/knap')]]));
    const result = await syncXTweetChannel(api, 1, follows, undefined, transport);
    expect(result.repos.length).toBeGreaterThan(0);

    // 清掉首轮同步写入的 60 秒水位，让全失败轮真正触网
    storage.metaRef.current.lastSyncedAt = null;
    const allFail = stubTransport({ geekbb: new Error('x.com responded 503'), ghost: new Error('offline') });
    await expect(
      syncXTweetChannel(makeApi(new Map()), 1, follows, undefined, allFail.transport),
    ).rejects.toThrow('x.com responded 503');
  });

  it('无效 handle 的关注被过滤，不发请求', async () => {
    const { transport, calls } = stubTransport({});
    const api = makeApi(new Map());
    const result = await syncXTweetChannel(
      api, 1,
      [{ handle: 'not a handle!', addedAt: '2026-09-12T00:00:00.000Z' }],
      undefined, transport,
    );
    expect(calls).toEqual([]);
    expect(result.repos).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('取消关注后其仓库不再出现在列表中', async () => {
    const { transport } = stubTransport({ geekbb: REAL_TIMELINE_HTML });
    const api = makeApi(new Map([['obsidianmd/knap', makeDetail('obsidianmd/knap')]]));
    await syncXTweetChannel(api, 1, follows.slice(0, 1), undefined, transport);
    const afterUnfollow = await syncXTweetChannel(api, 1, [], undefined, transport);
    expect(afterUnfollow.repos).toHaveLength(0);
    expect(afterUnfollow.hasMore).toBe(false);
  });

  it('翻页返回累积前缀；缓存不足且刚同步过时不再触网', async () => {
    // 在真实 fixture 后追加 25 条带仓库链接的推文，凑出超过一页窗口的缓存
    const extra = Array.from({ length: 25 }, (_, i) => {
      // base64("Tweet:<id>") 本身自带 VHdlZXQ6 前缀，client: 后直接拼即可；
      // 解析器只认顶层 TimelineTimelineEntry，合成块需一并带上
      const id = (9000000000000000000n + BigInt(i)).toString();
      const ref = Buffer.from(`Tweet:${id}`).toString('base64');
      return `client:urt:server:TimelineTimelineEntry:tweet-${id}:content client:${ref}:details full_text:"repo https://github.com/alice/repo${i}" expanded_url:"https://github.com/alice/repo${i}"`;
    }).join(' ');
    const { transport } = stubTransport({ geekbb: REAL_TIMELINE_HTML + ' ' + extra });
    const details = new Map<string, GitHubRepoDetailRead | null>([
      ['obsidianmd/knap', makeDetail('obsidianmd/knap')],
      ...Array.from({ length: 25 }, (_, i) => [`alice/repo${i}`, makeDetail(`alice/repo${i}`)] as const),
    ]);
    const api = makeApi(new Map(details));

    await syncXTweetChannel(api, 1, follows.slice(0, 1), undefined, transport);
    // 60 秒水位内：翻页纯切片，前缀 = min(缓存, 40)
    const page2 = await syncXTweetChannel(api, 2, follows.slice(0, 1), undefined, transport);
    expect(page2.repos.length).toBeGreaterThan(X_TWEET_CARD_PAGE_SIZE);
    expect(page2.hasMore).toBe(false);
  });
});

describe('落盘失败传播', () => {
  it('第一个博主落盘成功、第二个博主写失败时中止整轮：不持久化缺原贴的仓库，也不推进水位', async () => {
    const ghostHtml = [
      'client:urt:server:TimelineTimelineEntry:tweet-8888888888888888888:content',
      'client:VHdlZXQ6' + Buffer.from('Tweet:8888888888888888888').toString('base64').slice(8) + ':details',
      'full_text:"repo https://github.com/ghost/repo"',
      'expanded_url:"https://github.com/ghost/repo"',
    ].join(' ');
    const { transport } = stubTransport({ geekbb: REAL_TIMELINE_HTML, ghost: ghostHtml });
    const api = makeApi(new Map([['obsidianmd/knap', makeDetail('obsidianmd/knap')]]));
    // 第二批（含 ghost/repo 的落盘）写失败
    storage.setFailSyncBatchOnRepo('ghost/repo');

    await expect(
      syncXTweetChannel(api, 1, follows, undefined, transport),
    ).rejects.toThrow('sync batch tx failed');

    // 首批（geekbb）已原子持久化且原贴齐全；ghost 的脏合并未混入
    expect(storage.reposStore.has('ghost/repo')).toBe(false);
    for (const [key, repo] of storage.reposStore) {
      expect(storage.tweetsStore.has((repo as XStoredRepo).sourceTweetId)).toBe(true);
      expect(key.length).toBeGreaterThan(0);
    }
    expect(storage.metaRef.current.lastSyncedAt).toBeNull();
  });
});

describe('REST 回退', () => {
  it('GraphQL 整批失败时逐仓回退 REST 补全', async () => {
    const { transport } = stubTransport({ geekbb: REAL_TIMELINE_HTML });
    const api = makeApi(
      new Map([['obsidianmd/knap', makeDetail('obsidianmd/knap')]]),
      new Error('GraphQL batch failed: bad gateway'),
    );
    const result = await syncXTweetChannel(api, 1, follows.slice(0, 1), undefined, transport);
    // knap 走 REST 成功；one-ip/mac-duo 不在详情表 → REST 404 → 标记不可用不出卡
    expect(result.repos.map((repo) => repo.full_name)).toEqual(['obsidianmd/knap']);
    expect(api.getRepositoryDetails).toHaveBeenCalledWith('obsidianmd', 'knap', expect.anything());
    expect(api.getRepositoryDetails).toHaveBeenCalledWith('zhihui-hu', 'one-ip', expect.anything());
  });
});

describe('probeXTweetSource', () => {
  it('真实解析返回推文数与仓库链接数', async () => {
    const { transport } = stubTransport({ geekbb: REAL_TIMELINE_HTML });
    const result = await probeXTweetSource('geekbb', transport);
    expect(result.ok).toBe(true);
    expect(result.tweetCount!).toBe(5);
    expect(result.repoCount!).toBe(3);
  });

  it('无效用户名与抓取失败均返回可展示错误', async () => {
    expect((await probeXTweetSource('bad handle!', stubTransport({}).transport)).ok).toBe(false);
    const fail = stubTransport({ geekbb: new Error('timeout') });
    const result = await probeXTweetSource('geekbb', fail.transport);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
  });
});
