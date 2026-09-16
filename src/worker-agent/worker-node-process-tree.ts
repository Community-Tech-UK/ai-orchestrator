import { execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const PROCESS_INSPECTION_TIMEOUT_MS = 250;
const PROCESS_TABLE_MAX_OUTPUT_BYTES = 512 * 1024;
const PROCESS_ENV_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DESCENDANT_SAMPLE_INTERVAL_MS = 25;
const MAX_SCANNED_PROCESSES = 32_768;
export const NODE_EXEC_MAX_TRACKED_PROCESSES = 4_096;
export const NODE_EXEC_OWNERSHIP_MARKER_ENV = 'AIO_NODE_EXEC_OWNERSHIP';

export interface PosixProcessRuntime {
  readonly execFileProcess: typeof execFile;
  readonly killProcess: (pid: number, signal?: string | number) => boolean;
}

interface PosixProcessTarget {
  pid: number;
  ppid: number;
  pgid: number;
  depth: number;
}

export interface CapturedPosixProcessTree {
  targets: PosixProcessTarget[];
  rootPid: number;
  rootExited: boolean;
  failure?: string;
}

export interface PosixDescendantTracker {
  sample(): Promise<void>;
  pause(rootExited?: boolean): void;
  snapshot(): CapturedPosixProcessTree;
  dispose(): void;
}

export interface PosixTerminationResult {
  failures: string[];
  identityProven: boolean;
}

export function createPosixOwnershipMarker(): string {
  return randomBytes(16).toString('hex');
}

export function createPosixDescendantTracker(
  rootPid: number,
  runtime: PosixProcessRuntime,
): PosixDescendantTracker {
  const observed = new Map<number, PosixProcessTarget>([
    [rootPid, { pid: rootPid, ppid: 0, pgid: rootPid, depth: 0 }],
  ]);
  let failure: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let queued = false;
  let paused = false;
  let rootExited = false;
  let overflowed = false;
  const schedule = (): void => {
    if (disposed || paused || timer || active || overflowed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void sample();
    }, DESCENDANT_SAMPLE_INTERVAL_MS);
    timer.unref();
  };
  const sample = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (active) {
      queued = true;
      return active;
    }
    active = (async () => {
      do {
        queued = false;
        const current = await capturePosixProcessTree(rootPid, runtime);
        if (disposed) return;
        if (current.rootObserved && !rootExited) {
          for (const target of current.targets) {
            if (!observed.has(target.pid) && observed.size >= NODE_EXEC_MAX_TRACKED_PROCESSES) {
              overflowed = true;
              failure = processLimitFailure();
              break;
            }
            observed.set(target.pid, target);
          }
          if (!overflowed) failure = current.failure;
        } else if (!rootExited) {
          failure = current.failure;
        }
      } while (queued && !disposed && !overflowed);
    })().finally(() => {
      active = undefined;
      schedule();
    });
    return active;
  };
  let disposed = false;
  return {
    sample,
    pause: (didRootExit = false) => {
      paused = true;
      rootExited ||= didRootExit;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    snapshot: () => ({
      targets: [...observed.values()],
      rootPid,
      rootExited,
      ...(failure ? { failure } : {}),
    }),
    dispose: () => {
      disposed = true;
      queued = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      observed.clear();
    },
  };
}

export async function terminatePosixProcessTree(
  captured: CapturedPosixProcessTree,
  ownershipMarker: string,
  signal: NodeJS.Signals,
  runtime: PosixProcessRuntime,
  emptyIsComplete = false,
): Promise<PosixTerminationResult> {
  const identity = await captureMarkedProcesses(
    ownershipMarker,
    runtime,
    captured,
    emptyIsComplete,
  );
  const failures = [captured.failure, identity.failure].filter((value): value is string => Boolean(value));
  if (!identity.ok) return { failures, identityProven: false };
  if (identity.targets.length === 0) {
    return {
      failures,
      identityProven: identity.identityComplete && (emptyIsComplete || captured.rootExited),
    };
  }
  const complete = signalValidatedProcessTree(
    identity.targets,
    identity.unsafeGroups,
    signal,
    runtime,
  );
  if (!complete) failures.push(`[node.exec cleanupIncomplete: POSIX ${signal} was incomplete]`);
  return { failures, identityProven: true };
}

interface ProcessCaptureResult {
  ok: boolean;
  targets: PosixProcessTarget[];
  rootObserved: boolean;
  failure?: string;
}

