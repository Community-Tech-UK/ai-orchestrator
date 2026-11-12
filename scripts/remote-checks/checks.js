#!/usr/bin/env node
'use strict';
/**
 * Runs the project's checks (type checks, lint, builds) on the test machine when one is set up, and on
 * this Mac otherwise, then prints each one's result. With no commands it runs the usual list.
 *
 *   node scripts/remote-checks/checks.js [--json <file>] [--set default|push | command...]
 *
 * One snapshot goes across for the lot. Every check runs, whatever fails, as it would here, and the
 * exit code is the first failing check's. `--json` writes each check's result for the Plan Queue.
 *
 * With this Mac switched off in the config (`useThisMac: false`), the checks wait for a test machine and never run
 * here: when none takes them it prints `Not run: <reason>`, writes `{ notRun: true, reason, exitCode: 69, checks: [] }`
 * to the --json file and exits NOT_RUN (69).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { NOT_RUN, appendRunLog, isLoopRun, isQueueCheck, machinesFor, readConfig, stayReason } = require('./route');
const { runOnMachines } = require('./run-remote');

/** The only commands this runs, exactly as written. remote-run.sh's `known_check` has the same list. */
const KNOWN_CHECKS = [
  'npx tsc --noEmit',
  'npm run typecheck',
  'npm run typecheck:spec',
  'npm run lint',
  'npm run check:ts-max-loc',
  'npm run check:ui-hints',
  'npm run build:main',
  'npm run build:worker-agent',
  'npm run build:renderer',
];
/** The checklist in AGENTS.md, apart from the full test run, which has its own command. */
const DEFAULT_CHECKS = [
  'npm run typecheck',
  'npm run typecheck:spec',
  'npm run lint',
  'npm run check:ts-max-loc',
  'npm run check:ui-hints',
  'npm run build:main',
  'npm run build:renderer',
];
/** Named lists, so a caller needn't pass commands with spaces through a shell. */
const CHECK_SETS = {
  default: DEFAULT_CHECKS,
  // The slow part of scripts/run-git-hook.js's pre-push list, in its order.
  push: ['npm run lint', 'npm run typecheck', 'npm run typecheck:spec', 'npm run build:main', 'npm run build:worker-agent', 'npm run build:renderer'],
};
const MAC = 'the Mac';
/** What the Plan Queue keeps of a check's output, and so all a run needs to send back. */
const OUTPUT_LIMIT = 256_000;
const SHOWN_LINES = 40;

/**
 * - `local`: no test machine is set up, or this is GitHub. Runs here and logs nothing.
 * - `mac`: belongs here this time, for `reason`.
 * - `remote`: try the test machine first.
 * - `not-run`: this Mac is switched off and the checks can't go anywhere else, for `reason`.
 */
function decideChecksRoute({ env = process.env, root, config }) {
  if (env.GITHUB_ACTIONS || !config) return { kind: 'local' };
  if (config.useThisMac === false) {
    if (env.AIO_REMOTE_CHECKS === 'off') return { kind: 'not-run', reason: 'AIO_REMOTE_CHECKS=off asked for this Mac, and this Mac is switched off' };
    const stopped = stayReason(config, 'checks');
    if (stopped) return { kind: 'not-run', reason: `${stopped}, and this Mac is switched off` };
    return { kind: 'remote' };
  }
  if (env.AIO_REMOTE_CHECKS === 'off') return { kind: 'mac', reason: 'AIO_REMOTE_CHECKS=off asked for it' };
  const chosenHere = stayReason(config, 'checks');
  if (chosenHere) return { kind: 'mac', reason: chosenHere };
  if (isQueueCheck(root, env) && !config.queueChecks) return { kind: 'mac', reason: 'queue checks stay on the Mac for now' };
  return { kind: 'remote' };
}

