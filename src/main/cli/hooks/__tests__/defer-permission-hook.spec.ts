import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

const hookPath = path.join(
  process.cwd(),
  'src',
  'main',
  'cli',
  'hooks',
  'defer-permission-hook.mjs',
);

describe('defer-permission-hook', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('reads hook payloads from stdin and defers unsafe tools', () => {
    const result = spawnSync(
      process.execPath,
      [hookPath],
      {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-123',
        }),
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'defer',
        permissionDecisionReason: 'Orchestrator: awaiting user approval',
      },
    });
  });

  it('replays a stored decision file on resume', () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'defer-hook-test-'));
    writeFileSync(
      path.join(tempDir, 'tool-456.json'),
      JSON.stringify({
        permissionDecision: 'allow',
        reason: 'Previously approved',
      }),
      'utf8',
    );

    const result = spawnSync(
      process.execPath,
      [hookPath],
      {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-456',
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_DECISION_DIR: tempDir,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Previously approved',
      },
    });
  });

  it('includes updatedInput in hook reply when decision file carries it (modify flow)', () => {
    // Simulates a 'modify' decision written by DeferDecisionStore: permissionDecision='allow'
    // + updatedInput containing the replacement tool input.
    tempDir = mkdtempSync(path.join(tmpdir(), 'defer-hook-test-'));
    const replacement = { command: 'echo safe' };
    writeFileSync(
      path.join(tempDir, 'tool-789.json'),
      JSON.stringify({
        permissionDecision: 'allow',
        reason: 'Approved with modified command',
        updatedInput: replacement,
      }),
      'utf8',
    );

    const result = spawnSync(
      process.execPath,
      [hookPath],
      {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-789',
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_DECISION_DIR: tempDir,
        },
      },
    );

    expect(result.status).toBe(0);
    // NOTE: Whether the Claude CLI actually honors updatedInput is version-dependent
    // and cannot be validated headlessly. We verify the plumbing emits it correctly.
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Approved with modified command',
        updatedInput: replacement,
      },
      // top-level for forward-compatibility with CLI versions that may expect it there
      updatedInput: replacement,
    });
  });

  it('omits updatedInput from hook reply when decision file has none (plain allow)', () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'defer-hook-test-'));
    writeFileSync(
      path.join(tempDir, 'tool-plain.json'),
      JSON.stringify({
        permissionDecision: 'allow',
        reason: 'User approved',
      }),
      'utf8',
    );

    const result = spawnSync(
      process.execPath,
      [hookPath],
      {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-plain',
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_DECISION_DIR: tempDir,
        },
      },
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    // No updatedInput at top level or inside hookSpecificOutput
    expect(parsed['updatedInput']).toBeUndefined();
    expect(
      (parsed['hookSpecificOutput'] as Record<string, unknown>)['updatedInput'],
    ).toBeUndefined();
  });
});
