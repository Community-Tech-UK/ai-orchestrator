import { EventEmitter } from 'node:events';
import { spawn as nativeSpawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexDeviceLoginService, type CodexDeviceLoginChild } from './codex-device-login';
import { prepareCodexDeviceLoginHome, codexDeviceLoginSpawnOptions, spawnCodexDeviceLogin } from './codex-device-login-runtime';

const roots = vi.hoisted(() => ({ current: '' }));
vi.mock('node:child_process', async (load) => ({
  ...await load<typeof import('node:child_process')>(), spawn: vi.fn(),
}));
vi.mock('../../cli/adapters/adapter-spawn-helpers', async (load) => ({
  ...await load<typeof import('../../cli/adapters/adapter-spawn-helpers')>(),
  getProviderStateRoot: () => roots.current,
}));

const owner = { sessionId: 'test-session', generation: 'test-generation' };
const identity = 'approved@example.invalid';
const binding = {
  browserNodeId: 'test-browser', profileId: 'test-browser-profile', targetId: 'test-tab',
  origin: 'https://auth.openai.com', documentId: 'test-document',
  extensionInstanceId: 'test-installation', extensionGeneration: 'test-extension', approvalId: 'test-approval', expectedIdentity: identity,
};
// Obvious synthetic placeholder, never a real provider code.
const prompt = '\n1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   TEST-CODEX\n';

class Child extends EventEmitter implements CodexDeviceLoginChild {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() { this.killed = true; return true; }
}

function harness() {
  const child = new Child();
  const deliver = vi.fn(async (_code: string, _binding: typeof binding, _signal: AbortSignal): Promise<void> => undefined);
  const probe = vi.fn(async (_home: string, _signal: AbortSignal) => identity);
  const authorize = vi.fn(() => true);
  const service = new CodexDeviceLoginService({
    expectedIdentity: identity, nodeId: 'test-native',
    prepareHome: prepareCodexDeviceLoginHome, spawn: () => child,
    probeIdentity: probe, authorizeHandoff: authorize, deliver,
  });
  const start = () => service.start({ profileId: 'fresh', expectedIdentity: identity }, owner);
  return { child, deliver, probe, authorize, service, start };
}

beforeEach(() => {
  roots.current = mkdtempSync(join(tmpdir(), 'codex-device-login-test-'));
  vi.mocked(nativeSpawn).mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(roots.current, { recursive: true, force: true }); });

