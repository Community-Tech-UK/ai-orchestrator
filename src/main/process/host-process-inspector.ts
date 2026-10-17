/**
 * Host process tools: a read-only CPU/memory listing and a tightly-ruled
 * "stop leftovers" action. Runs in the unsandboxed Harness main process and is
 * exposed to sessions as deferred `orchestrator` MCP tools, because a session's
 * own Seatbelt sandbox cannot exec the setuid `ps`/`top` and the signal fence
 * stops it signalling processes outside its sandbox.
 *
 * Everything that touches the machine goes through `HostProcessRuntime` so the
 * logic is unit-testable with fixture `ps` output.
 *
 * Safety model: raw command lines and environments are NEVER returned. The
 * environment table is read only to look for the `AI_ORCHESTRATOR_INSTANCE_ID`
 * marker (a whole-token match); the label comes from the environment-free
 * table through `sanitizeProcessLabel`.
 */

import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { sanitizeProcessLabel } from '../instance/stall-process-facts';
import { getLogger } from '../logging/logger';

const logger = getLogger('HostProcessTools');

export const INSTANCE_MARKER_ENV = 'AI_ORCHESTRATOR_INSTANCE_ID';
export const HOST_PROCESS_MAX_PIDS = 100;
const PS_TIMEOUT_MS = 10_000;
const PS_TABLE_MAX_BYTES = 16 * 1024 * 1024;
const PS_ENV_MAX_BYTES = 64 * 1024 * 1024;
const MARKER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const MARKER_PREFIX = `${INSTANCE_MARKER_ENV}=`;
/** `sanitizeProcessLabel`'s fixed wording for any shell; kept whole. */
const SHELL_LABEL = 'a shell command';

export interface HostProcessRuntime {
  platform: NodeJS.Platform;
  /** Harness's own uid; null where the platform has none. */
  uid: number | null;
  harnessPid: number;
  runPs(args: string[], maxBuffer: number): Promise<string>;
  kill(pid: number, signal: NodeJS.Signals): void;
  isInstanceLive(instanceId: string): boolean;
  /** Pids of CLI processes Harness currently tracks for live sessions. */
  getLiveSessionPids(): ReadonlySet<number>;
  cpuCount(): number;
  loadAverage(): number[];
}

export interface HostProcessRuntimeHooks {
  isInstanceLive(instanceId: string): boolean;
  getLiveSessionPids(): ReadonlySet<number>;
}

export function createDefaultHostProcessRuntime(hooks: HostProcessRuntimeHooks): HostProcessRuntime {
  return {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    harnessPid: process.pid,
    runPs: (args, maxBuffer) => new Promise((resolve, reject) => {
      // LC_ALL=C: a comma-decimal locale would print `pcpu` as `1,5` and fail the parse.
      const env = { ...process.env, LC_ALL: 'C' };
      execFile('ps', args, { encoding: 'utf8', timeout: PS_TIMEOUT_MS, maxBuffer, windowsHide: true, env }, (error, stdout) => {
        if (error) reject(error); else resolve(stdout);
      });
    }),
    kill: (pid, signal) => { process.kill(pid, signal); },
    isInstanceLive: hooks.isInstanceLive,
    getLiveSessionPids: hooks.getLiveSessionPids,
    cpuCount: () => os.cpus().length,
    loadAverage: () => os.loadavg(),
  };
}

export interface HostProcessRow {
  pid: number;
  parentPid: number;
  cpuPercent: number;
  memoryMb: number;
  runningFor: string;
  label: string;
  /** Same Mac user account as Harness. */
  ownedByYou: boolean;
  /** Orphaned program that a Harness session started (stop rules 1 to 3). */
  leftover: boolean;
  /** Would pass every stop rule for the calling session. */
  stoppable: boolean;
  stopRefusal?: string;
}

export interface ListHostProcessesInput {
  limit?: number;
  nameFilter?: string;
  /** Only rows that are leftovers (rules 1 to 3), however little CPU they use. */
  leftoverOnly?: boolean;
  callerInstanceId: string;
}

export interface ListHostProcessesResult {
  processes: HostProcessRow[];
  summary: { totalProcesses: number; matchingProcesses: number; cpuCount: number; loadAverage: number[] };
  notes?: string[];
}

export interface StopLeftoverInput {
  pids: number[];
  force?: boolean;
  callerInstanceId: string;
}

export type StopOutcome = 'stopped' | 'already-exited' | 'refused' | 'failed';

export interface StopLeftoverPidResult {
  pid: number;
  outcome: StopOutcome;
  reason?: string;
  alsoStopped?: number[];
}

export interface StopLeftoverResult {
  results: StopLeftoverPidResult[];
  summary: string;
}

