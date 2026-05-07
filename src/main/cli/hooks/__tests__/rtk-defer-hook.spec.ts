import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const hookPath = path.join(
  process.cwd(),
  'src',
  'main',
  'cli',
  'hooks',
  'rtk-defer-hook.mjs',
);

/**
 * Build a stub rtk binary that exits with the requested code and prints the
 * given stdout. Lets us drive the hook's RTK integration without the real binary.
 */
function makeStubRtk(
  rootDir: string,
  spec: { exit: number; stdout?: string },
): string {
  if (process.platform === 'win32') {
    // Skip Windows in unit tests; covered by the integration matrix.
    return '';
  }
  const stubPath = path.join(rootDir, 'rtk');
  const lines: string[] = ['#!/usr/bin/env bash'];
  // Honor `rtk --version` so any precondition probe doesn't blow up
  lines.push(
    'if [[ "$1" == "--version" ]]; then',
    '  echo "rtk 0.39.0"',
    '  exit 0',
    'fi',
  );
  if (spec.stdout) {
    const safe = spec.stdout.replace(/'/g, `'\\''`);
    lines.push(`printf '${safe}'`);
  }
  lines.push(`exit ${spec.exit}`);
  writeFileSync(stubPath, lines.join('\n') + '\n', 'utf-8');
  chmodSync(stubPath, 0o755);
  return stubPath;
}

describe('rtk-defer-hook', () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'rtk-defer-hook-'));
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('defers unsafe tools when feature flag is off (parity with defer-permission-hook)', () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        tool_input: { command: 'git status' },
      }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'defer',
        permissionDecisionReason: 'Orchestrator: awaiting user approval',
      },
    });
  });

  it('auto-approves safe tools when feature flag is off', () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        tool_name: 'Read',
        tool_use_id: 'tool-2',
        tool_input: { file_path: '/tmp/foo.txt' },
      }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
  });

  it.runIf(process.platform !== 'win32')(
    'rewrites Bash command and defers when rtk exits 0 (allow + defer for orchestrator UI)',
    () => {
      const stub = makeStubRtk(tempDir!, { exit: 0, stdout: 'rtk git status' });
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-3',
          tool_input: { command: 'git status' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_RTK_ENABLED: '1',
          ORCHESTRATOR_RTK_PATH: stub,
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // Bash is not in AUTO_APPROVE — so we still defer, but with the rewritten command
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('defer');
      expect(parsed.hookSpecificOutput.updatedInput).toEqual({ command: 'rtk git status' });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'forces defer with rewritten command when rtk exits 3 (ask)',
    () => {
      const stub = makeStubRtk(tempDir!, { exit: 3, stdout: 'rtk git push' });
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-4',
          tool_input: { command: 'git push' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_RTK_ENABLED: '1',
          ORCHESTRATOR_RTK_PATH: stub,
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('defer');
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('RTK ask rule');
      expect(parsed.hookSpecificOutput.updatedInput).toEqual({ command: 'rtk git push' });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'leaves command unchanged when rtk exits 1 (passthrough)',
    () => {
      const stub = makeStubRtk(tempDir!, { exit: 1 });
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-5',
          tool_input: { command: 'htop' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_RTK_ENABLED: '1',
          ORCHESTRATOR_RTK_PATH: stub,
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('defer');
      expect(parsed.hookSpecificOutput.updatedInput).toBeUndefined();
    },
  );

  it.runIf(process.platform !== 'win32')(
    'leaves command unchanged when rtk exits 2 (deny)',
    () => {
      const stub = makeStubRtk(tempDir!, { exit: 2 });
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-6',
          tool_input: { command: 'rm -rf /' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_RTK_ENABLED: '1',
          ORCHESTRATOR_RTK_PATH: stub,
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // We don't auto-allow on deny — Claude Code's native deny rules will fire
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('defer');
      expect(parsed.hookSpecificOutput.updatedInput).toBeUndefined();
    },
  );

  it.runIf(process.platform !== 'win32')(
    'gracefully degrades when rtk binary is missing',
    () => {
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-7',
          tool_input: { command: 'git status' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_RTK_ENABLED: '1',
          ORCHESTRATOR_RTK_PATH: '/nonexistent/path/to/rtk',
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // Falls back to normal defer, no rewrite
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('defer');
      expect(parsed.hookSpecificOutput.updatedInput).toBeUndefined();
    },
  );

  it.runIf(process.platform !== 'win32')(
    'skips rtk for non-Bash tools',
    () => {
      const stub = makeStubRtk(tempDir!, { exit: 0, stdout: 'should-not-be-used' });
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          tool_name: 'Edit',
          tool_use_id: 'tool-8',
          tool_input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_RTK_ENABLED: '1',
          ORCHESTRATOR_RTK_PATH: stub,
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(parsed.hookSpecificOutput.updatedInput).toBeUndefined();
    },
  );

  it.runIf(process.platform !== 'win32')(
    'replays stored decision file on resume, preserving rewrite',
    () => {
      const stub = makeStubRtk(tempDir!, { exit: 0, stdout: 'rtk git status' });
      writeFileSync(
        path.join(tempDir!, 'tool-9.json'),
        JSON.stringify({ permissionDecision: 'allow', reason: 'Previously approved' }),
        'utf8',
      );

      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-9',
          tool_input: { command: 'git status' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_RTK_ENABLED: '1',
          ORCHESTRATOR_RTK_PATH: stub,
          ORCHESTRATOR_DECISION_DIR: tempDir!,
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe('Previously approved');
      expect(parsed.hookSpecificOutput.updatedInput).toEqual({ command: 'rtk git status' });
    },
  );
});
