/**
 * Leftover process sweeper: finds programs that a Harness session started and
 * abandoned, and stops the ones that keep burning CPU.
 *
 * Why it exists (docs/plans/2026-10-24-agent-leftover-processes_report.md):
 * agent CLIs run shell commands outside their own process group, so stopping a
 * session never reaches what those commands started, and nothing runs when a
 * command exits normally. On 23 October 2026 eight `yes` processes left by an
 * OpenCode session burned six cores for ten hours.
 *
 * Scope is deliberately narrow (spec section 4.2):
 *  - only same-user programs reparented to launchd (ppid 1), so nothing still
 *    owned by a terminal or a live parent is ever a candidate;
 *  - only programs attributed to a Harness session, by the inherited
 *    `AI_ORCHESTRATOR_INSTANCE_ID` marker or by the session's recorded process
 *    groups (`SessionProcessLineage`, which covers Apple binaries whose
 *    environment macOS hides);
 *  - a CPU burner (a subtree averaging at least half a core for ten minutes
 *    after its session ended, or for an hour while the session is still open)
 *    is stopped under the default setting; an idle leftover of a finished
 *    session is only reported unless the setting says otherwise. Hibernated and
 *    errored owners count as live, matching the host-process stop rules.
 */

import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';
import type { AppSettings } from '../../shared/types/settings.types';
import {
  parseCpuSeconds,
  parseElapsedSeconds,
  programLabel,
  resolveEnvMarkers,
  type Marker,
} from './host-process-inspector';
import { SessionProcessLineage, type LineageProcessRow } from './session-process-lineage';
import { listFolderProcessPids } from '../workspace/git/leftover-worktree-processes';

const logger = getLogger('LeftoverProcessSweeper');

export type LeftoverProcessCleanupMode = AppSettings['leftoverProcessCleanup'];
export type OwnerState = 'live' | 'ended' | 'unknown';

export const LINEAGE_INTERVAL_MS = 10_000;
export const SWEEP_EVERY_TICKS = 6;
/** CPU window when this Harness run saw the owning session end. */
export const CPU_WINDOW_SEC = 10 * 60;
/**
 * CPU window while the owning session is still open, or is not known to this run: an agent may
 * have backgrounded a long test run or build it is still polling (possibly in another Harness app
 * on this Mac), so only an hour of sustained use counts as runaway.
 */
export const LIVE_OWNER_CPU_WINDOW_SEC = 60 * 60;
/** Half of one core, averaged over the window. */
export const CPU_HOG_CORES = 0.5;
export const ENDED_GRACE_SEC = 60 * 60;
export const STOP_ESCALATION_MS = 10_000;
const PS_TABLE_MAX_BYTES = 16 * 1024 * 1024;
const PS_ENV_MAX_BYTES = 64 * 1024 * 1024;
const PERSIST_MIN_INTERVAL_MS = 60_000;
const NOTICE_MAX_LABELS = 5;
/** `ps` derives start times from its own whole-second clock, so the same process can read ±1 s apart. */
const START_JITTER_SEC = 3;
export const MAX_REMEMBERED_SESSIONS = 5_000;
const SLOW_TABLE_MS = 500;

export interface SweeperProcessRow extends LineageProcessRow {
  cpuSeconds: number;
  command: string;
}

export interface LeftoverSweeperRuntime {
  platform: NodeJS.Platform;
  uid: number | null;
  harnessPid: number;
  nowMs(): number;
  runPs(args: string[], maxBuffer: number): Promise<string>;
  kill(pid: number, signal: NodeJS.Signals): void;
  /**
   * `ended` once this Harness run saw the session terminate or fail. `unknown` for an id this
   * run does not know: a session from before a crash, or one in another Harness app on the same
   * Mac. Hibernated and errored sessions are `live`.
   */
  getOwnerState(instanceId: string): OwnerState;
  /** The session's display name while Harness still knows it. */
  getSessionName(instanceId: string): string | undefined;
  /** Running session CLI pid → instance id. */
  getLiveSessionRoots(): ReadonlyMap<number, string>;
  /** Every pid Harness tracks for a session, live or stored; never a candidate. */
  getLiveSessionPids(): ReadonlySet<number>;
  getMode(): LeftoverProcessCleanupMode;
  notify(title: string, body: string): void;
  readLineage(): unknown;
  writeLineage(data: unknown): void;
}

