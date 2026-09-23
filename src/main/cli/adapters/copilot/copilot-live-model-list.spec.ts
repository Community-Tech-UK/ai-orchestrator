import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./copilot-sdk-loader', () => ({
  loadCopilotSdk: vi.fn(() => null),
}));

import { COPILOT_STRIPPED_AUTH_ENV_VARS } from '../adapter-spawn-helpers';
import { listCopilotLiveModelIds, liveCopilotModelIds } from './copilot-live-model-list';
import type { LoadedCopilotSdk } from './copilot-sdk-loader';

interface FakeClient {
  options: Record<string, unknown>;
  start: ReturnType<typeof vi.fn>;
  listModels: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  forceStop: ReturnType<typeof vi.fn>;
}

function fakeSdk(overrides: Partial<Omit<FakeClient, 'options'>> = {}): {
  sdk: LoadedCopilotSdk;
  clients: FakeClient[];
} {
  const clients: FakeClient[] = [];
  const CopilotClient = vi.fn(function (this: FakeClient, options: Record<string, unknown>) {
    this.options = options;
    this.start = overrides.start ?? vi.fn(async () => undefined);
    this.listModels = overrides.listModels ?? vi.fn(async () => []);
    this.stop = overrides.stop ?? vi.fn(async () => []);
    this.forceStop = overrides.forceStop ?? vi.fn(async () => undefined);
    clients.push(this);
  });
  return {
    sdk: {
      CopilotClient: CopilotClient as unknown as LoadedCopilotSdk['CopilotClient'],
      sdkPath: '/pkg/copilot-sdk/index.js',
      packageVersion: '1.0.88',
      cliPath: '/usr/local/bin/copilot',
    },
    clients,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('liveCopilotModelIds', () => {
  it('keeps enabled and policy-less models, drops disabled, unconfigured and malformed entries', () => {
    expect(liveCopilotModelIds([
      { id: 'auto' },
      { id: 'claude-opus-5.5', policy: { state: 'enabled' } },
      { id: 'gpt-6-sol', policy: { state: 'unconfigured' } },
      { id: 'gpt-4.1', policy: { state: 'disabled' } },
      { id: '  ' },
      { name: 'no id' },
      null,
      'gpt-6-luna',
    ])).toEqual(['auto', 'claude-opus-5.5']);
  });
});

describe('listCopilotLiveModelIds', () => {
  it('queries the runtime under the profile home, host and a token-free environment', async () => {
    vi.stubEnv('GH_TOKEN', 'placeholder-token');
    vi.stubEnv('COPILOT_GITHUB_TOKEN', 'placeholder-token');
    const { sdk, clients } = fakeSdk({
      listModels: vi.fn(async () => [
        { id: 'claude-opus-5.5', policy: { state: 'enabled' } },
        { id: 'gpt-6-sol', policy: { state: 'enabled' } },
      ]),
    });

    await expect(listCopilotLiveModelIds({
      homeDir: '/state/copilot-cli-profiles/enterprise',
      host: 'ebrd.ghe.com',
      sdk,
    })).resolves.toEqual(['claude-opus-5.5', 'gpt-6-sol']);

    const [client] = clients;
    expect(client?.options['connection']).toEqual({ kind: 'stdio', path: '/usr/local/bin/copilot' });
    expect(client?.options['baseDirectory']).toBe('/state/copilot-cli-profiles/enterprise');
    const env = client?.options['env'] as Record<string, string | undefined>;
    expect(env['COPILOT_HOME']).toBe('/state/copilot-cli-profiles/enterprise');
    expect(env['COPILOT_GH_HOST']).toBe('ebrd.ghe.com');
    for (const key of COPILOT_STRIPPED_AUTH_ENV_VARS) {
      expect(env).not.toHaveProperty(key);
    }
    expect(client?.start).toHaveBeenCalledOnce();
    expect(client?.stop).toHaveBeenCalledOnce();
    expect(client?.forceStop).not.toHaveBeenCalled();
  });

  it('does not invent a host when the profile has none', async () => {
    const { sdk, clients } = fakeSdk();
    await listCopilotLiveModelIds({ homeDir: '/home', sdk });
    const env = clients[0]?.options['env'] as Record<string, string | undefined>;
    expect(env['COPILOT_GH_HOST']).toBe(process.env['COPILOT_GH_HOST']);
  });

  it('rejects when the bundled SDK is unavailable', async () => {
    await expect(listCopilotLiveModelIds({ homeDir: '/home', sdk: null })).rejects.toThrow(
      'Copilot SDK unavailable',
    );
  });

  it('rejects on an SDK without listModels and still stops the client', async () => {
    const { sdk, clients } = fakeSdk();
    const CopilotClient = sdk.CopilotClient;
    const withoutListModels: LoadedCopilotSdk = {
      ...sdk,
      CopilotClient: function (options?: Record<string, unknown>) {
        const client = new CopilotClient(options) as unknown as Record<string, unknown>;
        delete client['listModels'];
        return client;
      } as unknown as LoadedCopilotSdk['CopilotClient'],
    };

    await expect(listCopilotLiveModelIds({ homeDir: '/home', sdk: withoutListModels })).rejects.toThrow(
      'does not support listing models',
    );
    expect(clients[0]?.stop).toHaveBeenCalledOnce();
  });

  it('stops the client when the request fails', async () => {
    const { sdk, clients } = fakeSdk({
      listModels: vi.fn(async () => {
        throw new Error('403 Forbidden');
      }),
    });
    await expect(listCopilotLiveModelIds({ homeDir: '/home', sdk })).rejects.toThrow('403 Forbidden');
    expect(clients[0]?.stop).toHaveBeenCalledOnce();
  });

  it('times out a wedged runtime and force-stops it', async () => {
    vi.useFakeTimers();
    const { sdk, clients } = fakeSdk({
      listModels: vi.fn(() => new Promise<unknown[]>(() => undefined)),
    });
    const pending = listCopilotLiveModelIds({ homeDir: '/home', sdk, timeoutMs: 50 });
    const assertion = expect(pending).rejects.toThrow('Timeout listing live Copilot models');
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(clients[0]?.forceStop).toHaveBeenCalledOnce();
    expect(clients[0]?.stop).not.toHaveBeenCalled();
  });
});
