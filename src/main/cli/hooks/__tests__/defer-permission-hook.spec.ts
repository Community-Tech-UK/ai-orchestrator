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
});
