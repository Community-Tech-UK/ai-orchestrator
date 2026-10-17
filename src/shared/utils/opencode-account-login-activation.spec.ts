import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { openCodeAccountLoginCommand } from './opencode-account-login-command';
import { V2_LOGIN_CLI_FIXTURE } from './opencode-account-login.test-helper';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function setup(extraEnv: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aio-login-activation-')); roots.push(root);
  const data = join(root, 'data'); mkdirSync(join(data, 'opencode'), { recursive: true });
  const file = join(data, 'opencode', 'opencode.db');
  const binary = join(root, 'selected opencode');
  writeFileSync(binary, `#!${process.execPath}\nif(process.argv[2]==='--version'){console.log('2.0.30');process.exit(0);}\n${V2_LOGIN_CLI_FIXTURE}`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_DATA_HOME: data, OPENCODE_DB: file, OPENCODE_CONFIG_CONTENT: '', ...extraEnv };
  const run = (key: string, id = 'account-b') => {
    const command = openCodeAccountLoginCommand({ id, isLegacy: false, region: 'ams' }, { command: binary, major: 2 });
    const script = atob(command.match(/Buffer.from\('([^']+)'/)![1]);
    return spawnSync(process.execPath, ['-e', script], { env, input: `${key}\n`, encoding: 'utf8', timeout: 10000 });
  };
  const rows = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare('SELECT integration_id, active, value FROM credential ORDER BY rowid').all(); }
    finally { db.close(); }
  };
  return { root, data, env, run, rows };
}

it('activates an entered replacement key without changing another account', () => {
  const f = setup();
  expect(f.run('placeholder-other-key', 'account-a').status).toBe(0);
  expect(f.run('placeholder-first-key').status).toBe(0);
  const replacement = f.run('placeholder-replacement-key');
  expect(replacement.status, replacement.stderr).toBe(0);
  expect(replacement.stdout).toContain('Signed in as');
  expect(f.rows()).toEqual([
    { integration_id: 'aio-mimo-account-a', active: 1, value: JSON.stringify({ type: 'key', key: 'placeholder-other-key' }) },
    { integration_id: 'aio-mimo-account-b', active: 0, value: JSON.stringify({ type: 'key', key: 'placeholder-first-key' }) },
    { integration_id: 'aio-mimo-account-b', active: 1, value: JSON.stringify({ type: 'key', key: 'placeholder-replacement-key' }) },
  ]);
  expect(replacement.stdout + replacement.stderr).not.toContain('placeholder-replacement-key');
});

it('activates only the selected integration while preserving inherited configuration and keeping the key off arguments', () => {
  const f = setup({ OPENCODE_CONFIG_CONTENT: JSON.stringify({
    providers: { untouched: { activation: 'disabled' }, 'aio-mimo-account-b': { settings: { baseURL: 'https://example.invalid/v1' } } },
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
  }) });
  const calls = join(f.root, 'auth-calls.jsonl'); f.env['TEST_AUTH_CALLS'] = calls;
  const result = f.run('placeholder-new-key'); expect(result.status, result.stderr).toBe(0);
  const observed = readFileSync(calls, 'utf8').trim().split('\n').map((row) => JSON.parse(row));
  expect(observed).toEqual([
    { args: ['auth', 'import', '--standalone'], config: {
      providers: { untouched: { activation: 'disabled' }, 'aio-mimo-account-b': { settings: { baseURL: 'https://example.invalid/v1' }, activation: 'enabled' } },
      permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    } },
    { args: ['auth', 'switch', 'aio-mimo-account-b', expect.stringMatching(/^aio-[0-9a-f-]{36}$/), '--standalone'], config: {
      providers: { untouched: { activation: 'disabled' }, 'aio-mimo-account-b': { settings: { baseURL: 'https://example.invalid/v1' }, activation: 'enabled' } },
      permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    } },
  ]);
  expect(readFileSync(calls, 'utf8') + result.stdout + result.stderr).not.toContain('placeholder-new-key');
});

it.each([{ TEST_SWITCH_EXIT: '7' }, { TEST_SWITCH_NOOP: 'true' }])('refuses successful sign-in when activation fails: %j', (env) => {
  const failed = setup(); expect(failed.run('placeholder-first-key').status).toBe(0);
  // Start with an existing active entry, so an import alone cannot pass verification.
  Object.assign(failed.env, env);
  const result = failed.run('placeholder-replacement-key');
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('Signed in as');
  expect(result.stderr).toContain('OpenCode sign-in failed');
  expect(result.stdout + result.stderr).not.toContain('placeholder-replacement-key');
  expect(failed.rows().filter((row) => row['active'] === 1)).toEqual([
    { integration_id: 'aio-mimo-account-b', active: 1, value: JSON.stringify({ type: 'key', key: 'placeholder-first-key' }) },
  ]);
});

it('keeps legacy copying from activating over a credential added during the import', () => {
  const f = setup({ TEST_CONCURRENT_CREDENTIAL: 'true' });
  writeFileSync(join(f.data, 'opencode', 'auth.json'), JSON.stringify({ 'aio-mimo-account-b': { type: 'api', key: 'placeholder-legacy-key' } }));
  const result = f.run('yes');
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('Copied ');
  expect(f.rows().filter((row) => row['active'] === 1)).toEqual([
    { integration_id: 'aio-mimo-account-b', active: 1, value: '{}' },
  ]);
});

it.each(['null', '[]', '{"providers":null}', '{"providers":[]}', '{"providers":{"aio-mimo-account-b":null}}', '{"providers":{"aio-mimo-account-b":false}}'])('refuses malformed activation configuration before importing: %s', (config) => {
  const f = setup({ OPENCODE_CONFIG_CONTENT: config });
  const result = f.run('placeholder-new-key');
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('Signed in as');
  expect(() => readFileSync(join(f.data, 'opencode', 'opencode.db'))).toThrow();
});
