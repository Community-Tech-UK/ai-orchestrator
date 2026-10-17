import { describe, expect, it, vi } from 'vitest';

const logInfo = vi.hoisted(() => vi.fn());
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: logInfo, warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
import {
  formatRunningFor,
  listHostProcesses,
  parseElapsedSeconds,
  parseEnvMarkers,
  parsePsTable,
  stopLeftoverProcesses,
  type HostProcessRuntime,
} from './host-process-inspector';

const UID = 501;
const HARNESS_PID = 500;
const CALLER = 'caller-1';
const SECRET = 'sk-ant-api03-SUPERSECRETVALUE1234567890';

interface Proc {
  pid: number;
  ppid?: number;
  uid?: number;
  cpu?: number;
  rssKb?: number;
  etime?: string;
  command?: string;
  /** Text appended after the command in the environment table. */
  env?: string;
}

function marker(id: string): string {
  return `HOME=/Users/x ${`AI_ORCHESTRATOR_INSTANCE_ID=${id}`} API_KEY=${SECRET}`;
}

function tableOutput(procs: Proc[]): string {
  return procs.map((p) => [
    p.pid, p.ppid ?? 1, p.uid ?? UID, (p.cpu ?? 0).toFixed(1), p.rssKb ?? 2048, p.etime ?? '03:00',
    p.command ?? `/usr/bin/tool-${p.pid}`,
  ].join(' ')).join('\n');
}

function envOutput(procs: Proc[]): string {
  return procs.map((p) => `${p.pid} ${p.ppid ?? 1} ${p.command ?? `/usr/bin/tool-${p.pid}`} ${p.env ?? ''}`).join('\n');
}

interface Setup {
  runtime: HostProcessRuntime;
  kill: ReturnType<typeof vi.fn>;
  runPs: ReturnType<typeof vi.fn>;
}

function setup(procs: Proc[], options: {
  live?: string[];
  livePids?: number[];
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  platform?: NodeJS.Platform;
  envFails?: boolean;
  tableFails?: boolean;
} = {}): Setup {
  const kill = vi.fn(options.kill ?? (() => undefined));
  const runPs = vi.fn(async (args: string[]) => {
    if (args[0] === '-A') {
      if (options.tableFails) throw new Error('ps blew up');
      return tableOutput(procs);
    }
    if (options.envFails) throw new Error('env ps blew up');
    return envOutput(procs);
  });
  const live = new Set(options.live ?? []);
  return {
    kill,
    runPs,
    runtime: {
      platform: options.platform ?? 'darwin',
      uid: UID,
      harnessPid: HARNESS_PID,
      runPs,
      kill,
      isInstanceLive: (id) => live.has(id),
      getLiveSessionPids: () => new Set(options.livePids ?? []),
      cpuCount: () => 10,
      loadAverage: () => [1.234, 2, 3],
    },
  };
}

describe('parsing', () => {
  it('parses elapsed times and formats them for humans', () => {
    expect(parseElapsedSeconds('03:07')).toBe(187);
    expect(parseElapsedSeconds('01:02:03')).toBe(3723);
    expect(parseElapsedSeconds('2-01:00:00')).toBe(2 * 86400 + 3600);
    expect(parseElapsedSeconds('garbage')).toBeNull();
    expect(formatRunningFor(45)).toBe('45 s');
    expect(formatRunningFor(180)).toBe('3 min');
    expect(formatRunningFor(7200)).toBe('2 h');
    expect(formatRunningFor(86400)).toBe('1 day');
    expect(formatRunningFor(3 * 86400)).toBe('3 days');
    expect(formatRunningFor(null)).toBe('unknown');
  });

  it('skips headers and malformed rows in the process table', () => {
    const rows = parsePsTable([
      '  PID  PPID UID %CPU RSS ELAPSED COMMAND',
      '10 1 501 12.5 2048 03:00 /usr/bin/node server.js',
      'abc 1 501 1.0 1 00:01 bad-pid',
      '11 1 501 notnum 1 00:01 bad-cpu',
      '12 1 501 1.0',
      '0 1 501 1.0 1 00:01 pid-zero',
      '13 1 501 0.0 1024 00:05',
    ].join('\n'));
    expect([...rows.keys()]).toEqual([10, 13]);
    expect(rows.get(10)).toMatchObject({ ppid: 1, uid: 501, cpu: 12.5, rssKb: 2048, command: '/usr/bin/node server.js' });
    expect(rows.get(13)?.command).toBe('');
  });

  it('matches the marker only as a whole token', () => {
    const markers = parseEnvMarkers([
      '10 1 node a.js HOME=/x AI_ORCHESTRATOR_INSTANCE_ID=abc-123 B=1',
      '11 1 node a.js XAI_ORCHESTRATOR_INSTANCE_ID=abc-123',
      '12 1 node a.js --flag=AI_ORCHESTRATOR_INSTANCE_ID=abc-123',
      '13 1 node a.js AI_ORCHESTRATOR_INSTANCE_ID=bad/id',
      '14 1 node a.js AI_ORCHESTRATOR_INSTANCE_ID=a AI_ORCHESTRATOR_INSTANCE_ID=b',
      '15 1 node a.js AI_ORCHESTRATOR_INSTANCE_ID=',
      'not a row',
    ].join('\n'));
    expect(markers.get(10)?.marker).toEqual({ kind: 'id', id: 'abc-123' });
    expect(markers.get(11)?.marker).toEqual({ kind: 'none' });
    expect(markers.get(12)?.marker).toEqual({ kind: 'none' });
    expect(markers.get(13)?.marker).toEqual({ kind: 'invalid' });
    expect(markers.get(14)?.marker).toEqual({ kind: 'invalid' });
    expect(markers.get(15)?.marker).toEqual({ kind: 'invalid' });
    expect(markers.has(0)).toBe(false);
  });
});

