import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fsp from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import {
  installTestBrowserExtension,
  restoreTestBrowserExtension,
  type ExtensionTestInstallDeps,
} from './extension-test-install-service';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';

const manifest = (version: string) => JSON.stringify({ manifest_version: 3, version });

function node(name: string, overrides: Partial<WorkerNodeInfo['capabilities']> = {}, connected = true, browserComputer = true) {
  return {
    browserComputer,
    info: {
      id: `${name}-id`,
      name,
      status: connected ? 'connected' : 'disconnected',
      activeInstances: 0,
      capabilities: { extensionRelay: { enabled: true, running: true, extensionVersion: '0.2.54' }, ...overrides },
    } as unknown as WorkerNodeInfo,
    connected,
  };
}

describe('test browser extension install (coordinator)', () => {
  let root: string;
  let workspace: string;
  let sendRpc: ReturnType<typeof vi.fn<ExtensionTestInstallDeps['sendRpc']>>;
  let nodes: ReturnType<typeof node>[];
  let deps: ExtensionTestInstallDeps;

  const writeBuild = (dir: string, version = '0.2.55') => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), manifest(version));
    fs.writeFileSync(path.join(dir, 'background.js'), '// build');
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-ext-svc-'));
    workspace = path.join(root, 'work');
    writeBuild(path.join(workspace, 'resources', 'browser-extension'));
    nodes = [node('windows-pc'), node('plain-worker', { extensionRelay: undefined }), node('relay-only', {}, true, false)];
    sendRpc = vi.fn<ExtensionTestInstallDeps['sendRpc']>(async () => ({ state: 'active', testVersion: '0.2.55', reloadObserved: true }));
    deps = {
      nodeControl: {
        registry: { getAllNodes: () => nodes.map((entry) => entry.info) },
        server: {
          isNodeConnected: (id: string) => nodes.find((entry) => entry.info.id === id)?.connected === true,
          getConnectedNodeIds: () => [],
          resetNodeConnection: () => false,
        },
      },
      sendRpc,
      isBrowserComputer: (id) => nodes.find((entry) => entry.info.id === id)?.browserComputer === true,
      resolveWorkspace: (instanceId) => (instanceId === 'session-1' ? workspace : undefined),
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const install = (overrides: Partial<{ node: string; sourceDir: string; ttlMinutes: number; instanceId: string }> = {}) =>
    installTestBrowserExtension(deps, { instanceId: 'session-1', node: 'windows-pc', sourceDir: 'resources/browser-extension', ...overrides });

  it('sends the whole build to the named browser computer, owned by the calling session', async () => {
    const result = await install({ ttlMinutes: 10 });
    expect(result).toMatchObject({ nodeName: 'windows-pc', state: 'active', reloadObserved: true });
    expect(sendRpc).toHaveBeenCalledTimes(1);
    const [nodeId, method, rawParams] = sendRpc.mock.calls[0]!;
    const params = rawParams as { files: { name: string }[]; ttlMs: number; ownerId: string };
    expect(nodeId).toBe('windows-pc-id');
    expect(method).toBe(COORDINATOR_TO_NODE.BROWSER_EXTENSION_TEST_INSTALL);
    expect(params).toMatchObject({ action: 'install', ownerId: 'session-1', ttlMs: 600_000 });
    expect(params.files.map((file) => file.name).sort()).toEqual(['background.js', 'manifest.json']);
  });

  it('refuses a build whose version is not above the one running there, before sending anything', async () => {
    writeBuild(path.join(workspace, 'old'), '0.2.54');
    await expect(install({ sourceDir: 'old' })).rejects.toThrow('must be above');
    expect(sendRpc).not.toHaveBeenCalled();
  });

  it('refuses a source folder outside the session workspace, including through a link', async () => {
    writeBuild(path.join(root, 'elsewhere'));
    await expect(install({ sourceDir: path.join(root, 'elsewhere') })).rejects.toThrow('inside the current workspace');
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(workspace, 'linked'));
    await expect(install({ sourceDir: 'linked' })).rejects.toThrow('outside the current workspace');
    expect(sendRpc).not.toHaveBeenCalled();
  });

  it('refuses folders with sub-folders, links or stray files', async () => {
    const dir = path.join(workspace, 'resources', 'browser-extension');
    fs.mkdirSync(path.join(dir, 'nested'));
    await expect(install()).rejects.toThrow('plain files');
    fs.rmdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
    await expect(install()).rejects.toThrow('not allowed');
    expect(sendRpc).not.toHaveBeenCalled();
  });

  it('refuses a file swapped for a link to outside the workspace after the folder was listed', async () => {
    const dir = path.join(workspace, 'resources', 'browser-extension');
    const secret = path.join(root, 'secret.js');
    fs.writeFileSync(secret, '// not the caller\'s to send');
    const realReaddir = fsp.readdir.bind(fsp);
    vi.spyOn(fsp, 'readdir').mockImplementation(((...args: Parameters<typeof fsp.readdir>) =>
      realReaddir(...args).then((listing) => {
        fs.rmSync(path.join(dir, 'background.js'));
        fs.symlinkSync(secret, path.join(dir, 'background.js'));
        return listing;
      })) as typeof fsp.readdir);
    await expect(install()).rejects.toThrow();
    expect(sendRpc).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('refuses computers that are unknown, offline, fuzzy-matched or have no extension relay', async () => {
    await expect(install({ node: 'nobody' })).rejects.toThrow('No worker node');
    await expect(install({ node: 'browser' })).rejects.toThrow('No worker node');
    await expect(install({ node: 'plain-worker' })).rejects.toThrow('no browser extension relay');
    nodes.push(node('offline-pc', {}, false));
    await expect(install({ node: 'offline-pc' })).rejects.toThrow('not connected');
    expect(sendRpc).not.toHaveBeenCalled();
  });

  it('refuses a connected, relay-enabled node that is not classified as a browser computer, for install and restore', async () => {
    await expect(install({ node: 'relay-only' })).rejects.toThrow('not a browser computer');
    await expect(restoreTestBrowserExtension(deps, { instanceId: 'session-1', node: 'relay-only' })).rejects.toThrow('not a browser computer');
    expect(sendRpc).not.toHaveBeenCalled();
  });

  it('refuses a caller with no working folder', async () => {
    await expect(install({ instanceId: 'stranger' })).rejects.toThrow('working folder');
  });

  it('restores through the same worker call and checks the reply shape', async () => {
    sendRpc.mockResolvedValueOnce({ state: 'idle', restored: true, reloadObserved: true });
    expect(await restoreTestBrowserExtension(deps, { instanceId: 'session-1', node: 'windows-pc' }))
      .toMatchObject({ state: 'idle', restored: true });
    expect(sendRpc.mock.calls[0]?.[2]).toEqual({ action: 'restore', ownerId: 'session-1' });

    sendRpc.mockResolvedValueOnce({ state: 'weird' });
    await expect(restoreTestBrowserExtension(deps, { instanceId: 'session-1', node: 'windows-pc' })).rejects.toThrow();
  });
});
