import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { InstanceManager } from '../../instance/instance-manager';

type Handler = (event: unknown, payload: unknown) => Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const liveTest = vi.hoisted(() => ({ dataPath: null as string | null }));

vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } }));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../app/live-test-context', () => ({
  isHarnessLiveTest: () => liveTest.dataPath !== null,
  harnessLiveTestDataPath: () => liveTest.dataPath,
}));

import {
  _resetLiveTestQuestionFoldersForTesting,
  isLiveTestQuestionFolder,
  MAX_LIVE_TEST_QUESTION_SESSIONS,
} from '../../cli/adapters/live-test-question-fixtures';
import {
  _resetLiveTestQuestionSessionsForTesting,
  registerLiveTestQuestionSessionHandlers,
} from './live-test-question-session-handlers';

describe('live-test question session handlers', () => {
  let dataPath: string;
  let created = 0;
  const live = new Set<string>();
  const createInstance = vi.fn(async (config: { workingDirectory: string }) => {
    const id = `instance-${++created}`;
    live.add(id);
    void config;
    return { id };
  });
  const terminateInstance = vi.fn(async (id: string) => { live.delete(id); });
  const instanceManager = {
    createInstance,
    terminateInstance,
    getInstance: (id: string) => (live.has(id) ? { id } : undefined),
  } as unknown as InstanceManager;

  const call = (channel: string, payload: unknown = {}) => handlers.get(channel)!(null, payload);
  const create = () => call(IPC_CHANNELS.LIVE_TEST_QUESTION_SESSION_CREATE);
  const remove = (instanceId: string) => call(IPC_CHANNELS.LIVE_TEST_QUESTION_SESSION_REMOVE, { instanceId });

  beforeEach(() => {
    handlers.clear();
    live.clear();
    created = 0;
    createInstance.mockClear();
    terminateInstance.mockClear();
    _resetLiveTestQuestionFoldersForTesting();
    _resetLiveTestQuestionSessionsForTesting();
    dataPath = realpathSync(mkdtempSync(join(tmpdir(), 'aio-lt-question-spec-')));
    liveTest.dataPath = dataPath;
  });
  afterEach(() => {
    liveTest.dataPath = null;
    rmSync(dataPath, { recursive: true, force: true });
  });

  it('registers nothing in an ordinary app', () => {
    liveTest.dataPath = null;
    registerLiveTestQuestionSessionHandlers({ instanceManager });
    expect(handlers.size).toBe(0);
  });

  it('starts an OpenCode-shaped, non-YOLO session in its own folder inside the test profile', async () => {
    registerLiveTestQuestionSessionHandlers({ instanceManager });
    const response = await create();

    expect(response).toMatchObject({ success: true, data: { instanceId: 'instance-1' } });
    const config = createInstance.mock.calls[0]![0] as unknown as { workingDirectory: string; provider: string; yoloMode: boolean };
    expect(config.provider).toBe('opencode');
    expect(config.yoloMode).toBe(false);
    expect(config.workingDirectory.startsWith(join(dataPath, 'question-session-'))).toBe(true);
    expect(existsSync(config.workingDirectory)).toBe(true);
    expect(isLiveTestQuestionFolder(config.workingDirectory)).toBe(true);
  });

  it('refuses a payload carrying anything it did not define', async () => {
    registerLiveTestQuestionSessionHandlers({ instanceManager });
    const response = await call(IPC_CHANNELS.LIVE_TEST_QUESTION_SESSION_CREATE, { workingDirectory: '/' });
    expect(response.success).toBe(false);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('removes only a session it started, then cleans up its folder', async () => {
    registerLiveTestQuestionSessionHandlers({ instanceManager });
    await create();
    const folder = (createInstance.mock.calls[0]![0] as unknown as { workingDirectory: string }).workingDirectory;

    expect(await remove('instance-1')).toEqual({ success: true });
    expect(terminateInstance).toHaveBeenCalledWith('instance-1', false);
    expect(existsSync(folder)).toBe(false);
    expect(isLiveTestQuestionFolder(folder)).toBe(false);
  });

  it('refuses to remove a session it did not start', async () => {
    registerLiveTestQuestionSessionHandlers({ instanceManager });
    live.add('production-session');

    const response = await remove('production-session');

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('NOT_A_LIVE_TEST_QUESTION_SESSION');
    expect(terminateInstance).not.toHaveBeenCalled();
    expect(live.has('production-session')).toBe(true);
  });

  it('cleans up after a session closed some other way, and a second remove is refused', async () => {
    registerLiveTestQuestionSessionHandlers({ instanceManager });
    await create();
    const folder = (createInstance.mock.calls[0]![0] as unknown as { workingDirectory: string }).workingDirectory;
    live.delete('instance-1');

    expect(await remove('instance-1')).toEqual({ success: true });
    expect(terminateInstance).not.toHaveBeenCalled();
    expect(existsSync(folder)).toBe(false);
    expect((await remove('instance-1')).error?.code).toBe('NOT_A_LIVE_TEST_QUESTION_SESSION');
  });

  it('still frees the folder when stopping the session fails', async () => {
    registerLiveTestQuestionSessionHandlers({ instanceManager });
    await create();
    const folder = (createInstance.mock.calls[0]![0] as unknown as { workingDirectory: string }).workingDirectory;
    terminateInstance.mockRejectedValueOnce(new Error('stuck'));

    const response = await remove('instance-1');

    expect(response.success).toBe(false);
    expect(existsSync(folder)).toBe(false);
    expect(isLiveTestQuestionFolder(folder)).toBe(false);
  });

  it('leaves nothing behind when the session cannot be created', async () => {
    registerLiveTestQuestionSessionHandlers({ instanceManager });
    createInstance.mockRejectedValueOnce(new Error('no room'));

    const response = await create();

    expect(response.success).toBe(false);
    const folder = (createInstance.mock.calls[0]![0] as unknown as { workingDirectory: string }).workingDirectory;
    expect(existsSync(folder)).toBe(false);
    expect(isLiveTestQuestionFolder(folder)).toBe(false);
  });

  it('stops at the limit and leaves no folder for the refused session', async () => {
    registerLiveTestQuestionSessionHandlers({ instanceManager });
    for (let i = 0; i < MAX_LIVE_TEST_QUESTION_SESSIONS; i++) expect((await create()).success).toBe(true);

    const response = await create();

    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('Remove one first');
    expect(createInstance).toHaveBeenCalledTimes(MAX_LIVE_TEST_QUESTION_SESSIONS);
    await remove('instance-1');
    expect((await create()).success).toBe(true);
  });
});
