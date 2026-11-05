import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildQueuePushGuardEnv, isQueueSession, QUEUE_SESSION_ENV } from './plan-queue-push-guard';

let dir: string;
const git = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  // A Plan Queue worker running this suite inherits the guard's own git settings; the tests count from a clean environment.
  for (const key of Object.keys(process.env)) if (/^GIT_CONFIG_/.test(key) || key === QUEUE_SESSION_ENV) vi.stubEnv(key, undefined);
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'queue-push-guard-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'T']); git(['config', 'user.email', 't@example.invalid']);
  writeFileSync(join(dir, 'a'), '1'); git(['add', 'a']); git(['commit', '-qm', 'one']);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('buildQueuePushGuardEnv', () => {
  it('marks the session and numbers the git settings from zero', async () => {
    const env = await buildQueuePushGuardEnv(dir);
    expect(env[QUEUE_SESSION_ENV]).toBe('1');
    const count = Number(env['GIT_CONFIG_COUNT']);
    expect(count).toBeGreaterThanOrEqual(7);
    expect(env['GIT_CONFIG_KEY_0']).toMatch(/^url\..+\.pushInsteadOf$/);
    expect(env[`GIT_CONFIG_KEY_${count - 1}`]).toBeDefined();
    expect(env[`GIT_CONFIG_KEY_${count}`]).toBeUndefined();
  });

  it('counts git settings the app\'s own environment carries too', async () => {
    process.env['GIT_CONFIG_COUNT'] = '3';
    try {
      expect((await buildQueuePushGuardEnv(dir))['GIT_CONFIG_KEY_3']).toMatch(/pushInsteadOf/);
    } finally { delete process.env['GIT_CONFIG_COUNT']; }
  });

  it('appends to settings the environment already carries instead of replacing them', async () => {
    const env = await buildQueuePushGuardEnv(dir, { GIT_CONFIG_COUNT: '2' });
    expect(env['GIT_CONFIG_KEY_0']).toBeUndefined();
    expect(env['GIT_CONFIG_KEY_2']).toMatch(/pushInsteadOf/);
    expect(Number(env['GIT_CONFIG_COUNT'])).toBeGreaterThan(2);
  });

  it('makes git push to every covered address form fail without reaching the remote', async () => {
    const guard = await buildQueuePushGuardEnv(dir);
    for (const url of ['git@github.com:owner/repo.git', 'ssh://git@example.invalid/repo.git', 'https://example.invalid/repo.git', 'git://example.invalid/repo.git']) {
      git(['remote', 'add', 'probe', url]);
      let message = '';
      try { git(['push', 'probe', 'main'], { ...process.env, ...guard }); } catch (error) { message = String((error as { stderr?: string }).stderr); }
      expect(message, url).toContain('aio-queue-push-blocked');
      git(['remote', 'remove', 'probe']);
    }
  });

  it('also blocks a remote that has its own push address', async () => {
    git(['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
    git(['config', 'remote.origin.pushurl', 'git@example.invalid:repo.git']);
    const guard = await buildQueuePushGuardEnv(dir);
    let message = '';
    try { git(['push', 'origin', 'main'], { ...process.env, ...guard }); } catch (error) { message = String((error as { stderr?: string }).stderr); }
    expect(message).toContain('aio-queue-push-blocked');
  });

  it('leaves a push to a local path alone, which test fixtures rely on', async () => {
    const bare = join(dir, 'remote.git'); mkdirSync(bare);
    execFileSync('git', ['init', '-q', '--bare', bare]);
    git(['remote', 'add', 'local', bare]);
    const guard = await buildQueuePushGuardEnv(dir);
    expect(() => git(['push', 'local', 'main'], { ...process.env, ...guard })).not.toThrow();
  });

  it('adds only the marker and prefix settings in a folder that is not a repository', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'queue-push-guard-none-'));
    try {
      const env = await buildQueuePushGuardEnv(outside);
      expect(Object.keys(env).filter((key) => key.startsWith('GIT_CONFIG_KEY_'))).toHaveLength(7);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

describe('isQueueSession', () => {
  const sessions: Record<string, { metadata?: Record<string, unknown>; parentId?: string | null }> = {
    worker: { metadata: { planQueueRole: 'worker' }, parentId: 'parent' },
    child: { parentId: 'worker' },
    grandchild: { parentId: 'child' },
    ordinary: { parentId: 'parent' },
    parent: {},
    loopA: { parentId: 'loopB' },
    loopB: { parentId: 'loopA' },
  };
  const lookup = (id: string) => sessions[id];

  it('is true for sessions the queue started, and for their children at any depth', () => {
    for (const id of ['worker', 'child', 'grandchild']) expect(isQueueSession(sessions[id], lookup), id).toBe(true);
    expect(isQueueSession({ metadata: { planQueueRole: 'triage' } }, lookup)).toBe(true);
  });

  it('is false for other sessions, a missing session and a parent cycle', () => {
    for (const id of ['ordinary', 'parent', 'loopA']) expect(isQueueSession(sessions[id], lookup), id).toBe(false);
    expect(isQueueSession(undefined, lookup)).toBe(false);
    expect(isQueueSession({ parentId: 'gone' }, lookup)).toBe(false);
  });
});
