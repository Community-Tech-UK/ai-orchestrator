import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CopilotAccountProfile,
  CopilotAccountRoutingRule,
} from '../../../shared/types/copilot-account.types';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
  },
}));

const bindingState = { current: 'authenticated' as string };

vi.mock('../../providers/copilot/copilot-account-binding-service', () => ({
  LOCAL_COPILOT_NODE_ID: 'local',
  getCopilotAccountBindingService: () => ({
    checkBinding: async (profile: CopilotAccountProfile, nodeId = 'local') => ({
      profileId: profile.id,
      nodeId,
      state: bindingState.current,
      checkedAt: 1,
    }),
    invalidate: vi.fn(),
  }),
}));

vi.mock('../../providers/copilot/copilot-account-routing-service', () => ({
  getCopilotAccountRoutingService: () => ({
    resolveRouteForSpawn: async () => ({
      ok: true,
      route: {
        profileId: 'personal',
        source: 'default',
        executionNodeId: 'local',
        profileLabel: 'Personal',
        expectedLogin: 'octocat',
        host: 'github.com',
      },
    }),
  }),
}));

vi.mock('../../providers/copilot/copilot-account-doctor', () => ({
  buildCopilotAccountDoctorReport: async () => ({
    aggregate: 'available',
    nodeId: 'local',
    profiles: [],
    unreachableRuleIds: [],
    conflictingRuleIds: [],
    ambientTokenVariablesPresent: [],
    legacyMigrationInUse: false,
    warnings: [],
  }),
}));

