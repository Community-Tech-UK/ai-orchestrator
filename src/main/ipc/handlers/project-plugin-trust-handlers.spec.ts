import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { ProjectPluginTrust } from '../../../shared/types/settings.types';
import { registerProjectPluginTrustHandlers } from './project-plugin-trust-handlers';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  return handler({}, payload);
}

describe('registerProjectPluginTrustHandlers', () => {
  let trustMap: Record<string, ProjectPluginTrust>;
  let writeTrustMap: ReturnType<typeof vi.fn>;
  let clearPluginCache: ReturnType<typeof vi.fn>;
  let writeOrder: string[];

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    trustMap = {};
    writeOrder = [];
    writeTrustMap = vi.fn((map: Record<string, ProjectPluginTrust>) => {
      writeOrder.push('write');
      trustMap = map;
    });
    clearPluginCache = vi.fn(() => {
      writeOrder.push('clear');
    });
    registerProjectPluginTrustHandlers({
      readTrustMap: () => trustMap,
      writeTrustMap,
      clearPluginCache,
      homeDir: null,
    });
  });

  it('reports ask for a project root without a recorded decision', async () => {
    const workingDirectory = path.join(os.tmpdir(), `trust-query-${Date.now()}`);
    await fsPromises.mkdir(workingDirectory, { recursive: true });

    const response = await invoke(IPC_CHANNELS.PROJECT_PLUGIN_TRUST_QUERY, { workingDirectory });

    expect(response.success).toBe(true);
    const { decisions } = response.data as {
      decisions: { projectRoot: string; trust: ProjectPluginTrust }[];
    };
    expect(decisions).toContainEqual(expect.objectContaining({
      projectRoot: path.resolve(workingDirectory),
      trust: 'ask',
    }));

    await fsPromises.rm(workingDirectory, { recursive: true, force: true });
  });

  it('grants trust by persisting to the user-scoped map before clearing the plugin cache', async () => {
    const projectRoot = path.join(path.sep, 'repo', 'nested', '..');
    const canonical = path.resolve(projectRoot);

    const response = await invoke(IPC_CHANNELS.PROJECT_PLUGIN_TRUST_GRANT, { projectRoot });

    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({ projectRoot: canonical, trust: 'trusted' });
    expect(trustMap[canonical]).toBe('trusted');
    expect(clearPluginCache).toHaveBeenCalledOnce();
    // Security invariant: the trust setting is written BEFORE the cache clear
    // that allows the next load to import plugin code.
    expect(writeOrder).toEqual(['write', 'clear']);
  });

  it('revokes trust by persisting an explicit untrusted decision', async () => {
    const projectRoot = path.join(path.sep, 'repo');
    trustMap = { [projectRoot]: 'trusted' };

    const response = await invoke(IPC_CHANNELS.PROJECT_PLUGIN_TRUST_REVOKE, { projectRoot });

    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({ projectRoot, trust: 'untrusted' });
    expect(trustMap[projectRoot]).toBe('untrusted');
    expect(clearPluginCache).toHaveBeenCalledOnce();
  });

  it('preserves existing decisions for other roots when granting', async () => {
    const otherRoot = path.join(path.sep, 'other-repo');
    trustMap = { [otherRoot]: 'untrusted' };
    const projectRoot = path.join(path.sep, 'repo');

    await invoke(IPC_CHANNELS.PROJECT_PLUGIN_TRUST_GRANT, { projectRoot });

    expect(trustMap).toEqual({
      [otherRoot]: 'untrusted',
      [projectRoot]: 'trusted',
    });
  });

  it('rejects invalid payloads with a structured error and writes nothing', async () => {
    for (const [channel, code] of [
      [IPC_CHANNELS.PROJECT_PLUGIN_TRUST_QUERY, 'PROJECT_PLUGIN_TRUST_QUERY_FAILED'],
      [IPC_CHANNELS.PROJECT_PLUGIN_TRUST_GRANT, 'PROJECT_PLUGIN_TRUST_GRANT_FAILED'],
      [IPC_CHANNELS.PROJECT_PLUGIN_TRUST_REVOKE, 'PROJECT_PLUGIN_TRUST_REVOKE_FAILED'],
    ] as const) {
      const response = await invoke(channel, { bogus: true });
      expect(response.success).toBe(false);
      expect(response.error?.code).toBe(code);
    }
    expect(writeTrustMap).not.toHaveBeenCalled();
    expect(clearPluginCache).not.toHaveBeenCalled();
  });
});
