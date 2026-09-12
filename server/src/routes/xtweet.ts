import { Router } from 'express';
import { logger } from '../services/logger.js';

/**
 * X 推文频道：服务端代抓 x.com 未登录主页 HTML。
 * 浏览器渲染进程受 CORS 限制无法直连 x.com，桌面端走 Electron 主进程 IPC，
 * 服务端（fullstack）部署走本路由。只抓固定的 https://x.com/<handle>，
 * handle 严格校验，不透传任意 URL。
 */
const X_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const FETCH_TIMEOUT_MS = 20_000;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const router: Router = Router();

router.get('/api/xtweet/profile/:handle', async (req, res) => {
  const { handle } = req.params;
  if (typeof handle !== 'string' || !X_HANDLE_PATTERN.test(handle)) {
    res.status(400).json({ error: 'invalid handle', code: 'INVALID_HANDLE' });
    return;
  }
  try {
    const response = await fetch(`https://x.com/${handle}`, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!response.ok) {
      logger.warn('xtweet', `x.com responded ${response.status} for @${handle}`);
      res.status(502).json({ error: `x.com responded ${response.status}`, code: 'UPSTREAM_ERROR' });
      return;
    }
    const html = await response.text();
    res.json({ html });
  } catch (error) {
    logger.warn('xtweet', `fetch failed for @${handle}`, error);
    res.status(502).json({
      error: error instanceof Error ? error.message : 'fetch failed',
      code: 'UPSTREAM_ERROR',
    });
  }
});

export default router;
