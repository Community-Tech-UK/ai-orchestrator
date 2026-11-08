import type { BrowserProfile, BrowserTarget } from '@contracts/types/browser';
import { describe, expect, it, vi } from 'vitest';
import type { ComputerChoice } from '../../shared/types/settings.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { BrowserComputerBalancer } from './browser-computer-balancer';
const sessions = vi.hoisted(() => ({ list: [] as Array<{ nodeId: string; nodeName: string; browserCapable?: boolean }> }));
vi.mock('../auth/remote-auth', () => ({
  getRemoteAuthService: () => ({ listSessions: () => sessions.list }),
}));

import {
  listKnownBrowserComputers,
  routeBrowserGatewayRequest,
  type BrowserRemoteOffloadPolicyDeps,
  type KnownBrowserComputer,
} from './browser-remote-offload-policy';
import { validateBrowserRpcPayload } from './browser-rpc-server-support';

describe('listKnownBrowserComputers', () => {
  it('reads only paired nodes flagged as browser computers', () => {
    sessions.list = [
      { nodeId: 'windows-node', nodeName: 'windows-pc', browserCapable: true },
      { nodeId: 'noah-node', nodeName: 'noahlaptop', browserCapable: false },
      { nodeId: 'old-node', nodeName: 'never-reported' },
    ];

    expect(listKnownBrowserComputers()).toEqual([{ id: 'windows-node', name: 'windows-pc' }]);
  });
});