describe('listHostProcesses', () => {
  const procs: Proc[] = [
    { pid: 10, cpu: 5, command: '/usr/bin/low', rssKb: 1024 },
    { pid: 11, cpu: 90.44, command: '/opt/bin/Busy Thing --flag', rssKb: 10 * 1024 },
    { pid: 12, cpu: 40, command: '/usr/bin/mid' },
    { pid: 13, cpu: 40, command: '/usr/bin/mid2' },
  ];

  it('sorts by CPU, applies the limit and reports a summary', async () => {
    const { runtime } = setup(procs);
    const result = await listHostProcesses(runtime, { limit: 3, callerInstanceId: CALLER });
    expect(result.processes.map((p) => p.pid)).toEqual([11, 12, 13]);
    expect(result.processes[0]).toMatchObject({ cpuPercent: 90.4, memoryMb: 10, runningFor: '3 min', ownedByYou: true });
    expect(result.summary).toEqual({ totalProcesses: 4, matchingProcesses: 4, cpuCount: 10, loadAverage: [1.23, 2, 3] });
  });

  it('defaults to 20 rows and clamps the limit', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ pid: i + 10, cpu: i }));
    const { runtime } = setup(many);
    expect((await listHostProcesses(runtime, { callerInstanceId: CALLER })).processes).toHaveLength(20);
    expect((await listHostProcesses(runtime, { limit: 1000, callerInstanceId: CALLER })).processes).toHaveLength(100);
    expect((await listHostProcesses(runtime, { limit: 0, callerInstanceId: CALLER })).processes).toHaveLength(1);
  });

  it('filters case-insensitively on the sanitised label only', async () => {
    const withSecretArg: Proc[] = [
      ...procs,
      { pid: 14, command: '/usr/bin/runner', env: `ZZZ_ENV_ONLY=1 ${marker('x')}` },
    ];
    const { runtime } = setup(withSecretArg);
    const byName = await listHostProcesses(runtime, { nameFilter: 'BUSY', callerInstanceId: CALLER });
    expect(byName.processes.map((p) => p.pid)).toEqual([11]);
    expect(byName.summary.matchingProcesses).toBe(1);
    const byEnv = await listHostProcesses(runtime, { nameFilter: 'ZZZ_ENV_ONLY', callerInstanceId: CALLER });
    expect(byEnv.processes).toEqual([]);
  });

  it('never leaks command lines, environments or secrets', async () => {
    const { runtime } = setup([
      { pid: 20, command: `/usr/bin/node /tmp/server.js --token ${SECRET}`, env: marker(CALLER), cpu: 1 },
      { pid: 21, command: `/bin/zsh -c "curl -H 'Authorization: Bearer ${SECRET}'"`, cpu: 2 },
    ]);
    const text = JSON.stringify(await listHostProcesses(runtime, { callerInstanceId: CALLER }));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('API_KEY');
    expect(text).not.toContain('HOME=');
    expect(text).not.toContain('AI_ORCHESTRATOR_INSTANCE_ID');
    expect(text).not.toContain('--token');
  });

  it('shows only the program name, never short positional arguments', async () => {
    const { runtime } = setup([{ pid: 22, command: '/usr/bin/sshpass hunter2 ssh box', cpu: 1 }]);
    const result = await listHostProcesses(runtime, { callerInstanceId: CALLER });
    expect(result.processes[0]?.label).toBe('sshpass');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('keeps the whole shell label so a shell filter can match', async () => {
    const { runtime } = setup([{ pid: 23, command: '/bin/zsh -c "sleep 100"', cpu: 1 }]);
    const result = await listHostProcesses(runtime, { nameFilter: 'shell', callerInstanceId: CALLER });
    expect(result.processes.map((p) => p.label)).toEqual(['a shell command']);
  });

  it('lists only leftovers, however idle, when asked', async () => {
    const { runtime } = setup([
      { pid: 24, cpu: 50 },
      { pid: 25, cpu: 0, env: marker('dead') },
      { pid: 26, cpu: 0, env: marker('sibling') },
    ], { live: ['sibling'] });
    const result = await listHostProcesses(runtime, { leftoverOnly: true, limit: 1, callerInstanceId: CALLER });
    expect(result.summary.matchingProcesses).toBe(2);
    expect(result.processes.map((p) => p.pid)).toEqual([25]);
  });

  it('flags leftovers and stoppable rows, with plain refusal reasons', async () => {
    const { runtime } = setup([
      { pid: 30, cpu: 9, env: marker(CALLER) },
      { pid: 31, cpu: 8, env: marker('sibling') },
      { pid: 32, cpu: 7, env: marker('dead') },
      { pid: 33, cpu: 6, ppid: 400, env: marker(CALLER) },
      { pid: 34, cpu: 5 },
      { pid: 35, cpu: 4, uid: 0, env: marker(CALLER) },
    ], { live: ['sibling'] });
    const rows = new Map((await listHostProcesses(runtime, { callerInstanceId: CALLER })).processes.map((p) => [p.pid, p]));
    expect(rows.get(30)).toMatchObject({ leftover: true, stoppable: true });
    expect(rows.get(30)?.stopRefusal).toBeUndefined();
    expect(rows.get(31)).toMatchObject({ leftover: true, stoppable: false, stopRefusal: 'belongs to another session that is still running' });
    expect(rows.get(32)).toMatchObject({ leftover: true, stoppable: true });
    expect(rows.get(33)).toMatchObject({ leftover: false, stoppable: false, stopRefusal: 'still has a parent program, so it is not a leftover' });
    expect(rows.get(34)).toMatchObject({ leftover: false, stopRefusal: 'was not started by a Harness session' });
    expect(rows.get(35)).toMatchObject({ ownedByYou: false, leftover: false, stopRefusal: 'is not owned by you' });
  });

  it('treats other-user rows that show no environment as unmarked', async () => {
    const { runtime } = setup([{ pid: 40, uid: 0, command: '/usr/sbin/daemon' }]);
    const row = (await listHostProcesses(runtime, { callerInstanceId: CALLER })).processes[0]!;
    expect(row).toMatchObject({ ownedByYou: false, leftover: false, stoppable: false });
  });

  it('degrades with a note when the environment table cannot be read', async () => {
    const { runtime } = setup([{ pid: 30, env: marker(CALLER) }], { envFails: true });
    const result = await listHostProcesses(runtime, { callerInstanceId: CALLER });
    expect(result.processes[0]).toMatchObject({ leftover: false, stoppable: false });
    expect(result.notes?.[0]).toMatch(/could not be read/);
  });

  it('fails when the process list itself cannot be read, and on Windows', async () => {
    await expect(listHostProcesses(setup([], { tableFails: true }).runtime, { callerInstanceId: CALLER }))
      .rejects.toThrow(/Could not read the process list/);
    const win = setup([], { platform: 'win32' });
    await expect(listHostProcesses(win.runtime, { callerInstanceId: CALLER })).rejects.toThrow(/not supported on Windows/);
    expect(win.runPs).not.toHaveBeenCalled();
  });

  it('uses the BSD dash-less selector for the environment table', async () => {
    const { runtime, runPs } = setup([]);
    await listHostProcesses(runtime, { callerInstanceId: CALLER });
    expect(runPs.mock.calls.map((c) => (c[0] as string[])[0]).sort()).toEqual(['-A', 'axeww']);
  });
});

