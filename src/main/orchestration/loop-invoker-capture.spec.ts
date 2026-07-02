import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createLoopInvocationCapture,
  createToolTimeoutWatchdogWidener,
  DECLARED_TOOL_TIMEOUT_GRACE_MS,
  extractDeclaredToolTimeoutMs,
  extractFinishReasonFromResponse,
  MAX_DECLARED_TOOL_TIMEOUT_MS,
} from './loop-invoker-capture';
import type { LoopInvocationActivity } from './loop-invocation-activity';

describe('createLoopInvocationCapture', () => {
  it('captures read paths, result hashes, durations, and unresolved tool calls', () => {
    let timestamp = 100;
    const capture = createLoopInvocationCapture({
      workspaceDir: '/workspace/project',
      now: () => timestamp,
    });

    capture.recordActivity({
      kind: 'tool_use',
      message: 'Using tool: Read',
      detail: { id: 'read-1', name: 'Read', input: { file_path: '/workspace/project/src/input.ts' } },
    });
    timestamp = 125;
    capture.recordActivity({
      kind: 'tool_result',
      message: 'Tool result: Read',
      detail: { id: 'read-1', name: 'Read', result: '' },
    });
    timestamp = 150;
    capture.recordActivity({
      kind: 'tool_use',
      message: 'Using tool: Bash',
      detail: { id: 'bash-1', name: 'Bash', input: { command: 'npm test', timeout: 1_200_000 } },
    });
    timestamp = 175;
    capture.recordActivity({
      kind: 'complete',
      message: 'done',
      detail: { finishReason: 'tool_use' },
    });

    expect(capture.finalize()).toEqual({
      filesRead: ['src/input.ts'],
      finishReason: 'tool_use',
      toolRwLockConflicts: [],
      unresolvedToolCalls: true,
      toolCalls: [
        {
          toolName: 'Read',
          argsHash: expect.any(String),
          resultHash: sha16(''),
          success: true,
          durationMs: 25,
        },
        {
          toolName: 'Bash',
          argsHash: expect.any(String),
          success: true,
          durationMs: 25,
          // E2 (#12) capture half: agent-declared timeout persisted on the record.
          declaredTimeoutMs: 1_200_000,
        },
      ],
    });
  });

  it('omits declaredTimeoutMs when the tool call declares none or an insane value', () => {
    const capture = createLoopInvocationCapture({ workspaceDir: '/workspace/project', now: () => 0 });
    capture.recordActivity({
      kind: 'tool_use',
      message: 'Using tool: Bash',
      detail: { id: 'b1', name: 'Bash', input: { command: 'ls' } },
    });
    capture.recordActivity({
      kind: 'tool_use',
      message: 'Using tool: Bash',
      detail: { id: 'b2', name: 'Bash', input: { command: 'ls', timeout: MAX_DECLARED_TOOL_TIMEOUT_MS + 1 } },
    });
    for (const record of capture.finalize().toolCalls) {
      expect(record.declaredTimeoutMs).toBeUndefined();
    }
  });

  it('records overlapping write tool conflicts only when rw locks are enabled', () => {
    const disabled = createLoopInvocationCapture({ workspaceDir: '/workspace/project' });
    disabled.recordActivity({
      kind: 'tool_use',
      message: 'Using tool: Edit',
      detail: { id: 'edit-1', name: 'Edit', input: { file_path: 'src/app.ts' } },
    });
    disabled.recordActivity({
      kind: 'tool_use',
      message: 'Using tool: Edit',
      detail: { id: 'edit-2', name: 'Edit', input: { file_path: '/workspace/project/src/app.ts' } },
    });
    expect(disabled.finalize().toolRwLockConflicts).toEqual([]);

    const enabled = createLoopInvocationCapture({ workspaceDir: '/workspace/project', rwLocksEnabled: true });
    enabled.recordActivity({
      kind: 'tool_use',
      message: 'Using tool: Edit',
      detail: { id: 'edit-1', name: 'Edit', input: { file_path: 'src' } },
    });
    enabled.recordActivity({
      kind: 'tool_use',
      message: 'Using tool: Write',
      detail: { id: 'write-1', name: 'Write', input: { file_path: 'src/app.ts' } },
    });

    const conflicts = enabled.finalize().toolRwLockConflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual(expect.objectContaining({
      bucket: 'tool-rw-lock-conflict',
      exactHash: expect.any(String),
      excerpt: expect.stringContaining('Overlapping write tools'),
    }));
  });

  it('does not report a write conflict after the first write tool has settled', () => {
    const capture = createLoopInvocationCapture({ workspaceDir: '/workspace/project', rwLocksEnabled: true });
    capture.recordActivity({
      kind: 'tool_use',
      message: 'Using tool: Edit',
      detail: { id: 'edit-1', name: 'Edit', input: { file_path: 'src/app.ts' } },
    });
    capture.recordActivity({
      kind: 'tool_result',
      message: 'Tool result: Edit',
      detail: { id: 'edit-1', success: true, result: 'ok' },
    });
    capture.recordActivity({
      kind: 'tool_use',
      message: 'Using tool: Write',
      detail: { id: 'write-1', name: 'Write', input: { file_path: 'src/app.ts' } },
    });

    expect(capture.finalize().toolRwLockConflicts).toEqual([]);
  });
});

