import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { defaultProviderAccountPools } from '../../../shared/types/provider-account.types';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }>>();

const copied = vi.hoisted(() => [] as string[]);
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => Promise<never>) => {
      handlers.set(channel, fn);
    },
  },
  clipboard: { writeText: (text: string) => { copied.push(text); } },
}));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
const bindingState = vi.hoisted(() => ({ state: 'authenticated', observedIdentity: 'b@example.com' as string | undefined }));
vi.mock('../../providers/account-pool/provider-account-binding-service', () => ({
  getProviderAccountBindingService: () => ({
    checkBinding: async (profile: ProviderAccountProfile) => ({
      provider: profile.provider, profileId: profile.id, nodeId: 'local', state: bindingState.state,
      checkedAt: 1, ...(bindingState.observedIdentity ? { observedIdentity: bindingState.observedIdentity } : {}),
    }),
    invalidate: vi.fn(),
    rememberObservedIdentity: vi.fn(),
  }),
}));
const launched = vi.hoisted(() => [] as unknown[]);
const LOGIN_COMMAND = "CLAUDE_CONFIG_DIR='/state/claude-cli-profiles/max-b' claude auth login";
vi.mock('../../providers/provider-login-launcher', () => ({
  copyAccountProfileLoginCommand: (_request: unknown, writeText: (text: string) => void) => {
    writeText(LOGIN_COMMAND);
    return { hint: 'Sign in' };
  },
  launchProviderLogin: async (...args: unknown[]) => {
    launched.push(args);
    return { provider: 'claude', command: LOGIN_COMMAND, terminal: 'Terminal', hint: 'Sign in' };
  },
}));
vi.mock('../../providers/account-pool/codex-account-probe', () => ({ probeCodexAccount: vi.fn() }));
vi.mock('../../providers/account-pool/provider-account-doctor', () => ({ buildProviderAccountDoctorReport: vi.fn() }));
const previewRequests = vi.hoisted(() => [] as unknown[]);
vi.mock('../../providers/account-pool/provider-account-routing-service', () => ({
  getProviderAccountRoutingService: () => ({
    preview: async (request: unknown) => {
      previewRequests.push(request);
      return { outcome: { ok: true, route: { provider: 'claude', profileId: 'legacy', source: 'legacy', executionNodeId: 'local' } }, considered: [] };
    },
  }),
}));

import { IPC_CHANNELS } from '@contracts/channels';
import { assertNoAccountPathOrSecret, registerProviderAccountHandlers } from './provider-account-handlers';
import { ProviderAccountStore } from '../../providers/account-pool/provider-account-store';

function legacy(provider: 'claude' | 'codex'): ProviderAccountProfile {
  return {
    id: 'legacy', provider, label: `Existing ${provider}`, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    priority: 0, enabled: true, automationPolicy: 'allow-routed', isLegacy: true, createdAt: 1, updatedAt: 1,
  };
}

let state: { profiles: ProviderAccountProfile[]; pools: ReturnType<typeof defaultProviderAccountPools> };
const requestRuntimeChange = vi.fn(async () => undefined);
const token = { ipcAuthToken: 'renderer-token' };

beforeEach(() => {
  handlers.clear();
  launched.length = 0;
  copied.length = 0;
  previewRequests.length = 0;
  requestRuntimeChange.mockClear();
  bindingState.state = 'authenticated';
  state = { profiles: [legacy('claude'), legacy('codex')], pools: defaultProviderAccountPools() };
  const store = new ProviderAccountStore({
    read: () => ({ profiles: state.profiles, pools: state.pools }),
    write: (update) => {
      if (update.profiles) state.profiles = update.profiles;
      if (update.pools) state.pools = update.pools;
    },
    randomSuffix: () => 'ab12',
  });
  registerProviderAccountHandlers({
    store,
    getInstances: () => [{ id: 'inst-1', provider: 'claude', status: 'idle', accountProfileId: 'max-b-ab12' }],
    requestRuntimeChange,
  });
});

async function call(channel: string, payload: unknown) {
  return handlers.get(channel)!({}, payload);
}

