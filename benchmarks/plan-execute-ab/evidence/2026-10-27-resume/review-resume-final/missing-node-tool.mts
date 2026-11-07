import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreRun } from '../../../scorer.ts';
import { prepareScoringDependencies } from '../../../scoring-setup.ts';
import type { TaskDefinition } from '../../../types.ts';

const dir = mkdtempSync(join(tmpdir(), 'review-missing-node-tool-'));
try {
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  writeFileSync(join(dir, 'package-lock.json'), '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}');
  const dependencies = await prepareScoringDependencies(dir);
  const task: TaskDefinition = {
    id: 'PROBE', repoId: 'fixture', commitSha: 'fixed', parentSha: 'parent', commitMessage: '',
    size: 'small', prompt: 'Probe', hiddenTests: ['fixture.cjs'],
    hiddenTestCommand: [process.execPath, '-e', ''],
    damageCommands: [[process.execPath, '--max-old-space-size=8192', 'node_modules/typescript/bin/tsc', '--noEmit']],
    sourceFiles: [], verification: { failOnParent: true, passOnCommit: true, checkedAt: '', evidenceDir: '' },
  };
  try {
    const result = await scoreRun(task, { workspaceDir: dir, dependencies });
    console.log(JSON.stringify({ outcome: 'scored', result }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ outcome: 'unscored', error: String(error) }, null, 2));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
