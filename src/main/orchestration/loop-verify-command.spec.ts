import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inferLoopVerifyCommand,
  resolveLoopVerification,
  type InferredLoopVerifyCommand,
} from './loop-verify-command';

let workspace: string | null = null;

afterEach(() => {
  if (!workspace) return;
  rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

function quotedShellArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

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
      scope: 'workspace',
    });
  });

  it('finds the nearest parent package verifier for nested workspaces, marked as an ancestor', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-verify-infer-'));
    writePackageJson({
      verify: 'npm test',
    });
    const nestedWorkspace = join(workspace, 'src', 'main');
    mkdirSync(nestedWorkspace, { recursive: true });

    await expect(inferLoopVerifyCommand(nestedWorkspace)).resolves.toEqual({
      command: `npm --prefix ${quotedShellArg(workspace)} run verify`,
      source: 'package.json script "verify"',
      scope: 'ancestor',
    });
  });

  it('finds a verifier in a child package when the workspace is a parent folder', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-verify-infer-'));
    const siblingWorkspace = join(workspace, 'agent-orchestrator');
    mkdirSync(siblingWorkspace, { recursive: true });
    writeFileSync(
      join(siblingWorkspace, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest run' } }, null, 2),
    );
    const packageWorkspace = join(workspace, 'ai-orchestrator');
    mkdirSync(packageWorkspace, { recursive: true });
    writeFileSync(
      join(packageWorkspace, 'package.json'),
      JSON.stringify({ scripts: { verify: 'npm test' } }, null, 2),
    );

    // The prefix is WORKSPACE-RELATIVE — the command is spawned with cwd = the
    // loop's working directory, so it needs no absolute machine path.
    await expect(inferLoopVerifyCommand(workspace)).resolves.toEqual({
      command: `npm --prefix ${quotedShellArg('ai-orchestrator')} run verify`,
      source: 'package.json script "verify"',
      scope: 'descendant',
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
      scope: 'workspace',
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

describe('resolveLoopVerification', () => {
  const detected = (
    overrides: Partial<InferredLoopVerifyCommand> = {},
  ): InferredLoopVerifyCommand => ({
    command: 'npm run verify',
    source: 'package.json script "verify"',
    scope: 'workspace',
    ...overrides,
  });
  const inferSpy = (result: InferredLoopVerifyCommand | null) => {
    const calls: string[] = [];
    const infer = async (cwd: string) => { calls.push(cwd); return result; };
    return { infer, calls };
  };

  it('adopts the workspace verifier when the caller supplied no command', async () => {
    const { infer, calls } = inferSpy(detected());

    await expect(resolveLoopVerification({
      workspaceCwd: '/ws', verifyCommand: '  ', requireAuthority: true, infer,
    })).resolves.toEqual({
      authority: 'inferred',
      verifyCommand: 'npm run verify',
      inferredSource: 'package.json script "verify"',
    });
    expect(calls).toEqual(['/ws']);
  });

  it('adopts a descendant package verifier', async () => {
    const { infer } = inferSpy(detected({ command: 'npm --prefix "app" run verify', scope: 'descendant' }));

    const resolved = await resolveLoopVerification({
      workspaceCwd: '/ws', requireAuthority: true, infer,
    });

    expect(resolved.authority).toBe('inferred');
    expect(resolved.verifyCommand).toBe('npm --prefix "app" run verify');
  });

  it('refuses to adopt an ancestor verifier — it belongs to a project the loop was not aimed at', async () => {
    const { infer } = inferSpy(detected({ command: 'npm --prefix "/repo" run verify', scope: 'ancestor' }));

    await expect(resolveLoopVerification({
      workspaceCwd: '/repo/sub', requireAuthority: true, infer,
    })).resolves.toEqual({ authority: 'none', verifyCommand: '' });
  });

  it('an explicit command wins and skips detection entirely', async () => {
    const { infer, calls } = inferSpy(detected());

    await expect(resolveLoopVerification({
      workspaceCwd: '/ws', verifyCommand: '  make check  ', requireAuthority: true, infer,
    })).resolves.toEqual({ authority: 'explicit', verifyCommand: 'make check' });
    expect(calls).toEqual([]);
  });

  it('an explicit operator-reviewed choice is not silently given a detected gate', async () => {
    const { infer, calls } = inferSpy(detected());

    await expect(resolveLoopVerification({
      workspaceCwd: '/ws', allowOperatorReviewedCompletion: true, requireAuthority: true, infer,
    })).resolves.toEqual({ authority: 'operator-reviewed', verifyCommand: '' });
    expect(calls).toEqual([]);
  });

  it('does not infer for goals that need no authority (investigation)', async () => {
    const { infer, calls } = inferSpy(detected());

    await expect(resolveLoopVerification({
      workspaceCwd: '/ws', requireAuthority: false, infer,
    })).resolves.toEqual({ authority: 'none', verifyCommand: '' });
    expect(calls).toEqual([]);
  });

  it('reports no authority when the workspace exposes no verifier', async () => {
    const { infer } = inferSpy(null);

    await expect(resolveLoopVerification({
      workspaceCwd: '/ws', requireAuthority: true, infer,
    })).resolves.toEqual({ authority: 'none', verifyCommand: '' });
  });
});

function writePackageJson(scripts: Record<string, string>): void {
  if (!workspace) throw new Error('workspace not initialised');
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts }, null, 2));
}
