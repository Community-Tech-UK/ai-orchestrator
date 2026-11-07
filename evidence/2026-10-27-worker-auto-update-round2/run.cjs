const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
process.chdir(root);
const scratch = path.join(root, '_scratch/worker-auto-update-round2');
const out = path.join(root, 'evidence/2026-10-27-worker-auto-update-round2');
fs.mkdirSync(out, { recursive: true });
const receipts = path.join(out, 'command-receipts.jsonl');
const original = path.join(root, 'evidence/2026-10-27-worker-auto-update-round2');
for (const name of ['dev-smoke.cjs', 'run-dev-smoke.cjs', 'isolated-runtime.ts']) {
  const source = fs.readFileSync(path.join(original, name), 'utf8');
  fs.writeFileSync(path.join(scratch, name), source);
  fs.writeFileSync(path.join(out, name), source);
}
let failed = false;
function run(name, executable, args, env = {}) {
  const log = path.join(out, name + '.log.txt');
  const fd = fs.openSync(log, 'w');
  const startedAt = new Date().toISOString();
  const result = spawnSync(executable, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd], timeout: 300000 });
  fs.closeSync(fd);
  const receipt = { startedAt, finishedAt: new Date().toISOString(), executable, args, envOverrides: env, exitCode: result.status, signal: result.signal, error: result.error?.message, log: path.basename(log) };
  fs.appendFileSync(receipts, JSON.stringify(receipt) + '\n');
  console.log(name + ': ' + (result.status === 0 ? 'PASS' : 'FAIL'));
  if (result.status !== 0) failed = true;
  return result.status === 0;
}
if (run('build-main', 'npm', ['run', 'build:main']) && run('build-renderer', 'npm', ['run', 'build:renderer'])) {
  run('dev-smoke', process.execPath, [path.join(scratch, 'run-dev-smoke.cjs')], { AIO_LT_REUSE_OWN_PROFILE: '1' });
  run('isolated-runtime', process.execPath, ['--import', 'tsx', path.join(scratch, 'isolated-runtime.ts')]);
}
run('focused-tests', 'npm', ['run', 'test:quiet', '--', 'src/worker-agent/worker-self-update.spec.ts', 'src/worker-agent/worker-self-update-wiring.spec.ts', 'src/worker-agent/worker-supervisor.spec.ts', 'src/worker-agent/worker-activity.spec.ts'], { AIO_TEST_MAX_FORKS: '1', AIO_TEST_SUMMARY: '0' });
run('typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
run('typecheck-spec', 'npm', ['run', 'typecheck:spec']);
for (const name of ['dev-result.json', 'dev-exit.json', 'isolated-runtime-result.json']) {
  const file = path.join(scratch, name);
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(out, name));
}
process.exitCode = failed ? 1 : 0;
