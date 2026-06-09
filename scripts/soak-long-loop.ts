import { spawnSync } from 'node:child_process';

const durationHours = Number(process.env['AIO_SOAK_HOURS'] ?? 1);
const startedAt = Date.now();
const deadline = startedAt + durationHours * 60 * 60 * 1000;
let runs = 0;

while (Date.now() < deadline) {
  const result = spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', 'src/main/orchestration/long-loop-resilience.spec.ts'],
    { stdio: 'inherit' },
  );
  runs++;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`long-loop soak completed ${runs} run(s) in ${durationHours} hour(s)`);
