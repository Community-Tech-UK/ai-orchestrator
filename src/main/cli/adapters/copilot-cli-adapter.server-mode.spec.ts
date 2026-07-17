/**
 * WS14 — Copilot adapter dual mode: SDK server session preferred, exec
 * fallback preserved verbatim (the guardrail: server mode is additive).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const loadCopilotSdkMock = vi.hoisted(() => vi.fn());
vi.mock('./copilot/copilot-sdk-loader', () => ({
  loadCopilotSdk: loadCopilotSdkMock,
}));

const serverStartMock = vi.hoisted(() => vi.fn());
vi.mock('./copilot/copilot-server-session', () => ({
  CopilotServerSession: { start: serverStartMock },
}));

import { CopilotCliAdapter } from './copilot-cli-adapter';

const FAKE_SDK = {
  CopilotClient: class {},
  sdkPath: '/fake/copilot-sdk/index.js',
  packageVersion: '1.0.99',
  cliPath: '/fake/bin/copilot',
};

function makeFakeServerSession(overrides: Record<string, unknown> = {}) {
  return {
    copilotSessionId: 'cop-sess-9',
    send: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function spawnAdapter(adapter: CopilotCliAdapter): Promise<void> {
  vi.spyOn(adapter, 'checkStatus').mockResolvedValue({ available: true, version: '1.0.99' });
  await adapter.spawn();
}

describe('CopilotCliAdapter server mode', () => {
  beforeEach(() => {
    loadCopilotSdkMock.mockReset();
    serverStartMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stays in exec mode when the bundled SDK is unavailable (fallback regression)', async () => {
    loadCopilotSdkMock.mockReturnValue(null);
    const adapter = new CopilotCliAdapter({});
    await spawnAdapter(adapter);

    expect(serverStartMock).not.toHaveBeenCalled();
    expect(adapter.getAdapterCapabilities()).toEqual({
      residentSession: false,
      liveInterrupt: false,
      liveSteer: false,
    });
    expect(adapter.getSpawnMode()).toBe('subprocess-stream');
  });

  it('opens a server session, captures the Copilot session id, and advertises resident capabilities', async () => {
    loadCopilotSdkMock.mockReturnValue(FAKE_SDK);
    const session = makeFakeServerSession();
    serverStartMock.mockResolvedValue(session);

    const adapter = new CopilotCliAdapter({ workingDir: '/repo', model: 'gpt-5.5', systemPrompt: 'Be terse.' });
    await spawnAdapter(adapter);

    expect(serverStartMock).toHaveBeenCalledWith(expect.objectContaining({
      sdk: FAKE_SDK,
      workingDirectory: '/repo',
      model: 'gpt-5.5',
    }));
    expect(adapter.getCopilotSessionId()).toBe('cop-sess-9');
    expect(adapter.getSpawnMode()).toBe('app-server');
    expect(adapter.getAdapterCapabilities()).toEqual({
      residentSession: true,
      liveInterrupt: true,
      liveSteer: false,
    });
  });

  it('omits the model for auto routing and approves permissions (exec-posture parity)', async () => {
    loadCopilotSdkMock.mockReturnValue(FAKE_SDK);
    serverStartMock.mockResolvedValue(makeFakeServerSession());
    const adapter = new CopilotCliAdapter({ model: 'auto' });
    await spawnAdapter(adapter);

    const params = serverStartMock.mock.calls[0][0];
    expect(params.model).toBeUndefined();
    await expect(params.onPermissionRequest({ kind: 'write' })).resolves.toEqual({ kind: 'approved' });
  });

  it('routes sendInput through the server session with the system prompt prefixed', async () => {
    loadCopilotSdkMock.mockReturnValue(FAKE_SDK);
    const session = makeFakeServerSession();
    serverStartMock.mockResolvedValue(session);
    const adapter = new CopilotCliAdapter({ systemPrompt: 'Be terse.' });
    await spawnAdapter(adapter);

    const statuses: string[] = [];
    adapter.on('status', (s: string) => statuses.push(s));
    await adapter.sendInput('hello there');

    expect(session.send).toHaveBeenCalledWith('Be terse.\n\nhello there');
    // busy on submit; idle arrives later via the session.idle effect.
    expect(statuses).toContain('busy');
    expect(statuses).not.toContain('idle');
  });

  it('interrupt aborts the in-flight turn and resolves interrupted', async () => {
    loadCopilotSdkMock.mockReturnValue(FAKE_SDK);
    const session = makeFakeServerSession();
    serverStartMock.mockResolvedValue(session);
    const adapter = new CopilotCliAdapter({});
    await spawnAdapter(adapter);

    const result = adapter.interrupt();
    expect(result.status).toBe('accepted');
    await expect(result.completion).resolves.toEqual({ status: 'interrupted' });
    expect(session.abort).toHaveBeenCalled();
  });

  it('terminate disposes the server session', async () => {
    loadCopilotSdkMock.mockReturnValue(FAKE_SDK);
    const session = makeFakeServerSession();
    serverStartMock.mockResolvedValue(session);
    const adapter = new CopilotCliAdapter({});
    await spawnAdapter(adapter);

    await adapter.terminate();
    expect(session.dispose).toHaveBeenCalled();
    // Post-terminate, capabilities revert to the exec posture.
    expect(adapter.getAdapterCapabilities().residentSession).toBe(false);
  });

  it('falls back to exec mode (degraded) when the server session fails to start', async () => {
    loadCopilotSdkMock.mockReturnValue(FAKE_SDK);
    serverStartMock.mockRejectedValue(new Error('runtime refused'));
    const adapter = new CopilotCliAdapter({});
    await spawnAdapter(adapter);

    expect(adapter.getSpawnMode()).toBe('subprocess-exec');
    expect(adapter.getAdapterCapabilities().residentSession).toBe(false);
  });
});