describe('Browser Gateway remote offload policy', () => {
  it('rewrites unscoped discovery onto the connected Windows node but keeps explicit local', () => {
    const windows = makeNode({ id: 'windows-node', name: 'windows-pc', platform: 'win32' });
    const deps = makeDeps({ nodes: [windows] });

    expect(routeBrowserGatewayRequest('browser.list_targets', {}, 'agent-1', deps)).toEqual({
      nodeId: 'windows-node',
      computer: 'windows-pc',
    });
    expect(routeBrowserGatewayRequest(
      'browser.find_or_open',
      { url: 'https://example.test', computer: 'local' },
      'agent-1',
      deps,
    )).toEqual({
      url: 'https://example.test',
      computer: 'local',
    });
    expect(routeBrowserGatewayRequest(
      'browser.list_targets',
      { computer: 'local', refresh: true },
      'agent-1',
      deps,
    )).toEqual({ computer: 'local', refresh: true });
    expect(routeBrowserGatewayRequest(
      'browser.list_targets',
      { computer: '   ' },
      'agent-1',
      deps,
    )).toEqual({ nodeId: 'windows-node', computer: 'windows-pc' });
  });

  it('prefers a capable Windows worker but preserves an explicit remote selection', () => {
    const linux = makeNode({ id: 'linux-node', name: 'linux-browser', platform: 'linux' });
    const windows = makeNode({ id: 'windows-node', name: 'windows-pc', platform: 'win32' });
    const deps = makeDeps({ nodes: [linux, windows] });

    expect(routeBrowserGatewayRequest('browser.preflight_target', {
      url: 'https://example.test',
    }, 'agent-1', deps)).toMatchObject({ nodeId: 'windows-node', computer: 'windows-pc' });
    expect(routeBrowserGatewayRequest('browser.list_targets', {
      nodeId: 'linux-node',
      computer: 'linux-browser',
    }, 'agent-1', deps)).toEqual({ nodeId: 'linux-node', computer: 'linux-browser' });
  });

  it('routes extension recovery to the selected remote computer without selecting local implicitly', () => {
    const windows = makeNode({ id: 'windows-node', name: 'windows-pc', platform: 'win32' });
    const deps = makeDeps({ nodes: [windows] });

    expect(routeBrowserGatewayRequest('browser.recover_extension', {}, 'agent-1', deps)).toEqual({
      nodeId: 'windows-node',
      computer: 'windows-pc',
    });
    expect(routeBrowserGatewayRequest(
      'browser.recover_extension',
      { computer: 'local' },
      'agent-1',
      deps,
    )).toEqual({ computer: 'local' });
  });

  it('blocks control of a cached coordinator-local target', () => {
    const windows = makeNode({ id: 'windows-node', name: 'windows-pc', platform: 'win32' });
    const localTarget = makeTarget({ id: 'local-target', profileId: 'local-profile' });
    const deps = makeDeps({ nodes: [windows], targets: [localTarget] });

    expect(() => routeBrowserGatewayRequest('browser.check_session', {
      profileId: 'local-profile',
      targetId: 'local-target',
    }, 'agent-1', deps)).toThrow(
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
      'agent-1',
      deps,
    )).toThrow(/browser_local_target_blocked_by_remote_auto_offload/);
    expect(routeBrowserGatewayRequest(
      'browser.close_profile',
      { profileId: 'local-profile' },
      'agent-1',
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
    }, 'agent-1', deps)).toEqual({
      profileId: 'remote-profile',
      targetId: 'remote-target',
      selector: '#continue',
    });
    expect(routeBrowserGatewayRequest(
      'browser.open_profile',
      { profileId: 'remote-profile' },
      'agent-1',
      deps,
    )).toEqual({ profileId: 'remote-profile' });
  });

  it('leaves local routing available when the setting is off or no capable node is connected', () => {
    const windows = makeNode({ id: 'windows-node', name: 'windows-pc', platform: 'win32' });
    const disabled = makeDeps({ nodes: [windows], autoOffloadBrowser: false });
    const unavailable = makeDeps({ nodes: [] });
    const payload = { computer: 'local', refresh: true };

    expect(routeBrowserGatewayRequest('browser.list_targets', payload, 'agent-1', disabled)).toBe(payload);
    expect(routeBrowserGatewayRequest('browser.list_targets', payload, 'agent-1', unavailable)).toBe(payload);
  });

  describe('when the paired browser computer is unavailable', () => {
    const offlineWindows = { id: 'windows-node', name: 'windows-pc' };

    it('refuses unscoped discovery instead of silently using this Mac', () => {
      const deps = makeDeps({ nodes: [], knownBrowserComputers: [offlineWindows] });

      for (const method of ['browser.list_targets', 'browser.find_or_open', 'browser.preflight_target', 'browser.recover_extension']) {
        expect(() => routeBrowserGatewayRequest(method, { url: 'https://example.test' }, 'agent-1', deps)).toThrow(
          /browser_remote_computer_offline: The browser computer "windows-pc" is offline or not ready.*ask whether to use this Mac.*retry with computer: "local"/,
        );
      }
    });

    it('still runs an explicit local or explicitly targeted request', () => {
      const deps = makeDeps({ nodes: [], knownBrowserComputers: [offlineWindows] });
      const local = { url: 'https://example.test', computer: 'local' };
      const named = { nodeId: 'windows-node', computer: 'windows-pc' };

      expect(routeBrowserGatewayRequest('browser.find_or_open', local, 'agent-1', deps)).toBe(local);
      expect(routeBrowserGatewayRequest('browser.list_targets', named, 'agent-1', deps)).toBe(named);
    });

    it('leaves malformed selectors for RPC schema validation', () => {
      const deps = makeDeps({ nodes: [], knownBrowserComputers: [offlineWindows] });
      const malformed = { computer: 42 };

      expect(routeBrowserGatewayRequest('browser.list_targets', malformed, 'agent-1', deps)).toBe(malformed);
    });

    it('refuses opening a local managed profile and points at the agreed local path', () => {
      const localProfile = makeProfile({ id: 'local-profile' });
      const remoteProfile = makeProfile({ id: 'remote-profile', executionNodeId: 'windows-node' });
      const deps = makeDeps({
        nodes: [],
        knownBrowserComputers: [offlineWindows],
        profiles: [localProfile, remoteProfile],
      });

      expect(() => routeBrowserGatewayRequest('browser.open_profile', { profileId: 'local-profile' }, 'agent-1', deps))
        .toThrow(/browser_remote_computer_offline.*use browser\.find_or_open with computer: "local"/);
      expect(routeBrowserGatewayRequest('browser.open_profile', { profileId: 'remote-profile' }, 'agent-1', deps))
        .toEqual({ profileId: 'remote-profile' });
      expect(routeBrowserGatewayRequest('browser.close_profile', { profileId: 'local-profile' }, 'agent-1', deps))
        .toEqual({ profileId: 'local-profile' });
    });

    it('keeps an agreed local session usable once a local target exists', () => {
      const localTarget = makeTarget({ id: 'local-target', profileId: 'local-profile' });
      const deps = makeDeps({ nodes: [], knownBrowserComputers: [offlineWindows], targets: [localTarget] });
      const click = { targetId: 'local-target', selector: '#go' };

      expect(routeBrowserGatewayRequest('browser.click', click, 'agent-1', deps)).toBe(click);
    });

    it('treats a connected browser computer without browser automation as unavailable', () => {
      const windows = makeNode({ id: 'windows-node', name: 'windows-pc', platform: 'win32' });
      windows.capabilities.hasBrowserMcp = false;
      const deps = makeDeps({ nodes: [windows], knownBrowserComputers: [offlineWindows] });

      expect(() => routeBrowserGatewayRequest('browser.list_targets', {}, 'agent-1', deps))
        .toThrow(/browser_remote_computer_offline/);
    });

    it('does nothing when browser offload is switched off', () => {
      const deps = makeDeps({ nodes: [], knownBrowserComputers: [offlineWindows], autoOffloadBrowser: false });

      expect(routeBrowserGatewayRequest('browser.list_targets', {}, 'agent-1', deps)).toEqual({});
    });
  });

  describe('with two browser computers', () => {
    const windows = makeNode({ id: 'windows-node', name: 'windows-pc', platform: 'win32' });
    const mac = makeNode({ id: 'mac-node', name: 'ct-test-mac', platform: 'darwin' });
    const open = (deps: BrowserRemoteOffloadPolicyDeps, instanceId: string, url = 'https://example.test') =>
      routeBrowserGatewayRequest('browser.find_or_open', { url }, instanceId, deps)['computer'];

    it('spreads sessions across them, and keeps each session on its own', () => {
      const deps = makeDeps({ nodes: [windows, mac] });
      expect(open(deps, 'agent-1')).toBe('windows-pc');
      expect(open(deps, 'agent-2')).toBe('ct-test-mac');
      expect(open(deps, 'agent-1')).toBe('windows-pc');
      expect(routeBrowserGatewayRequest('browser.list_targets', {}, 'agent-2', deps)).toMatchObject({ nodeId: 'mac-node' });
    });

    it('keeps a session on a computer it named, and on the computer of a tab it used', () => {
      const deps = makeDeps({
        nodes: [windows, mac],
        targets: [makeTarget({ id: 'mac-tab', profileId: 'p', nodeId: 'mac-node' })],
      });
      routeBrowserGatewayRequest('browser.list_targets', { computer: 'ct-test-mac' }, 'agent-1', deps);
      expect(open(deps, 'agent-1')).toBe('ct-test-mac');
      routeBrowserGatewayRequest('browser.click', { targetId: 'mac-tab', selector: '#go' }, 'agent-2', deps);
      expect(open(deps, 'agent-2')).toBe('ct-test-mac');
    });

    it('obeys a named computer exactly, even one the balance would not pick', () => {
      const deps = makeDeps({ nodes: [windows, mac], choices: [{ id: 'mac-node', paused: true, sessions: true }] });
      const named = { url: 'https://example.test', computer: 'ct-test-mac' };
      expect(routeBrowserGatewayRequest('browser.find_or_open', named, 'agent-1', deps)).toBe(named);
    });

    it('sends no new session to a paused computer, and says so rather than running here when every one is', () => {
      const someDeps = makeDeps({ nodes: [windows, mac], choices: [{ id: 'windows-node', paused: true, sessions: true }] });
      expect(open(someDeps, 'agent-1')).toBe('ct-test-mac');
      expect(open(someDeps, 'agent-2')).toBe('ct-test-mac');
      const allDeps = makeDeps({
        nodes: [windows, mac],
        choices: [{ id: 'windows-node', paused: true, sessions: true }, { id: 'mac-node', paused: true, sessions: true }],
        knownBrowserComputers: [{ id: 'windows-node', name: 'windows-pc' }, { id: 'mac-node', name: 'ct-test-mac' }],
      });
      expect(() => open(allDeps, 'agent-1')).toThrow(/browser_computers_paused: Every browser computer \("windows-pc", "ct-test-mac"\) is paused/);
    });

    it('keeps a session where it is when a request names a computer that is not there or contradicts itself', () => {
      // A shop tab on the PC: a session that lost its place would choose afresh and be sent there.
      const shopTab = { ...makeTarget({ id: 'shop-tab', profileId: 'p', nodeId: 'windows-node' }), origin: 'https://shop.test' };
      for (const named of [{ nodeId: 'no-such-node' }, { nodeId: 'windows-node', computer: 'ct-test-mac' }]) {
        const deps = makeDeps({ nodes: [windows, mac], targets: [shopTab] });
        expect(open(deps, 'agent-2')).toBe('windows-pc');
        expect(open(deps, 'agent-1')).toBe('ct-test-mac');
        routeBrowserGatewayRequest('browser.list_targets', named, 'agent-1', deps);
        expect(open(deps, 'agent-1', 'https://shop.test/basket')).toBe('ct-test-mac');
      }
    });
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
      const routed = routeBrowserGatewayRequest('browser.list_targets', payload, 'agent-1', deps);
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
  knownBrowserComputers?: KnownBrowserComputer[];
  choices?: ComputerChoice[];
  balancer?: BrowserComputerBalancer;
} = {}): BrowserRemoteOffloadPolicyDeps {
  const profiles = options.profiles ?? [];
  return {
    getConfig: () => ({
      enabled: options.enabled ?? true,
      autoOffloadBrowser: options.autoOffloadBrowser ?? true,
    }),
    getConnectedNodes: () => options.nodes ?? [],
    getKnownBrowserComputers: () => options.knownBrowserComputers ?? [],
    listTargets: () => options.targets ?? [],
    getProfile: (profileId) => profiles.find((profile) => profile.id === profileId) ?? null,
    getComputerChoices: () => options.choices ?? [],
    balancer: options.balancer ?? new BrowserComputerBalancer(),
    now: () => 1_000,
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
