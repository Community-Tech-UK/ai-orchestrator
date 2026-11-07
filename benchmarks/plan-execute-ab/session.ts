import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { log } from './cli-util';
import { cleanupWorkspace } from './task-export';
import type { RunRecord } from './types';

export interface Session {
  dir: string;
  runsPath: string;
  patchesDir: string;
  plansDir: string;
  judgeDir: string;
}

export function openSession(resultsRoot: string, name: string | undefined): Session {
  const id = name ?? new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(resolve(resultsRoot), id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'patches'), { recursive: true });
  mkdirSync(join(dir, 'plans'), { recursive: true });
  mkdirSync(join(dir, 'judge'), { recursive: true });
  return {
    dir,
    runsPath: join(dir, 'runs.jsonl'),
    patchesDir: join(dir, 'patches'),
    plansDir: join(dir, 'plans'),
    judgeDir: join(dir, 'judge'),
  };
}

/**
 * One run cell's identity: task + arm + numbered repeat slot. Records are
 * keyed by it so a slot can never be counted twice (aggregation) or filled
 * twice (persistence).
 */
export function runCellKey(taskId: string, armId: string, runNumber: number): string {
  return `${taskId}|${armId}|${runNumber}`;
}

/**
 * Reconcile records to ONE per run cell. Duplicated records of an existing
 * slot are not extra experimental evidence — counting them inflates rates and
 * can reverse a decision (verifier repro: two copies of one successful record
 * moved C1 from 5/10 to 7/12 and switched the pilot stop rule off). The FIRST
 * record per cell wins: it is the one judges compare and the one the cost logs
 * are keyed to; later duplicates are reconciled away consistently before any
 * aggregation or decision.
 */
export function reconcileRunRecords(runs: readonly RunRecord[]): { records: RunRecord[]; duplicates: number } {
  const seen = new Set<string>();
  const records: RunRecord[] = [];
  let duplicates = 0;
  for (const run of runs) {
    const key = runCellKey(run.taskId, run.armId, run.runNumber);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    records.push(run);
  }
  return { records, duplicates };
}

export function loadRunRecords(session: Session): RunRecord[] {
  if (!existsSync(session.runsPath)) return [];
  const parsed = readFileSync(session.runsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunRecord);
  return reconcileRunRecords(parsed).records;
}

/**
 * Append a scored run. Rejects a duplicate run cell: re-running a slot is a
 * deliberate act (quarantine/move the existing record out first, as the C1
 * protocol restart did) and must never silently double the evidence.
 */
export function appendRunRecord(session: Session, record: RunRecord): void {
  const key = runCellKey(record.taskId, record.armId, record.runNumber);
  const clash = loadRunRecords(session).find(
    (run) => runCellKey(run.taskId, run.armId, run.runNumber) === key,
  );
  if (clash) {
    throw new Error(
      `duplicate run cell ${key}: a record already exists (started ${clash.startedAt}) — `
      + 'quarantine the existing record before re-running a slot',
    );
  }
  appendFileSync(session.runsPath, `${JSON.stringify(record)}\n`);
}

/**
 * Persist a scored run, then clean its throwaway workspace. LT-707: the
 * record goes first — a cleanup flake (ENOTEMPTY removal races) must never
 * discard a completed, scored run or fail its batch cell.
 */
export function finalizeScoredRun(
  session: Session,
  record: RunRecord,
  workspaceDir: string,
  cleanup: (dir: string) => void = cleanupWorkspace,
): void {
  appendRunRecord(session, record);
  bestEffortCleanup(workspaceDir, cleanup);
}

export function bestEffortCleanup(dir: string, cleanup: (dir: string) => void = cleanupWorkspace): void {
  try {
    cleanup(dir);
  } catch (error) {
    log(`workspace cleanup failed for ${dir} (record preserved): ${error instanceof Error ? error.message : String(error)}`);
  }
}