vi.mock('../../vcs/remotes/github-remote-identity', () => ({
  collectFetchRemoteIdentities: () => [
    {
      remoteName: 'origin',
      host: 'github.com',
      owner: 'octocat',
      repo: 'hello-world',
      displayPath: 'octocat/hello-world',
    },
  ],
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { IPC_CHANNELS } from '@contracts/channels';
import type { CopilotAccountStore } from '../../providers/copilot/copilot-account-store';
import {
  assertNoPathOrSecret,
  registerCopilotAccountHandlers,
} from './copilot-account-handlers';

interface IpcResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

const profile: CopilotAccountProfile = {
  id: 'personal',
  label: 'Personal',
  expectedLogin: 'octocat',
  host: 'github.com',
  accountKind: 'personal',
  scopePolicy: 'default-eligible',
  automationPolicy: 'allow-routed',
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
};

const rule: CopilotAccountRoutingRule = {
  id: 'rule-1',
  profileId: 'personal',
  matcher: { type: 'owner', host: 'github.com', owner: 'octocat' },
  isProtected: false,
  createdAt: 1,
  updatedAt: 1,
};

const storeSpies = {
  removeProfile: vi.fn(),
  createProfile: vi.fn(() => profile),
  createRule: vi.fn(() => rule),
  removeRule: vi.fn(),
};

function fakeStore(): CopilotAccountStore {
  return {
    listProfiles: () => [profile],
    listRules: () => [rule],
    createProfile: storeSpies.createProfile,
    renameProfile: (_id: string, label: string) => ({ ...profile, label }),
    updatePolicy: () => profile,
    setDefault: () => profile,
    adoptObservedIdentity: (_id: string, observed: { login: string }) => ({
      ...profile,
      expectedLogin: observed.login,
    }),
    removeProfile: storeSpies.removeProfile,
    createRule: storeSpies.createRule,
    removeRule: storeSpies.removeRule,
  } as unknown as CopilotAccountStore;
}

async function invoke(channel: string, payload?: unknown): Promise<IpcResult> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return (await handler({}, payload)) as IpcResult;
}

beforeEach(() => {
  handlers.clear();
  bindingState.current = 'authenticated';
  for (const spy of Object.values(storeSpies)) spy.mockClear();
});

describe('Copilot account IPC — schema rejection', () => {
  beforeEach(() => registerCopilotAccountHandlers({ store: fakeStore() }));

  it('rejects a profile ID that could escape a directory', async () => {
    for (const profileId of ['../escape', 'a/b', 'Upper', '/etc/passwd', '']) {
      const result = await invoke(IPC_CHANNELS.COPILOT_ACCOUNT_VERIFY_BINDING, { profileId });
      expect(result.success, profileId).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_FAILED');
    }
  });

  it('rejects a non-exact host on rule creation', async () => {
    const result = await invoke(IPC_CHANNELS.COPILOT_ACCOUNT_RULE_CREATE, {
      profileId: 'personal',
      matcher: { type: 'owner', host: 'GitHub.com', owner: 'octocat' },
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a path-prefix rule containing traversal', async () => {
    const result = await invoke(IPC_CHANNELS.COPILOT_ACCOUNT_RULE_CREATE, {
      profileId: 'personal',
      matcher: { type: 'path-prefix', canonicalPath: '/work/../../etc' },
    });
    expect(result.success).toBe(false);
    expect(storeSpies.createRule).not.toHaveBeenCalled();
  });

  it('rejects unknown fields — a path or env map cannot ride along', async () => {
    const result = await invoke(IPC_CHANNELS.COPILOT_ACCOUNT_CREATE, {
      label: 'Enterprise',
      accountKind: 'enterprise',
      copilotHome: '/tmp/attacker-controlled',
    });
    expect(result.success).toBe(false);
    expect(storeSpies.createProfile).not.toHaveBeenCalled();
  });
});

describe('Copilot account IPC — removal guard', () => {
  it('refuses removal while a live session uses the profile', async () => {
    registerCopilotAccountHandlers({
      store: fakeStore(),
      profilesInUse: () => ['personal'],
    });
    const result = await invoke(IPC_CHANNELS.COPILOT_ACCOUNT_REMOVE, { profileId: 'personal' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('COPILOT_ACCOUNT_IN_USE');
    expect(storeSpies.removeProfile).not.toHaveBeenCalled();
  });

  it('allows removal when no session holds it', async () => {
    registerCopilotAccountHandlers({ store: fakeStore(), profilesInUse: () => [] });
    const result = await invoke(IPC_CHANNELS.COPILOT_ACCOUNT_REMOVE, { profileId: 'personal' });
    expect(result.success).toBe(true);
    expect(storeSpies.removeProfile).toHaveBeenCalledWith('personal');
  });
});

describe('Copilot account IPC — response safety', () => {
  beforeEach(() => registerCopilotAccountHandlers({ store: fakeStore() }));

  it('returns bounded identity metadata and no filesystem path', async () => {
    const result = await invoke(IPC_CHANNELS.COPILOT_ACCOUNT_LIST, {});
    expect(result.success).toBe(true);
    const [entry] = (result.data as { profiles: Record<string, unknown>[] }).profiles;
    expect(entry).toMatchObject({
      id: 'personal',
      label: 'Personal',
      expectedLogin: 'octocat',
      host: 'github.com',
      binding: { state: 'authenticated' },
    });
    expect(JSON.stringify(result.data)).not.toMatch(/\/(Users|home|var|tmp)\//);
  });

  it('blocks any response that would carry a path or a secret-shaped value', () => {
    for (const unsafe of [
      { success: true, data: { home: '/Users/me/copilot-cli-profiles/personal' } },
      { success: true, data: { home: 'C:\\Users\\me\\profiles' } },
      { success: true, data: { copilotTokens: { 'github.com:octocat': 'x' } } },
      { success: true, data: { token: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAA' } },
    ]) {
      const guarded = assertNoPathOrSecret(unsafe);
      expect(guarded.success, JSON.stringify(unsafe)).toBe(false);
      expect(guarded.error?.code).toBe('COPILOT_ACCOUNT_UNSAFE_RESPONSE');
    }
  });

  it('lets ordinary safe payloads through', () => {
    const safe = { success: true, data: { profiles: [{ id: 'personal', host: 'github.com' }] } };
    expect(assertNoPathOrSecret(safe)).toBe(safe);
  });

  it('previews a route without leaking the workspace path back', async () => {
    const result = await invoke(IPC_CHANNELS.COPILOT_ACCOUNT_PREVIEW_ROUTE, {
      workingDirectory: '/Users/me/work/repo',
    });
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain('/Users/me/work/repo');
  });

  it('suggests rules from the workspace remotes', async () => {
    const result = await invoke(IPC_CHANNELS.COPILOT_ACCOUNT_SUGGEST_RULES, {
      workingDirectory: '/Users/me/work/repo',
    });
    expect(result.success).toBe(true);
    expect((result.data as { remotes: unknown[] }).remotes).toHaveLength(1);
  });

  it('reports a profile-by-node matrix without guessing a remote node state', async () => {
    registerCopilotAccountHandlers({ store: fakeStore(), listNodeIds: () => ['worker-1'] });
    const result = await invoke(IPC_CHANNELS.COPILOT_ACCOUNT_NODE_MATRIX, {});
    const data = result.data as {
      nodeIds: string[];
      rows: { nodes: { nodeId: string; state: string }[] }[];
    };
    expect(data.nodeIds).toEqual(['local', 'worker-1']);
    // The controller cannot read a worker's Copilot home, so it reports
    // unavailable rather than assuming its own state applies there.
    expect(data.rows[0].nodes.find((node) => node.nodeId === 'worker-1')?.state).toBe(
      'unavailable',
    );
  });
});
