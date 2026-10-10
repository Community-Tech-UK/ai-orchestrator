import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeAccountLoginCommand } from './opencode-account-login-command';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function execute(exitCode = 0, signal?: 'SIGINT' | 'SIGTERM') {
  const root = mkdtempSync(join(tmpdir(), 'mimo login command '));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const output = join(root, 'observed.json');
  // Only the external CLI is replaced. Run the actual generated shell command;
  // the fake observes its arguments, temporary catalog and inherited state.
  writeFileSync(join(bin, 'opencode'), `#!${process.execPath}\n` +
    `const fs=require('node:fs');fs.writeFileSync(process.env.TEST_LOGIN_OUTPUT,JSON.stringify({` +
    `args:process.argv.slice(2),catalog:JSON.parse(fs.readFileSync(process.env.OPENCODE_MODELS_PATH,'utf8')),` +
    `file:process.env.OPENCODE_MODELS_PATH,home:process.env.HOME,data:process.env.XDG_DATA_HOME,` +
    `disabled:process.env.OPENCODE_DISABLE_MODELS_FETCH}));${signal ? `process.kill(process.pid,'${signal}');` : `process.exit(${exitCode});`}`, { mode: 0o700 });
  const command = openCodeAccountLoginCommand({ id: 'account-b', isLegacy: false, region: 'ams' });
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env['PATH']}`, HOME: root,
      XDG_DATA_HOME: join(root, 'data'), TEST_LOGIN_OUTPUT: output } });
  return { root, command, result, observed: JSON.parse(readFileSync(output, 'utf8')) as {
    args: string[]; catalog: unknown; file: string; home: string; data: string; disabled: string;
  } };
}
describe('portable OpenCode account sign-in', () => {
  it('registers only the custom provider and preserves the OpenCode store and key prompt boundary', () => {
    const { root, command, result, observed } = execute();
    expect(result.status).toBe(0);
    expect(observed).toMatchObject({ args: ['auth', 'login', '-p', 'aio-mimo-account-b'],
      catalog: { 'aio-mimo-account-b': { id: 'aio-mimo-account-b', env: [], models: {} } },
      home: root, data: join(root, 'data'), disabled: 'true' });
    expect(existsSync(observed.file)).toBe(false);
    // cmd.exe has an 8191-character command limit. The shell sees only audited
    // wrapper tokens and base64, never the nested JSON or caller input.
    expect(command.length).toBeLessThan(8191);
    expect(command).toMatch(/^node -e "eval\(Buffer.from\('[A-Za-z0-9+/=]+','base64'\).toString\(\)\)"$/);
    expect(atob(command.match(/Buffer.from\('([^']+)'/)![1])).toContain("shell:process.platform==='win32'");
  });
  it('propagates a CLI failure and removes the catalog', () => {
    const { result, observed } = execute(7);
    expect(result.status).toBe(7);
    expect(existsSync(observed.file)).toBe(false);
  });
  it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('propagates %s cancellation and removes the catalog', (signal, exitCode) => {
    const { result, observed } = execute(0, signal);
    expect(result.status).toBe(exitCode);
    expect(existsSync(observed.file)).toBe(false);
  });

  it('propagates an executable failure and cleans temporary files', () => {
    const root = mkdtempSync(join(tmpdir(), 'mimo missing cli '));
    roots.push(root);
    const command = openCodeAccountLoginCommand({ id: 'b', isLegacy: false });
    const script = atob(command.match(/Buffer.from\('([^']+)'/)![1]);
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, PATH: '', TMPDIR: root } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENOENT');
    expect(readdirSync(root)).toEqual([]);
  });
  it.each(['../escape', 'b & echo unsafe', 'b%PATH%', "b'", 'b\"', 'Upper', ''])('rejects unsafe profile %s before shell encoding', (id) => {
    expect(() => openCodeAccountLoginCommand({ id, isLegacy: false })).toThrow('Invalid account profile ID');
  });
});
