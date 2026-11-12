import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changeTestMachine, readRunLog, readTestMachines, summariseWorkToday } from './test-machine-file';

const require = createRequire(import.meta.url);
const { readConfig } = require('../../../scripts/remote-checks/route.js') as {
  readConfig: (env: NodeJS.ProcessEnv) => { queueChecks: boolean; machines: Record<string, unknown>[] } | null;
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

const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));

/** One machine, as the file was first written. */
const SET_UP = { host: 'harness-checks', label: 'the Windows PC', sshConfig: '/somewhere/ssh_config', queueChecks: true };
const TEST_MAC = { host: 'ct-test-mac', label: 'the test Mac', platform: 'darwin' };
const LISTED = { ...SET_UP, moreMachines: [TEST_MAC] };

describe('the test machine file', () => {
  it('says there are none when the file is missing, and refuses a broken one', () => {
    expect(readTestMachines(folder(null))).toEqual([]);
    expect(() => readTestMachines(folder('{ broken'))).toThrow();
    expect(() => readTestMachines(folder({ label: 'x' }))).toThrow(/no host/);
    expect(() => readTestMachines(folder('[]'))).toThrow(/not a JSON object/);
    expect(() => readTestMachines(folder({ ...SET_UP, moreMachines: [TEST_MAC, 'x'] }))).toThrow(/not a JSON object/);
    expect(() => readTestMachines(folder({ ...SET_UP, moreMachines: [{ label: 'x' }] }))).toThrow(/no host/);
  });

  it('reads what the scripts would: on, three at a time, Linux, unless the file says otherwise', () => {
    expect(readTestMachines(folder(SET_UP))).toEqual([{
      host: 'harness-checks', platform: 'linux', label: 'the Windows PC', nodeName: null, paused: false, testRuns: true,
      checks: true, slots: 3,
    }]);
    expect(readTestMachines(folder({ ...SET_UP, nodeName: 'windows-pc', paused: true, checks: false, slots: 9 }))).toMatchObject([{
      nodeName: 'windows-pc', paused: true, checks: false, slots: 3,
    }]);
  });

  it('reads the top-level machine, then any more in their order, as the scripts do', () => {
    const dir = folder(LISTED);
    expect(readTestMachines(dir).map(machine => [machine.host, machine.platform, machine.label])).toEqual([
      ['harness-checks', 'linux', 'the Windows PC'], ['ct-test-mac', 'darwin', 'the test Mac'],
    ]);
    expect(readConfig({ AIO_REMOTE_CHECKS_DIR: dir })!.machines.map(machine => machine['host'])).toEqual(['harness-checks', 'ct-test-mac']);
  });

  it('changes only the machine and fields it is given, keeps the rest of the file, and agrees with the scripts afterwards', () => {
    const dir = folder(LISTED);
    expect(changeTestMachine('ct-test-mac', { paused: true, slots: 5 }, dir)).toMatchObject({ host: 'ct-test-mac', paused: true, slots: 5, testRuns: true });
    expect(read(dir)).toEqual({ ...SET_UP, moreMachines: [{ ...TEST_MAC, paused: true, slots: 5 }] });
    expect(readConfig({ AIO_REMOTE_CHECKS_DIR: dir })).toMatchObject({
      queueChecks: true,
      machines: [{ host: 'harness-checks', paused: false, slots: 3 }, { host: 'ct-test-mac', paused: true, slots: 5, testRuns: true, checks: true }],
    });
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('changes the first machine where it is, at the top, where older copies of the scripts and Harness read it', () => {
    const dir = folder(LISTED);
    expect(changeTestMachine('harness-checks', { checks: false }, dir)).toMatchObject({ checks: false, testRuns: true });
    expect(read(dir)).toEqual({ ...LISTED, checks: false });
    const single = folder(SET_UP);
    changeTestMachine('harness-checks', { paused: true }, single);
    expect(read(single)).toEqual({ ...SET_UP, paused: true });
  });

  it('refuses a change it does not own or cannot use, or a machine that is not there, and leaves the file alone', () => {
    const dir = folder(LISTED);
    for (const change of [{ host: 'elsewhere' }, { slots: 0 }, { slots: 9 }, { slots: 2.5 }, { paused: 'yes' }]) {
      expect(() => changeTestMachine('ct-test-mac', change as never, dir)).toThrow();
    }
    expect(() => changeTestMachine('elsewhere', { paused: true }, dir)).toThrow(/No test machine called elsewhere/);
    expect(read(dir)).toEqual(LISTED);
  });

  it('cannot set up a test machine that does not exist', () => {
    const dir = folder(null);
    expect(() => changeTestMachine('harness-checks', { paused: true }, dir)).toThrow(/No test machine/);
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
      { at: at(1), ranOn: 'ct-test-mac', kind: 'ios' },
      { at: at(1), ranOn: 'mac', kind: 'ios', fellBackBecause: 'the test Mac could not be reached' },
      { at: at(30), ranOn: 'mac', fellBackBecause: 'yesterday' },
    ], NOW);
    expect(summary).toEqual({
      testRuns: { there: 2, here: 3 },
      checks: { there: 1, here: 1 },
      iphone: { there: 1, here: 1 },
      shortRunsHere: 2,
      hereBecause: [
        { reason: 'the Windows PC is paused', count: 2 },
        { reason: 'the Windows PC could not be reached', count: 1 },
        { reason: 'checks are turned off for the Windows PC', count: 1 },
        { reason: 'the test Mac could not be reached', count: 1 },
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