describe('provider-account IPC handlers', () => {
  it('accepts the preload auth token and lists profiles with bindings and pools', async () => {
    const response = await call(IPC_CHANNELS.PROVIDER_ACCOUNT_LIST, { ...token });
    expect(response.success).toBe(true);
    expect((response.data as { profiles: unknown[] }).profiles).toHaveLength(2);
  });

  it('creates, verifies (adopting the first identity) and refuses removal while in use', async () => {
    const created = await call(IPC_CHANNELS.PROVIDER_ACCOUNT_CREATE, { ...token, provider: 'claude', label: 'Max B' });
    expect(created).toMatchObject({ success: true, data: { id: 'max-b-ab12', enabled: false } });
    const verified = await call(IPC_CHANNELS.PROVIDER_ACCOUNT_VERIFY, { ...token, provider: 'claude', profileId: 'max-b-ab12' });
    expect(verified).toMatchObject({ success: true, data: { expectedIdentity: 'b@example.com', binding: { state: 'authenticated' } } });
    const removal = await call(IPC_CHANNELS.PROVIDER_ACCOUNT_REMOVE, { ...token, provider: 'claude', profileId: 'max-b-ab12' });
    expect(removal).toMatchObject({ success: false, error: { message: expect.stringMatching(/in use/) } });
  });

  it('copies the login command and does not open a terminal by default', async () => {
    await call(IPC_CHANNELS.PROVIDER_ACCOUNT_CREATE, { ...token, provider: 'claude', label: 'Max B' });
    const response = await call(IPC_CHANNELS.PROVIDER_ACCOUNT_LAUNCH_LOGIN, { ...token, provider: 'claude', profileId: 'max-b-ab12' });
    expect(response).toEqual({ success: true, data: { copied: true, openedTerminal: false, hint: 'Sign in' } });
    expect(copied).toEqual([LOGIN_COMMAND]);
    expect(launched).toEqual([]);
    expect(JSON.stringify(response)).not.toContain('claude-cli-profiles');
  });

  it('opens a Harness terminal only when asked, still without returning the command', async () => {
    await call(IPC_CHANNELS.PROVIDER_ACCOUNT_CREATE, { ...token, provider: 'claude', label: 'Max B' });
    const response = await call(IPC_CHANNELS.PROVIDER_ACCOUNT_LAUNCH_LOGIN, {
      ...token, provider: 'claude', profileId: 'max-b-ab12', openTerminal: true,
    });
    expect(response).toEqual({ success: true, data: { copied: true, openedTerminal: true, terminal: 'Terminal', hint: 'Sign in' } });
    expect(launched[0]).toEqual(['claude', undefined, { provider: 'claude', profileId: 'max-b-ab12' }]);
    expect(JSON.stringify(response)).not.toContain('claude-cli-profiles');
  });

  it('acknowledges ownership and updates pool policy', async () => {
    const ack = await call(IPC_CHANNELS.PROVIDER_ACCOUNT_ACKNOWLEDGE_OWNERSHIP, { ...token, provider: 'codex', acknowledged: true });
    expect(ack).toMatchObject({ success: true, data: { failoverMode: 'automatic' } });
    const update = await call(IPC_CHANNELS.PROVIDER_ACCOUNT_POOL_UPDATE, { ...token, provider: 'codex', continuation: 'replay', preemptive: { thresholdPct: 80 } });
    expect(update).toMatchObject({ success: true, data: { continuation: 'replay', preemptive: { thresholdPct: 80, newSessions: true } } });
  });

  it('requests an explicit confirmed handoff for a session switch', async () => {
    await call(IPC_CHANNELS.PROVIDER_ACCOUNT_CREATE, { ...token, provider: 'claude', label: 'Max B' });
    await call(IPC_CHANNELS.PROVIDER_ACCOUNT_ACKNOWLEDGE_OWNERSHIP, { ...token, provider: 'claude', acknowledged: true });
    await call(IPC_CHANNELS.PROVIDER_ACCOUNT_UPDATE, { ...token, provider: 'claude', profileId: 'max-b-ab12', enabled: true });
    const response = await call(IPC_CHANNELS.PROVIDER_ACCOUNT_SWITCH_SESSION, { ...token, instanceId: 'inst-1', profileId: 'legacy', confirmed: true });
    expect(response.success).toBe(true);
    expect(requestRuntimeChange).toHaveBeenCalledWith('inst-1', {
      provider: 'claude', accountProfileId: 'legacy', accountHandoffKind: 'explicit', accountHandoffConfirmed: true,
    });
  });

  it('previews the route for the draft model and target worker node', async () => {
    const response = await call(IPC_CHANNELS.PROVIDER_ACCOUNT_RESOLVE_PREVIEW, {
      ...token, provider: 'claude', model: 'opus', executionNodeId: 'node-1',
    });
    expect(response.success).toBe(true);
    expect(previewRequests).toEqual([{ provider: 'claude', model: 'opus', executionNodeId: 'node-1', origin: 'interactive' }]);
  });

  it('rejects payloads carrying paths or unknown fields', async () => {
    const response = await call(IPC_CHANNELS.PROVIDER_ACCOUNT_CREATE, { ...token, provider: 'claude', label: 'X', home: '/tmp' });
    expect(response).toMatchObject({ success: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('gates responses that would leak a profile home or token shape', () => {
    expect(assertNoAccountPathOrSecret({ success: true, data: { x: '/u/claude-cli-profiles/a' } }).success).toBe(false);
    expect(assertNoAccountPathOrSecret({ success: false, error: { code: 'e', message: 'refresh_token rejected', timestamp: 1 } }).success).toBe(false);
    expect(assertNoAccountPathOrSecret({ success: true, data: { label: 'Max / Work' } }).success).toBe(true);
  });
});
