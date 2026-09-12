import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repositoryChatStorage } from './repositoryChatStorage';
import type { RepositoryChatMessage, RepositoryChatSession, RepositoryChatToolEvent, ToolEvidence } from '../types/repositoryChat';

const createSession = (id: string, repoId: number, updatedAt: string): RepositoryChatSession => ({
  id,
  repoId,
  repoFullName: `owner/repository-${repoId}`,
  sourceRefSha: 'abcdef1234567890',
  title: id,
  createdAt: updatedAt,
  updatedAt,
});

const createMessage = (id: string, sessionId: string, evidenceIds: string[] = []): RepositoryChatMessage => ({
  id,
  sessionId,
  role: 'assistant',
  content: 'Answer',
  status: 'complete',
  evidenceIds,
  createdAt: '2026-08-26T00:00:00.000Z',
});

const createToolEvent = (sessionId: string, evidenceId?: string): RepositoryChatToolEvent => ({
  id: `tool-${sessionId}`,
  sessionId,
  messageId: `message-${sessionId}`,
  toolName: 'read_repo_readme',
  status: 'success',
  paramSummary: 'README.md',
  ...(evidenceId ? { evidenceId } : {}),
  createdAt: '2026-08-26T00:00:00.000Z',
});

const createEvidence = (id: string): ToolEvidence => ({
  id,
  source: 'github',
  repoFullName: 'owner/repository-1',
  refSha: 'abcdef1234567890',
  path: 'README.md',
  lineStart: 1,
  lineEnd: 2,
  url: 'https://github.com/owner/repository-1/blob/abcdef1234567890/README.md#L1-L2',
  excerpt: 'README',
  retrievedAt: '2026-08-26T00:00:00.000Z',
});

describe('repositoryChatStorage local fallback', () => {
  const originalIndexedDb = Object.getOwnPropertyDescriptor(window, 'indexedDB');
  const originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalIndexedDb) Object.defineProperty(window, 'indexedDB', originalIndexedDb);
    else delete (window as { indexedDB?: IDBFactory }).indexedDB;
    if (originalLocalStorage) Object.defineProperty(window, 'localStorage', originalLocalStorage);
  });

  it('filters, orders, and soft-deletes sessions strictly within the selected repository', async () => {
    await repositoryChatStorage.saveSession(createSession('older', 1, '2026-08-24T00:00:00.000Z'));
    await repositoryChatStorage.saveSession(createSession('other-repository', 2, '2026-08-26T00:00:00.000Z'));
    await repositoryChatStorage.saveSession(createSession('newer', 1, '2026-08-25T00:00:00.000Z'));

    await expect(repositoryChatStorage.listSessionsByRepository(1)).resolves.toMatchObject([
      { id: 'newer', repoId: 1 },
      { id: 'older', repoId: 1 },
    ]);

    await repositoryChatStorage.softDeleteSession('newer');
    await expect(repositoryChatStorage.listSessionsByRepository(1)).resolves.toMatchObject([
      { id: 'older', repoId: 1 },
    ]);
    await expect(repositoryChatStorage.listSessionsByRepository(2)).resolves.toMatchObject([
      { id: 'other-repository', repoId: 2 },
    ]);
  });

  it('purges expired sessions for the active repository while retaining current sessions', async () => {
    await repositoryChatStorage.saveSession(createSession('expired', 1, '2026-01-01T00:00:00.000Z'));
    await repositoryChatStorage.saveSession(createSession('current', 1, new Date().toISOString()));

    await repositoryChatStorage.purgeExpiredSessions(1, 1);

    await expect(repositoryChatStorage.getSession('expired')).resolves.toBeNull();
    await expect(repositoryChatStorage.getSession('current')).resolves.toMatchObject({ id: 'current' });
  });

  it('physically deletes all messages, tool events, and evidence connected to the deleted session', async () => {
    const session = createSession('session-1', 1, '2026-08-26T00:00:00.000Z');
    const messageEvidence = createEvidence('message-evidence');
    const toolEvidence = createEvidence('tool-evidence');
    await repositoryChatStorage.saveSession(session);
    await repositoryChatStorage.saveMessage(createMessage('message-1', session.id, [messageEvidence.id]));
    await repositoryChatStorage.saveToolEvent(createToolEvent(session.id, toolEvidence.id));
    await repositoryChatStorage.saveEvidence(messageEvidence);
    await repositoryChatStorage.saveEvidence(toolEvidence);

    await repositoryChatStorage.permanentlyDeleteSession(session.id);

    await expect(repositoryChatStorage.getSession(session.id)).resolves.toBeNull();
    await expect(repositoryChatStorage.listMessages(session.id)).resolves.toEqual([]);
    await expect(repositoryChatStorage.listToolEvents(session.id)).resolves.toEqual([]);
    await expect(repositoryChatStorage.listEvidence([messageEvidence.id, toolEvidence.id])).resolves.toEqual([]);
  });

  it('lists recent sessions across repositories in recency order with a limit', async () => {
    await repositoryChatStorage.saveSession(createSession('repo1-older', 1, '2026-08-24T00:00:00.000Z'));
    await repositoryChatStorage.saveSession(createSession('repo2-newer', 2, '2026-08-26T00:00:00.000Z'));
    await repositoryChatStorage.saveSession(createSession('repo1-middle', 1, '2026-08-25T00:00:00.000Z'));

    await expect(repositoryChatStorage.listRecentSessions(2)).resolves.toMatchObject([
      { id: 'repo2-newer', repoId: 2 },
      { id: 'repo1-middle', repoId: 1 },
    ]);
    await expect(repositoryChatStorage.listRecentSessions()).resolves.toMatchObject([
      { id: 'repo2-newer', repoId: 2 },
      { id: 'repo1-middle', repoId: 1 },
      { id: 'repo1-older', repoId: 1 },
    ]);

    await repositoryChatStorage.softDeleteSession('repo2-newer');
    await expect(repositoryChatStorage.listRecentSessions()).resolves.toMatchObject([
      { id: 'repo1-middle', repoId: 1 },
      { id: 'repo1-older', repoId: 1 },
    ]);
  });

  it('rejects fallback writes when localStorage persistence is unavailable', async () => {
    // 直接把 window.localStorage 换成抛错桩：不同平台的 jsdom 对 Storage 原型/
    // 实例方法的实现有差异，逐方法 spy 在 CI（Linux）上不可靠。
    const storageError = () => { throw new DOMException('storage is unavailable'); };
    const throwingStorage = {
      getItem: storageError,
      setItem: storageError,
      removeItem: storageError,
      clear: storageError,
      key: storageError,
      get length() { throw new DOMException('storage is unavailable'); },
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, value: throwingStorage });

    await expect(repositoryChatStorage.saveSession(createSession('cannot-persist', 1, '2026-08-26T00:00:00.000Z')))
      .rejects.toThrow('unable to persist fallback snapshot');
  });
});
