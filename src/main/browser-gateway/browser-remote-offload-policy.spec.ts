import type { BrowserProfile, BrowserTarget } from '@contracts/types/browser';
import { describe, expect, it } from 'vitest';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import {
  routeBrowserGatewayRequest,
  type BrowserRemoteOffloadPolicyDeps,
} from './browser-remote-offload-policy';
import { validateBrowserRpcPayload } from './browser-rpc-server-support';

describe('Browser Gateway remote offload policy', () => {
  it('rewrites implicit and explicitly local discovery onto the connected Windows node', () => {
    const windows = makeNode({ id: 'windows-node', name: 'windows-pc', platform: 'win32' });
    const deps = makeDeps({ nodes: [windows] });

    expect(routeBrowserGatewayRequest('browser.list_targets', {}, deps)).toEqual({
      nodeId: 'windows-node',
      computer: 'windows-pc',
    });
    expect(routeBrowserGatewayRequest(
      'browser.find_or_open',
      { url: 'https://example.test', computer: 'local' },
      deps,
    )).toEqual({
      url: 'https://example.test',
      nodeId: 'windows-node',
      computer: 'windows-pc',
    });
    expect(routeBrowserGatewayRequest(
      'browser.list_targets',
      { computer: '   ' },
      deps,
    )).toEqual({ nodeId: 'windows-node', computer: 'windows-pc' });
  });

  it('prefers a capable Windows worker but preserves an explicit remote selection', () => {
    const linux = makeNode({ id: 'linux-node', name: 'linux-browser', platform: 'linux' });
    const windows = makeNode({ id: 'windows-node', name: 'windows-pc', platform: 'win32' });
    const deps = makeDeps({ nodes: [linux, windows] });

    expect(routeBrowserGatewayRequest('browser.preflight_target', {
      url: 'https://example.test',
    }, deps)).toMatchObject({ nodeId: 'windows-node', computer: 'windows-pc' });
    expect(routeBrowserGatewayRequest('browser.list_targets', {
      nodeId: 'linux-node',
      computer: 'linux-browser',
    }, deps)).toEqual({ nodeId: 'linux-node', computer: 'linux-browser' });
  });

  it('blocks control of a cached coordinator-local target', () => {
    const windows = makeNode({ id: 'windows-node', name: 'windows-pc', platform: 'win32' });
    const localTarget = makeTarget({ id: 'local-target', profileId: 'local-profile' });
    const deps = makeDeps({ nodes: [windows], targets: [localTarget] });

    expect(() => routeBrowserGatewayRequest('browser.check_session', {
      profileId: 'local-profile',
      targetId: 'local-target',
    }, deps)).toThrow(
      /browser_local_target_blocked_by_remote_auto_offload.*windows-pc/,
    );
  });

  it('blocks opening a coordinator-local managed profile but permits cleanup', () => {
    const windows = makeNode({ id: 'windows-node', name: 'windows-pc', platform: 'win32' });
    const localProfile = makeProfile({ id: 'local-profile' });
    const deps = makeDeps({ nodes: [windows], profiles: [localProfile] });

    expect(() => routeBrowserGatewayRequest(
      'browser.open_profile',
      { profileId: 'local-profile' },
      deps,
    )).toThrow(/browser_local_target_blocked_by_remote_auto_offload/);
    expect(routeBrowserGatewayRequest(
      'browser.close_profile',
      { profileId: 'local-profile' },
      deps,
    )).toEqual({ profileId: 'local-profile' });
  });

  it('allows control of remote targets and remotely bound managed profiles', () => {
    const windows = makeNode({ id: 'windows-node', name: 'windows-pc', platform: 'win32' });
    const remoteTarget = makeTarget({
      id: 'remote-target',
      profileId: 'remote-profile',
      nodeId: 'windows-node',
    });
    const remoteProfile = makeProfile({ id: 'remote-profile', executionNodeId: 'windows-node' });
    const deps = makeDeps({
      nodes: [windows],
      targets: [remoteTarget],
      profiles: [remoteProfile],
    });

    expect(routeBrowserGatewayRequest('browser.click', {
      profileId: 'remote-profile',
      targetId: 'remote-target',
      selector: '#continue',
    }, deps)).toEqual({
      profileId: 'remote-profile',
      targetId: 'remote-target',
      selector: '#continue',
    });
    expect(routeBrowserGatewayRequest(
      'browser.open_profile',
      { profileId: 'remote-profile' },
      deps,
    )).toEqual({ profileId: 'remote-profile' });
  });

  it('leaves local routing available when the setting is off or no capable node is connected', () => {
    const windows = makeNode({ id: 'windows-node', name: 'windows-pc', platform: 'win32' });
    const disabled = makeDeps({ nodes: [windows], autoOffloadBrowser: false });
    const unavailable = makeDeps({ nodes: [] });
    const payload = { computer: 'local', refresh: true };

    expect(routeBrowserGatewayRequest('browser.list_targets', payload, disabled)).toBe(payload);
    expect(routeBrowserGatewayRequest('browser.list_targets', payload, unavailable)).toBe(payload);
  });

  it('preserves malformed selectors so RPC schema validation rejects them', () => {
    const windows = makeNode({ id: 'windows-node', name: 'windows-pc', platform: 'win32' });
    const deps = makeDeps({ nodes: [windows] });
    const malformed = [
      { computer: 42 },
      { computer: '' },
      { nodeId: 42 },
      { nodeId: '' },
    ];

    for (const payload of malformed) {
      const routed = routeBrowserGatewayRequest('browser.list_targets', payload, deps);
      expect(routed).toBe(payload);
      expect(() => validateBrowserRpcPayload('browser.list_targets', routed)).toThrow(
        'Invalid browser gateway RPC payload',
      );
    }
  });
});

