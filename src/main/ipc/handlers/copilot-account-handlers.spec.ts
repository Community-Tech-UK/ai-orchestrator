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

/**
 * Regression cover for LT-522.
 *
 * Every one of these channels is reached through `createCopilotAccountDomain`,
 * which the preload constructs WITH `withAuth` — so the payload main actually
 * receives always carries an `ipcAuthToken` key. The payload schemas are
 * `.strict()`, and originally did not declare it, so all fifteen channels
 * rejected every real renderer call while this spec (which sent bare payloads)
 * stayed green. These tests send what the preload sends.
 */
describe('Copilot account IPC — accepts the preload auth stamp (LT-522)', () => {
  beforeEach(() => registerCopilotAccountHandlers({ store: fakeStore() }));

  // Mirrors withAuth() in src/preload/preload.ts: the key is ALWAYS present,
  // and is `undefined` until a token has been issued. An `undefined` value
  // still counts as an own key, which is what `.strict()` refuses.
  const withAuth = (
    payload: Record<string, unknown> = {},
    token: string | null = null,
  ): Record<string, unknown> => ({ ...payload, ipcAuthToken: token || undefined });

  const channelPayloads: Array<[string, Record<string, unknown>]> = [
    [IPC_CHANNELS.COPILOT_ACCOUNT_LIST, {}],
    [IPC_CHANNELS.COPILOT_ACCOUNT_CREATE, { label: 'Enterprise', accountKind: 'enterprise' }],
    [IPC_CHANNELS.COPILOT_ACCOUNT_RENAME, { profileId: 'personal', label: 'Renamed' }],
    [IPC_CHANNELS.COPILOT_ACCOUNT_UPDATE_POLICY, { profileId: 'personal', scopePolicy: 'matched-only' }],
    [IPC_CHANNELS.COPILOT_ACCOUNT_REMOVE, { profileId: 'personal' }],
    [IPC_CHANNELS.COPILOT_ACCOUNT_SET_DEFAULT, { profileId: 'personal' }],
    [IPC_CHANNELS.COPILOT_ACCOUNT_VERIFY_BINDING, { profileId: 'personal' }],
    [IPC_CHANNELS.COPILOT_ACCOUNT_ADOPT_IDENTITY, { profileId: 'personal', login: 'octocat' }],
    [IPC_CHANNELS.COPILOT_ACCOUNT_RULE_LIST, {}],
    [
      IPC_CHANNELS.COPILOT_ACCOUNT_RULE_CREATE,
      { profileId: 'personal', matcher: { type: 'owner', host: 'github.com', owner: 'octocat' } },
    ],
    [IPC_CHANNELS.COPILOT_ACCOUNT_RULE_REMOVE, { ruleId: 'rule-1' }],
    [IPC_CHANNELS.COPILOT_ACCOUNT_PREVIEW_ROUTE, { workingDirectory: '/Users/me/work/repo' }],
    [IPC_CHANNELS.COPILOT_ACCOUNT_SUGGEST_RULES, { workingDirectory: '/Users/me/work/repo' }],
    [IPC_CHANNELS.COPILOT_ACCOUNT_NODE_MATRIX, {}],
    [IPC_CHANNELS.COPILOT_ACCOUNT_DIAGNOSTICS, {}],
  ];

  it('covers every channel the preload domain exposes', () => {
    // Guards against a new channel being added without auth-stamp cover.
    expect(channelPayloads).toHaveLength(15);
  });

  it.each(channelPayloads)(
    'accepts an auth-stamped payload on %s (token not yet issued)',
    async (channel, payload) => {
      const result = await invoke(channel, withAuth(payload));
      expect(result.error?.code, `${channel}: ${result.error?.message}`).not.toBe('VALIDATION_FAILED');
      expect(result.success, `${channel}: ${result.error?.message}`).toBe(true);
    },
  );

  it.each(channelPayloads)(
    'accepts an auth-stamped payload on %s (token issued)',
    async (channel, payload) => {
      const result = await invoke(channel, withAuth(payload, 'issued-token'));
      expect(result.error?.code, `${channel}: ${result.error?.message}`).not.toBe('VALIDATION_FAILED');
      expect(result.success, `${channel}: ${result.error?.message}`).toBe(true);
    },
  );

  // The fix must not have traded strictness away: admitting the auth stamp is
  // not the same as admitting arbitrary keys, and these are exactly the keys
  // the schema header says must never cross.
  it('still rejects an unexpected key alongside the auth stamp', async () => {
    for (const rogue of [{ copilotHome: '/tmp' }, { env: { GITHUB_TOKEN: 'x' } }, { configPath: '/tmp/c' }]) {
      const result = await invoke(
        IPC_CHANNELS.COPILOT_ACCOUNT_PREVIEW_ROUTE,
        withAuth({ workingDirectory: '/Users/me/work/repo', ...rogue }, 'issued-token'),
      );
      expect(result.success, JSON.stringify(rogue)).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_FAILED');
    }
  });

  it('still rejects a non-string auth stamp', async () => {
    const result = await invoke(IPC_CHANNELS.COPILOT_ACCOUNT_LIST, { ipcAuthToken: { evil: true } });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
  });
});