describe('owned Codex device login', () => {
  it('counts owned active children for worker restart protection', () => {
    const h = harness();
    const view = h.start();
    expect(h.service.activeCount()).toBe(1);
    h.service.cancel(view.handle, owner);
    expect(h.service.activeCount()).toBe(0);
  });
  it('keeps split CLI output private and delivers once only to the approved binding', async () => {
    const h = harness();
    try {
      const view = h.start();
      h.child.stdout.write(prompt.slice(0, 90));
      expect(h.service.read(view.handle, owner).state).toBe('starting');
      h.child.stdout.write(prompt.slice(90));
      expect(h.service.read(view.handle, owner).state).toBe('awaiting_handoff');
      const reservation = h.service.reserveHandoff(view.handle, owner, binding);
      await expect(h.service.deliverHandoff(reservation, owner, { ...binding, targetId: 'other' })).rejects.toThrow('handoff_binding_mismatch');
      await h.service.deliverHandoff(reservation, owner, binding);
      expect(h.deliver).toHaveBeenCalledWith('TEST-CODEX', { ...binding, operationHandle: view.handle, expiresAt: view.expiresAt }, expect.any(AbortSignal));
      await expect(h.service.deliverHandoff(reservation, owner, binding)).rejects.toThrow('handoff_unavailable');
      h.child.emit('close', 0);
      await vi.waitFor(() => expect(h.service.read(view.handle, owner).state).toBe('authenticated'));
      const serialized = JSON.stringify(h.service.read(view.handle, owner));
      expect(serialized).not.toContain('TEST');
      expect(serialized).not.toContain(roots.current);
    } finally { h.service.shutdown(); }
  });

  it('refuses wrong identity, owner, duplicate profile and approval revocation', async () => {
    const h = harness();
    try {
      expect(() => h.service.start({ profileId: 'fresh', expectedIdentity: 'wrong@example.invalid' }, owner)).toThrow('identity_not_authorized');
      const view = h.start();
      expect(() => h.service.read(view.handle, { ...owner, generation: 'other' })).toThrow('operation_not_owned');
      expect(() => h.start()).toThrow('profile_in_use');
      h.child.stdout.write(prompt);
      const reservation = h.service.reserveHandoff(view.handle, owner, binding);
      h.authorize.mockImplementation(() => { throw new Error('untrusted details'); });
      await expect(h.service.deliverHandoff(reservation, owner, binding)).rejects.toThrow('handoff_not_authorized');
      expect(h.deliver).not.toHaveBeenCalled();
    } finally { h.service.shutdown(); }
  });

  it.each(['cancel', 'expiry', 'shutdown'] as const)('stops the owned child and invalidates reservations on %s', async (action) => {
    vi.useFakeTimers();
    const h = harness();
    const view = h.start();
    h.child.stdout.write(prompt);
    const reservation = h.service.reserveHandoff(view.handle, owner, binding);
    if (action === 'cancel') h.service.cancel(view.handle, owner);
    if (action === 'expiry') await vi.advanceTimersByTimeAsync(300_001);
    if (action === 'shutdown') h.service.shutdown();
    expect(h.child.killed).toBe(true);
    await expect(h.service.deliverHandoff(reservation, owner, binding)).rejects.toThrow('handoff_unavailable');
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it.each(['overflow', 'origin', 'exit', 'error'] as const)('contains %s failure and never returns CLI text', (failure) => {
    const h = harness();
    try {
      const view = h.start();
      if (failure === 'overflow') h.child.stderr.write('PRIVATE_PLACEHOLDER'.repeat(5000));
      if (failure === 'origin') h.child.stdout.write(prompt.replace('auth.openai.com', 'wrong.example.invalid'));
      if (failure === 'exit') h.child.emit('close', 1);
      if (failure === 'error') h.child.emit('error', new Error('PRIVATE_PLACEHOLDER'));
      expect(h.service.read(view.handle, owner).state).toBe('failed');
      expect(JSON.stringify(h.service.read(view.handle, owner))).not.toContain('PRIVATE_PLACEHOLDER');
    } finally { h.service.shutdown(); }
  });

  it('fails identity mismatch after native completion without deleting credentials', async () => {
    const h = harness();
    try {
      const view = h.start();
      const auth = join(roots.current, 'codex-cli-profiles', 'fresh', 'auth.json');
      h.child.stdout.write(prompt);
      await h.service.deliverHandoff(h.service.reserveHandoff(view.handle, owner, binding), owner, binding);
      writeFileSync(auth, 'PLACEHOLDER_AUTH');
      h.probe.mockResolvedValue('wrong@example.invalid');
      h.child.emit('close', 0);
      await vi.waitFor(() => expect(h.service.read(view.handle, owner)).toMatchObject({ state: 'failed', error: 'identity_mismatch' }));
      expect(readFileSync(auth, 'utf8')).toBe('PLACEHOLDER_AUTH');
    } finally { h.service.shutdown(); }
  });

  it('aborts an in-progress delivery and ignores its late success after cancellation', async () => {
    const h = harness();
    let finish!: () => void;
    h.deliver.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const view = h.start();
    h.child.stdout.write(prompt);
    const pending = h.service.deliverHandoff(h.service.reserveHandoff(view.handle, owner, binding), owner, binding);
    h.service.cancel(view.handle, owner);
    expect(h.deliver.mock.calls[0][2].aborted).toBe(true);
    finish();
    await expect(pending).rejects.toThrow('operation_inactive');
    expect(h.service.read(view.handle, owner).state).toBe('cancelled');
  });

  it('settles a cancelled handoff even when its driver never settles', async () => {
    const h = harness();
    h.deliver.mockImplementation(() => new Promise<void>(() => undefined));
    const view = h.start();
    h.child.stdout.write(prompt);
    const pending = h.service.deliverHandoff(h.service.reserveHandoff(view.handle, owner, binding), owner, binding);
    h.service.cancel(view.handle, owner);
    await expect(pending).rejects.toThrow('operation_inactive');
  });

  it.each(['documentId', 'extensionInstanceId'])('refuses bindings missing %s even if an authority accidentally accepts them', (key) => {
    const h = harness();
    try {
      const view = h.start();
      h.child.stdout.write(prompt);
      const incomplete = { ...binding };
      Reflect.deleteProperty(incomplete, key);
      expect(() => h.service.reserveHandoff(view.handle, owner, incomplete)).toThrow('handoff_not_authorized');
    } finally { h.service.shutdown(); }
  });

  it('fails unknown prompt framing after a bounded wait and does not expose it', async () => {
    vi.useFakeTimers();
    const h = harness();
    const view = h.start();
    h.child.stdout.write('UNKNOWN_PRIVATE_PLACEHOLDER');
    await vi.advanceTimersByTimeAsync(15_001);
    expect(h.service.read(view.handle, owner)).toMatchObject({ state: 'failed', error: 'unsupported_login_output' });
    expect(h.child.killed).toBe(true);
  });

  it('cannot authenticate on an unsolicited successful child exit', () => {
    const h = harness();
    const view = h.start();
    h.child.emit('close', 0);
    expect(h.service.read(view.handle, owner)).toMatchObject({ state: 'failed', error: 'unapproved_completion' });
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('cancels the native identity probe and cannot adopt a late successful identity', async () => {
    const h = harness();
    let finishProbe!: (email: string) => void;
    h.probe.mockImplementation(() => new Promise<string>((resolve) => { finishProbe = resolve; }));
    const view = h.start();
    h.child.stdout.write(prompt);
    await h.service.deliverHandoff(h.service.reserveHandoff(view.handle, owner, binding), owner, binding);
    h.child.emit('close', 0);
    h.service.cancel(view.handle, owner);
    expect(h.probe.mock.calls[0][1]?.aborted).toBe(true);
    finishProbe(identity);
    await Promise.resolve();
    expect(h.service.read(view.handle, owner).state).toBe('cancelled');
  });

  it('does not extend a shorter provider expiry by the time spent receiving its prompt', async () => {
    vi.useFakeTimers();
    const h = harness();
    const view = h.start();
    await vi.advanceTimersByTimeAsync(10_000);
    h.child.stdout.write(prompt.replace('15 minutes', '1 minutes'));
    await vi.advanceTimersByTimeAsync(50_001);
    expect(h.service.read(view.handle, owner).state).toBe('expired');
    h.service.shutdown();
  });

  it('reports failure to stop the child without adopting its late completion', () => {
    const h = harness();
    const view = h.start();
    h.child.kill = () => false;
    expect(h.service.cancel(view.handle, owner).error).toBe('login_cleanup_failed');
    h.child.emit('close', 0);
    expect(h.service.read(view.handle, owner).state).toBe('cancelled');
  });

  it.each(['reservation', 'delivery'] as const)('refuses %s when the authority cancels the operation during its check', async (phase) => {
    const h = harness();
    const view = h.start();
    h.child.stdout.write(prompt);
    const reservation = phase === 'delivery' ? h.service.reserveHandoff(view.handle, owner, binding) : undefined;
    h.authorize.mockImplementation(() => { h.service.cancel(view.handle, owner); return true; });
    if (reservation) await expect(h.service.deliverHandoff(reservation, owner, binding)).rejects.toThrow('operation_inactive');
    else expect(() => h.service.reserveHandoff(view.handle, owner, binding)).toThrow('operation_inactive');
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.service.read(view.handle, owner).state).toBe('cancelled');
  });

  it.each(['false', 'promise'] as const)('rejects an authority returning %s before reserving or delivering', (kind) => {
    const h = harness();
    try {
      const view = h.start();
      h.child.stdout.write(prompt);
      if (kind === 'false') h.authorize.mockReturnValue(false);
      // Deliberate invalid runtime dependency: the typed production interface must also reject this.
      else h.authorize.mockImplementation((async () => true) as unknown as () => boolean);
      expect(() => h.service.reserveHandoff(view.handle, owner, binding)).toThrow('handoff_not_authorized');
      expect(h.service.read(view.handle, owner).state).toBe('awaiting_handoff');
      expect(h.deliver).not.toHaveBeenCalled();
    } finally { h.service.shutdown(); }
  });
});

describe('fresh native profile and spawn preparation', () => {
  it('refuses legacy, an existing home and a symlink without changing existing files', () => {
    expect(() => prepareCodexDeviceLoginHome('legacy')).toThrow('fresh_profile_required');
    const root = join(roots.current, 'codex-cli-profiles');
    mkdirSync(join(root, 'existing'), { recursive: true });
    writeFileSync(join(root, 'existing', 'auth.json'), 'PLACEHOLDER_AUTH');
    symlinkSync(join(roots.current, 'missing'), join(root, 'linked'));
    expect(() => prepareCodexDeviceLoginHome('existing')).toThrow('fresh_profile_required');
    expect(() => prepareCodexDeviceLoginHome('linked')).toThrow('fresh_profile_required');
    expect(readFileSync(join(root, 'existing', 'auth.json'), 'utf8')).toBe('PLACEHOLDER_AUTH');
  });

  it('pins file storage, disables shell spawning and strips ambient authentication', () => {
    vi.stubEnv('OPENAI_API_KEY', 'PLACEHOLDER');
    vi.stubEnv('CODEX_ACCESS_TOKEN', 'PLACEHOLDER');
    vi.stubEnv('NODE_OPTIONS', 'PLACEHOLDER');
    const home = prepareCodexDeviceLoginHome('new-profile');
    const options = codexDeviceLoginSpawnOptions(home);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('cli_auth_credentials_store = "file"\n');
    expect(options.shell).toBe(false);
    expect(options.env?.['CODEX_HOME']).toBe(home);
    expect(options.env?.['OPENAI_API_KEY']).toBeUndefined();
    expect(options.env?.['CODEX_ACCESS_TOKEN']).toBeUndefined();
    expect(options.env?.['NODE_OPTIONS']).toBeUndefined();
  });

  it('rejects caller commands and shell shims before any process can start', () => {
    expect(() => spawnCodexDeviceLogin('codex', roots.current)).toThrow('native_executable_required');
    expect(() => spawnCodexDeviceLogin(join(roots.current, 'codex.cmd'), roots.current)).toThrow('native_executable_required');
    expect(nativeSpawn).not.toHaveBeenCalled();
  });

  it('starts only the direct native device login with pinned storage and private pipes', () => {
    const child = new Child();
    vi.mocked(nativeSpawn).mockReturnValue(child as unknown as ReturnType<typeof nativeSpawn>);
    const executable = join(roots.current, 'native-codex');
    expect(spawnCodexDeviceLogin(executable, roots.current)).toBe(child);
    expect(nativeSpawn).toHaveBeenCalledWith(executable,
      ['-c', 'cli_auth_credentials_store=file', 'login', '--device-auth'],
      expect.objectContaining({ cwd: roots.current, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  });

  it('discards native spawn exception text', () => {
    vi.mocked(nativeSpawn).mockImplementation(() => { throw new Error('PRIVATE_PLACEHOLDER'); });
    expect(() => spawnCodexDeviceLogin(join(roots.current, 'native-codex'), roots.current)).toThrow('login_spawn_failed');
  });
});
