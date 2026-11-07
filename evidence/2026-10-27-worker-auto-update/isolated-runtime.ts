import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { WorkerSelfUpdater, restorePreviousWorkerBundle, type RunCommand } from '../../src/worker-agent/worker-self-update';
import { WorkerActivity } from '../../src/worker-agent/worker-activity';

async function main() {
  const root = process.cwd();
  const output = path.join(root, '_scratch/worker-auto-update-evidence');
  const fixture = path.join(output, 'runtime');
  fs.mkdirSync(fixture);
  const bundle = path.join(fixture, 'index.js');
  const stamp = path.join(fixture, '.source-commit');
  const failed = path.join(fixture, '.auto-update-failed');
  const config = path.join(fixture, 'config.json');
  fs.writeFileSync(config, '{}');
  fs.writeFileSync(bundle, 'console.log("original isolated worker fixture")');
  const C1 = '1'.repeat(40), C2 = '2'.repeat(40), C3 = '3'.repeat(40), C4 = '4'.repeat(40);
  fs.writeFileSync(stamp, C1 + '\n');
  let head = C1, target = C2, now = 1_000_000, busyCount = 1, buildFails = false, restarts = 0;
  const commands: unknown[] = [], events: unknown[] = [], states: unknown[] = [];
  const activity = new WorkerActivity(() => busyCount, () => 0, () => now);
  const run: RunCommand = async (file, args, opts) => {
    if (file === 'git') {
      commands.push({ kind: 'INJECTED_GIT_NO_REPOSITORY_MUTATION', args });
      let stdout = '';
      if (args[0] === 'rev-parse') stdout = args.at(-1) === 'HEAD' ? head : target;
      if (args[0] === 'merge') head = args.at(-1)!;
      if (args[0] === 'reset') head = args.at(-1)!;
      return { code: 0, stdout, stderr: '' };
    }
    const selfCheck = args.includes('--self-check');
    // Preserve production build and self-check execution. Only the broken build
    // uses a disposable invalid JS file; no real checkout or commit is changed.
    let actualArgs = args;
    if (!selfCheck && buildFails) {
      const broken = path.join(fixture, 'broken-build.cjs');
      fs.writeFileSync(broken, 'const = ;');
      actualArgs = ['--check', broken];
    }
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      execFile(file, actualArgs, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr }));
    });
    commands.push({ kind: selfCheck ? 'REAL_SELF_CHECK' : buildFails ? 'REAL_INVALID_FIXTURE_BUILD' : 'REAL_PRODUCTION_BUILD', file, args: actualArgs, code: result.code, stdout: result.stdout, stderr: result.stderr });
    return result;
  };
  const options = {
    repoRoot: root, bundlePath: bundle, configPath: config,
    isBusy: () => activity.isBusy(), lastActivityAt: () => activity.lastActivityAt(),
    restart: async () => { restarts++; }, run, now: () => now,
    firstCheckDelayMs: 0, checkIntervalMs: 0,
    logger: { info: (message: string, meta?: unknown) => events.push({ message, meta }), warn: (message: string, meta?: unknown) => events.push({ message, meta }) },
  };
  let updater = new WorkerSelfUpdater(options);
  const record = (step: string) => states.push({ step, clock: now, ...updater.getSummary(), restarts });
  await updater.tick(); record('busy with target');
  assert.equal(updater.getSummary().state, 'waiting_for_idle');
  assert.equal(fs.readFileSync(stamp, 'utf8').trim(), C1);
  busyCount = 0; now += 179999;
  await updater.tick(); record('quiet 179999ms');
  assert.equal(updater.getSummary().state, 'waiting_for_idle');
  assert.equal(restarts, 0);
  now++;
  await updater.tick(); record('quiet 180000ms real build/self-check/swap');
  assert.equal(restarts, 1);
  assert.equal(fs.readFileSync(stamp, 'utf8').trim(), C2);
  assert.equal(fs.readFileSync(stamp + '.prev', 'utf8').trim(), C1);
  updater = new WorkerSelfUpdater(options);
  target = C3; buildFails = true; now += 180000;
  await updater.tick(); record('broken build');
  assert.equal(updater.getSummary().state, 'blocked');
  assert.equal(head, C2);
  assert.equal(fs.readFileSync(stamp, 'utf8').trim(), C2);
  assert.equal(JSON.parse(fs.readFileSync(failed, 'utf8')).commit, C3);
  const buildsBeforeRetry = commands.filter((x: any) => x.kind === 'REAL_INVALID_FIXTURE_BUILD').length;
  await updater.tick(); record('same failed target not rebuilt');
  assert.equal(commands.filter((x: any) => x.kind === 'REAL_INVALID_FIXTURE_BUILD').length, buildsBeforeRetry);
  buildFails = false; target = C4;
  await updater.tick(); record('fixed target real build/self-check/swap');
  assert.equal(head, C4); assert.equal(restarts, 2); assert.equal(fs.existsSync(failed), false);
  assert.equal(restorePreviousWorkerBundle(bundle), true);
  assert.equal(fs.readFileSync(stamp, 'utf8').trim(), C2);
  assert.equal(JSON.parse(fs.readFileSync(failed, 'utf8')).commit, C4);
  fs.writeFileSync(path.join(output, 'isolated-runtime-result.json'), JSON.stringify({ observedAt: new Date().toISOString(), result: 'PASS', limits: 'Git responses, clock and restart callback injected; real production esbuild, Node self-check, filesystem swaps and rollback. Not a real pushed commit, running worker restart or Windows filesystem check.', states, events, commands }, null, 2));
  console.log('PASS: isolated busy/quiet, real build/self-check/swap, broken build rollback, retry suppression, fixed target and startup restore');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
