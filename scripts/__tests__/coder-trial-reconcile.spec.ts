import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

// Keep the standalone Node suite runnable without the app's dependencies while
// including every regression in the normal repository verification gate.
it('passes the standalone coder-trial reconciliation regressions', () => {
  const result = spawnSync(process.execPath, ['--test', 'scripts/coder-trial-reconcile.test.mjs'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 35_000);
