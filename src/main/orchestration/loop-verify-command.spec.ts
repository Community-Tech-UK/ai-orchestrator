import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findContendedWorkspacePaths,
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

/**
 * T42/T44 — a workspace another agent is mid-edit in must not have its suite
 * silently adopted as this loop's completion authority.
 */
describe('resolveLoopVerification concurrent-writer guard (T42)', () => {
  const inferred = async () => ({
    command: 'npm run verify',
    source: 'package.json script "verify"',
    scope: 'workspace' as const,
  });

  it('refuses to auto-adopt when untracked spec files signal another writer', async () => {
    const result = await resolveLoopVerification({
      workspaceCwd: '/repo',
      requireAuthority: true,
      infer: inferred,
      gitStatus: async () => '?? src/main/foo.spec.ts\n M src/main/foo.ts\n',
    });

    expect(result.authority).toBe('none');
    expect(result.verifyCommand).toBe('');
    expect(result.contendedPaths).toEqual(['src/main/foo.spec.ts']);
  });

  it('treats a live loop-state directory as contention', async () => {
    const result = await resolveLoopVerification({
      workspaceCwd: '/repo',
      requireAuthority: true,
      infer: inferred,
      gitStatus: async () => '?? .aio-loop-state/loop-9/\n',
    });

    expect(result.contendedPaths).toEqual(['.aio-loop-state/loop-9/']);
  });

  it('adopts the verifier when only ordinary untracked files are present', async () => {
    const result = await resolveLoopVerification({
      workspaceCwd: '/repo',
      requireAuthority: true,
      infer: inferred,
      gitStatus: async () => '?? docs/plans/some-plan.md\n?? notes.txt\n',
    });

    expect(result.authority).toBe('inferred');
    expect(result.verifyCommand).toBe('npm run verify');
  });

  it('skips the probe entirely when the loop is isolated', async () => {
    const gitStatus = vi.fn();
    const result = await resolveLoopVerification({
      workspaceCwd: '/repo',
      requireAuthority: true,
      isolated: true,
      infer: inferred,
      gitStatus,
    });

    expect(gitStatus).not.toHaveBeenCalled();
    expect(result.authority).toBe('inferred');
  });

  it('fails open when git status cannot be read', async () => {
    const result = await resolveLoopVerification({
      workspaceCwd: '/repo',
      requireAuthority: true,
      infer: inferred,
      gitStatus: async () => null,
    });

    expect(result.authority).toBe('inferred');
  });

  // An explicit command is the operator's choice; the guard only blocks silent
  // adoption.
  it('never blocks an explicitly supplied verify command', async () => {
    const result = await resolveLoopVerification({
      workspaceCwd: '/repo',
      verifyCommand: 'npm test',
      requireAuthority: true,
      infer: inferred,
      gitStatus: async () => '?? src/main/foo.spec.ts\n',
    });

    expect(result.authority).toBe('explicit');
    expect(result.verifyCommand).toBe('npm test');
  });
});

describe('findContendedWorkspacePaths (T42)', () => {
  it('reports only untracked entries', () => {
    expect(findContendedWorkspacePaths(' M src/a.spec.ts\n?? src/b.spec.ts\n'))
      .toEqual(['src/b.spec.ts']);
  });

  it('strips the quoting git applies to unusual path names', () => {
    expect(findContendedWorkspacePaths('?? "src/main/c d.spec.ts"\n'))
      .toEqual(['src/main/c d.spec.ts']);
  });

  it('returns nothing for a clean status', () => {
    expect(findContendedWorkspacePaths('')).toEqual([]);
  });
});
