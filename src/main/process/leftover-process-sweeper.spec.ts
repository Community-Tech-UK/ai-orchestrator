import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetForTesting as resetCleanups } from '../util/cleanup-registry';
import { parseCpuSeconds } from './host-process-inspector';
import {
  LeftoverProcessSweeper,
  MAX_REMEMBERED_SESSIONS,
  parseProcessTable,
  type LeftoverProcessCleanupMode,
  type LeftoverSweeperRuntime,
  type OwnerState,
} from './leftover-process-sweeper';
import { SessionProcessLineage } from './session-process-lineage';

const HARNESS = 50;
const UID = 501;
const MARKER = 'AI_ORCHESTRATOR_INSTANCE_ID';

interface FakeProcess {
  pid: number;
  ppid: number;
  pgid: number;
  uid?: number;
  startSec: number;
  /** CPU cores this process uses from `busySinceSec` on. */
  cores?: number;
  busySinceSec?: number;
  command: string;
  env?: string;
}

function elapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

function cpuTime(seconds: number): string {
  // BSD form: unbounded minutes, two-decimal seconds.
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
}

class FakeMachine {
  readonly processes = new Map<number, FakeProcess>();
  readonly signals: Array<[number, NodeJS.Signals]> = [];
  readonly notices: string[] = [];
  mode: LeftoverProcessCleanupMode = 'stop-cpu-hogs';
  owners = new Map<string, OwnerState>();
  names = new Map<string, string>([['sess-1', 'Check flaky test']]);
  roots = new Map<number, string>();
  saved: unknown = null;
  envReadable = true;

  add(process: FakeProcess): void {
    this.processes.set(process.pid, process);
  }

  nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  runtime(overrides: Partial<LeftoverSweeperRuntime> = {}): LeftoverSweeperRuntime {
    return {
      platform: 'darwin',
      uid: UID,
      harnessPid: HARNESS,
      nowMs: () => Date.now(),
      runPs: async (args) => (args[0] === 'axeww' ? this.envTable() : this.table()),
      kill: (pid, signal) => {
        if (!this.processes.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        this.signals.push([pid, signal]);
        if (signal === 'SIGKILL') this.processes.delete(pid);
      },
      getOwnerState: (id) => this.owners.get(id) ?? 'unknown',
      getSessionName: (id) => (this.owners.has(id) ? this.names.get(id) : undefined),
      getLiveSessionRoots: () => this.roots,
      getLiveSessionPids: () => new Set(this.roots.keys()),
      getMode: () => this.mode,
      notify: (_title, body) => { this.notices.push(body); },
      readLineage: () => this.saved,
      writeLineage: (data) => { this.saved = JSON.parse(JSON.stringify(data)); },
      ...overrides,
    };
  }

  private table(): string {
    const now = this.nowSec();
    return [...this.processes.values()].map((p) => {
      const busy = p.cores ? Math.max(0, now - (p.busySinceSec ?? p.startSec)) * p.cores : 0;
      return `${p.pid} ${p.ppid} ${p.pgid} ${p.uid ?? UID} ${elapsed(now - p.startSec)} ${cpuTime(busy)} ${p.command}`;
    }).join('\n');
  }

  private envTable(): string {
    if (!this.envReadable) throw new Error('ps: environment unavailable');
    // Apple binaries (`yes`, `zsh`) show no environment, exactly as on macOS.
    return [...this.processes.values()].map((p) => `${p.pid} ${p.ppid} ${p.command}${p.env ? ` ${p.env}` : ''}`).join('\n');
  }
}

let machine: FakeMachine;
let sweeper: LeftoverProcessSweeper | null;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-23T12:00:00Z') });
  resetCleanups();
  machine = new FakeMachine();
  sweeper = null;
});

afterEach(() => {
  sweeper?.stop();
  vi.useRealTimers();
  resetCleanups();
});

