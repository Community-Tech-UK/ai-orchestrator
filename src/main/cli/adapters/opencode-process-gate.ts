/**
 * One startup gate for every OpenCode process Harness launches.
 *
 * Any `opencode` command that opens OpenCode's shared database — `opencode
 * acp`, and also `opencode models` and `opencode auth list` — dies with
 * "database is locked" when it opens the database in the same instant as
 * another (probe: docs/plans/2026-09-22-opencode-provider_plan_completed.md, Task 0.2 and
 * the post-build discovery race check). ACP sessions hold the gate until
 * `initialize` answers; short commands hold it for their whole run.
 */

import { createAcpStartupGate } from './acp-startup-gate';

export const openCodeProcessGate = createAcpStartupGate();

export async function withOpenCodeProcessGate<T>(run: () => Promise<T>): Promise<T> {
  const release = await openCodeProcessGate();
  try {
    return await run();
  } finally {
    release();
  }
}