interface Candidate {
  pid: number;
  startSec: number;
  instanceId: string;
  label: string;
  /** Candidate and same-user descendants, deepest first, with their start times. */
  subtree: Array<{ pid: number; startSec: number }>;
  cpuSeconds: number;
}

interface Tracked {
  startSec: number;
  samples: Array<{ atSec: number; cpuSeconds: number }>;
  deadSinceSec: number | null;
  reported: boolean;
}

export interface SweepEntry {
  pid: number;
  label: string;
  instanceId: string;
  sessionName?: string;
}

export interface SweepSummary {
  candidates: number;
  stoppedHogs: SweepEntry[];
  stoppedEnded: SweepEntry[];
  reportedHogs: SweepEntry[];
  reportedEnded: SweepEntry[];
  /** Idle leftovers whose session this run never saw: a crashed earlier run, or another Harness app. */
  reportedUnknown: SweepEntry[];
}

export function parseProcessTable(stdout: string, nowSec: number): Map<number, SweeperProcessRow> {
  const rows = new Map<number, SweeperProcessRow>();
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/u.exec(line);
    if (!match) continue;
    const [pid, ppid, pgid, uid] = [match[1], match[2], match[3], match[4]].map(Number) as [number, number, number, number];
    const elapsed = parseElapsedSeconds(match[5]!);
    const cpuSeconds = parseCpuSeconds(match[6]!);
    if (!Number.isSafeInteger(pid) || pid < 1 || elapsed === null || cpuSeconds === null) continue;
    rows.set(pid, { pid, ppid, pgid, uid, startSec: nowSec - elapsed, cpuSeconds, command: match[7] ?? '' });
  }
  return rows;
}

export class LeftoverProcessSweeper {
  private readonly lineage = new SessionProcessLineage(LINEAGE_INTERVAL_MS / 1000);
  /** Candidate state by pid; the start time tells a reused pid apart. */
  private readonly tracked = new Map<number, Tracked>();
  /**
   * Sessions this run has seen live, with their names. Harness deletes a session when it is
   * closed, so "seen live, now unknown" is how a closed session is recognised as ended.
   */
  private readonly seenLive = new Map<string, string | undefined>();
  private tableCostLogged = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private running = false;
  private lastPersistMs = 0;
  private unregisterCleanup: (() => void) | null = null;

  constructor(private readonly runtime: LeftoverSweeperRuntime) {
    try {
      this.lineage.load(runtime.readLineage());
    } catch (error) {
      logger.warn('Could not read the saved process lineage; starting empty', { error: errorText(error) });
    }
  }

  /** Begin the 10 s lineage tick and the 60 s sweep. No-op on Windows (phase 2). */
  start(): void {
    if (this.timer || this.runtime.platform === 'win32' || this.runtime.uid === null) return;
    this.timer = setInterval(() => { void this.onTick(); }, LINEAGE_INTERVAL_MS);
    this.timer.unref?.();
    this.unregisterCleanup = registerCleanup(() => this.stop());
    // A sweep right away also covers what a crashed previous run left behind.
    void this.onTick(true);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unregisterCleanup?.();
    this.unregisterCleanup = null;
    this.persist(true);
  }

  /** Record the live sessions' process groups now (the 10 s tick does this on its own). */
  async refreshLineage(): Promise<void> {
    const { rows, nowSec } = await this.readTable();
    this.recordLineage(rows, this.runtime.getLiveSessionRoots(), nowSec);
  }