/** Runs one check here, appending its output to the log, and keeping the end of it. */
function runHere(command, root, logStream) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('bash', ['-c', command], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let kept = Buffer.alloc(0);
    const take = (chunk) => {
      logStream.write(chunk);
      kept = Buffer.concat([kept, chunk]);
      if (kept.length > OUTPUT_LIMIT * 2) kept = kept.subarray(-OUTPUT_LIMIT);
    };
    logStream.write(`[checks] ${command}\n`);
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const finish = (exitCode) => resolve({
      command, exitCode, durationMs: Date.now() - started, output: kept.subarray(-OUTPUT_LIMIT).toString('utf8'),
    });
    child.on('error', (error) => {
      take(Buffer.from(`${error.message}\n`));
      finish(127);
    });
    child.on('close', (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
}

async function runAllHere(checks, root, logPath, onResult) {
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const results = [];
  for (const command of checks) {
    const result = await runHere(command, root, logStream);
    results.push(result);
    onResult(result);
  }
  await new Promise(resolve => logStream.end(resolve));
  return results;
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function lastLines(text, count) {
  return text.trimEnd().split('\n').slice(-count).join('\n');
}

/**
 * Runs `checks` wherever they belong. Resolves `{ exitCode, ranOn, where, fellBackBecause, checks }`, where
 * `ranOn` is `the Mac` or the machine's label, or null when no test machine is set up, and `checks` has every
 * check's result in order. `onResult` hears each one as soon as it's known: as it finishes here, all at once from afar.
 */
async function runChecks({ checks, root, logPath, env = process.env, onResult = () => {} }) {
  let config;
  try {
    config = readConfig(env);
  } catch (error) {
    process.stderr.write(`Remote checks are switched off for this run: ${error.message}\n`);
    config = null;
  }
  const route = decideChecksRoute({ env, root, config });
  const started = Date.now();
  let results = null;
  let ranOn = MAC;
  let host = 'mac';
  let reason = route.reason ?? null;
  const thisMacOff = config?.useThisMac === false;

  if (route.kind === 'not-run') return notRunOutcome({ root, env, started, reason });
  if (route.kind === 'remote') {
    const machines = machinesFor(config, 'checks');
    // Which one takes them is known only afterwards, and the last line says.
    const to = machines.length === 1 ? machines[0].label : 'your test machines';
    process.stderr.write(`checks: sending ${checks.length} to ${to}\n`);
    const remote = await runOnMachines(machines, {
      root, logPath, jsonPath: null, ci: env.CI, noCache: false, checks, ...(thisMacOff ? { patient: true, env } : {}),
    });
    if (remote.ok) {
      results = remote.checks;
      ranOn = remote.machine.label;
      host = remote.machine.host;
      results.forEach(onResult);
    } else if (thisMacOff) {
      reason = remote.notRun ? remote.reason : `${remote.reason}, and this Mac is switched off`;
      return notRunOutcome({ root, env, started, reason });
    } else {
      reason = remote.reason;
      process.stderr.write(`checks: running on the Mac because ${reason}\n`);
    }
  }
  results ||= await runAllHere(checks, root, logPath, onResult);

  const tookMs = Date.now() - started;
  const firstFailure = results.find(result => result.exitCode !== 0)?.exitCode ?? 0;
  // 69 means "not run" to every caller, so a check that really exits 69 reads as a plain failure.
  const exitCode = firstFailure === NOT_RUN ? 1 : firstFailure;
  if (route.kind !== 'local') {
    appendRunLog({
      at: new Date(started).toISOString(),
      project: path.basename(root),
      kind: 'checks',
      loop: isLoopRun(env),
      ranOn: host,
      checks: results.map(result => ({ command: result.command, exitCode: result.exitCode, tookMs: result.durationMs })),
      tookMs,
      exitCode,
      fellBackBecause: ranOn === MAC ? reason : null,
    }, env);
  }
  const where = route.kind === 'local'
    ? null
    : ranOn === MAC
      ? `Ran on the Mac in ${formatDuration(tookMs)}, because ${reason}.`
      : `Ran on ${ranOn} in ${formatDuration(tookMs)}.`;
  return {
    exitCode, ranOn: route.kind === 'local' ? null : ranOn, where, fellBackBecause: ranOn === MAC ? reason : null, checks: results,
  };
}

/** Nothing ran: no test machine took the checks, and this Mac is switched off. */
function notRunOutcome({ root, env, started, reason }) {
  appendRunLog({
    at: new Date(started).toISOString(),
    project: path.basename(root),
    kind: 'checks',
    loop: isLoopRun(env),
    ranOn: 'none',
    checks: [],
    tookMs: Date.now() - started,
    exitCode: NOT_RUN,
    fellBackBecause: null,
    notRunBecause: reason,
  }, env);
  return { exitCode: NOT_RUN, notRun: true, reason, ranOn: null, where: `Not run: ${reason}.`, fellBackBecause: null, checks: [] };
}

/** Throws for a set it doesn't know. */
function parseArgs(argv) {
  const args = [...argv];
  const take = (flag) => {
    const at = args.indexOf(flag);
    if (at < 0) return null;
    const [, value] = args.splice(at, 2);
    return value ?? null;
  };
  const jsonPath = take('--json');
  const set = take('--set');
  if (args[0] === '--') args.shift();
  if (set !== null) {
    if (!Object.hasOwn(CHECK_SETS, set) || args.length) throw new Error(`--set takes one of ${Object.keys(CHECK_SETS).join(', ')}, and no commands`);
    return { jsonPath, checks: CHECK_SETS[set] };
  }
  return { jsonPath, checks: args.length ? args : DEFAULT_CHECKS };
}

async function main() {
  const root = process.cwd();
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`checks: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const { jsonPath, checks } = parsed;
  const unknown = checks.filter(check => !KNOWN_CHECKS.includes(check));
  if (unknown.length) {
    process.stderr.write(`checks: not a check this can run: ${unknown.join(', ')}\nKnown: ${KNOWN_CHECKS.join(', ')}\n`);
    process.exitCode = 2;
    return;
  }
  const scratch = path.join(root, '_scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const logPath = path.join(scratch, `checks.pid-${process.pid}.log`);

  const show = (result) => {
    const time = formatDuration(result.durationMs);
    if (result.exitCode === 0) {
      process.stdout.write(`✓ ${result.command} (${time})\n`);
    } else {
      process.stdout.write(`✗ ${result.command}: exit ${result.exitCode} (${time})\n${lastLines(result.output, SHOWN_LINES)}\n`);
    }
  };
  const outcome = await runChecks({ checks, root, logPath, onResult: show });
  if (outcome.where) process.stdout.write(`${outcome.where}\n`);
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(outcome));
  if (outcome.exitCode === 0 || outcome.notRun) {
    fs.rmSync(logPath, { force: true });
  } else {
    process.stdout.write(`Full output: ${path.relative(root, logPath)}\n`);
  }
  // Not process.exit: piped output could be cut short.
  process.exitCode = outcome.exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`checks: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { CHECK_SETS, DEFAULT_CHECKS, KNOWN_CHECKS, NOT_RUN, decideChecksRoute, parseArgs, runChecks };
