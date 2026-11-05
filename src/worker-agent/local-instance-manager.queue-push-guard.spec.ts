import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const createAdapter = vi.hoisted(() => vi.fn());
vi.mock('../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: createAdapter }));
import { LocalInstanceManager } from './local-instance-manager';
import { InstanceSpawnParamsSchema } from '../main/remote-node/rpc-schemas';
import { remoteSpawnMetadata } from '../main/remote-node/remote-spawn-metadata';
import { preserveHarnessCliShellPolicy } from '../main/cli/adapters/codex/codex-harness-shell-policy';

function fakeAdapter(): EventEmitter {
  return Object.assign(new EventEmitter(), {
    spawn: vi.fn().mockResolvedValue(1), sendInput: vi.fn().mockResolvedValue(undefined), terminate: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn(() => ({ status: 'already-idle' })), getName: () => 'fake', getSessionId: () => 'provider-session',
    getRuntimeCapabilities: () => ({ supportsResume: true, supportsForkSession: false, supportsNativeCompaction: false, supportsPermissionPrompts: false, supportsDeferPermission: false, selfManagedAutoCompaction: false }),
  });
}

let repo: string;
let manager: LocalInstanceManager;
const git = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const spawnedEnv = (): Record<string, string> => (createAdapter.mock.calls.at(-1)![1] as { env?: Record<string, string> }).env ?? {};
const pushFailure = (remote: string, env: Record<string, string>): string => {
  try { git(['push', remote, 'main'], { ...process.env, ...env }); return ''; } catch (error) { return String((error as { stderr?: string }).stderr); }
};

beforeEach(() => {
  vi.clearAllMocks();
  // A Plan Queue worker running this suite carries the guard's own git settings; count from a clean environment.
  for (const key of Object.keys(process.env)) if (/^GIT_CONFIG_/.test(key) || key === 'AIO_QUEUE_SESSION') vi.stubEnv(key, undefined);
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'worker-queue-guard-')));
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'T']); git(['config', 'user.email', 't@example.invalid']);
  writeFileSync(join(repo, 'a'), '1'); git(['add', 'a']); git(['commit', '-qm', 'one']);
  manager = new LocalInstanceManager([repo]);
  createAdapter.mockImplementation(() => fakeAdapter());
});
afterEach(async () => { await manager.terminateAll(); vi.unstubAllEnvs(); rmSync(repo, { recursive: true, force: true }); });

describe('LocalInstanceManager — Plan Queue push guard built on this node', () => {
  it.each(['git@github.com:owner/repo.git', 'ssh://git@example.invalid/repo.git', 'git+ssh://git@example.invalid/repo.git',
    'ssh+git://git@example.invalid/repo.git', 'https://example.invalid/repo.git', 'http://example.invalid/repo.git', 'git://example.invalid/repo.git'])(
    'makes a push to %s fail without reaching the remote',
    async (url) => {
      await manager.spawn({ instanceId: 'q-1', cliType: 'claude', workingDirectory: repo, queuePushGuard: true });
      git(['remote', 'add', 'probe', url]);
      expect(spawnedEnv()['AIO_QUEUE_SESSION']).toBe('1');
      expect(pushFailure('probe', spawnedEnv())).toContain('aio-queue-push-blocked');
    },
  );

  it('also blocks a remote this node\'s repository gives its own push address', async () => {
    git(['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
    git(['config', 'remote.origin.pushurl', 'git@example.invalid:repo.git']);
    await manager.spawn({ instanceId: 'q-2', cliType: 'claude', workingDirectory: repo, queuePushGuard: true });
    expect(pushFailure('origin', spawnedEnv())).toContain('aio-queue-push-blocked');
    // The controller could not have sent this: it exists only in the node's repository.
  });

  it('keeps the node\'s own settings for the browser and adds the guard beside them', async () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '2');
    await manager.spawn({ instanceId: 'q-3', cliType: 'claude', workingDirectory: repo, queuePushGuard: true });
    expect(spawnedEnv()['GIT_CONFIG_KEY_0']).toBeUndefined();
    expect(spawnedEnv()['GIT_CONFIG_KEY_2']).toMatch(/pushInsteadOf/);
  });

  it('gives no guard to an ordinary session', async () => {
    git(['remote', 'add', 'probe', 'https://example.invalid/repo.git']);
    await manager.spawn({ instanceId: 'plain-1', cliType: 'claude', workingDirectory: repo });
    expect(spawnedEnv()['AIO_QUEUE_SESSION']).toBeUndefined();
    expect(Object.keys(spawnedEnv()).filter((key) => key.startsWith('GIT_CONFIG_'))).toEqual([]);
  });

  it('builds the guard again when a hibernated session wakes', async () => {
    await manager.spawn({ instanceId: 'q-4', cliType: 'claude', workingDirectory: repo, queuePushGuard: true });
    await manager.hibernate('q-4');
    createAdapter.mockClear();
    await manager.wake('q-4');
    expect(spawnedEnv()['AIO_QUEUE_SESSION']).toBe('1');
  });

  it('keeps a Codex session\'s guard variables through Codex\'s own shell filter', async () => {
    await manager.spawn({ instanceId: 'q-6', cliType: 'codex', workingDirectory: repo, queuePushGuard: true });
    const policy = preserveHarnessCliShellPolicy('[shell_environment_policy]\ninclude_only = ["PATH"]\n', spawnedEnv());
    expect(policy).toContain('AIO_QUEUE_SESSION = "1"');
    expect(policy).toContain('"GIT_CONFIG_COUNT"');
  });
});

describe('queuePushGuard on the wire', () => {
  const base = { instanceId: 'w-1', cliType: 'claude', workingDirectory: '/tmp' };
  it('survives validation on the node, and an ordinary session carries nothing', () => {
    const sent = { ...base, ...remoteSpawnMetadata({ queuePushGuard: true }, false) };
    expect(InstanceSpawnParamsSchema.parse(sent).queuePushGuard).toBe(true);
    expect(remoteSpawnMetadata({}, false)).not.toHaveProperty('queuePushGuard');
    expect(InstanceSpawnParamsSchema.parse(base).queuePushGuard).toBeUndefined();
  });
  it('rejects a value other than true', () => {
    expect(() => InstanceSpawnParamsSchema.parse({ ...base, queuePushGuard: false })).toThrow();
  });
});