  private async onTick(forceSweep = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.runtime.getMode() === 'off') return;
      this.tick += 1;
      const sweep = forceSweep || this.tick % SWEEP_EVERY_TICKS === 0;
      const roots = this.runtime.getLiveSessionRoots();
      for (const instanceId of roots.values()) this.rememberLive(instanceId);
      if (!sweep && roots.size === 0) return;
      const { rows, nowSec } = await this.readTable();
      this.recordLineage(rows, roots, nowSec);
      if (sweep) await this.sweep(rows, nowSec);
    } catch (error) {
      logger.warn('Leftover process check failed', { error: errorText(error) });
    } finally {
      this.running = false;
    }
  }

  /** One full pass; exported for tests and the on-demand path. */
  async sweep(rows?: Map<number, SweeperProcessRow>, nowSecArg?: number): Promise<SweepSummary> {
    const read = rows && nowSecArg !== undefined ? { rows, nowSec: nowSecArg } : await this.readTable();
    const { nowSec } = read;
    const table = read.rows;
    const markers = await this.readMarkers(table);
    const candidates = this.findCandidates(table, markers);
    const summary: SweepSummary = {
      candidates: candidates.length, stoppedHogs: [], stoppedEnded: [], reportedHogs: [], reportedEnded: [], reportedUnknown: [],
    };
    const mode = this.runtime.getMode();
    const seen = new Set<number>();

    for (const candidate of candidates) {
      seen.add(candidate.pid);
      let state = this.tracked.get(candidate.pid);
      if (!state || Math.abs(state.startSec - candidate.startSec) > START_JITTER_SEC) {
        state = { startSec: candidate.startSec, samples: [], deadSinceSec: null, reported: false };
        this.tracked.set(candidate.pid, state);
      }
      state.samples.push({ atSec: nowSec, cpuSeconds: candidate.cpuSeconds });
      trimSamples(state, nowSec);
      const owner = this.ownerState(candidate.instanceId);
      state.deadSinceSec = owner === 'live' ? null : state.deadSinceSec ?? nowSec;
      const entry: SweepEntry = {
        pid: candidate.pid,
        label: candidate.label,
        instanceId: candidate.instanceId,
        sessionName: this.runtime.getSessionName(candidate.instanceId) ?? this.seenLive.get(candidate.instanceId),
      };

      // For a closed session only CPU used after it closed counts toward the 10-minute window.
      const hog = owner === 'ended'
        ? isCpuHog(state, nowSec, candidate.cpuSeconds, CPU_WINDOW_SEC, state.deadSinceSec ?? nowSec)
        : isCpuHog(state, nowSec, candidate.cpuSeconds, LIVE_OWNER_CPU_WINDOW_SEC);
      if (hog) {
        if (mode === 'stop-cpu-hogs' || mode === 'stop-all') {
          this.stopSubtree(candidate);
          this.tracked.delete(candidate.pid);
          summary.stoppedHogs.push(entry);
        } else if (!state.reported) {
          state.reported = true;
          summary.reportedHogs.push(entry);
        }
        continue;
      }
      if (state.deadSinceSec !== null && nowSec - state.deadSinceSec >= ENDED_GRACE_SEC) {
        // Only a session this run saw end is stopped; an unknown owner may be another Harness app's.
        if (mode === 'stop-all' && owner === 'ended') {
          this.stopSubtree(candidate);
          this.tracked.delete(candidate.pid);
          summary.stoppedEnded.push(entry);
        } else if (!state.reported) {
          state.reported = true;
          (owner === 'ended' ? summary.reportedEnded : summary.reportedUnknown).push(entry);
        }
      }
    }
    for (const pid of this.tracked.keys()) {
      if (!seen.has(pid)) this.tracked.delete(pid);
    }

    this.lineage.prune(new Set([...table.values()].map((row) => row.pgid)), nowSec);
    this.persist(false);
    this.report(summary);
    return summary;
  }

  /** Stop attributed leftovers among `pids` (e.g. those working inside a worktree about to be removed). */
  async stopAttributedAmong(pids: ReadonlySet<number>): Promise<number> {
    if (this.runtime.platform === 'win32' || this.runtime.uid === null || pids.size === 0) return 0;
    const mode = this.runtime.getMode();
    if (mode === 'off' || mode === 'notify') return 0;
    const { rows: table } = await this.readTable();
    const markers = await this.readMarkers(table);
    const stopped = this.findCandidates(table, markers).filter((candidate) => pids.has(candidate.pid));
    for (const candidate of stopped) this.stopSubtree(candidate);
    if (stopped.length) {
      logger.info('Stopped leftovers in a folder being removed', {
        programs: stopped.map(({ pid, label, instanceId }) => ({ pid, label, instanceId })),
      });
    }
    return stopped.length;
  }

  /**
   * `ended` also covers a session this run saw live that Harness no longer knows: closing a
   * session deletes it. `unknown` stays for ids never seen live here (a crashed earlier run, or
   * another Harness app on this Mac), which are treated as possibly still open.
   */
  private ownerState(instanceId: string): OwnerState {
    const state = this.runtime.getOwnerState(instanceId);
    if (state === 'live') {
      this.rememberLive(instanceId);
      return 'live';
    }
    return state === 'unknown' && this.seenLive.has(instanceId) ? 'ended' : state;
  }

  /** Remember a live session and its current name (titles change after spawn), oldest evicted first. */
  private rememberLive(instanceId: string): void {
    const name = this.runtime.getSessionName(instanceId) ?? this.seenLive.get(instanceId);
    this.seenLive.delete(instanceId);
    this.seenLive.set(instanceId, name);
    if (this.seenLive.size > MAX_REMEMBERED_SESSIONS) {
      const oldest = this.seenLive.keys().next().value;
      if (oldest !== undefined) this.seenLive.delete(oldest);
    }
  }

  private recordLineage(rows: Map<number, SweeperProcessRow>, roots: ReadonlyMap<number, string>, nowSec: number): void {
    // A root counts only if Harness itself is its parent: a stored pid reused by an unrelated
    // program must never make that program's children look like a session's.
    const verified = new Map<number, string>();
    for (const [pid, instanceId] of roots) {
      if (rows.get(pid)?.ppid === this.runtime.harnessPid) verified.set(pid, instanceId);
    }
    if (verified.size > 0) this.lineage.record(rows.values(), verified, this.runtime.uid!, nowSec);
    this.persist(false);
  }

  private findCandidates(rows: Map<number, SweeperProcessRow>, markers: Map<number, Marker> | null): Candidate[] {
    const uid = this.runtime.uid;
    const protectedPids = this.runtime.getLiveSessionPids();
    const children = new Map<number, number[]>();
    for (const row of rows.values()) {
      const list = children.get(row.ppid) ?? [];
      list.push(row.pid);
      children.set(row.ppid, list);
    }
    const candidates: Candidate[] = [];
    for (const row of rows.values()) {
      if (row.uid !== uid || row.ppid !== 1 || row.pid <= 1 || row.pid === this.runtime.harnessPid) continue;
      if (protectedPids.has(row.pid)) continue;
      const marker = markers?.get(row.pid);
      const instanceId = marker?.kind === 'id'
        ? marker.id
        : this.lineage.attribute(row.pgid, row.startSec);
      if (!instanceId) continue;
      const subtree = collectSubtree(row.pid, rows, children, uid!, protectedPids);
      candidates.push({
        pid: row.pid,
        startSec: row.startSec,
        instanceId,
        label: programLabel(row.command),
        subtree,
        cpuSeconds: subtree.reduce((sum, member) => sum + (rows.get(member.pid)?.cpuSeconds ?? 0), 0),
      });
    }
    return candidates;
  }

  private stopSubtree(candidate: Candidate): void {
    for (const member of candidate.subtree) this.signal(member.pid, 'SIGTERM');
    const escalation = setTimeout(() => { void this.escalate(candidate.subtree); }, STOP_ESCALATION_MS);
    escalation.unref?.();
    logger.info('Stopping a leftover program', {
      pid: candidate.pid, label: candidate.label, instanceId: candidate.instanceId, members: candidate.subtree.length,
    });
  }

  /** SIGKILL survivors whose pid still belongs to the same process (same start time). */
  private async escalate(members: Array<{ pid: number; startSec: number }>): Promise<void> {
    try {
      const { rows } = await this.readTable();
      for (const member of members) {
        const row = rows.get(member.pid);
        if (row && Math.abs(row.startSec - member.startSec) <= START_JITTER_SEC) this.signal(member.pid, 'SIGKILL');
      }
    } catch (error) {
      logger.warn('Could not confirm leftovers stopped', { error: errorText(error) });
    }
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      this.runtime.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        logger.warn('Could not signal a leftover program', { pid, signal, error: errorText(error) });
      }
    }
  }

  private report(summary: SweepSummary): void {
    const sentences: string[] = [];
    const { stoppedHogs, stoppedEnded, reportedHogs, reportedEnded, reportedUnknown } = summary;
    if (stoppedHogs.length) {
      sentences.push(`Stopped ${describe(stoppedHogs)}${fromSessions(stoppedHogs)}. A command left ${them(stoppedHogs)} running and ${they(stoppedHogs)} kept using CPU.`);
    }
    if (stoppedEnded.length) {
      sentences.push(`Stopped ${describe(stoppedEnded)}${fromSessions(stoppedEnded)}, still running after ${stoppedEnded.length === 1 ? 'its session was' : 'their sessions were'} closed.`);
    }
    if (reportedHogs.length) {
      sentences.push(`${capitalise(describe(reportedHogs))}${fromSessions(reportedHogs)} ${isAre(reportedHogs)} using a lot of CPU.`);
    }
    if (reportedEnded.length) {
      sentences.push(`${capitalise(describe(reportedEnded))}${fromSessions(reportedEnded)} ${isAre(reportedEnded)} still running after ${reportedEnded.length === 1 ? 'its session was' : 'their sessions were'} closed.`);
    }
    if (reportedUnknown.length) {
      sentences.push(`${capitalise(describe(reportedUnknown))} started by a session that Harness no longer has open ${isAre(reportedUnknown)} still running, possibly from before Harness restarted.`);
    }
    const idle = [...reportedHogs, ...reportedEnded, ...reportedUnknown];
    if (idle.length) {
      sentences.push(`If you do not need ${them(idle)}, quit ${them(idle)} in Activity Monitor (process ${idle.slice(0, 10).map((entry) => entry.pid).join(', ')}${idle.length > 10 ? ' and more' : ''}).`);
    }
    if (sentences.length === 0) return;
    logger.info('Leftover programs', { stoppedHogs, stoppedEnded, reportedHogs, reportedEnded, reportedUnknown });
    this.runtime.notify('Leftover programs from agent sessions', sentences.join(' '));
  }

  /**
   * The table, with the clock read after `ps` returns: start times are `now - elapsed`, and a
   * clock read before a slow `ps` (the overloaded machine this exists for) would shift them.
   */
  private async readTable(): Promise<{ rows: Map<number, SweeperProcessRow>; nowSec: number }> {
    const startedMs = this.runtime.nowMs();
    const stdout = await this.runtime.runPs(['-A', '-ww', '-o', 'pid=,ppid=,pgid=,uid=,etime=,time=,command='], PS_TABLE_MAX_BYTES);
    const finishedMs = this.runtime.nowMs();
    const nowSec = Math.floor(finishedMs / 1000);
    const rows = parseProcessTable(stdout, nowSec);
    const costMs = finishedMs - startedMs;
    // The spec asks for the table's cost to be measured on the real machine: log it once, and again if slow.
    if (!this.tableCostLogged || costMs > SLOW_TABLE_MS) {
      this.tableCostLogged = true;
      logger.info('Leftover process table read', { rows: rows.size, costMs });
    }
    return { rows, nowSec };
  }

  /** Null when the environment table cannot be read: lineage alone still attributes. */
  private async readMarkers(rows: Map<number, SweeperProcessRow>): Promise<Map<number, Marker> | null> {
    try {
      // Dash-less BSD form: accepted by both macOS ps and procps (see host-process-inspector.ts).
      return resolveEnvMarkers(await this.runtime.runPs(['axeww', '-o', 'pid=,ppid=,command='], PS_ENV_MAX_BYTES), rows);
    } catch (error) {
      logger.warn('Could not read process environments; using recorded lineage only', { error: errorText(error) });
      return null;
    }
  }

  private persist(force: boolean): void {
    const now = this.runtime.nowMs();
    if (!force && now - this.lastPersistMs < PERSIST_MIN_INTERVAL_MS) return;
    if (!this.lineage.takeChanged() && !force) return;
    this.lastPersistMs = now;
    try {
      this.runtime.writeLineage(this.lineage.toJSON());
    } catch (error) {
      logger.warn('Could not save the process lineage', { error: errorText(error) });
    }
  }
}

