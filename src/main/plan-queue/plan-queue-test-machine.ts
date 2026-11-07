/**
 * Where full test runs went, for "Queue health". `scripts/remote-checks/` keeps the record, one
 * JSON line per run, because it has to work with Harness closed. This only reads it. With no
 * config file there, no test machine is set up and there is nothing to say.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PlanQueueHealth } from '@contracts/schemas/plan-queue';
import { getLogger } from '../logging/logger';

const logger = getLogger('PlanQueueTestMachine');

const DAY_MS = 24 * 60 * 60_000;
/** Tests can go quiet for a while. Past this, an old fault says nothing about the machine now. */
const NOTICE_LIFETIME_MS = 60 * 60_000;
const MAC = 'mac';
const CHOSE_THE_MAC = /AIO_REMOTE_CHECKS=off|queue checks stay on the Mac/;
const COULD_NOT_REACH = /could not be reached|was lost during the run/;

interface RunLine { at: string; kind?: string; ranOn: string; fellBackBecause: string | null }
type TestMachineHealth = NonNullable<PlanQueueHealth['testMachine']>;

function remoteChecksDir(): string {
  return process.env['AIO_REMOTE_CHECKS_DIR'] || join(homedir(), '.ai-orchestrator', 'remote-checks');
}

function readLabel(dir: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(dir, 'config.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    const { label } = JSON.parse(text) as { label?: unknown };
    return typeof label === 'string' && label ? label.slice(0, 100) : 'the test machine';
  } catch (error) {
    logger.warn('Remote checks config could not be read', { error: String(error) });
    return null;
  }
}

function readRuns(dir: string): RunLine[] {
  let text: string;
  try {
    text = readFileSync(join(dir, 'runs.jsonl'), 'utf8');
  } catch {
    return [];
  }
  // A run still being written, or killed part way, can leave half a line.
  return text.split('\n').flatMap((line) => {
    try {
      const run = JSON.parse(line) as RunLine;
      return typeof run.at === 'string' && typeof run.ranOn === 'string' ? [run] : [];
    } catch {
      return [];
    }
  });
}

const share = (count: number, of: number) => ({ count, of, share: of ? count / of : null });

export function readTestMachineHealth(now: number, windowDays: number, dir = remoteChecksDir()): TestMachineHealth | undefined {
  const label = readLabel(dir);
  if (!label) return undefined;

  const since = now - windowDays * DAY_MS;
  const recent = readRuns(dir).filter(run => Date.parse(run.at) >= since);
  const tried = recent.filter(run => !CHOSE_THE_MAC.test(run.fellBackBecause ?? ''));
  const fullRuns = recent.filter(run => !run.kind);
  const triedFullRuns = tried.filter(run => !run.kind);
  const ranThere = fullRuns.filter(run => run.ranOn !== MAC);
  const latest = tried.at(-1);

  return {
    label,
    ranThere: share(ranThere.length, fullRuns.length),
    movedToMac: share(triedFullRuns.filter(run => run.ranOn === MAC).length, triedFullRuns.length),
    unreachable: Boolean(latest && latest.ranOn === MAC && COULD_NOT_REACH.test(latest.fellBackBecause ?? '')
      && now - Date.parse(latest.at) < NOTICE_LIFETIME_MS),
  };
}

/** Queue health with where full test runs went, when a test machine is set up. */
export function withTestMachine(health: PlanQueueHealth, now: number): PlanQueueHealth {
  const testMachine = readTestMachineHealth(now, health.windowDays);
  return testMachine ? { ...health, testMachine } : health;
}
