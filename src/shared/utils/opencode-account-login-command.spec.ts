import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeAccountLoginCommand, openCodeLoginSpawnTarget, type OpenCodeLoginSelection } from './opencode-account-login-command';
import { V2_LOGIN_CLI_FIXTURE } from './opencode-account-login.test-helper';

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
    `if(process.argv[2]==='--version'){console.log('1.19.1');process.exit(0);}const fs=require('node:fs');fs.writeFileSync(process.env.TEST_LOGIN_OUTPUT,JSON.stringify({` +
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
    expect(atob(command.match(/Buffer.from\('([^']+)'/)![1])).toContain('shell:target.shell');
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
    expect(result.stderr).toContain('No supported OpenCode command found');
    expect(readdirSync(root)).toEqual([]);
  });
  it.each(['../escape', 'b & echo unsafe', 'b%PATH%', "b'", 'b"', 'Upper', ''])('rejects unsafe profile %s before shell encoding', (id) => {
    expect(() => openCodeAccountLoginCommand({ id, isLegacy: false })).toThrow('Invalid account profile ID');
  });
});

it('imports a version 2 credential through stdin using the selected binary', () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-v2-login-')); roots.push(root);
  const output = join(root, 'observed.json');
  const binary = join(root, 'selected opencode');
  writeFileSync(binary, `#!${process.execPath}\nif(process.argv[2]==='--version'){console.log('2.0.30');process.exit(0);}${V2_LOGIN_CLI_FIXTURE}`, { mode: 0o700 });
  const command = openCodeAccountLoginCommand({ id: 'account-b', isLegacy: false, region: 'ams' }, { command: binary, major: 2 });
  const result = spawnSync('/bin/sh', ['-c', command], { input: 'placeholder-not-a-real-key\n', encoding: 'utf8', env: { ...process.env, HOME: root, XDG_DATA_HOME: join(root, 'data'), OPENCODE_DB: join(root, 'opencode.db'), TEST_IMPORT: output } });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ args: ['auth', 'import', '--standalone'], value: [{ integrationID: 'aio-mimo-account-b', active: true, value: { type: 'key', key: 'placeholder-not-a-real-key' } }] });
  expect(command).not.toContain('placeholder-not-a-real-key');
  expect(result.stdout).not.toContain('placeholder-not-a-real-key');
  expect(command.length).toBeLessThan(8191);
});

it('quotes Windows npm shim paths and keeps native executables off the shell', () => {
  expect(openCodeLoginSpawnTarget('C:\\Program Files\\OpenCode\\opencode.cmd', 'win32')).toEqual({ command: '"C:\\Program Files\\OpenCode\\opencode.cmd"', shell: true });
  expect(openCodeLoginSpawnTarget('C:\\Program Files\\OpenCode\\opencode.exe', 'win32')).toEqual({ command: 'C:\\Program Files\\OpenCode\\opencode.exe', shell: false });
  expect(() => openCodeLoginSpawnTarget('C:\\bad%PATH%\\opencode.cmd', 'win32')).toThrow('Unsafe OpenCode command path');
});

it('keeps maximum profile IDs and long selected Windows paths inside the terminal command limit', () => {
  const profile = { id: 'a'.repeat(63), isLegacy: false, region: 'ams' as const };
  expect(openCodeAccountLoginCommand(profile).length).toBeLessThan(8191);
  expect(openCodeAccountLoginCommand(profile, { command: `C:\\Program Files\\${'a'.repeat(220)}\\opencode.exe`, major: 2 }).length).toBeLessThan(8191);
});


const loginProfiles = [
  { id: 'account-b', isLegacy: false, region: 'ams' as const },
  { id: 'legacy', isLegacy: true, region: 'ams' as const },
  { id: 'legacy', isLegacy: true },
];

