import { describe, it, expect } from 'vitest';
import {
  DEFAULT_XTWEET_FEED_BASE_URL,
  DEFAULT_XTWEET_FOLLOWS,
  normalizeXTweetFollows,
  normalizeXTweetHandleInput,
  normalizeXTweetFeedBaseUrl,
} from './xTweetFollows';

describe('normalizeXTweetHandleInput', () => {
  it('接受 @用户名、裸用户名与 x.com/twitter.com 主页链接', () => {
    expect(normalizeXTweetHandleInput('@geekbb')).toBe('geekbb');
    expect(normalizeXTweetHandleInput('geekbb')).toBe('geekbb');
    expect(normalizeXTweetHandleInput('https://x.com/geekbb')).toBe('geekbb');
    expect(normalizeXTweetHandleInput('https://twitter.com/geekbb')).toBe('geekbb');
    expect(normalizeXTweetHandleInput('https://x.com/geekbb?foo=1')).toBe('geekbb');
    expect(normalizeXTweetHandleInput('  @geekbb  ')).toBe('geekbb');
  });

  it('拒绝空输入、超长与非法字符', () => {
    expect(normalizeXTweetHandleInput('')).toBeNull();
    expect(normalizeXTweetHandleInput('   ')).toBeNull();
    expect(normalizeXTweetHandleInput('this-handle-is-way-too-long-for-x')).toBeNull();
    expect(normalizeXTweetHandleInput('bad handle!')).toBeNull();
    expect(normalizeXTweetHandleInput('https://example.com/geekbb')).toBeNull();
  });
});

describe('normalizeXTweetFollows', () => {
  it('非数组回退默认关注（geekbb）', () => {
    expect(normalizeXTweetFollows(undefined)).toEqual(DEFAULT_XTWEET_FOLLOWS);
    expect(normalizeXTweetFollows('nope')).toEqual(DEFAULT_XTWEET_FOLLOWS);
  });

  it('空数组被尊重（用户可清空关注）', () => {
    expect(normalizeXTweetFollows([])).toEqual([]);
  });

  it('剔除非法项并按 handle 去重（大小写不敏感，保留最早添加）', () => {
    const result = normalizeXTweetFollows([
      { handle: 'geekbb', addedAt: '2026-09-12T00:00:00.000Z' },
      { handle: '@GeekBB', addedAt: '2026-09-13T00:00:00.000Z' },
      { handle: 'not a handle!', addedAt: '2026-09-13T00:00:00.000Z' },
      { handle: 'ruanyf', addedAt: 'invalid-date' },
    ]);
    expect(result).toEqual([
      { handle: 'geekbb', addedAt: '2026-09-12T00:00:00.000Z' },
      { handle: 'ruanyf', addedAt: '1970-01-01T00:00:00.000Z' },
    ]);
  });
});

describe('normalizeXTweetFeedBaseUrl', () => {
  it('剥掉末尾斜杠并保留路径', () => {
    expect(normalizeXTweetFeedBaseUrl('https://rsshub.example.com/')).toBe('https://rsshub.example.com');
    expect(normalizeXTweetFeedBaseUrl('https://proxy.example.com/rsshub/')).toBe('https://proxy.example.com/rsshub');
  });

  it('空/非法/非 http(s) 输入回退默认实例', () => {
    expect(normalizeXTweetFeedBaseUrl('')).toBe(DEFAULT_XTWEET_FEED_BASE_URL);
    expect(normalizeXTweetFeedBaseUrl('not a url')).toBe(DEFAULT_XTWEET_FEED_BASE_URL);
    expect(normalizeXTweetFeedBaseUrl('ftp://rsshub.example.com')).toBe(DEFAULT_XTWEET_FEED_BASE_URL);
    expect(normalizeXTweetFeedBaseUrl(42)).toBe(DEFAULT_XTWEET_FEED_BASE_URL);
  });
});