describe('stopLeftoverProcesses', () => {
  const stop = (s: Setup, pids: number[], force?: boolean) =>
    stopLeftoverProcesses(s.runtime, { pids, callerInstanceId: CALLER, ...(force === undefined ? {} : { force }) });

  it('stops the caller\'s own leftover with SIGTERM', async () => {
    const s = setup([{ pid: 30, env: marker(CALLER) }]);
    const result = await stop(s, [30]);
    expect(result.results).toEqual([{ pid: 30, outcome: 'stopped' }]);
    expect(s.kill).toHaveBeenCalledWith(30, 'SIGTERM');
    expect(result.summary).toMatch(/Asked 1 program to stop/);
  });

  it('ignores a marker typed on the command line rather than inherited', async () => {
    const forged = `/usr/bin/node app.js AI_ORCHESTRATOR_INSTANCE_ID=dead`;
    const s = setup([{ pid: 33, command: forged, env: 'HOME=/Users/x' }]);
    const result = await stop(s, [33]);
    expect(result.results[0]).toMatchObject({ outcome: 'refused', reason: 'was not started by a Harness session' });
    expect(s.kill).not.toHaveBeenCalled();
  });

  it('logs who stopped what, without any marker or environment text', async () => {
    logInfo.mockClear();
    const s = setup([{ pid: 36, env: marker(CALLER) }]);
    await stop(s, [36]);
    expect(logInfo).toHaveBeenCalledWith('stop_leftover_processes', {
      callerInstanceId: CALLER,
      signal: 'SIGTERM',
      results: [{ pid: 36, outcome: 'stopped' }],
    });
  });

  it('stops a dead session\'s leftover', async () => {
    const s = setup([{ pid: 32, env: marker('dead') }], { live: ['sibling'] });
    expect((await stop(s, [32])).results[0]?.outcome).toBe('stopped');
  });

  it('uses SIGKILL when forced', async () => {
    const s = setup([{ pid: 30, env: marker(CALLER) }]);
    const result = await stop(s, [30], true);
    expect(s.kill).toHaveBeenCalledWith(30, 'SIGKILL');
    expect(result.summary).toMatch(/Force-stopped/);
  });

  it.each([
    ['Harness itself', { pid: HARNESS_PID, env: marker(CALLER) }, 'is Harness itself'],
    ['another user', { pid: 31, uid: 0, env: marker(CALLER) }, 'is not owned by you'],
    ['has a parent', { pid: 32, ppid: 77, env: marker(CALLER) }, 'still has a parent program, so it is not a leftover'],
    ['unmarked', { pid: 33 }, 'was not started by a Harness session'],
    ['marker as substring only', { pid: 34, env: `X_AI_ORCHESTRATOR_INSTANCE_ID=${CALLER}` }, 'was not started by a Harness session'],
    ['implausible marker', { pid: 35, env: 'AI_ORCHESTRATOR_INSTANCE_ID=../../etc' }, 'was not started by a Harness session'],
    ['live sibling', { pid: 36, env: marker('sibling') }, 'belongs to another session that is still running'],
    ['live session pid', { pid: 37, env: marker('dead') }, "is a live session's own program"],
  ] satisfies Array<[string, Proc, string]>)('refuses %s', async (_name, proc, reason) => {
    const s = setup([proc], { live: ['sibling'], livePids: [37] });
    const result = await stop(s, [proc.pid]);
    expect(result.results).toEqual([{ pid: proc.pid, outcome: 'refused', reason }]);
    expect(s.kill).not.toHaveBeenCalled();
  });

  it('refuses pid 1 and invalid pids without signalling', async () => {
    const s = setup([{ pid: 1, ppid: 0, env: marker(CALLER) }]);
    const result = await stop(s, [1, 0, -4, 1.5]);
    expect(result.results.map((r) => r.outcome)).toEqual(['refused', 'refused', 'refused', 'refused']);
    expect(s.kill).not.toHaveBeenCalled();
  });

  it('reports a pid that is no longer running as already exited', async () => {
    const s = setup([]);
    expect((await stop(s, [999])).results).toEqual([{ pid: 999, outcome: 'already-exited', reason: 'is no longer running' }]);
  });

  it('takes a fresh snapshot for every call', async () => {
    const s = setup([{ pid: 30, env: marker(CALLER) }]);
    await stop(s, [30]);
    await stop(s, [30]);
    expect(s.runPs).toHaveBeenCalledTimes(4);
  });

  it('refuses everything when the environment table cannot be read', async () => {
    const s = setup([{ pid: 30, env: marker(CALLER) }], { envFails: true });
    const result = await stop(s, [30]);
    expect(result.results[0]?.outcome).toBe('refused');
    expect(s.kill).not.toHaveBeenCalled();
  });

  it('stops same-marker descendants deepest first and leaves unmarked ones alone', async () => {
    const s = setup([
      { pid: 30, env: marker(CALLER) },
      { pid: 31, ppid: 30, env: marker(CALLER) },
      { pid: 32, ppid: 31, env: marker(CALLER) },
      { pid: 33, ppid: 30 },
      { pid: 34, ppid: 30, env: marker('other-session') },
      { pid: 35, ppid: 30, uid: 0, env: marker(CALLER) },
      { pid: 36, ppid: 33, env: marker(CALLER) },
      { pid: 37, ppid: 30, env: marker(CALLER) },
    ], { livePids: [37] });
    const result = await stop(s, [30]);
    const killed = s.kill.mock.calls.map((c) => c[0] as number);
    expect(killed.slice(-1)).toEqual([30]);
    expect(killed.indexOf(32)).toBeLessThan(killed.indexOf(31));
    expect(killed.indexOf(36)).toBeLessThan(killed.indexOf(30));
    expect(killed).not.toContain(33);
    expect(killed).not.toContain(34);
    expect(killed).not.toContain(35);
    expect(killed).not.toContain(37);
    expect(result.results[0]).toMatchObject({ pid: 30, outcome: 'stopped' });
    expect([...(result.results[0]?.alsoStopped ?? [])].sort()).toEqual([31, 32, 36]);
    expect(result.summary).toMatch(/plus 3 of their child programs/);
  });

  it('reports a requested child as stopped together with its approved parent', async () => {
    const s = setup([
      { pid: 30, env: marker(CALLER) },
      { pid: 31, ppid: 30, env: marker(CALLER) },
    ]);
    const result = await stop(s, [31, 30]);
    expect(result.results.map((r) => [r.pid, r.outcome])).toEqual([[31, 'stopped'], [30, 'stopped']]);
    expect(result.results[0]?.reason).toBe('stopped together with program 30');
    expect(s.kill.mock.calls.filter((c) => c[0] === 31)).toHaveLength(1);
  });

  it('treats ESRCH as already exited, not a failure', async () => {
    const esrch = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    const s = setup([{ pid: 30, env: marker(CALLER) }], { kill: () => { throw esrch; } });
    const result = await stop(s, [30]);
    expect(result.results[0]).toMatchObject({ pid: 30, outcome: 'already-exited' });
    expect(result.summary).toMatch(/had already exited/);
  });

  it('reports other kill errors as failed and keeps going', async () => {
    const eperm = Object.assign(new Error('nope'), { code: 'EPERM' });
    const s = setup([
      { pid: 30, env: marker(CALLER) },
      { pid: 31, env: marker(CALLER) },
    ], { kill: (pid) => { if (pid === 30) throw eperm; } });
    const result = await stop(s, [30, 31]);
    expect(result.results.map((r) => r.outcome)).toEqual(['failed', 'stopped']);
    expect(result.results[0]?.reason).toBe('the system refused to stop it');
  });

  it('notes child programs that could not be stopped', async () => {
    const eperm = Object.assign(new Error('nope'), { code: 'EPERM' });
    const s = setup([
      { pid: 30, env: marker(CALLER) },
      { pid: 31, ppid: 30, env: marker(CALLER) },
    ], { kill: (pid) => { if (pid === 31) throw eperm; } });
    const result = await stop(s, [30]);
    expect(result.results[0]).toMatchObject({ outcome: 'stopped', reason: '1 of its child programs could not be stopped' });
  });

  it('deduplicates pids and rejects on Windows', async () => {
    const s = setup([{ pid: 30, env: marker(CALLER) }]);
    const result = await stop(s, [30, 30]);
    expect(result.results).toHaveLength(1);
    expect(s.kill).toHaveBeenCalledTimes(1);
    await expect(stop(setup([], { platform: 'win32' }), [30])).rejects.toThrow(/not supported on Windows/);
  });

  it('never puts environment values in results', async () => {
    const s = setup([{ pid: 30, env: marker(CALLER) }, { pid: 31, env: marker('sibling') }], { live: ['sibling'] });
    const text = JSON.stringify(await stop(s, [30, 31]));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('API_KEY');
  });
});
