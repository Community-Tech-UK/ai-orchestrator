/**
 * Where full test runs went, for "Queue health". `scripts/remote-checks/` keeps the record, one
 * JSON line per run, because it has to work with Harness closed. This only reads it. With no
 * config file there, no test machine is set up and there is nothing to say.
 */
import type { PlanQueueHealth } from '@contracts/schemas/plan-queue';
import { getLogger } from '../logging/logger';
import { readRunLog, readTestMachines, remoteChecksDir } from '../computers/test-machine-file';

const logger = getLogger('PlanQueueTestMachine');

const DAY_MS = 24 * 60 * 60_000;
/** Tests can go quiet for a while. Past this, an old fault says nothing about the machine now. */
const NOTICE_LIFETIME_MS = 60 * 60_000;
const MAC = 'mac';
/** Runs kept here on purpose by a person, rather than by a fault. route.js writes these reasons. */
const KEPT_HERE = /AIO_REMOTE_CHECKS=off|queue checks stay on the Mac/;
/** What the Computers page turned off, one part per machine, joined with " and " when there are several. */
const TURNED_OFF = / is paused$|^(?:test runs|checks) are turned off for /;
const choseTheMac = (reason: string) => KEPT_HERE.test(reason) || (reason !== '' && reason.split(' and ').every(part => TURNED_OFF.test(part)));
const COULD_NOT_REACH = /could not be reached|was lost during the run/;

type TestMachineHealth = NonNullable<PlanQueueHealth['testMachine']>;

/** What Queue health calls where tests went: the one test machine's name, or all of them together. */
function readLabel(dir: string): string | null {
  try {
    const machines = readTestMachines(dir);
    if (!machines.length) return null;
    return machines.length === 1 ? machines[0]!.label : 'your test machines';
  } catch (error) {
    logger.warn('Remote checks config could not be read', { error: String(error) });
    return null;
  }
}


const share = (count: number, of: number) => ({ count, of, share: of ? count / of : null });

export function readTestMachineHealth(now: number, windowDays: number, dir = remoteChecksDir()): TestMachineHealth | undefined {
  const label = readLabel(dir);
  if (!label) return undefined;

  const since = now - windowDays * DAY_MS;
  // A run that was always going to stay here says nothing about the test machine, and as the latest
  // line it would clear an "unreachable" notice.
  const recent = readRunLog(dir).filter(run => run.kind !== 'local' && Date.parse(run.at) >= since);
  // iPhone work has a figure of its own, and whether it reached the test Mac says nothing about where tests run.
  const iphone = recent.filter(run => run.kind === 'ios');
  const tried = recent.filter(run => run.kind !== 'ios' && !choseTheMac(run.fellBackBecause ?? ''));
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
    iphone: share(iphone.filter(run => run.ranOn !== MAC).length, iphone.length),
  };
}

/** Queue health with where full test runs went, when a test machine is set up. */
export function withTestMachine(health: PlanQueueHealth, now: number): PlanQueueHealth {
  const testMachine = readTestMachineHealth(now, health.windowDays);
  return testMachine ? { ...health, testMachine } : health;
}