interface PsRow {
  pid: number;
  ppid: number;
  uid: number;
  cpu: number;
  rssKb: number;
  elapsedSeconds: number | null;
  command: string;
}

type Marker = { kind: 'none' } | { kind: 'id'; id: string } | { kind: 'invalid' };
interface Snapshot {
  rows: Map<number, PsRow>;
  /** Absent when the environment table could not be read. */
  markers: Map<number, Marker> | null;
}

export function parseElapsedSeconds(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(value);
  if (!match) return null;
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4]);
}

export function formatRunningFor(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  const days = Math.floor(seconds / 86400);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function parsePsTable(stdout: string): Map<number, PsRow> {
  const rows = new Map<number, PsRow>();
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\S+)\s*(.*)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const uid = Number(match[3]);
    const cpu = Number(match[4]);
    const rssKb = Number(match[5]);
    if (![pid, ppid, uid, cpu, rssKb].every(Number.isFinite) || !Number.isSafeInteger(pid) || pid < 1) continue;
    rows.set(pid, { pid, ppid, uid, cpu, rssKb, elapsedSeconds: parseElapsedSeconds(match[6]!), command: match[7] ?? '' });
  }
  return rows;
}

/** Whole-token match only: `FOO_AI_ORCHESTRATOR_INSTANCE_ID=x` or `--a=AI_...=x` do not count. */
export function parseEnvMarkers(stdout: string): Map<number, { ppid: number; marker: Marker }> {
  const result = new Map<number, { ppid: number; marker: Marker }>();
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(ppid)) continue;
    const values = new Set<string>();
    for (const token of match[3]!.split(/\s+/u)) {
      if (token.startsWith(MARKER_PREFIX)) values.add(token.slice(MARKER_PREFIX.length));
    }
    let marker: Marker = { kind: 'none' };
    if (values.size === 1) {
      const [id] = [...values];
      marker = MARKER_ID_PATTERN.test(id!) ? { kind: 'id', id: id! } : { kind: 'invalid' };
    } else if (values.size > 1) {
      marker = { kind: 'invalid' };
    }
    result.set(pid, { ppid, marker });
  }
  return result;
}

function assertSupported(runtime: HostProcessRuntime): void {
  if (runtime.platform === 'win32') {
    throw new Error('Host process tools are not supported on Windows; they need a macOS or Linux Harness host.');
  }
}

async function takeSnapshot(runtime: HostProcessRuntime): Promise<{ snapshot: Snapshot; envError?: string }> {
  // Dash-less BSD form for the environment table: procps-ng rejects `eww -axo`,
  // and `axeww -o` is accepted by both it and macOS ps (see worker-node-process-tree.ts).
  const [tableOut, envOut] = await Promise.allSettled([
    runtime.runPs(['-A', '-ww', '-o', 'pid=,ppid=,uid=,pcpu=,rss=,etime=,command='], PS_TABLE_MAX_BYTES),
    runtime.runPs(['axeww', '-o', 'pid=,ppid=,command='], PS_ENV_MAX_BYTES),
  ]);
  if (tableOut.status === 'rejected') {
    throw new Error(`Could not read the process list: ${errorText(tableOut.reason)}`);
  }
  const rows = parsePsTable(tableOut.value);
  if (envOut.status === 'rejected') {
    return { snapshot: { rows, markers: null }, envError: errorText(envOut.reason) };
  }
  const markers = new Map<number, Marker>();
  for (const [pid, entry] of parseEnvMarkers(envOut.value)) {
    // A pid that changed parent between the two reads may have been reused: treat as unmarked.
    const row = rows.get(pid);
    if (row?.ppid !== entry.ppid) continue;
    // The environment-free table holds only argv. A marker found there was typed on the command
    // line, not inherited from a Harness session, so it proves nothing.
    const inArgv = row.command.split(/\s+/u).some((token) => token.startsWith(MARKER_PREFIX));
    markers.set(pid, inArgv ? { kind: 'invalid' } : entry.marker);
  }
  return { snapshot: { rows, markers } };
}

function programLabel(command: string): string {
  const label = sanitizeProcessLabel(command);
  if (label === SHELL_LABEL) return label;
  return label.split(' ')[0] || 'unknown';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0]! : 'unknown error';
}

interface Evaluation {
  /** Rules 1 to 3. */
  leftover: boolean;
  stoppable: boolean;
  refusal?: string;
  markerId?: string;
}

