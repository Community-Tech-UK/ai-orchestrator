import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopStageMachine } from './loop-stage-machine';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { parseOutstandingSections } from './loop-stage-markdown';
it('seeds OUTSTANDING once and preserves in-progress questions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'outstanding-bootstrap-'));
  try {
    const machine = new LoopStageMachine(dir, 'run');
    await machine.bootstrap(defaultLoopConfig(dir, 'goal'));
    expect(parseOutstandingSections(readFileSync(machine.paths.outstanding, 'utf8')).needsHuman).toEqual([]);
    writeFileSync(machine.paths.outstanding, '## Needs human\n- Keep this question?');
    await machine.bootstrap(defaultLoopConfig(dir, 'goal'));
    expect(readFileSync(machine.paths.outstanding, 'utf8')).toContain('Keep this question?');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