describe('extractFinishReasonFromResponse', () => {
  it('reads finish reasons from direct, metadata, and raw response shapes', () => {
    expect(extractFinishReasonFromResponse({ finishReason: 'end_turn' })).toBe('end_turn');
    expect(extractFinishReasonFromResponse({ metadata: { stopReason: 'tool_use' } })).toBe('tool_use');
    expect(extractFinishReasonFromResponse({ raw: { stop_reason: 'max_tokens' } })).toBe('max_tokens');
  });
});

describe('extractDeclaredToolTimeoutMs', () => {
  it('reads timeout, timeout_ms, and timeoutMs keys', () => {
    expect(extractDeclaredToolTimeoutMs({ timeout: 1_200_000 })).toBe(1_200_000);
    expect(extractDeclaredToolTimeoutMs({ timeout_ms: 60_000 })).toBe(60_000);
    expect(extractDeclaredToolTimeoutMs({ timeoutMs: 90_000 })).toBe(90_000);
  });

  it('returns undefined for missing, non-numeric, zero/negative, or absurd values', () => {
    expect(extractDeclaredToolTimeoutMs(undefined)).toBeUndefined();
    expect(extractDeclaredToolTimeoutMs({})).toBeUndefined();
    expect(extractDeclaredToolTimeoutMs({ command: 'npm test' })).toBeUndefined();
    expect(extractDeclaredToolTimeoutMs({ timeout: '60000' })).toBeUndefined();
    expect(extractDeclaredToolTimeoutMs({ timeout: 0 })).toBeUndefined();
    expect(extractDeclaredToolTimeoutMs({ timeout: -1 })).toBeUndefined();
    expect(extractDeclaredToolTimeoutMs({ timeout: Number.NaN })).toBeUndefined();
    expect(extractDeclaredToolTimeoutMs({ timeout: MAX_DECLARED_TOOL_TIMEOUT_MS + 1 })).toBeUndefined();
  });

  it('accepts a declared timeout right at the sanity ceiling', () => {
    expect(extractDeclaredToolTimeoutMs({ timeout: MAX_DECLARED_TOOL_TIMEOUT_MS })).toBe(MAX_DECLARED_TOOL_TIMEOUT_MS);
  });
});

