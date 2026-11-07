import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changeTestMachine, readRunLog, readTestMachine, summariseWorkToday } from './test-machine-file';

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

describe('where today\'s work went', () => {
  const NOW = new Date(2026, 10, 7, 15, 0).getTime();
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

  it('counts today\'s test runs and checks by where they ran, apart from short runs, with reasons', () => {
    const summary = summariseWorkToday([
      { at: at(1), ranOn: 'pc' },
      { at: at(2), ranOn: 'pc', kind: 'commit' },
      { at: at(3), ranOn: 'mac', fellBackBecause: 'the Windows PC is paused' },
      { at: at(4), ranOn: 'mac', kind: 'targeted', fellBackBecause: 'the Windows PC is paused' },
      { at: at(5), ranOn: 'mac', kind: 'project', fellBackBecause: 'the Windows PC could not be reached' },
      { at: at(1), ranOn: 'pc', kind: 'checks' },
      { at: at(1), ranOn: 'mac', kind: 'checks', fellBackBecause: 'checks are turned off for the Windows PC' },
      { at: at(1), ranOn: 'mac', kind: 'local' },
      { at: at(1), ranOn: 'mac', kind: 'local' },
      { at: at(30), ranOn: 'mac', fellBackBecause: 'yesterday' },
    ], NOW);
    expect(summary).toEqual({
      testRuns: { there: 2, here: 3 },
      checks: { there: 1, here: 1 },
      shortRunsHere: 2,
      hereBecause: [
        { reason: 'the Windows PC is paused', count: 2 },
        { reason: 'the Windows PC could not be reached', count: 1 },
        { reason: 'checks are turned off for the Windows PC', count: 1 },
      ],
    });
  });

  it('reads the older log first, then the current one, skipping half-written lines', () => {
    const dir = folder(SET_UP);
    writeFileSync(join(dir, 'runs.old.jsonl'), `${JSON.stringify({ at: 'a', ranOn: 'pc' })}\n`);
    writeFileSync(join(dir, 'runs.jsonl'), `${JSON.stringify({ at: 'b', ranOn: 'mac' })}\n{"at": "half`);
    expect(readRunLog(dir).map(run => run.at)).toEqual(['a', 'b']);
  });
});