/** The 23 October shape: an OpenCode session whose tool shell backgrounds two `yes` and exits 0. */
function incident(): { orphaned: () => void } {
  const now = machine.nowSec();
  machine.add({ pid: 100, ppid: HARNESS, pgid: 100, startSec: now - 3600, command: 'opencode acp', env: `${MARKER}=sess-1` });
  machine.add({ pid: 200, ppid: 100, pgid: 200, startSec: now - 5, command: '/bin/zsh -c for j in 1 2', env: '' });
  machine.add({ pid: 201, ppid: 200, pgid: 200, startSec: now - 4, cores: 0.72, command: 'yes' });
  machine.add({ pid: 202, ppid: 200, pgid: 200, startSec: now - 4, cores: 0.72, command: 'yes' });
  machine.roots.set(100, 'sess-1');
  machine.owners.set('sess-1', 'live');
  return {
    orphaned: () => {
      machine.processes.delete(200);
      for (const pid of [201, 202]) {
        machine.processes.get(pid)!.ppid = 1;
        machine.processes.get(pid)!.busySinceSec = machine.nowSec();
      }
    },
  };
}

async function advanceMinutes(minutes: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(minutes * 60_000);
}

describe('ps column parsing', () => {
  it('reads both the BSD and the procps cumulative CPU formats', () => {
    expect(parseCpuSeconds('0:00.01')).toBeCloseTo(0.01);
    expect(parseCpuSeconds('1234:56.78')).toBeCloseTo(1234 * 60 + 56.78);
    expect(parseCpuSeconds('01:02:03')).toBe(3723);
    expect(parseCpuSeconds('2-01:02:03')).toBe(2 * 86400 + 3723);
    expect(parseCpuSeconds('abc')).toBeNull();
  });

  it('turns elapsed time into a start time and keeps the command', () => {
    const rows = parseProcessTable('  201     1   200   501    01:00:05  43:12.50 yes\nnonsense', 10_000);
    expect(rows.get(201)).toEqual({
      pid: 201, ppid: 1, pgid: 200, uid: 501, startSec: 10_000 - 3605, cpuSeconds: 43 * 60 + 12.5, command: 'yes',
    });
    expect(rows.size).toBe(1);
  });
});

describe('SessionProcessLineage', () => {
  const rows = [
    { pid: 100, ppid: HARNESS, pgid: 100, uid: UID, startSec: 900 },
    { pid: 200, ppid: 100, pgid: 200, uid: UID, startSec: 990 },
    { pid: 201, ppid: 200, pgid: 200, uid: UID, startSec: 995 },
    { pid: 300, ppid: 100, pgid: 300, uid: 0, startSec: 990 },
  ];

  it('records each group under a live root and attributes leftovers that started inside the window', () => {
    const lineage = new SessionProcessLineage(10);
    lineage.record(rows, new Map([[100, 'sess-1']]), UID, 1000);
    expect(lineage.attribute(200, 995)).toBe('sess-1');
    expect(lineage.attribute(200, 1015)).toBe('sess-1');
    // Another user's process under the session is never recorded.
    expect(lineage.attribute(300, 995)).toBeUndefined();
  });

  it('refuses a group number that was reused after the session last held it', () => {
    const lineage = new SessionProcessLineage(10);
    lineage.record(rows, new Map([[100, 'sess-1']]), UID, 1000);
    expect(lineage.attribute(200, 5000)).toBeUndefined();
    expect(lineage.attribute(200, 900)).toBeUndefined();
  });

  it('survives a save and load, skipping malformed entries', () => {
    const lineage = new SessionProcessLineage(10);
    lineage.record(rows, new Map([[100, 'sess-1']]), UID, 1000);
    const restored = new SessionProcessLineage(10);
    const saved = lineage.toJSON();
    restored.load({ ...saved, entries: [...saved.entries, [1, { instanceId: 'x' }], ['bad', null]] });
    expect(restored.attribute(200, 995)).toBe('sess-1');
    expect(restored.size).toBe(saved.entries.length);
  });

  it('forgets groups after a day only once they have no members', () => {
    const lineage = new SessionProcessLineage(10);
    lineage.record(rows, new Map([[100, 'sess-1']]), UID, 1000);
    lineage.prune(new Set([200]), 1000 + 25 * 3600);
    expect(lineage.attribute(200, 995)).toBe('sess-1');
    lineage.prune(new Set(), 1000 + 25 * 3600);
    expect(lineage.attribute(200, 995)).toBeUndefined();
  });
});

