import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const shared = require('../generated-artifacts.json') as { artifacts: string[]; generators: string[] };
const { GENERATED_ARTIFACTS, getHookCommands } = require('../run-git-hook.js') as {
  GENERATED_ARTIFACTS: string[];
  getHookCommands: (hookName: string) => Array<{ command: string; args: string[] }>;
};
const { getStagedTestRelatedFiles } = require('../test-staged.js') as {
  getStagedTestRelatedFiles: (options?: { execFileSync?: () => string; existsSync?: () => boolean }) => string[];
};

// Harness's Plan Queue reads this same file (src/main/plan-queue/plan-queue-generated-files.ts)
// to decide which root files a landing may replace, so the hook must not keep its own copy.
describe('generated-artifacts.json is the one list', () => {
  it('is what the hook regenerates, stages and what test:staged leaves out', () => {
    expect(GENERATED_ARTIFACTS).toEqual(shared.artifacts);
    const commands = getHookCommands('pre-commit');
    expect(commands.filter((call) => call.args[1]?.startsWith('generate:')).map((call) => call.args[1])).toEqual(shared.generators);
    expect(commands.find((call) => call.command === 'git')?.args).toEqual(['add', ...shared.artifacts]);
    expect(getStagedTestRelatedFiles({ execFileSync: () => [...shared.artifacts, 'src/main/real-change.ts'].join('\n'), existsSync: () => true }))
      .toEqual(['src/main/real-change.ts']);
  });

  it('names only npm scripts that exist', () => {
    const scripts = (JSON.parse(readFileSync(require.resolve('../../package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    for (const generator of shared.generators) expect(scripts[generator], generator).toBeTruthy();
  });
});