function makeDeps(options: {
  nodes?: WorkerNodeInfo[];
  targets?: BrowserTarget[];
  profiles?: BrowserProfile[];
  enabled?: boolean;
  autoOffloadBrowser?: boolean;
} = {}): BrowserRemoteOffloadPolicyDeps {
  const profiles = options.profiles ?? [];
  return {
    getConfig: () => ({
      enabled: options.enabled ?? true,
      autoOffloadBrowser: options.autoOffloadBrowser ?? true,
    }),
    getConnectedNodes: () => options.nodes ?? [],
    listTargets: () => options.targets ?? [],
    getProfile: (profileId) => profiles.find((profile) => profile.id === profileId) ?? null,
  };
}

function makeNode(options: {
  id: string;
  name: string;
  platform: WorkerNodeInfo['capabilities']['platform'];
}): WorkerNodeInfo {
  return {
    id: options.id,
    name: options.name,
    status: 'connected',
    activeInstances: 0,
    capabilities: {
      platform: options.platform,
      arch: 'x64',
      cpuCores: 8,
      totalMemoryMB: 32_768,
      availableMemoryMB: 16_384,
      supportedClis: ['codex'],
      hasBrowserRuntime: true,
      hasBrowserMcp: true,
      hasAndroidMcp: false,
      hasDocker: false,
      maxConcurrentInstances: 4,
      workingDirectories: [],
      browsableRoots: [],
      discoveredProjects: [],
    },
  };
}

function makeTarget(options: {
  id: string;
  profileId: string;
  nodeId?: string;
}): BrowserTarget {
  return {
    id: options.id,
    profileId: options.profileId,
    ...(options.nodeId ? { nodeId: options.nodeId } : {}),
    mode: 'existing-tab',
    driver: 'extension',
    status: 'available',
    lastSeenAt: 1,
  };
}

function makeProfile(options: { id: string; executionNodeId?: string }): BrowserProfile {
  return {
    id: options.id,
    label: options.id,
    mode: 'session',
    browser: 'chrome',
    allowedOrigins: [],
    ...(options.executionNodeId ? { executionNodeId: options.executionNodeId } : {}),
    status: 'stopped',
    createdAt: 1,
    updatedAt: 1,
  };
}
