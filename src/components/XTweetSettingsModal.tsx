import { Button } from './ui/button';
import { Input } from './ui/input';
import React, { useState } from 'react';
import { Globe, Plus, Trash2, Users } from 'lucide-react';
import type { XTweetFollow } from '../types';
import { useAppStore } from '../store/useAppStore';
import { Modal } from './Modal';
import { useDialog } from '../hooks/useDialog';
import {
  DEFAULT_XTWEET_FEED_BASE_URL,
  normalizeXTweetFeedBaseUrl,
  normalizeXTweetHandleInput,
} from '../utils/xTweetFollows';

interface XTweetSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * X 推文频道的配置弹窗：关注博主列表（可增删）与 RSSHub 兼容实例地址。
 * 关闭后回到频道页点"刷新"即可增量拉取新关注博主的时间线。
 */
export const XTweetSettingsModal: React.FC<XTweetSettingsModalProps> = ({ isOpen, onClose }) => {
  const language = useAppStore(state => state.language);
  const xTweetFollows = useAppStore(state => state.xTweetFollows);
  const xTweetFeedBaseUrl = useAppStore(state => state.xTweetFeedBaseUrl);
  const addXTweetFollow = useAppStore(state => state.addXTweetFollow);
  const removeXTweetFollow = useAppStore(state => state.removeXTweetFollow);
  const setXTweetFeedBaseUrl = useAppStore(state => state.setXTweetFeedBaseUrl);
  const { toast } = useDialog();

  const t = (zh: string, en: string) => language === 'zh' ? zh : en;
  const [input, setInput] = useState('');
  const [baseUrlInput, setBaseUrlInput] = useState(xTweetFeedBaseUrl);

  const handleKeys = new Set(xTweetFollows.map(follow => follow.handle.toLowerCase()));

  const handleAdd = () => {
    const handle = normalizeXTweetHandleInput(input);
    if (!handle) {
      toast(t('请输入有效的 X 用户名，例如 @geekbb 或主页链接。', 'Enter a valid X handle, e.g. @geekbb or a profile URL.'), 'error');
      return;
    }
    if (handleKeys.has(handle.toLowerCase())) {
      toast(t('该博主已在关注列表中。', 'This account is already in the list.'), 'info');
      return;
    }
    addXTweetFollow(handle);
    setInput('');
    toast(t('已添加关注博主。', 'Account added to the follow list.'), 'success');
  };

  const handleRemove = (follow: XTweetFollow) => {
    removeXTweetFollow(follow.handle);
    toast(t(`已取消关注 @${follow.handle}。`, `Unfollowed @${follow.handle}.`), 'info');
  };

  const handleBaseUrlBlur = () => {
    const normalized = normalizeXTweetFeedBaseUrl(baseUrlInput);
    setBaseUrlInput(normalized);
    if (normalized !== xTweetFeedBaseUrl) {
      setXTweetFeedBaseUrl(normalized);
      toast(t('RSSHub 实例地址已更新。', 'RSSHub instance URL updated.'), 'success');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('X 推文频道设置', 'X Tweets Channel Settings')} maxWidth="max-w-2xl">
      <div className="space-y-5">
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm text-muted-foreground dark:text-muted-foreground">
          {t(
            '刷新时会增量拉取关注博主的时间线，推文中包含 GitHub 仓库链接的条目会展示为列表项。数据通过 RSSHub 兼容实例获取。',
            'Refreshing incrementally pulls timelines of followed accounts; tweets containing GitHub repository links are listed. Data is fetched through an RSSHub-compatible instance.',
          )}
        </div>

        <div className="rounded-lg border border-border dark:border-border bg-muted/50 dark:bg-muted/20 p-4">
          <div className="mb-3 flex items-start gap-2">
            <Users className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <div>
              <h4 className="text-sm font-semibold text-foreground dark:text-foreground">{t('关注列表', 'Follow list')}</h4>
              <p className="mt-1 text-xs text-muted-foreground dark:text-muted-foreground">
                {t(
                  '支持 @用户名、用户名或 x.com 主页链接。刷新时逐位博主分页拉取。',
                  'Accepts @handle, handle, or an x.com profile URL. Timelines are fetched page by page on refresh.',
                )}
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <Input
              type="text"
              aria-label={t('X 用户名', 'X handle')}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) handleAdd();
              }}
              placeholder="@geekbb / geekbb / https://x.com/geekbb"
              className="min-w-0 flex-1 rounded-lg border border-border dark:border-border bg-card dark:bg-muted/40 px-3 py-2 text-sm text-foreground dark:text-foreground focus:border-transparent focus:ring-2 focus:ring-ring"
            />
            <Button
              type="button"
              onClick={handleAdd}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              {t('添加', 'Add')}
            </Button>
          </div>

          <div className="mt-3 space-y-2">
            {xTweetFollows.length === 0 ? (
              <p className="rounded-lg bg-card dark:bg-card/[0.03] px-3 py-2 text-xs text-muted-foreground dark:text-muted-foreground">
                {t('暂无关注博主。', 'No followed accounts yet.')}
              </p>
            ) : xTweetFollows.map((follow) => (
              <div
                key={follow.handle.toLowerCase()}
                className="flex items-center justify-between gap-3 rounded-lg bg-card dark:bg-muted/40 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground dark:text-foreground">@{follow.handle}</div>
                  <a
                    href={`https://x.com/${follow.handle}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    className="truncate text-xs text-muted-foreground dark:text-muted-foreground hover:text-foreground transition-colors"
                  >
                    https://x.com/{follow.handle}
                  </a>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => handleRemove(follow)}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                  title={t('取消关注', 'Unfollow')}
                  aria-label={t(`取消关注 @${follow.handle}`, `Unfollow @${follow.handle}`)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border dark:border-border bg-muted/50 dark:bg-muted/20 p-4">
          <div className="mb-3 flex items-start gap-2">
            <Globe className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <div>
              <h4 className="text-sm font-semibold text-foreground dark:text-foreground">{t('RSSHub 实例地址', 'RSSHub instance URL')}</h4>
              <p className="mt-1 text-xs text-muted-foreground dark:text-muted-foreground">
                {t(
                  `默认使用公共实例 ${DEFAULT_XTWEET_FEED_BASE_URL}。X 路由在公共实例上可能限流，可自建 RSSHub（需配置 X 数据源）后替换为私有实例地址。`,
                  `Defaults to the public instance ${DEFAULT_XTWEET_FEED_BASE_URL}. X routes may be rate-limited there; point this to your self-hosted RSSHub (with X data source configured) if needed.`,
                )}
              </p>
            </div>
          </div>
          <Input
            type="text"
            aria-label={t('RSSHub 实例地址', 'RSSHub instance URL')}
            value={baseUrlInput}
            onChange={(event) => setBaseUrlInput(event.target.value)}
            onBlur={handleBaseUrlBlur}
            placeholder={DEFAULT_XTWEET_FEED_BASE_URL}
            className="w-full rounded-lg border border-border dark:border-border bg-card dark:bg-muted/40 px-3 py-2 text-sm text-foreground dark:text-foreground focus:border-transparent focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('完成', 'Done')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
