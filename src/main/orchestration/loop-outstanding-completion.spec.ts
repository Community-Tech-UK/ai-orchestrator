import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { LoopStageMachine } from './loop-stage-machine';
import { applyOutstandingCompletionGate } from './loop-outstanding-completion';

it('incomplete or missing question files cannot prove a clean end', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'loop-question-gate-'));
  const machine = new LoopStageMachine(cwd, 'run');
  try {
    expect((await applyOutstandingCompletionGate({ status: 'completed', reason: 'Checks passed.' }, machine)).status).toBe('completed-needs-review');
    await machine.bootstrap(defaultLoopConfig(cwd, 'goal'));
    expect((await applyOutstandingCompletionGate({ status: 'completed', reason: 'Checks passed.' }, machine)).status).toBe('completed');
    writeFileSync(machine.paths.outstanding, '## For information\n' + 'x'.repeat(140 * 1024) + '\n## Needs human\n- Publish the release?');
    const result = await applyOutstandingCompletionGate({ status: 'completed', reason: 'Checks passed.' }, machine);
    expect(result.status).toBe('completed-needs-review');
    expect(result.reason).toContain('could not be read completely');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