function evaluate(
  pid: number,
  snapshot: Snapshot,
  runtime: HostProcessRuntime,
  callerInstanceId: string,
  liveSessionPids: ReadonlySet<number>,
): Evaluation {
  const row = snapshot.rows.get(pid);
  if (!row || !Number.isSafeInteger(pid) || pid <= 1) {
    return { leftover: false, stoppable: false, refusal: 'is not a program that can be stopped' };
  }
  if (pid === runtime.harnessPid) {
    return { leftover: false, stoppable: false, refusal: 'is Harness itself' };
  }
  if (runtime.uid === null || row.uid !== runtime.uid) {
    return { leftover: false, stoppable: false, refusal: 'is not owned by you' };
  }
  if (row.ppid !== 1) {
    return { leftover: false, stoppable: false, refusal: 'still has a parent program, so it is not a leftover' };
  }
  const marker = snapshot.markers?.get(pid) ?? { kind: 'none' as const };
  if (marker.kind !== 'id') {
    const reason = snapshot.markers === null
      ? 'could not be checked because the process environments could not be read'
      : 'was not started by a Harness session';
    return { leftover: false, stoppable: false, refusal: reason };
  }
  if (marker.id !== callerInstanceId && runtime.isInstanceLive(marker.id)) {
    return { leftover: true, stoppable: false, refusal: 'belongs to another session that is still running', markerId: marker.id };
  }
  if (liveSessionPids.has(pid)) {
    return { leftover: true, stoppable: false, refusal: "is a live session's own program", markerId: marker.id };
  }
  return { leftover: true, stoppable: true, markerId: marker.id };
}

export async function listHostProcesses(
  runtime: HostProcessRuntime,
  input: ListHostProcessesInput,
): Promise<ListHostProcessesResult> {
  assertSupported(runtime);
  const limit = Math.min(HOST_PROCESS_MAX_PIDS, Math.max(1, Math.floor(input.limit ?? 20)));
  const filter = input.nameFilter?.trim().toLowerCase() ?? '';
  const { snapshot, envError } = await takeSnapshot(runtime);
  const liveSessionPids = runtime.getLiveSessionPids();

  // Program or script name only: the shared label can keep short arguments, which may be secrets.
  const labelled = [...snapshot.rows.values()].map((row) => ({ row, label: programLabel(row.command) }));
  const evaluated = labelled
    .filter((entry) => !filter || entry.label.toLowerCase().includes(filter))
    .map((entry) => ({ ...entry, verdict: evaluate(entry.row.pid, snapshot, runtime, input.callerInstanceId, liveSessionPids) }));
  const matching = input.leftoverOnly ? evaluated.filter((entry) => entry.verdict.leftover) : evaluated;
  matching.sort((a, b) => b.row.cpu - a.row.cpu || a.row.pid - b.row.pid);

  const processes = matching.slice(0, limit).map(({ row, label, verdict }): HostProcessRow => {
    return {
      pid: row.pid,
      parentPid: row.ppid,
      cpuPercent: Math.round(row.cpu * 10) / 10,
      memoryMb: Math.round(row.rssKb / 1024 * 10) / 10,
      runningFor: formatRunningFor(row.elapsedSeconds),
      label,
      ownedByYou: runtime.uid !== null && row.uid === runtime.uid,
      leftover: verdict.leftover,
      stoppable: verdict.stoppable,
      ...(verdict.refusal ? { stopRefusal: verdict.refusal } : {}),
    };
  });
  return {
    processes,
    summary: {
      totalProcesses: snapshot.rows.size,
      matchingProcesses: matching.length,
      cpuCount: runtime.cpuCount(),
      loadAverage: runtime.loadAverage().map((value) => Math.round(value * 100) / 100),
    },
    ...(envError ? { notes: ['Process environments could not be read, so no process is shown as a leftover or stoppable.'] } : {}),
  };
}

/** Marked, same-uid, non-protected descendants of `rootPid`, deepest first. */
function collectDescendants(
  rootPid: number,
  markerId: string,
  snapshot: Snapshot,
  runtime: HostProcessRuntime,
  liveSessionPids: ReadonlySet<number>,
): number[] {
  const children = new Map<number, number[]>();
  for (const row of snapshot.rows.values()) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const found: Array<{ pid: number; depth: number }> = [];
  const seen = new Set<number>([rootPid]);
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const childPid of children.get(current.pid) ?? []) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      const entry = { pid: childPid, depth: current.depth + 1 };
      queue.push(entry); // Walk through unmarked intermediates too, but only act on marked ones.
      const row = snapshot.rows.get(childPid)!;
      const marker = snapshot.markers?.get(childPid);
      if (
        marker?.kind === 'id' && marker.id === markerId && row.uid === runtime.uid
        && childPid > 1 && childPid !== runtime.harnessPid && !liveSessionPids.has(childPid)
      ) {
        found.push(entry);
      }
    }
  }
  return found.sort((a, b) => b.depth - a.depth || b.pid - a.pid).map((entry) => entry.pid);
}

type SignalOutcome = 'sent' | 'gone' | 'failed';

