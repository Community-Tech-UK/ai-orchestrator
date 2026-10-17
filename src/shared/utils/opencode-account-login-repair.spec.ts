import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { openCodeAccountLoginCommand } from './opencode-account-login-command';
import { V2_LOGIN_CLI_FIXTURE } from './opencode-account-login.test-helper';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function setup(existing = false) {
  const root = mkdtempSync(join(tmpdir(), 'aio-login-repair-')); roots.push(root);
  const data = join(root, 'data'); mkdirSync(join(data, 'opencode'), { recursive: true });
  const file = join(data, 'opencode', 'opencode.db'); const database = new DatabaseSync(file);
  database.exec('CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, active INTEGER, value TEXT)');
  const add = () => database.prepare('INSERT INTO credential VALUES (?, ?, 1, ?)').run('existing-placeholder', 'aio-mimo-account-b', '{}');
  if (existing) add();
  writeFileSync(join(data, 'opencode', 'auth.json'), JSON.stringify({ 'aio-mimo-account-b': { type: 'api', key: 'placeholder-legacy-key' } }));
  const observed = join(root, 'import.json'); const binary = join(root, 'opencode');
  writeFileSync(binary, `#!${process.execPath}\nif(process.argv[2]==='--version'){console.log('2.0.30');process.exit(0);}${V2_LOGIN_CLI_FIXTURE}`, { mode: 0o700 });
  const command = openCodeAccountLoginCommand({ id: 'account-b', isLegacy: false, region: 'ams' }, { command: binary, major: 2 });
  const script = atob(command.match(/Buffer.from\('([^']+)'/)![1]);
  return { root, file, database, add, observed, script, env: { ...process.env, HOME: root, XDG_DATA_HOME: data, OPENCODE_DB: file, TEST_IMPORT: observed } };
}
it('refuses an unknown current store before offering or copying a legacy credential', () => {
  const f = setup(); f.database.exec('BEGIN EXCLUSIVE');
  try {
    const result = spawnSync(process.execPath, ['-e', f.script], { env: f.env, input: 'yes\n', encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unable to read OpenCode 2 credentials');
    expect(result.stdout).not.toContain('Copy it');
    expect(existsSync(f.observed)).toBe(false);
  } finally { f.database.exec('ROLLBACK'); f.database.close(); }
});
it('rechecks after explicit copy confirmation and preserves a credential added while the prompt was open', async () => {
  const f = setup(); const child = spawn(process.execPath, ['-e', f.script], { env: f.env }); let stdout = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Expected legacy copy prompt')), 5000);
      child.once('error', reject);
      child.stdout.on('data', (part) => { stdout += String(part); if (stdout.includes('Copy it')) { clearTimeout(timeout); resolve(); } });
    });
    f.add(); const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
    child.stdin.end('yes\n'); expect(await closed).toBe(0);
    expect(stdout).toContain('not copied'); expect(existsSync(f.observed)).toBe(false);
  } finally { child.kill(); f.database.close(); }
});
it('keeps the explicit manual-key path when an existing credential makes legacy copying unnecessary', () => {
  const f = setup(true);
  try {
    const result = spawnSync(process.execPath, ['-e', f.script], { env: f.env, input: 'placeholder-manual-key\n', encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('Copy it');
    expect(JSON.parse(readFileSync(f.observed, 'utf8')).value[0].value.key).toBe('placeholder-manual-key');
  } finally { f.database.close(); }
});


it('refuses a denied current database parent even when filesystem existence helpers conceal the error', () => {
  const f = setup(); const denied = join(f.root, 'denied'); mkdirSync(denied);
  const file = join(denied, 'opencode.db'); const database = new DatabaseSync(file);
  database.exec('CREATE TABLE credential (integration_id TEXT, active INTEGER)'); database.close();
  chmodSync(denied, 0);
  try {
    const result = spawnSync(process.execPath, ['-e', f.script], { env: { ...f.env, OPENCODE_DB: file }, input: 'yes\n', encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(1); expect(result.stderr).toContain('Unable to read OpenCode 2 credentials');
    expect(result.stdout).not.toContain('Copy it'); expect(existsSync(f.observed)).toBe(false);
  } finally { chmodSync(denied, 0o700); f.database.close(); }
});
