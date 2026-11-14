import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueueJobProjectCheck } from '../../shared/types/plan-queue-computers.types';
import type { ComputerChoice } from '../../shared/types/settings.types';
import type { TestMachineView } from '../../shared/types/computers.types';
import type { RemoteNodeRosterEntry } from '../../shared/types/worker-node.types';
import { QueueJobComputers, type QueueJobComputersOptions } from './queue-job-computers';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const node = (id: string, name = id) => ({ id, name }) as RemoteNodeRosterEntry;
const machine = (change: Partial<TestMachineView> = {}): TestMachineView => ({
  host: 'harness-checks', platform: 'linux', label: 'the Windows PC', nodeName: 'windows-pc', paused: false, testRuns: true, checks: true, slots: 3, ...change,
});
const check = (change: Partial<QueueJobProjectCheck> = {}): QueueJobProjectCheck => ({
  ok: true, checkedAt: 1_700_000_000_000, problem: null, summary: 'Checks took 43 s.', ...change,
});

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'queue-job-computers-'));
  dirs.push(dir);
  file = join(dir, 'nested', 'queue-job-computers.json');
});

function store(options: Partial<QueueJobComputersOptions> = {}): QueueJobComputers {
  return new QueueJobComputers({
    file,
    roster: () => [node('windows-pc'), node('laptop')],
    choices: () => [],
    testMachines: () => [],
    ...options,
  });
}

describe('QueueJobComputers', () => {
  it('starts off, two jobs at once, with nothing checked, and writes nothing until something changes', () => {
    expect(store().list()).toEqual([
      { nodeId: 'windows-pc', label: 'windows-pc', takesJobs: false, paused: false, jobsAtOnce: 2, projects: {} },
      { nodeId: 'laptop', label: 'laptop', takesJobs: false, paused: false, jobsAtOnce: 2, projects: {} },
    ]);
    expect(() => readFileSync(file)).toThrow();
  });

  it('lists computers in the Computers page order, saved ones first', () => {
    const choices: ComputerChoice[] = [{ id: 'laptop', paused: false, sessions: true }];
    expect(store({ choices: () => choices }).list().map(entry => entry.nodeId)).toEqual(['laptop', 'windows-pc']);
  });

  it('takes the name and Pause from the places the page does', () => {
    const choices: ComputerChoice[] = [{ id: 'laptop', paused: true, sessions: true }];
    const listed = store({ choices: () => choices, testMachines: () => [machine({ paused: true })] }).list();
    expect(listed.find(entry => entry.nodeId === 'windows-pc')).toMatchObject({ label: 'the Windows PC', paused: true });
    expect(listed.find(entry => entry.nodeId === 'laptop')).toMatchObject({ label: 'laptop', paused: true });
  });

  it('switches Plan Queue jobs on and off and keeps it across a new store', () => {
    store().setTakesJobs('windows-pc', true);
    expect(store().list().find(entry => entry.nodeId === 'windows-pc')?.takesJobs).toBe(true);
    expect(store().list().find(entry => entry.nodeId === 'laptop')?.takesJobs).toBe(false);
    store().setTakesJobs('windows-pc', false);
    expect(store().list()[0]?.takesJobs).toBe(false);
  });

  it('keeps jobs at once from 1 to 8 and refuses anything else', () => {
    const computers = store();
    computers.setJobsAtOnce('windows-pc', 8);
    expect(store().list()[0]?.jobsAtOnce).toBe(8);
    computers.setJobsAtOnce('windows-pc', 1);
    expect(store().list()[0]?.jobsAtOnce).toBe(1);
    for (const bad of [0, 9, 2.5, Number.NaN]) {
      expect(() => computers.setJobsAtOnce('windows-pc', bad), String(bad)).toThrow(/whole number from 1 to 8/);
    }
    expect(store().list()[0]?.jobsAtOnce).toBe(1);
  });

  it('refuses to change a computer that is not paired, and writes nothing', () => {
    expect(() => store().setTakesJobs('stranger', true)).toThrow(/not paired/);
    expect(() => store().recordProjectCheck('stranger', 'repo-1', check())).toThrow(/not paired/);
    expect(() => readFileSync(file)).toThrow();
  });

  it('records project results by key, newest replacing older, and keeps them apart per computer', () => {
    const computers = store();
    computers.recordProjectCheck('windows-pc', 'repo-1', check({ ok: false, problem: 'Lint failed.' }));
    computers.recordProjectCheck('windows-pc', 'repo-2', check());
    computers.recordProjectCheck('windows-pc', 'repo-1', check({ checkedAt: 1_700_000_100_000 }));
    const [pc, laptop] = store().list();
    expect(pc?.projects).toEqual({ 'repo-1': check({ checkedAt: 1_700_000_100_000 }), 'repo-2': check() });
    expect(laptop?.projects).toEqual({});
  });

  it('cuts overlong text instead of refusing the result', () => {
    const computers = store();
    computers.recordProjectCheck('windows-pc', 'repo-1', check({ ok: false, problem: 'p'.repeat(5000), summary: 's'.repeat(5000) }));
    const stored = store().list()[0]!.projects['repo-1']!;
    expect(stored.problem).toHaveLength(2000);
    expect(stored.summary).toHaveLength(1000);
  });

  it('clears one project or all of a computer\'s results, and leaves its switch and other computers alone', () => {
    const computers = store();
    computers.setTakesJobs('windows-pc', true);
    computers.recordProjectCheck('windows-pc', 'repo-1', check());
    computers.recordProjectCheck('windows-pc', 'repo-2', check());
    computers.recordProjectCheck('laptop', 'repo-1', check());
    computers.clearProjectChecks('windows-pc', 'repo-1');
    expect(Object.keys(store().list()[0]!.projects)).toEqual(['repo-2']);
    computers.clearProjectChecks('windows-pc');
    const [pc, laptop] = store().list();
    expect(pc).toMatchObject({ takesJobs: true, projects: {} });
    expect(Object.keys(laptop!.projects)).toEqual(['repo-1']);
    expect(() => computers.clearProjectChecks('stranger')).not.toThrow();
  });

  it('keeps what was saved for a computer while it is not paired, and shows it again when it returns', () => {
    store().setTakesJobs('windows-pc', true);
    expect(store({ roster: () => [node('laptop')] }).list().map(entry => entry.nodeId)).toEqual(['laptop']);
    expect(store().list()[0]?.takesJobs).toBe(true);
  });

  it('writes the file in one step, leaving no half-written copy behind', () => {
    store().setTakesJobs('windows-pc', true);
    expect(readdirSync(join(dir, 'nested'))).toEqual(['queue-job-computers.json']);
  });

  it('refuses a file it can not read and does not overwrite it', () => {
    store().setTakesJobs('windows-pc', true);
    writeFileSync(file, '{ broken');
    expect(() => store().list()).toThrow();
    expect(() => store().setTakesJobs('laptop', true)).toThrow();
    writeFileSync(file, JSON.stringify({ version: 1, computers: { laptop: { takesJobs: 'yes', jobsAtOnce: 2, projects: {} } } }));
    expect(() => store().list()).toThrow(/can't be read/);
    expect(readFileSync(file, 'utf8')).toContain('"yes"');
  });

  it('is a lazy single store that tests can reset', () => {
    QueueJobComputers._resetForTesting();
    const first = QueueJobComputers.getInstance();
    expect(QueueJobComputers.getInstance()).toBe(first);
    QueueJobComputers._resetForTesting();
    expect(QueueJobComputers.getInstance()).not.toBe(first);
    QueueJobComputers._resetForTesting();
  });
});