async function capturePosixProcessTree(
  rootPid: number,
  runtime: PosixProcessRuntime,
): Promise<ProcessCaptureResult> {
  const rootFallback: PosixProcessTarget = { pid: rootPid, ppid: 0, pgid: rootPid, depth: 0 };
  if (!isSafeProcessId(rootPid)) {
    return { ok: false, targets: [], rootObserved: false, failure: identityIncompleteFailure() };
  }
  const result = await runBoundedInspection(
    runtime,
    // Dash-less BSD selectors, as in captureMarkedProcesses: procps-ng only
    // accepts `-axo` through its error-fallback reparse.
    ['ax', '-o', 'pid=,ppid=,pgid='],
    PROCESS_TABLE_MAX_OUTPUT_BYTES,
  );
  if (!result.ok) {
    return { ok: false, targets: [rootFallback], rootObserved: false, failure: identityIncompleteFailure() };
  }
  const records = parseProcessRecords(result.stdout);
  const rootRecord = records.get(rootPid);
  if (!rootRecord || rootRecord.pgid !== rootPid) {
    return { ok: true, targets: [rootFallback], rootObserved: false };
  }
  const childrenByParent = new Map<number, PosixProcessTarget[]>();
  for (const record of records.values()) {
    const children = childrenByParent.get(record.ppid) ?? [];
    children.push(record);
    childrenByParent.set(record.ppid, children);
  }
  const targets: PosixProcessTarget[] = [{ ...rootRecord, depth: 0 }];
  const seen = new Set<number>([rootPid]);
  for (const parent of targets) {
    for (const child of childrenByParent.get(parent.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (targets.length >= NODE_EXEC_MAX_TRACKED_PROCESSES) {
        return { ok: true, targets, rootObserved: true, failure: processLimitFailure() };
      }
      targets.push({ ...child, depth: parent.depth + 1 });
    }
  }
  return { ok: true, targets, rootObserved: true };
}

async function captureMarkedProcesses(
  marker: string,
  runtime: PosixProcessRuntime,
  captured: CapturedPosixProcessTree,
  allowMissing: boolean,
): Promise<{
  ok: boolean;
  targets: PosixProcessTarget[];
  identityComplete: boolean;
  unsafeGroups: Set<number>;
  failure?: string;
}> {
  if (!/^[a-f0-9]{32}$/u.test(marker)) {
    return {
      ok: false,
      targets: [],
      identityComplete: false,
      unsafeGroups: new Set<number>(),
      failure: identityIncompleteFailure(),
    };
  }
  // Keep the BSD selectors in one dash-less word. procps-ng rejects
  // `eww -axo ...` ("must set personality to get -x option"), which made the
  // ownership scan fail on every Linux worker. `axeww -o` is accepted by both
  // procps-ng and macOS ps, and `e` still appends the environment to `command`.
  const result = await runBoundedInspection(
    runtime,
    ['axeww', '-o', 'pid=,ppid=,pgid=,command='],
    PROCESS_ENV_MAX_OUTPUT_BYTES,
  );
  if (!result.ok) {
    return {
      ok: false,
      targets: [],
      identityComplete: false,
      unsafeGroups: new Set<number>(),
      failure: identityIncompleteFailure(),
    };
  }
  const assignment = `${NODE_EXEC_OWNERSHIP_MARKER_ENV}=${marker}`;
  const known = new Map(captured.targets.map((target) => [target.pid, target]));
  const targets: PosixProcessTarget[] = [];
  const matchedPids = new Set<number>();
  const unmarkedGroups = new Set<number>();
  let skippedExitedRoot = false;
  let overflowed = false;
  let scannedProcesses = 0;
  for (const line of result.stdout.split(/\r?\n/u)) {
    const processRecord = parseProcessEnvironmentLine(line, assignment);
    if (!processRecord) continue;
    scannedProcesses += 1;
    if (scannedProcesses > MAX_SCANNED_PROCESSES) {
      return {
        ok: false,
        targets: [],
        identityComplete: false,
        unsafeGroups: new Set<number>(),
        failure: identityIncompleteFailure(),
      };
    }
    const { target: parsed, marked } = processRecord;
    if (!marked) {
      unmarkedGroups.add(parsed.pgid);
      continue;
    }
    if (captured.rootExited && parsed.pid === captured.rootPid) {
      skippedExitedRoot = true;
      continue;
    }
    if (targets.length >= NODE_EXEC_MAX_TRACKED_PROCESSES) {
      overflowed = true;
      continue;
    }
    matchedPids.add(parsed.pid);
    targets.push({ ...parsed, depth: known.get(parsed.pid)?.depth ?? 1 });
  }
  const missingCaptured = !allowMissing && captured.targets.some((target) => (
    !(captured.rootExited && target.pid === captured.rootPid) && !matchedPids.has(target.pid)
  ));
  const identityComplete = !skippedExitedRoot && !missingCaptured && !overflowed;
  const unsafeGroups = new Set(targets
    .filter(({ pgid }) => unmarkedGroups.has(pgid))
    .map(({ pgid }) => pgid));
  return {
    ok: true,
    targets,
    identityComplete,
    unsafeGroups,
    ...(identityComplete
      ? {}
      : { failure: overflowed ? processLimitFailure() : identityIncompleteFailure() }),
  };
}

function parseProcessRecords(stdout: string): Map<number, PosixProcessTarget> {
  const records = new Map<number, PosixProcessTarget>();
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)(?:\s+.*)?$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    if (!isSafeProcessId(pid) || !Number.isSafeInteger(ppid) || ppid < 0) continue;
    records.set(pid, { pid, ppid, pgid, depth: 0 });
  }
  return records;
}

