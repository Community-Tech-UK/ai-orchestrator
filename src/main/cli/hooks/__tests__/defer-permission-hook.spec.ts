import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { HARNESS_UNASKED_PREFIX } from '../../adapters/claude-permission-response';
import { CLAUDE_ALLOW_RULE_TOOLS } from '../../../../shared/permissions/claude-allow-rule-tools';

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

describe.each(['defer-permission-hook.mjs', 'rtk-defer-hook.mjs'])('%s PermissionRequest answer', (file) => {
  const run = (input: unknown) => spawnSync(process.execPath, [path.join(process.cwd(), 'src', 'main', 'cli', 'hooks', file)], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ORCHESTRATOR_RTK_ENABLED: '0', ORCHESTRATOR_RTK_REWRITE_ONLY: '0' },
  });

  it('refuses with text that says nobody was asked, names the tool and says what would allow it', () => {
    const result = run({ hook_event_name: 'PermissionRequest', tool_name: 'mcp__linear__save_issue', tool_use_id: 'toolu_1', tool_input: {} });
    expect(result.status).toBe(0);
    const reply = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; decision: { behavior: string; message: string } } };
    expect(reply.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
    expect(reply.hookSpecificOutput.decision.behavior).toBe('deny');
    // The hook repeats the TypeScript constant; the adapter relies on it to raise no dead-end card.
    expect(reply.hookSpecificOutput.decision.message.startsWith(HARNESS_UNASKED_PREFIX)).toBe(true);
    expect(reply.hookSpecificOutput.decision.message).toContain('mcp__linear__save_issue');
    expect(reply.hookSpecificOutput.decision.message).toMatch(/Auto-approve/);
  });

  it('keeps its copies of the shared constants equal to the TypeScript ones', () => {
    const source = readFileSync(path.join(process.cwd(), 'src', 'main', 'cli', 'hooks', file), 'utf8');
    expect(source).toContain(`const HARNESS_UNASKED_PREFIX = '${HARNESS_UNASKED_PREFIX}';`);
    expect(source).toContain(`const CLAUDE_ALLOW_RULE_TOOLS = [${CLAUDE_ALLOW_RULE_TOOLS.map(tool => `'${tool}'`).join(', ')}];`);
  });

  it.each(CLAUDE_ALLOW_RULE_TOOLS)('answers %s with Claude\'s wording, so the allow-rule card is still raised', (tool) => {
    const result = run({ hook_event_name: 'PermissionRequest', tool_name: tool, tool_use_id: 'toolu_3', tool_input: {} });
    const message = JSON.parse(result.stdout).hookSpecificOutput.decision.message as string;
    expect(message.startsWith(`Claude requested permissions to use ${tool}, but you haven't granted it yet.`)).toBe(true);
    expect(message).toContain('card');
  });

  it('still holds an orchestrator tool at PreToolUse', () => {
    const result = run({ hook_event_name: 'PreToolUse', tool_name: 'mcp__orchestrator__plan_queue_start', tool_use_id: 'toolu_2', tool_input: {} });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('defer');
  });
});