describe('createToolTimeoutWatchdogWidener', () => {
  function toolUse(id: string, input: Record<string, unknown>): LoopInvocationActivity {
    return { kind: 'tool_use', message: `Using tool: ${id}`, detail: { id, name: 'Bash', input } };
  }
  function toolResult(id: string): LoopInvocationActivity {
    return { kind: 'tool_result', message: `Tool result: ${id}`, detail: { id, success: true } };
  }

  it('does not call applyTimeoutMs when no tool declares a timeout (byte-identical to today)', () => {
    const applyTimeoutMs = vi.fn();
    const widener = createToolTimeoutWatchdogWidener({ baseTimeoutMs: 90_000, applyTimeoutMs });

    widener.onToolUse(toolUse('bash-1', { command: 'npm test' }));
    widener.onToolResult(toolResult('bash-1'));
    widener.onIterationSettled();

    expect(applyTimeoutMs).not.toHaveBeenCalled();
  });

  it('widens to max(base, declared + grace) for a long declared build and does not false-kill it', () => {
    const applyTimeoutMs = vi.fn();
    const widener = createToolTimeoutWatchdogWidener({ baseTimeoutMs: 90_000, applyTimeoutMs });

    // A 20-minute declared build timeout.
    widener.onToolUse(toolUse('build-1', { command: 'make', timeout: 20 * 60 * 1000 }));

    expect(applyTimeoutMs).toHaveBeenCalledTimes(1);
    expect(applyTimeoutMs).toHaveBeenCalledWith(20 * 60 * 1000 + DECLARED_TOOL_TIMEOUT_GRACE_MS);
  });

  it('reverts to the base threshold once the tool settles via tool_result', () => {
    const applyTimeoutMs = vi.fn();
    const widener = createToolTimeoutWatchdogWidener({ baseTimeoutMs: 90_000, applyTimeoutMs });

    widener.onToolUse(toolUse('build-1', { timeout: 20 * 60 * 1000 }));
    widener.onToolResult(toolResult('build-1'));

    expect(applyTimeoutMs).toHaveBeenCalledTimes(2);
    expect(applyTimeoutMs).toHaveBeenLastCalledWith(90_000);
  });

  it('reverts via onIterationSettled when a tool_result never arrives (unresolved tool call)', () => {
    const applyTimeoutMs = vi.fn();
    const widener = createToolTimeoutWatchdogWidener({ baseTimeoutMs: 90_000, applyTimeoutMs });

    widener.onToolUse(toolUse('build-1', { timeout: 20 * 60 * 1000 }));
    widener.onIterationSettled();

    expect(applyTimeoutMs).toHaveBeenCalledTimes(2);
    expect(applyTimeoutMs).toHaveBeenLastCalledWith(90_000);
  });

  it('never widens below the existing base ceiling (short declared timeout)', () => {
    const applyTimeoutMs = vi.fn();
    const widener = createToolTimeoutWatchdogWidener({ baseTimeoutMs: 90_000, applyTimeoutMs });

    // A 5s declared timeout is well under the existing 90s base ceiling.
    widener.onToolUse(toolUse('quick-1', { timeout: 5_000 }));

    expect(applyTimeoutMs).not.toHaveBeenCalled();
  });

  it('keeps the widened threshold while multiple declared-timeout tools overlap', () => {
    const applyTimeoutMs = vi.fn();
    const widener = createToolTimeoutWatchdogWidener({ baseTimeoutMs: 90_000, applyTimeoutMs });

    widener.onToolUse(toolUse('build-1', { timeout: 10 * 60 * 1000 }));
    widener.onToolUse(toolUse('build-2', { timeout: 20 * 60 * 1000 }));
    applyTimeoutMs.mockClear();

    // The shorter of the two settles first — threshold must stay widened for build-2.
    widener.onToolResult(toolResult('build-1'));
    expect(applyTimeoutMs).not.toHaveBeenCalled();

    widener.onToolResult(toolResult('build-2'));
    expect(applyTimeoutMs).toHaveBeenCalledWith(90_000);
  });

  it('falls back to the oldest in-flight call when tool_result omits an id', () => {
    const applyTimeoutMs = vi.fn();
    const widener = createToolTimeoutWatchdogWidener({ baseTimeoutMs: 90_000, applyTimeoutMs });

    widener.onToolUse(toolUse('build-1', { timeout: 20 * 60 * 1000 }));
    widener.onToolResult({ kind: 'tool_result', message: 'Tool result', detail: { success: true } });

    expect(applyTimeoutMs).toHaveBeenLastCalledWith(90_000);
  });
});

function sha16(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
