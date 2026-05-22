import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferLoopVerifyCommand } from './loop-verify-command';

let workspace: string | null = null;

afterEach(() => {
  if (!workspace) return;
  rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

describe('inferLoopVerifyCommand', () => {
  it('prefers an explicit package verify script', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-verify-infer-'));
    writePackageJson({
      verify: 'npm run lint && npm test',
      lint: 'eslint .',
      test: 'vitest run',
    });

    await expect(inferLoopVerifyCommand(workspace)).resolves.toEqual({
      command: 'npm run verify',
      source: 'package.json script "verify"',
    });
  });

  it('composes the strongest available package scripts when verify is absent', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-verify-infer-'));
    writePackageJson({
      typecheck: 'tsc --noEmit',
      lint: 'eslint .',
      test: 'vitest run',
    });

    await expect(inferLoopVerifyCommand(workspace)).resolves.toEqual({
      command: 'npm run typecheck && npm run lint && npm run test',
      source: 'package.json scripts: typecheck, lint, test',
    });
  });

  it('returns null when the workspace has no usable verifier', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-verify-infer-'));
    writePackageJson({
      build: 'vite build',
      start: 'vite dev',
    });

    await expect(inferLoopVerifyCommand(workspace)).resolves.toBeNull();
  });
});

function writePackageJson(scripts: Record<string, string>): void {
  if (!workspace) throw new Error('workspace not initialised');
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts }, null, 2));
}