function parseProcessEnvironmentLine(
  line: string,
  assignment: string,
): { target: Omit<PosixProcessTarget, 'depth'>; marked: boolean } | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
  if (!match) return undefined;
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  const pgid = Number(match[3]);
  if (!isSafeProcessId(pid) || !Number.isSafeInteger(ppid) || ppid < 0) return undefined;
  return {
    target: { pid, ppid, pgid },
    marked: match[4]?.split(/\s+/u).includes(assignment) ?? false,
  };
}

function signalValidatedProcessTree(
  targets: PosixProcessTarget[],
  unsafeGroups: Set<number>,
  signal: NodeJS.Signals,
  runtime: PosixProcessRuntime,
): boolean {
  const targetPids = new Set(targets.map(({ pid }) => pid));
  const depthByPid = new Map(targets.map(({ pid, depth }) => [pid, depth]));
  const groups = [...new Set(targets
    .map(({ pgid }) => pgid)
    .filter((pgid) => (
      isSafeProcessId(pgid) && targetPids.has(pgid) && !unsafeGroups.has(pgid)
    )))]
    .sort((left, right) => (depthByPid.get(right) ?? 0) - (depthByPid.get(left) ?? 0));
  const signalledGroups = new Set<number>();
  let complete = true;
  for (const pgid of groups) {
    const outcome = signalProcess(-pgid, signal, runtime);
    if (outcome === 'sent') signalledGroups.add(pgid);
    if (outcome === 'failed') complete = false;
  }
  for (const target of [...targets].sort((left, right) => right.depth - left.depth)) {
    if (signalledGroups.has(target.pgid)) continue;
    if (signalProcess(target.pid, signal, runtime) === 'failed') complete = false;
  }
  return complete;
}

function signalProcess(
  pid: number,
  signal: NodeJS.Signals,
  runtime: PosixProcessRuntime,
): 'sent' | 'not-running' | 'failed' {
  if (!isSafeProcessId(Math.abs(pid))) return 'failed';
  try {
    return runtime.killProcess(pid, signal) ? 'sent' : 'failed';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'not-running' : 'failed';
  }
}

type InspectionResult = { ok: true; stdout: string } | { ok: false };

function runBoundedInspection(
  runtime: PosixProcessRuntime,
  args: string[],
  maxBuffer: number,
): Promise<InspectionResult> {
  return new Promise((resolve) => {
    let settled = false;
    let command: ChildProcess | undefined;
    const finish = (result: InspectionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        command?.kill('SIGKILL');
      } catch {
        // The bounded inspection process may already have exited.
      }
      disposeInspectionProcess(command);
      finish({ ok: false });
    }, PROCESS_INSPECTION_TIMEOUT_MS);
    try {
      command = runtime.execFileProcess(
        'ps',
        args,
        { encoding: 'utf8', killSignal: 'SIGKILL', maxBuffer, timeout: PROCESS_INSPECTION_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => finish(error ? { ok: false } : { ok: true, stdout }),
      );
    } catch {
      finish({ ok: false });
    }
  });
}

function disposeInspectionProcess(command: ChildProcess | undefined): void {
  if (!command) return;
  for (const stream of [command.stdin, command.stdout, command.stderr]) {
    try {
      stream?.destroy();
    } catch {
      // Settlement continues even if one inspection stream rejects disposal.
    }
  }
  try {
    command.unref();
  } catch {
    // The bounded timer already prevents the handle from blocking cleanup.
  }
}

function isSafeProcessId(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid;
}

function identityIncompleteFailure(): string {
  return '[node.exec cleanupIncomplete: POSIX ownership identity could not be proven]';
}

function processLimitFailure(): string {
  return `[node.exec cleanupIncomplete: POSIX process target limit ${NODE_EXEC_MAX_TRACKED_PROCESSES} reached]`;
}