function executeVersioned(profile: typeof loginProfiles[number], versions: Record<string, string>, selected?: OpenCodeLoginSelection) {
  const root = mkdtempSync(join(tmpdir(), 'aio-login-version-')); roots.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const output = join(root, 'auth-calls.jsonl');
  for (const [command, version] of Object.entries(versions)) {
    writeFileSync(join(bin, command), `#!${process.execPath}\n` +
      `if(process.argv[2]==='--version'){${version === '__hang__' ? 'setInterval(()=>{},1000);return;' : version === '__overflow__' ? "process.stdout.write('x'.repeat(131072));return;" : `console.log(${JSON.stringify(version)});process.exit(0);`}}` +
      `require('node:fs').appendFileSync(process.env.TEST_LOGIN_OUTPUT,JSON.stringify({command:${JSON.stringify(command)},args:process.argv.slice(2)})+'\\n');` +
      V2_LOGIN_CLI_FIXTURE +
      `process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`, { mode: 0o700 });
  }
  const command = openCodeAccountLoginCommand(profile, selected);
  const encoded = command.match(/Buffer.from\('([^']+)'/)?.[1];
  const result = spawnSync(encoded ? process.execPath : '/bin/sh', encoded ? ['-e', atob(encoded)] : ['-c', command], { encoding: 'utf8', input: 'placeholder-not-a-real-key\n', timeout: 10000,
    env: { ...process.env, PATH: bin, HOME: root, XDG_DATA_HOME: join(root, 'data'), OPENCODE_DB: join(root, 'opencode.db'), TMPDIR: root, TEST_LOGIN_OUTPUT: output } });
  const calls = existsSync(output) ? readFileSync(output, 'utf8').trim().split('\n').map((row) => JSON.parse(row) as { command: string; args: string[] }) : [];
  return { result, calls, command };
}

describe('generated login version boundary', () => {
  it.each(['2.0.30rc', '2.0.30-alpha.1', '2.0.30.1', '2.0.29', '2.0.30+', '2.0.30+bad..metadata', '3.0.0', 'unknown'])(
    'refuses unsupported %s before any account login or import', (version) => {
      for (const profile of loginProfiles) {
        const { result, calls } = executeVersioned(profile, { opencode2: version });
        expect(result.status, `${version}: ${result.stderr}`).toBe(1);
        expect(calls).toEqual([]);
        expect(result.stderr).toContain('No supported OpenCode command found');
      }
    },
  );

  it.each(['2.0.30', 'opencode v2.0.30+build.1', '2.1.0'])('prefers stable %s over version 1 on every fallback route', (version) => {
    for (const profile of loginProfiles) {
      const { result, calls, command } = executeVersioned(profile, { opencode2: version, opencode: '1.19.1' });
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual(profile.isLegacy && !profile.region
        ? [{ command: 'opencode2', args: ['auth', 'login', '--standalone'] }]
        : [{ command: 'opencode2', args: ['auth', 'import', '--standalone'] },
          { command: 'opencode2', args: ['auth', 'switch', profile.isLegacy ? 'xiaomi-token-plan-ams' : 'aio-mimo-account-b', expect.stringMatching(/^aio-[0-9a-f-]{36}$/), '--standalone'] }]);
      expect(command.length).toBeLessThan(8191);
    }
  });

  it('falls back to stable version 1 for legacy and custom profiles', () => {
    for (const profile of loginProfiles) {
      const { result, calls } = executeVersioned(profile, { opencode2: '2.0.30rc', opencode: '1.19.1' });
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual([{ command: 'opencode', args: profile.isLegacy && !profile.region
        ? ['auth', 'login'] : ['auth', 'login', '-p', profile.isLegacy ? 'xiaomi-token-plan-ams' : 'aio-mimo-account-b'] }]);
    }
  });

  it.each(['3.0.0', 'unknown', '2.0.30-alpha.1', '2.0.29', '1.19.1'])(
    'rechecks a copied selected command and refuses changed version %s before auth', (version) => {
      const { result, calls } = executeVersioned(loginProfiles[0]!, { opencode: version }, { command: 'opencode', major: 2 });
      expect(result.status).toBe(1);
      expect(calls).toEqual([]);
    },
  );

  it.each(['__hang__', '__overflow__'])('bounds a %s version probe before any auth command', (version) => {
    const { result, calls } = executeVersioned(loginProfiles[0]!, { opencode2: version });
    expect(result.status, result.stderr).toBe(1);
    expect(calls).toEqual([]);
    expect(result.stderr).toContain('No supported OpenCode command found');
  }, 15000);

  it.each([0, 3, Number.NaN])('rejects unsupported selected major %s while building the command', (major) => {
    expect(() => openCodeAccountLoginCommand(loginProfiles[0]!, { command: 'opencode', major })).toThrow('Unsupported OpenCode major');
  });
});