function collectSubtree(
  rootPid: number,
  rows: Map<number, SweeperProcessRow>,
  children: Map<number, number[]>,
  uid: number,
  protectedPids: ReadonlySet<number>,
): Array<{ pid: number; startSec: number }> {
  const found: Array<{ pid: number; startSec: number; depth: number }> = [];
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
  const seen = new Set<number>();
  for (let index = 0; index < queue.length; index += 1) {
    const { pid, depth } = queue[index]!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.get(pid);
    if (!row || row.uid !== uid || protectedPids.has(pid)) continue;
    found.push({ pid, startSec: row.startSec, depth });
    for (const child of children.get(pid) ?? []) queue.push({ pid: child, depth: depth + 1 });
  }
  return found.sort((a, b) => b.depth - a.depth).map(({ pid, startSec }) => ({ pid, startSec }));
}

/** Drop samples older than the newest one that is a full long window old (the longest baseline needed). */
function trimSamples(state: Tracked, nowSec: number): void {
  let baseline = -1;
  for (let index = 0; index < state.samples.length; index += 1) {
    if (nowSec - state.samples[index]!.atSec >= LIVE_OWNER_CPU_WINDOW_SEC) baseline = index;
  }
  if (baseline > 0) state.samples.splice(0, baseline);
}

/**
 * Average cores used since the newest sample at least `windowSec` old and taken no earlier than
 * `notBeforeSec`; false until such a sample exists.
 */
