/**
 * The test machine's choices, in `~/.ai-orchestrator/remote-checks/config.json`. Test runs, checks and pushes read it
 * through `scripts/remote-checks/route.js` with Harness closed, so it is the one record. This reads it for Harness,
 * and changes only the fields the Computers page owns, keeping everything else in the file as it was.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const DEFAULT_SLOTS = 3;
export const MAX_SLOTS = 8;
const DEFAULT_LABEL = 'the test machine';
const MAX_LABEL_CHARS = 100;

export interface TestMachine {
  host: string;
  /** What people call it, as the scripts print it: "Ran on the Windows PC in ...". */
  label: string;
  /** The paired computer this machine is part of, so the Computers page shows them as one. */
  nodeName: string | null;
  paused: boolean;
  testRuns: boolean;
  checks: boolean;
  /** How many test runs or checks it takes at once. */
  slots: number;
}

/** What the Computers page may change. */
export const TestMachineChangeSchema = z.object({
  paused: z.boolean(),
  testRuns: z.boolean(),
  checks: z.boolean(),
  slots: z.number().int().min(1).max(MAX_SLOTS),
}).partial().strict();
export type TestMachineChange = z.infer<typeof TestMachineChangeSchema>;

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
  const valid = TestMachineChangeSchema.parse(change);
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
