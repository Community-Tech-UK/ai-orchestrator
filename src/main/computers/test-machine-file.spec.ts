import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changeTestMachine, readTestMachine } from './test-machine-file';

const require = createRequire(import.meta.url);
const { readConfig } = require('../../../scripts/remote-checks/route.js') as {
  readConfig: (env: NodeJS.ProcessEnv) => Record<string, unknown> | null;
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(config: object | string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'test-machine-file-'));
  dirs.push(dir);
  if (config !== null) writeFileSync(join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

const SET_UP = { host: 'harness-checks', label: 'the Windows PC', sshConfig: '/somewhere/ssh_config', queueChecks: true };

describe('the test machine file', () => {
  it('says there is none when the file is missing, and refuses a broken one', () => {
    expect(readTestMachine(folder(null))).toBeNull();
    expect(() => readTestMachine(folder('{ broken'))).toThrow();
    expect(() => readTestMachine(folder({ label: 'x' }))).toThrow(/no host/);
    expect(() => readTestMachine(folder('[]'))).toThrow(/not a JSON object/);
  });

  it('reads what the scripts would: on, three at a time, unless the file says otherwise', () => {
    expect(readTestMachine(folder(SET_UP))).toEqual({
      host: 'harness-checks', label: 'the Windows PC', nodeName: null, paused: false, testRuns: true, checks: true, slots: 3,
    });
    expect(readTestMachine(folder({ ...SET_UP, nodeName: 'windows-pc', paused: true, checks: false, slots: 9 }))).toMatchObject({
      nodeName: 'windows-pc', paused: true, checks: false, slots: 3,
    });
  });

  it('changes only what it is given, keeps the rest of the file, and agrees with the scripts afterwards', () => {
    const dir = folder(SET_UP);
    expect(changeTestMachine({ paused: true, slots: 5 }, dir)).toMatchObject({ paused: true, slots: 5, testRuns: true });
    const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(written).toEqual({ ...SET_UP, paused: true, slots: 5 });
    expect(readConfig({ AIO_REMOTE_CHECKS_DIR: dir })).toMatchObject({ paused: true, slots: 5, testRuns: true, checks: true });
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('refuses a change it does not own or cannot use, and leaves the file alone', () => {
    const dir = folder(SET_UP);
    for (const change of [{ host: 'elsewhere' }, { slots: 0 }, { slots: 9 }, { slots: 2.5 }, { paused: 'yes' }]) {
      expect(() => changeTestMachine(change as never, dir)).toThrow();
    }
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual(SET_UP);
  });

  it('cannot set up a test machine that does not exist', () => {
    const dir = folder(null);
    expect(() => changeTestMachine({ paused: true }, dir)).toThrow(/No test machine/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
