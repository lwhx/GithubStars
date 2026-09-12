import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GitHubApiService, GitHubRepoDetailRead } from './githubApi';
import {
  extractTweetId,
  parseXTweetFeed,
  ingestFeedTweets,
  reposNeedingDetail,
  buildXTweetDiscoveryRepos,
  shouldRefreshPage1,
  syncXTweetChannel,
  X_TWEET_CARD_PAGE_SIZE,
  X_TWEET_MAX_TWEETS_PER_FETCH,
  X_TWEET_TWEETS_PER_BLOGGER,
} from './xTweetService';
import type { XStoredRepo, XStoredTweet, XTweetSyncMeta } from './xTweetStorage';
import type { XTweetFollow } from '../types';

// 内存版存储替身（jsdom 无 IndexedDB）：验证 syncXTweetChannel 的分页/水位/取尽语义
const storage = vi.hoisted(() => {
  const tweetsStore = new Map<string, unknown>();
  const reposStore = new Map<string, unknown>();
  const metaRef = {
    current: {
      lastSyncedAt: null as string | null,
      feedBaseUrl: 'https://rsshub.test',
      fetchedCounts: {} as Record<string, number>,
      exhaustedHandles: [] as string[],
    },
  };
  return {
    tweetsStore,
    reposStore,
    metaRef,
    reset() {
      tweetsStore.clear();
      reposStore.clear();
      metaRef.current = {
        lastSyncedAt: null,
        feedBaseUrl: 'https://rsshub.test',
        fetchedCounts: {},
        exhaustedHandles: [],
      };
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

const makeApi = (details: Map<string, GitHubRepoDetailRead | null>): GitHubApiService => ({
  graphqlFetchRepositories: vi.fn(async (fullNames: string[]) => {
    const result = new Map<string, GitHubRepoDetailRead | null>();
    for (const fullName of fullNames) result.set(fullName.toLowerCase(), details.get(fullName.toLowerCase()) ?? null);
    return result;
  }),
  getRepositoryDetails: vi.fn(async (owner: string, name: string) => {
    const detail = details.get(`${owner}/${name}`.toLowerCase());
    if (!detail) throw new Error(`404: ${owner}/${name}`);
    return detail;
  }),
} as unknown as GitHubApiService);

const escapeXml = (text: string) => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const buildFeedXml = (handle: string, tweets: Array<{ id: number; body: string; daysAgo: number }>): string => {
  const items = tweets.map((tweet) => {
    const created = new Date(Date.now() - tweet.daysAgo * 24 * 60 * 60 * 1000);
    return `<item>
  <title>tweet ${tweet.id}</title>
  <link>https://x.com/${handle}/status/${tweet.id}</link>
  <guid>https://x.com/${handle}/status/${tweet.id}</guid>
  <dc:creator>@${handle}</dc:creator>
  <description><![CDATA[<p>${escapeXml(tweet.body)}</p>]]></description>
  <pubDate>${created.toUTCString()}</pubDate>
</item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>X timeline</title>${items.join('\n')}</channel>
</rss>`;
};

/** 在全局 fetch 上装 feed 替身：记录每次请求，按 handle 返回构造的 RSS（遵守 count 截取语义，与真实 RSSHub/测试服务器一致） */
const stubFeedFetch = (
  feeds: Record<string, Array<{ id: number; body: string; daysAgo: number }>>,
  statusByHandle: Record<string, number> = {},
) => {
  const calls: Array<{ handle: string; count: number }> = [];
  const fetchMock = vi.fn(async (url: string) => {
    const match = url.match(/\/twitter\/user\/([^/]+)\/count=(\d+)/);
    const handle = decodeURIComponent(match![1]);
    const count = Number(match![2]);
    calls.push({ handle, count });
    const status = statusByHandle[handle] ?? 200;
    if (status !== 200) {
      return { ok: false, status, text: async () => '' };
    }
    const tweets = (feeds[handle] ?? []).slice(0, count);
    return { ok: true, status: 200, text: async () => buildFeedXml(handle, tweets) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
};

const follows: XTweetFollow[] = [
  { handle: 'alice', addedAt: '2026-09-12T00:00:00.000Z' },
  { handle: 'bob', addedAt: '2026-09-12T00:00:00.000Z' },
];

beforeEach(() => {
  storage.reset();
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractTweetId', () => {
  it('从推文链接提取 ID', () => {
    expect(extractTweetId('https://x.com/geekbb/status/1234567890123456789')).toBe('1234567890123456789');
    expect(extractTweetId('https://x.com/geekbb')).toBeNull();
  });
});

describe('parseXTweetFeed', () => {
  it('解析条目并从正文提取仓库链接（仅 github.com）', () => {
    const xml = buildFeedXml('geekbb', [
      { id: 1, body: 'check out https://github.com/owner/one and https://github.com/owner/two/tree/main', daysAgo: 1 },
      { id: 2, body: 'no repos here, see https://example.com/foo', daysAgo: 2 },
    ]);
    const tweets = parseXTweetFeed(xml, 'geekbb');
    expect(tweets).toHaveLength(2);
    expect(tweets[0].tweetId).toBe('1');
    expect(tweets[0].repoFullNames).toEqual(['owner/one', 'owner/two']);
    expect(tweets[1].repoFullNames).toEqual([]);
    expect(tweets[0].handle).toBe('geekbb');
    expect(tweets[0].htmlUrl).toContain('/status/1');
    expect(Number.isFinite(Date.parse(tweets[0].createdAt))).toBe(true);
  });

  it('XML 损坏时抛错', () => {
    expect(() => parseXTweetFeed('<rss><channel>', 'geekbb')).toThrow();
  });
});

describe('ingestFeedTweets', () => {
  it('按 tweetId 去重；重复推文跳过', () => {
    const tweets = new Map<string, XStoredTweet>();
    const repos = new Map<string, XStoredRepo>();
    const feed = parseXTweetFeed(buildFeedXml('alice', [
      { id: 1, body: 'repo https://github.com/a/one', daysAgo: 1 },
    ]), 'alice');
    const first = ingestFeedTweets(feed, tweets, repos);
    expect(first.newTweets).toHaveLength(1);
    const second = ingestFeedTweets(feed, tweets, repos);
    expect(second.newTweets).toHaveLength(0);
  });

  it('同仓库多推文时原贴指向最新推文', () => {
    const tweets = new Map<string, XStoredTweet>();
    const repos = new Map<string, XStoredRepo>();
    ingestFeedTweets(parseXTweetFeed(buildFeedXml('alice', [
      { id: 1, body: 'repo https://github.com/a/one', daysAgo: 5 },
    ]), 'alice'), tweets, repos);
    ingestFeedTweets(parseXTweetFeed(buildFeedXml('alice', [
      { id: 2, body: 'again https://github.com/a/one', daysAgo: 1 },
    ]), 'alice'), tweets, repos);
    expect(repos.get('a/one')!.sourceTweetId).toBe('2');
  });
});

describe('reposNeedingDetail', () => {
  it('新触达必补全；新鲜快照跳过；过期快照与到期不可用仓库重试', () => {
    const now = Date.now();
    const repos = new Map<string, XStoredRepo>();
    repos.set('a/new', { fullName: 'a/new', detail: null, lastFetchedAt: '', sourceTweetId: '1', tweetCreatedAt: '' });
    repos.set('a/fresh', { fullName: 'a/fresh', detail: makeDetail('a/fresh'), lastFetchedAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(), sourceTweetId: '1', tweetCreatedAt: '' });
    repos.set('a/stale', { fullName: 'a/stale', detail: makeDetail('a/stale'), lastFetchedAt: new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(), sourceTweetId: '1', tweetCreatedAt: '' });
    repos.set('a/dead', { fullName: 'a/dead', detail: null, lastFetchedAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(), sourceTweetId: '1', tweetCreatedAt: '' });
    const targets = reposNeedingDetail(repos, new Set(['a/new', 'a/fresh', 'a/stale', 'a/dead']), now);
    expect(targets.map((repo) => repo.fullName)).toEqual(['a/new', 'a/stale', 'a/dead']);
  });
});

describe('buildXTweetDiscoveryRepos', () => {
  it('只展示当前关注 + 已补全详情的仓库，按推文时间倒序并赋 rank', () => {
    const tweets = new Map<string, XStoredTweet>();
    const repos = new Map<string, XStoredRepo>();
    ingestFeedTweets(parseXTweetFeed(buildFeedXml('alice', [
      { id: 1, body: 'repo https://github.com/a/one', daysAgo: 1 },
      { id: 2, body: 'repo https://github.com/a/two', daysAgo: 3 },
    ]), 'alice'), tweets, repos);
    ingestFeedTweets(parseXTweetFeed(buildFeedXml('bob', [
      { id: 3, body: 'repo https://github.com/b/three', daysAgo: 2 },
    ]), 'bob'), tweets, repos);
    ingestFeedTweets(parseXTweetFeed(buildFeedXml('carol', [
      { id: 4, body: 'repo https://github.com/c/four', daysAgo: 0 },
    ]), 'carol'), tweets, repos);
    repos.set('a/two', { ...repos.get('a/two')!, detail: null });
    repos.set('b/three', { ...repos.get('b/three')!, detail: makeDetail('b/three') });
    repos.set('a/one', { ...repos.get('a/one')!, detail: makeDetail('a/one') });
    repos.set('c/four', { ...repos.get('c/four')!, detail: makeDetail('c/four') });

    const list = buildXTweetDiscoveryRepos(tweets, repos, ['alice', 'bob']);
    // a/two 未补全不展示；c/four 属于已取消关注的 carol，不展示
    expect(list.map((repo) => repo.full_name)).toEqual(['a/one', 'b/three']);
    expect(list[0].rank).toBe(1);
    expect(list[0].channel).toBe('x-tweet');
    expect(list[0].xTweet?.handle).toBe('alice');
    expect(list[0].xTweet?.tweetId).toBe('1');
  });
});

describe('shouldRefreshPage1', () => {
  const now = Date.now();
  const meta = (overrides: Partial<XTweetSyncMeta>): XTweetSyncMeta => ({
    lastSyncedAt: new Date(now - 10 * 60 * 1000).toISOString(),
    feedBaseUrl: 'https://rsshub.test',
    fetchedCounts: { alice: 20, bob: 20 },
    exhaustedHandles: [],
    ...overrides,
  });

  it('水位覆盖当前关注且未超 60 秒 → 跳过刷新', () => {
    expect(shouldRefreshPage1(meta({ lastSyncedAt: new Date(now - 30 * 1000).toISOString() }), ['alice', 'bob'], 'https://rsshub.test', now)).toBe(false);
  });

  it('超 60 秒 / 新关注 / 实例地址变化 / 水位缺失 → 强制刷新', () => {
    expect(shouldRefreshPage1(meta({}), ['alice', 'bob'], 'https://rsshub.test', now)).toBe(true);
    expect(shouldRefreshPage1(meta({}), ['alice', 'bob', 'carol'], 'https://rsshub.test', now)).toBe(true);
    expect(shouldRefreshPage1(meta({}), ['alice', 'bob'], 'https://rsshub2.test', now)).toBe(true);
    expect(shouldRefreshPage1(meta({ fetchedCounts: { alice: 20 } }), ['alice', 'bob'], 'https://rsshub.test', now)).toBe(true);
  });
});

describe('syncXTweetChannel', () => {
  it('首页拉一批：每博主 count=每页条数，仓库详情补全后返回切片', async () => {
    const tweets = Array.from({ length: X_TWEET_TWEETS_PER_BLOGGER }, (_, i) => ({
      id: i + 1,
      body: `repo https://github.com/alice/repo${i + 1}`,
      daysAgo: i + 1,
    }));
    stubFeedFetch({ alice: tweets, bob: [] });
    const details = new Map<string, GitHubRepoDetailRead | null>(
      tweets.map((tweet) => [`alice/repo${tweet.id}`, makeDetail(`alice/repo${tweet.id}`)] as const),
    );
    const api = makeApi(details);

    const result = await syncXTweetChannel(api, 1, follows.slice(0, 1), 'https://rsshub.test', undefined);
    // 20 条推文各含一个仓库链接 → 20 张卡片，首页切片全量返回
    expect(result.repos).toHaveLength(X_TWEET_TWEETS_PER_BLOGGER);
    expect(result.totalCount).toBe(X_TWEET_TWEETS_PER_BLOGGER);
    expect(result.hasMore).toBe(true);
    expect(result.nextPageIndex).toBe(2);
    // feed 返回条数达到请求数 → 未取尽
    expect(storage.metaRef.current.exhaustedHandles).toEqual([]);
    expect(storage.metaRef.current.fetchedCounts.alice).toBe(X_TWEET_TWEETS_PER_BLOGGER);
  });

  it('60 秒内重复刷新走缓存，不再请求 feed', async () => {
    const { calls } = stubFeedFetch({ alice: [] });
    const api = makeApi(new Map());
    await syncXTweetChannel(api, 1, follows.slice(0, 1), 'https://rsshub.test', undefined);
    const callsAfterFirst = calls.length;
    await syncXTweetChannel(api, 1, follows.slice(0, 1), 'https://rsshub.test', undefined);
    expect(calls.length).toBe(callsAfterFirst);
  });

  it('新添加的关注突破 60 秒跳过窗口，立即拉取', async () => {
    stubFeedFetch({ alice: [] });
    const api = makeApi(new Map());
    await syncXTweetChannel(api, 1, follows.slice(0, 1), 'https://rsshub.test', undefined);
    const { calls } = stubFeedFetch({ alice: [], carol: [] });
    await syncXTweetChannel(api, 1, [...follows.slice(0, 1), { handle: 'carol', addedAt: '2026-09-13T00:00:00.000Z' }], 'https://rsshub.test', undefined);
    expect(calls.some((call) => call.handle === 'carol')).toBe(true);
  });

  it('翻页：缓存不足时对未取尽博主加深请求（count = 页数 × 每页条数）', async () => {
    // 5 条推文只含 1 个有效仓库 → 首页仅 1 张卡片，翻页应触发 deepen
    const tweets = [{ id: 1, body: 'repo https://github.com/alice/only', daysAgo: 1 }];
    tweets.push(...Array.from({ length: X_TWEET_TWEETS_PER_BLOGGER - 1 }, (_, i) => ({
      id: i + 2,
      body: 'no repos, just chatter',
      daysAgo: i + 2,
    })));
    const { calls } = stubFeedFetch({ alice: tweets });
    const api = makeApi(new Map([['alice/only', makeDetail('alice/only')]]));

    await syncXTweetChannel(api, 1, follows.slice(0, 1), 'https://rsshub.test', undefined);
    expect(calls[0]).toEqual({ handle: 'alice', count: X_TWEET_TWEETS_PER_BLOGGER });
    // feed 返回 20 条 = 请求数 → 未取尽 → 翻页触发 count=40 的 deepen
    await syncXTweetChannel(api, 2, follows.slice(0, 1), 'https://rsshub.test', undefined);
    expect(calls[1]).toEqual({ handle: 'alice', count: 2 * X_TWEET_TWEETS_PER_BLOGGER });
  });

  it('加深拉取新增卡片落入已消费窗口时，翻页结果以累积前缀整体返回', async () => {
    // 前 20 条推文只有 1 条带仓库链接，21-40 每条都带 → 首页仅 1 张卡片，
    // count=40 加深后新卡片索引落在 1-19（首页窗口内），page 2 前缀应整体包含
    const tweets = [{ id: 1, body: 'repo https://github.com/alice/only', daysAgo: 1 }];
    tweets.push(...Array.from({ length: X_TWEET_TWEETS_PER_BLOGGER - 1 }, (_, i) => ({
      id: i + 2,
      body: 'no repos, just chatter',
      daysAgo: i + 2,
    })));
    tweets.push(...Array.from({ length: X_TWEET_TWEETS_PER_BLOGGER }, (_, i) => ({
      id: i + 21,
      body: `repo https://github.com/alice/extra${i + 1}`,
      daysAgo: 21 + i,
    })));
    stubFeedFetch({ alice: tweets });
    const details = new Map<string, GitHubRepoDetailRead | null>([
      ['alice/only', makeDetail('alice/only')],
      ...Array.from({ length: X_TWEET_TWEETS_PER_BLOGGER }, (_, i) =>
        [`alice/extra${i + 1}`, makeDetail(`alice/extra${i + 1}`)] as const),
    ]);
    const api = makeApi(details);

    const page1 = await syncXTweetChannel(api, 1, follows.slice(0, 1), 'https://rsshub.test', undefined);
    expect(page1.repos).toHaveLength(1);
    const page2 = await syncXTweetChannel(api, 2, follows.slice(0, 1), 'https://rsshub.test', undefined);
    // 累积前缀 = 1 + 20 = 21 张卡片全部返回（append 切片语义会丢掉窗口内新增的 20 张）
    expect(page2.repos).toHaveLength(1 + X_TWEET_TWEETS_PER_BLOGGER);
    expect(page2.totalCount).toBe(1 + X_TWEET_TWEETS_PER_BLOGGER);
  });

  it('feed 条数不足请求数 → 取尽标记；全部取尽后 hasMore=false', async () => {
    stubFeedFetch({ alice: [{ id: 1, body: 'repo https://github.com/a/one', daysAgo: 1 }] });
    const api = makeApi(new Map([['a/one', makeDetail('a/one')]]));
    const page1 = await syncXTweetChannel(api, 1, follows.slice(0, 1), 'https://rsshub.test', undefined);
    expect(page1.repos).toHaveLength(1);
    expect(storage.metaRef.current.exhaustedHandles).toEqual(['alice']);
    // 翻页：已取尽且缓存只有 1 页 → 不触网；返回累积前缀（含首页那 1 张）
    const page2 = await syncXTweetChannel(api, 2, follows.slice(0, 1), 'https://rsshub.test', undefined);
    expect(page2.repos).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
  });

  it('单个博主 feed 失败不拖垮整轮；全部失败才抛错', async () => {
    stubFeedFetch(
      { bob: [{ id: 1, body: 'repo https://github.com/b/one', daysAgo: 1 }] },
      { alice: 500 },
    );
    const api = makeApi(new Map([['b/one', makeDetail('b/one')]]));
    const result = await syncXTweetChannel(api, 1, follows, 'https://rsshub.test', undefined);
    expect(result.repos.map((repo) => repo.full_name)).toEqual(['b/one']);

    stubFeedFetch({}, { alice: 500, bob: 404 });
    await expect(
      syncXTweetChannel(makeApi(new Map()), 1, follows, 'https://rsshub.test', undefined),
    ).rejects.toThrow('all followed accounts unavailable');
  });

  it('换 RSSHub 实例后水位作废重新拉取', async () => {
    stubFeedFetch({ alice: [] });
    const api = makeApi(new Map());
    await syncXTweetChannel(api, 1, follows.slice(0, 1), 'https://rsshub.test', undefined);
    const { calls } = stubFeedFetch({ alice: [] });
    await syncXTweetChannel(api, 1, follows.slice(0, 1), 'https://rsshub2.test', undefined);
    expect(calls.some((call) => call.handle === 'alice')).toBe(true);
    expect(storage.metaRef.current.feedBaseUrl).toBe('https://rsshub2.test');
  });

  it('翻页水位达到 count 上限后不再加深，hasMore 收敛为 false', async () => {
    // 每"页"推文都带新仓库链接 → 水位持续打满；把每页深度直接顶到上限
    storage.metaRef.current.fetchedCounts.alice = X_TWEET_MAX_TWEETS_PER_FETCH;
    storage.metaRef.current.lastSyncedAt = new Date().toISOString();
    storage.metaRef.current.feedBaseUrl = 'https://rsshub.test';
    stubFeedFetch({ alice: [] });
    const api = makeApi(new Map());
    const result = await syncXTweetChannel(api, 6, follows.slice(0, 1), 'https://rsshub.test', undefined);
    expect(result.hasMore).toBe(false);
  });

  it('取消关注后其仓库不再出现在列表中', async () => {
    stubFeedFetch({ alice: [{ id: 1, body: 'repo https://github.com/a/one', daysAgo: 1 }] });
    const api = makeApi(new Map([['a/one', makeDetail('a/one')]]));
    await syncXTweetChannel(api, 1, follows.slice(0, 1), 'https://rsshub.test', undefined);
    const afterUnfollow = await syncXTweetChannel(api, 1, [], 'https://rsshub.test', undefined);
    expect(afterUnfollow.repos).toHaveLength(0);
    expect(afterUnfollow.hasMore).toBe(false);
  });
});

describe('X_TWEET_CARD_PAGE_SIZE', () => {
  it('与每博主条数一致，保证 UI 翻页与网络批量对齐', () => {
    expect(X_TWEET_CARD_PAGE_SIZE).toBe(X_TWEET_TWEETS_PER_BLOGGER);
  });
});