function signalPid(runtime: HostProcessRuntime, pid: number, signal: NodeJS.Signals): SignalOutcome {
  try {
    runtime.kill(pid, signal);
    return 'sent';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'failed';
  }
}

export async function stopLeftoverProcesses(
  runtime: HostProcessRuntime,
  input: StopLeftoverInput,
): Promise<StopLeftoverResult> {
  assertSupported(runtime);
  const signal: NodeJS.Signals = input.force ? 'SIGKILL' : 'SIGTERM';
  const pids = [...new Set(input.pids)].slice(0, HOST_PROCESS_MAX_PIDS);
  // Fresh read at call time; nothing from an earlier list is trusted.
  const { snapshot } = await takeSnapshot(runtime);
  const liveSessionPids = runtime.getLiveSessionPids();

  const plans = new Map<number, { descendants: number[]; verdict: Evaluation }>();
  const results = new Map<number, StopLeftoverPidResult>();
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      results.set(pid, { pid, outcome: 'refused', reason: 'is not a valid program number' });
      continue;
    }
    if (!snapshot.rows.has(pid)) {
      results.set(pid, { pid, outcome: 'already-exited', reason: 'is no longer running' });
      continue;
    }
    const verdict = evaluate(pid, snapshot, runtime, input.callerInstanceId, liveSessionPids);
    if (!verdict.stoppable || !verdict.markerId) {
      results.set(pid, { pid, outcome: 'refused', reason: verdict.refusal ?? 'cannot be stopped' });
      continue;
    }
    plans.set(pid, { verdict, descendants: collectDescendants(pid, verdict.markerId, snapshot, runtime, liveSessionPids) });
  }

  const signalled = new Set<number>();
  for (const [pid, plan] of plans) {
    const alsoStopped: number[] = [];
    let childFailures = 0;
    for (const childPid of plan.descendants) {
      if (signalled.has(childPid)) { alsoStopped.push(childPid); continue; }
      const outcome = signalPid(runtime, childPid, signal);
      signalled.add(childPid);
      if (outcome === 'sent') alsoStopped.push(childPid);
      else if (outcome === 'failed') childFailures += 1;
    }
    const rootOutcome = signalled.has(pid) ? 'sent' : signalPid(runtime, pid, signal);
    signalled.add(pid);
    const extra = alsoStopped.length ? { alsoStopped } : {};
    if (rootOutcome === 'sent') {
      results.set(pid, {
        pid, outcome: 'stopped', ...extra,
        ...(childFailures ? { reason: `${childFailures} of its child programs could not be stopped` } : {}),
      });
    } else if (rootOutcome === 'gone') {
      results.set(pid, { pid, outcome: 'already-exited', reason: 'exited before it could be stopped', ...extra });
    } else {
      results.set(pid, { pid, outcome: 'failed', reason: 'the system refused to stop it', ...extra });
    }
  }
  // A pid the caller listed that was stopped as another leftover's child is not a refusal.
  for (const [pid, result] of results) {
    if (result.outcome !== 'refused') continue;
    const parent = [...results.values()].find((other) => other.alsoStopped?.includes(pid));
    if (parent) results.set(pid, { pid, outcome: 'stopped', reason: `stopped together with program ${parent.pid}` });
  }

  const ordered = pids.map((pid) => results.get(pid)!);
  // Audit trail: the session transcript is not the only record of what an agent stopped.
  logger.info('stop_leftover_processes', {
    callerInstanceId: input.callerInstanceId,
    signal,
    results: ordered.map(({ pid, outcome, alsoStopped }) => ({ pid, outcome, ...(alsoStopped ? { alsoStopped } : {}) })),
  });
  return { results: ordered, summary: summarise(ordered, input.force === true) };
}

function summarise(results: StopLeftoverPidResult[], force: boolean): string {
  const count = (outcome: StopOutcome) => results.filter((entry) => entry.outcome === outcome).length;
  const plural = (n: number) => `${n} program${n === 1 ? '' : 's'}`;
  const children = results.reduce((sum, entry) => sum + (entry.alsoStopped?.length ?? 0), 0);
  const parts: string[] = [];
  if (count('stopped')) {
    parts.push(`${force ? 'Force-stopped' : 'Asked'} ${plural(count('stopped'))}${force ? '' : ' to stop'}${children ? ` (plus ${children} of their child programs)` : ''}`);
  }
  if (count('already-exited')) parts.push(`${plural(count('already-exited'))} had already exited`);
  if (count('refused')) parts.push(`${count('refused')} refused (see the reasons)`);
  if (count('failed')) parts.push(`${count('failed')} could not be stopped`);
  const text = parts.join('; ');
  const hint = !force && count('stopped') ? ' If one is still listed afterwards, retry with force.' : '';
  return `${text || 'Nothing to do'}.${hint}`;
}