describe('LeftoverProcessSweeper', () => {
  it('stops the incident\'s orphaned yes processes after an hour while their session is still open', async () => {
    const { orphaned } = incident();
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await vi.advanceTimersByTimeAsync(10_000);
    orphaned();

    await advanceMinutes(58);
    expect(machine.signals).toEqual([]);

    await advanceMinutes(4);
    expect(machine.signals).toEqual(expect.arrayContaining([[201, 'SIGTERM'], [202, 'SIGTERM']]));
    expect(machine.notices).toHaveLength(1);
    expect(machine.notices[0]).toBe(
      'Stopped 2 programs (2 × yes) from session "Check flaky test". A command left them running and they kept using CPU.',
    );

    // Still running ten seconds later: escalated, and only for the same processes.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(machine.signals).toEqual(expect.arrayContaining([[201, 'SIGKILL'], [202, 'SIGKILL']]));
    expect(machine.processes.has(201)).toBe(false);
  });

  it('treats a closed session that Harness has deleted as ended, so its burner stops after ten minutes', async () => {
    const { orphaned } = incident();
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await vi.advanceTimersByTimeAsync(10_000);
    orphaned();
    // Closing a session deletes it: the id becomes unknown rather than terminated.
    machine.owners.delete('sess-1');
    machine.roots.clear();
    machine.processes.delete(100);

    await advanceMinutes(12);
    expect(machine.signals).toEqual(expect.arrayContaining([[201, 'SIGTERM'], [202, 'SIGTERM']]));
    // The name was remembered while the session was live.
    expect(machine.notices[0]).toContain('from session "Check flaky test"');
  });

  it('keeps measuring a burner whose start time reads a second differently between sweeps', async () => {
    const { orphaned } = incident();
    machine.owners.set('sess-1', 'ended');
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await vi.advanceTimersByTimeAsync(10_000);
    orphaned();
    let flip = 0;
    const runtime = machine.runtime();
    const jittery = new LeftoverProcessSweeper({
      ...runtime,
      // ps reads its own clock: the derived start time wobbles by a second.
      runPs: async (args, maxBuffer) => {
        const out = await runtime.runPs(args, maxBuffer);
        if (args[0] === 'axeww') return out;
        flip += 1;
        return flip % 2 ? out : out.replace(/^(\d+ \d+ \d+ \d+ )(\d\d):(\d\d):(\d\d)/gm, (_m, head, h, m, sec) => {
          const total = Number(h) * 3600 + Number(m) * 60 + Number(sec) + 1;
          const pad = (n: number) => String(n).padStart(2, '0');
          return `${head}${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
        });
      },
    });
    sweeper.stop();
    sweeper = jittery;
    await jittery.refreshLineage();
    for (let minute = 0; minute < 12; minute += 1) {
      await advanceMinutes(1);
      await jittery.sweep();
    }
    expect(machine.signals).toEqual(expect.arrayContaining([[201, 'SIGTERM'], [202, 'SIGTERM']]));
  });

  it('stops them after ten minutes once the session has ended', async () => {
    const { orphaned } = incident();
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await vi.advanceTimersByTimeAsync(10_000);
    orphaned();
    machine.owners.set('sess-1', 'ended');
    machine.roots.clear();
    machine.processes.delete(100);

    await advanceMinutes(12);
    expect(machine.signals).toEqual(expect.arrayContaining([[201, 'SIGTERM'], [202, 'SIGTERM']]));
  });

  it('only reports a CPU burner in notify mode, once', async () => {
    const { orphaned } = incident();
    machine.mode = 'notify';
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await vi.advanceTimersByTimeAsync(10_000);
    orphaned();

    await advanceMinutes(75);
    expect(machine.signals).toEqual([]);
    expect(machine.notices).toHaveLength(1);
    expect(machine.notices[0]).toContain('using a lot of CPU');
  });

  it('never touches a busy orphan it cannot attribute to a session', async () => {
    const now = machine.nowSec();
    machine.add({ pid: 400, ppid: 1, pgid: 400, startSec: now - 60, cores: 1, command: 'yes' });
    machine.add({ pid: 401, ppid: 1, pgid: 401, startSec: now - 60, cores: 1, command: 'node server.js', env: 'HOME=/x' });
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await advanceMinutes(90);
    expect(machine.signals).toEqual([]);
    expect(machine.notices).toEqual([]);
  });

  it('never treats a program with a live parent as a leftover', async () => {
    const now = machine.nowSec();
    machine.add({ pid: 500, ppid: 499, pgid: 500, startSec: now - 60, cores: 1, command: 'node dev-server.js', env: `${MARKER}=gone` });
    machine.owners.set('gone', 'ended');
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await advanceMinutes(90);
    expect(machine.signals).toEqual([]);
  });

  it('reports an idle leftover of an ended session after an hour, and stops it only in stop-all mode', async () => {
    const now = machine.nowSec();
    machine.add({ pid: 600, ppid: 1, pgid: 600, startSec: now - 60, command: 'postgres -D /tmp/db', env: `${MARKER}=done` });
    machine.add({ pid: 601, ppid: 600, pgid: 600, startSec: now - 59, command: 'postgres: checkpointer', env: `${MARKER}=done` });
    machine.owners.set('done', 'ended');
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();

    await advanceMinutes(61);
    expect(machine.signals).toEqual([]);
    expect(machine.notices).toHaveLength(1);
    expect(machine.notices[0]).toBe(
      'One program (postgres) from an agent session is still running after its session was closed. If you do not need it, quit it in Activity Monitor (process 600).',
    );

    await advanceMinutes(30);
    expect(machine.notices).toHaveLength(1);

    machine.mode = 'stop-all';
    await advanceMinutes(1);
    // Child first, then the orphan itself.
    expect(machine.signals.slice(0, 2)).toEqual([[601, 'SIGTERM'], [600, 'SIGTERM']]);
  });

  it('does not stop an idle leftover whose session this run does not know, even in stop-all mode', async () => {
    const now = machine.nowSec();
    machine.add({ pid: 700, ppid: 1, pgid: 700, startSec: now - 60, command: 'java -jar server.jar', env: `${MARKER}=other-app` });
    machine.mode = 'stop-all';
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await advanceMinutes(70);
    expect(machine.signals).toEqual([]);
    expect(machine.notices).toEqual([
      'One program (java) started by a session that Harness no longer has open is still running, possibly from before Harness restarted. If you do not need it, quit it in Activity Monitor (process 700).',
    ]);
  });

  it('names the session by its current title, not the one it had when first seen', async () => {
    const { orphaned } = incident();
    machine.names.set('sess-1', 'New session');
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await vi.advanceTimersByTimeAsync(10_000);
    machine.names.set('sess-1', 'Check flaky test');
    orphaned();
    await advanceMinutes(62);
    expect(machine.notices[0]).toContain('from session "Check flaky test"');
  });

  it('counts only CPU used after a session closed toward the ten-minute window', async () => {
    const { orphaned } = incident();
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await vi.advanceTimersByTimeAsync(10_000);
    orphaned();
    // Burning for 30 minutes while the session is open: under the hour, so left alone.
    await advanceMinutes(30);
    machine.owners.delete('sess-1');
    machine.roots.clear();
    machine.processes.delete(100);

    await advanceMinutes(5);
    expect(machine.signals).toEqual([]);
    await advanceMinutes(7);
    expect(machine.signals).toEqual(expect.arrayContaining([[201, 'SIGTERM'], [202, 'SIGTERM']]));
  });

  it('starts measuring again when a pid now belongs to a different process', async () => {
    const { orphaned } = incident();
    machine.owners.set('sess-1', 'ended');
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await vi.advanceTimersByTimeAsync(10_000);
    orphaned();
    await advanceMinutes(8);
    // The original 201 exits and its pid is reused by a new burner in the same recorded group.
    const reused = machine.processes.get(201)!;
    reused.startSec = machine.nowSec();
    reused.busySinceSec = machine.nowSec();
    await advanceMinutes(4);
    // 202 (same process all along) has crossed ten minutes; the new 201 has not.
    expect(machine.signals.filter(([pid]) => pid === 201)).toEqual([]);
    expect(machine.signals).toContainEqual([202, 'SIGTERM']);
  });

  it('forgets the oldest remembered sessions past its cap, which then count as unknown', async () => {
    const { orphaned } = incident();
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await vi.advanceTimersByTimeAsync(10_000);
    orphaned();
    machine.processes.delete(100);
    machine.owners.delete('sess-1');
    // Many later sessions push sess-1 out of memory.
    machine.roots = new Map(Array.from({ length: MAX_REMEMBERED_SESSIONS + 1 }, (_, index) => [100_000 + index, `later-${index}`]));
    await vi.advanceTimersByTimeAsync(10_000);
    machine.roots.clear();

    await advanceMinutes(30);
    // Unknown owner: the 60-minute window applies, so nothing yet.
    expect(machine.signals).toEqual([]);
  });

  it('ignores a session root whose parent is not Harness (a reused pid)', async () => {
    const { orphaned } = incident();
    machine.processes.get(100)!.ppid = 777;
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await vi.advanceTimersByTimeAsync(10_000);
    orphaned();
    machine.owners.set('sess-1', 'ended');
    await advanceMinutes(90);
    expect(machine.signals).toEqual([]);
  });

  it('attributes leftovers from a previous run through the saved lineage (post-crash launch)', async () => {
    const { orphaned } = incident();
    const first = new LeftoverProcessSweeper(machine.runtime());
    first.start();
    await vi.advanceTimersByTimeAsync(10_000);
    first.stop();
    expect(machine.saved).not.toBeNull();

    orphaned();
    machine.processes.delete(100);
    machine.roots.clear();
    machine.owners.clear();
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await advanceMinutes(62);
    expect(machine.signals).toEqual(expect.arrayContaining([[201, 'SIGTERM'], [202, 'SIGTERM']]));
  });

  it('still attributes by lineage when process environments cannot be read', async () => {
    const { orphaned } = incident();
    machine.envReadable = false;
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await vi.advanceTimersByTimeAsync(10_000);
    orphaned();
    await advanceMinutes(62);
    expect(machine.signals).toEqual(expect.arrayContaining([[201, 'SIGTERM'], [202, 'SIGTERM']]));
  });

  it('does nothing when the setting is off', async () => {
    const { orphaned } = incident();
    machine.mode = 'off';
    sweeper = new LeftoverProcessSweeper(machine.runtime());
    sweeper.start();
    await vi.advanceTimersByTimeAsync(10_000);
    orphaned();
    await advanceMinutes(90);
    expect(machine.signals).toEqual([]);
    expect(await sweeper.stopAttributedAmong(new Set([201]))).toBe(0);
  });

  it('stops attributed leftovers among the given pids on request (a worktree being removed)', async () => {
    const now = machine.nowSec();
    machine.add({ pid: 800, ppid: 1, pgid: 800, startSec: now - 60, command: 'node dev-server.js', env: `${MARKER}=sess-2` });
    machine.add({ pid: 801, ppid: 1, pgid: 801, startSec: now - 60, command: 'node mine.js' });
    machine.owners.set('sess-2', 'ended');
    sweeper = new LeftoverProcessSweeper(machine.runtime());

    machine.mode = 'notify';
    expect(await sweeper.stopAttributedAmong(new Set([800, 801]))).toBe(0);
    machine.mode = 'stop-cpu-hogs';
    expect(await sweeper.stopAttributedAmong(new Set([800, 801]))).toBe(1);
    expect(machine.signals).toEqual([[800, 'SIGTERM']]);
  });

  it('does not run on Windows', async () => {
    incident();
    const runPs = vi.fn();
    sweeper = new LeftoverProcessSweeper(machine.runtime({ platform: 'win32', runPs }));
    sweeper.start();
    await advanceMinutes(5);
    expect(runPs).not.toHaveBeenCalled();
  });
});
