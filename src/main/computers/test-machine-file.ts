/**
 * The test machine's choices, in `~/.ai-orchestrator/remote-checks/config.json`. Test runs, checks and pushes read it
 * through `scripts/remote-checks/route.js` with Harness closed, so it is the one record. This reads it for Harness,
 * and changes only the fields the Computers page owns, keeping everything else in the file as it was.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TestMachineView, WorkToday } from '../../shared/types/computers.types';
import { ComputersChangeTestMachinePayloadSchema, type ValidatedChangeTestMachinePayload } from '@contracts/schemas/remote-node';

export const DEFAULT_SLOTS = 3;
export const MAX_SLOTS = 8;
const DEFAULT_LABEL = 'the test machine';
const MAX_LABEL_CHARS = 100;

export type TestMachine = TestMachineView;

export type TestMachineChange = ValidatedChangeTestMachinePayload;

export function remoteChecksDir(): string {
  return process.env['AIO_REMOTE_CHECKS_DIR'] || join(homedir(), '.ai-orchestrator', 'remote-checks');
}

function configPath(dir: string): string {
  return join(dir, 'config.json');
}

/** The file as written, or null when there is none. Throws when it can't be read as a config. */
function readRaw(dir: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(configPath(dir), 'utf8');
  } catch {
    return null;
  }
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The test machine settings file is not a JSON object.');
  return raw as Record<string, unknown>;
}

/** The same reading `route.js` makes, so Harness shows what the scripts will do. */
function describe(raw: Record<string, unknown>): TestMachine {
  if (typeof raw['host'] !== 'string' || !raw['host']) throw new Error('The test machine settings file names no host.');
  const label = typeof raw['label'] === 'string' && raw['label'] ? raw['label'].slice(0, MAX_LABEL_CHARS) : DEFAULT_LABEL;
  const slots = raw['slots'];
  return {
    host: raw['host'],
    label,
    nodeName: typeof raw['nodeName'] === 'string' && raw['nodeName'] ? raw['nodeName'] : null,
    paused: raw['paused'] === true,
    testRuns: raw['testRuns'] !== false,
    checks: raw['checks'] !== false,
    slots: typeof slots === 'number' && Number.isInteger(slots) && slots >= 1 && slots <= MAX_SLOTS ? slots : DEFAULT_SLOTS,
  };
}

/** The test machine, or null when none is set up. Throws when its file is broken. */
export function readTestMachine(dir = remoteChecksDir()): TestMachine | null {
  const raw = readRaw(dir);
  return raw ? describe(raw) : null;
}

/**
 * Applies `change` and returns the result. The new file replaces the old in one step, so a test run starting at the
 * same moment reads one or the other, never half of each. Throws when no test machine is set up.
 */
export function changeTestMachine(change: TestMachineChange, dir = remoteChecksDir()): TestMachine {
  const valid = ComputersChangeTestMachinePayloadSchema.parse(change);
  const raw = readRaw(dir);
  if (!raw) throw new Error('No test machine is set up on this Mac.');
  const next = { ...raw, ...valid };
  const result = describe(next);
  const temporary = `${configPath(dir)}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, configPath(dir));
  } finally {
    rmSync(temporary, { force: true });
  }
  return result;
}

/** One line of the run log, as `scripts/remote-checks/` writes it. */
export interface RunLine {
  at: string;
  kind?: string;
  ranOn: string;
  fellBackBecause?: string | null;
}

/** Both log files, the older first: the scripts start a new one past about a megabyte. Half-written lines are skipped. */
export function readRunLog(dir = remoteChecksDir()): RunLine[] {
  const text = ['runs.old.jsonl', 'runs.jsonl'].map((name) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  }).join('\n');
  return text.split('\n').flatMap((line) => {
    try {
      const run = JSON.parse(line) as RunLine;
      return typeof run.at === 'string' && typeof run.ranOn === 'string' ? [run] : [];
    } catch {
      return [];
    }
  });
}


const MAC = 'mac';

/** Today in this Mac's own time zone. */
export function summariseWorkToday(runs: readonly RunLine[], now: number): WorkToday {
  const today = new Date(now).toDateString();
  const summary: WorkToday = { testRuns: { there: 0, here: 0 }, checks: { there: 0, here: 0 }, shortRunsHere: 0, hereBecause: [] };
  const reasons = new Map<string, number>();
  for (const run of runs) {
    if (new Date(run.at).toDateString() !== today) continue;
    if (run.kind === 'local') {
      summary.shortRunsHere += 1;
      continue;
    }
    const counts = run.kind === 'checks' ? summary.checks : summary.testRuns;
    if (run.ranOn === MAC) {
      counts.here += 1;
      if (run.fellBackBecause) reasons.set(run.fellBackBecause, (reasons.get(run.fellBackBecause) ?? 0) + 1);
    } else {
      counts.there += 1;
    }
  }
  summary.hereBecause = [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  return summary;
}