function isCpuHog(state: Tracked, nowSec: number, cpuNow: number, windowSec: number, notBeforeSec = -Infinity): boolean {
  let baseline: { atSec: number; cpuSeconds: number } | undefined;
  for (const sample of state.samples) {
    if (sample.atSec >= notBeforeSec && nowSec - sample.atSec >= windowSec) baseline = sample;
  }
  if (!baseline) return false;
  return (cpuNow - baseline.cpuSeconds) / (nowSec - baseline.atSec) >= CPU_HOG_CORES;
}

function describe(entries: Array<{ label: string }>): string {
  const counts = new Map<string, number>();
  for (const { label } of entries) counts.set(label, (counts.get(label) ?? 0) + 1);
  const parts = [...counts].map(([label, count]) => (count > 1 ? `${count} × ${label}` : label));
  const shown = parts.slice(0, NOTICE_MAX_LABELS).join(', ');
  const more = parts.length > NOTICE_MAX_LABELS ? ` and ${parts.length - NOTICE_MAX_LABELS} more` : '';
  return `${entries.length === 1 ? 'one program' : `${entries.length} programs`} (${shown}${more})`;
}

function fromSessions(entries: SweepEntry[]): string {
  const names = [...new Set(entries.map((entry) => entry.sessionName?.trim()).filter((name): name is string => Boolean(name)))];
  if (names.length === 0) return ' from an agent session';
  const quoted = names.slice(0, 3).map((name) => `"${name.slice(0, 60)}"`).join(', ');
  return ` from ${names.length === 1 ? 'session' : 'sessions'} ${quoted}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;
}

function them(entries: unknown[]): string {
  return entries.length === 1 ? 'it' : 'them';
}

function isAre(entries: unknown[]): string {
  return entries.length === 1 ? 'is' : 'are';
}

function they(entries: unknown[]): string {
  return entries.length === 1 ? 'it' : 'they';
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0]! : String(error);
}

/**
 * Stop leftovers a Harness session left working inside `folder`, before the folder is deleted.
 * Best effort: no sweeper, no folder table, or no attributed leftover all mean "nothing to do".
 */
export async function stopAttributedLeftoversIn(folder: string): Promise<number> {
  const sweeper = getLeftoverProcessSweeper();
  if (!sweeper) return 0;
  const pids = await listFolderProcessPids(folder);
  return pids ? sweeper.stopAttributedAmong(pids) : 0;
}

let instance: LeftoverProcessSweeper | null = null;

export function initLeftoverProcessSweeper(runtime: LeftoverSweeperRuntime): LeftoverProcessSweeper {
  instance?.stop();
  instance = new LeftoverProcessSweeper(runtime);
  return instance;
}

export function getLeftoverProcessSweeper(): LeftoverProcessSweeper | null {
  return instance;
}

export function _resetForTesting(): void {
  instance?.stop();
  instance = null;
}
