import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerExactSecretValue, unregisterExactSecretValue } from '../security/secret-detector';
import { describeStallProcessFacts, isNotableStallFact, sampleStallProcessFacts, type StallProcessFacts } from './stall-process-facts';

const header = '  PID  PPID STAT       TIME     ELAPSED   RSS COMMAND';
const root = ' 100 1 S 00:01.00 10:00 2048 /usr/bin/claude';
const row = (pid: number, ppid: number, age: string, command: string, stat = 'S', cpu = '0:00.00', rss = 2048) =>
  `${pid} ${ppid} ${stat} ${cpu} ${age} ${rss} ${command}`;

async function sample(first: string, second = first, silenceMs = 900_000) {
  let time = 1000;
  return sampleStallProcessFacts(100, {
    platform: 'darwin', silenceMs,
    runPs: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    sleep: async () => { time += 1500; }, now: () => time,
  });
}

function facts(overrides: Partial<StallProcessFacts> = {}): StallProcessFacts {
  return { pid: 100, state: 'sleeping', cpuPercent: 0, rssMb: 2, child: null, sampledAt: 2500, ...overrides };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('sampleStallProcessFacts', () => {
  it('parses macOS headers and calculates CPU across two wall-clock samples', async () => {
    const result = await sample(`${header}\n${root}`, `${header}\n${row(100, 1, '10:02', '/usr/bin/claude', 'R+', '0:02.44')}`);
    expect(result).toEqual(facts({ state: 'running', cpuPercent: 96 }));
  });

  it.each([
    ['linux hours', '01:00:00', '01:00:01.50'],
    ['days', '2-01:00:00', '2-01:00:01.50'],
    ['minutes', '04:00.00', '04:01.50'],
  ])('parses %s durations', async (_, first, second) => {
    const result = await sample(row(100, 1, '2-01:00:00', 'claude', 'Sl', first), row(100, 1, '2-01:00:02', 'claude', 'Sl', second));
    expect(result?.cpuPercent).toBe(100);
  });

  it.each([['R', 'running'], ['S', 'sleeping'], ['I', 'sleeping'], ['D', 'disk-wait'], ['U', 'disk-wait'], ['T', 'stopped'], ['t', 'stopped'], ['Z', 'zombie']])('reads state %s', async (stat, expected) => {
    expect((await sample(row(100, 1, '10:00', 'claude', stat)))?.state).toBe(expected);
  });

  it('retains a single-sample observation with unknown CPU when the second pid is absent', async () => {
    expect(await sample(root, header)).toEqual(facts({ state: 'unknown', cpuPercent: null }));
  });

  it('does not describe a historical child as a current wait after the parent disappears', async () => {
    const result = await sample(`${root}\n${row(101, 100, '00:02', 'npm test')}`, header);
    expect(result).toEqual(facts({ state: 'unknown', cpuPercent: null }));
    expect(describeStallProcessFacts(result!)).not.toContain('waiting on');
  });

  it('does not name a helper that predates the silence', async () => {
    expect((await sample(`${root}\n${row(101, 100, '30:00', 'node tool-server.mjs')}`))?.child).toBeNull();
  });

  it('follows the longest-running child chain through shell wrappers', async () => {
    const table = [root, row(101, 100, '14:00', 'sh -c npm test'), row(102, 101, '14:00', 'npm test'), row(103, 100, '00:02', 'node helper.mjs')].join('\n');
    expect((await sample(table))?.child).toEqual({ label: 'npm test', runningSeconds: 840, cpuPercent: 0 });
  });

  it('describes a leaf shell without its raw script', async () => {
    const result = await sample(`${root}\n${row(101, 100, '00:02', 'zsh -c echo PRIVATE_VALUE_PLACEHOLDER')}`);
    expect(result?.child?.label).toBe('a shell command');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE_PLACEHOLDER');
  });

  it('uses a script name without extension and omits flags and flag values', async () => {
    const result = await sample(`${root}\n${row(101, 100, '14:00', 'node /tmp/vitest.mjs run --reporter=json --token TOKEN_PLACEHOLDER')}`);
    expect(result?.child?.label).toBe('vitest run');
    expect(JSON.stringify(result)).not.toContain('TOKEN_PLACEHOLDER');
  });

  it('redacts credentials before shortening labels and never stores a raw command', async () => {
    const result = await sample(`${root}\n${row(101, 100, '00:02', 'npm test --token=TOKEN_PLACEHOLDER')}`);
    expect(result?.child?.label).toBe('npm test');
    expect(JSON.stringify(result)).not.toContain('TOKEN_PLACEHOLDER');
    const long = await sample(`${root}\n${row(101, 100, '00:02', `${'p'.repeat(70)} test`)}`);
    expect(long?.child?.label.length).toBeLessThanOrEqual(60);
  });

  it('uses the shared secret redactor on positional arguments', async () => {
    registerExactSecretValue('SECRET_PLACEHOLDER', 'test-placeholder');
    try {
      const result = await sample(`${root}\n${row(101, 100, '00:02', 'npm SECRET_PLACEHOLDER')}`);
      expect(result?.child?.label).toBe('npm [REDACTED:test-placeholder]');
      expect(JSON.stringify(result)).not.toContain('SECRET_PLACEHOLDER');
    } finally { unregisterExactSecretValue('SECRET_PLACEHOLDER'); }
  });

  it.each([0, 1, -1, null, 1.5, NaN])('refuses non-local pid %s without invoking ps', async (pid) => {
    const runPs = vi.fn();
    expect(await sampleStallProcessFacts(pid, { silenceMs: 70_000, runPs })).toBeNull();
    expect(runPs).not.toHaveBeenCalled();
  });

  it('refuses win32 without invoking ps', async () => {
    const runPs = vi.fn();
    expect(await sampleStallProcessFacts(100, { silenceMs: 70_000, platform: 'win32', runPs })).toBeNull();
    expect(runPs).not.toHaveBeenCalled();
  });

  it('returns null for a failing ps or absent first pid', async () => {
    expect(await sampleStallProcessFacts(100, { silenceMs: 70_000, runPs: async () => { throw new Error('not permitted'); } })).toBeNull();
    expect(await sample(header)).toBeNull();
  });

  it('caps a hung sample at five seconds', async () => {
    vi.useFakeTimers();
    const pending = sampleStallProcessFacts(100, { silenceMs: 70_000, runPs: () => new Promise(() => undefined) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not signal or stop processes while collecting or describing facts', async () => {
    const kill = vi.spyOn(process, 'kill');
    const result = await sample(root);
    describeStallProcessFacts(result!);
    expect(kill).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('samples the real ps format and names sleep 30', async (ctx) => {
    const child = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore', detached: true });
    await once(child, 'spawn');
    try {
      const result = await sampleStallProcessFacts(child.pid ?? null, { silenceMs: 70_000 });
      if (!result) { ctx.skip(); return; }
      expect(result.child?.label).toBe('sleep 30');
    } finally { if (child.pid) process.kill(-child.pid, 'SIGTERM'); }
  }, 10_000);
});

describe('describeStallProcessFacts', () => {
  it.each([
    ['stopped', 'paused by the system'], ['zombie', 'already exited'], ['disk-wait', 'waiting on the disk or network'],
  ] as const)('prioritizes %s over CPU and child evidence', (state, text) => {
    expect(describeStallProcessFacts(facts({ state, cpuPercent: 96, child: { label: 'npm test', runningSeconds: 840, cpuPercent: 0 } }))).toContain(text);
  });

  it('reports busy CPU before a child', () => {
    expect(describeStallProcessFacts(facts({ cpuPercent: 96, child: { label: 'npm test', runningSeconds: 840, cpuPercent: 0 } }))).toContain('busy, using 96% of a CPU');
  });

  it('names the child, age and CPU', () => {
    expect(describeStallProcessFacts(facts({ child: { label: 'npm test', runningSeconds: 840, cpuPercent: 0 } }))).toBe('Harness checked the process: it is waiting on "npm test", a program it started 14 min ago (using 0% of a CPU).');
  });

  it('does not claim a CPU reading when the process disappeared before the second sample', () => {
    expect(describeStallProcessFacts(facts({ cpuPercent: null }))).toContain('CPU use could not be measured');
  });

  it('adds the memory suffix only at four GB and makes the plain quiet case non-notable', () => {
    expect(describeStallProcessFacts(facts({ rssMb: 4300.8 }))).toContain('It is using 4.2 GB of memory.');
    expect(describeStallProcessFacts(facts({ rssMb: 4095 }))).not.toContain('of memory');
    expect(isNotableStallFact(facts())).toBe(false);
    expect(isNotableStallFact(facts({ cpuPercent: 80 }))).toBe(true);
    expect(isNotableStallFact(facts({ state: 'stopped' }))).toBe(true);
  });
});
