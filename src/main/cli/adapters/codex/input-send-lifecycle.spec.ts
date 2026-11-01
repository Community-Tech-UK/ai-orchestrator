import { describe, expect, it, vi } from 'vitest';
import type { InstanceStatus } from '../../../../shared/types/instance.types';
import { isRecoverableCodexTurnError } from './app-server-recovery-policy';
import { runCodexInputSend } from './input-send-lifecycle';

// Verbatim shape of the terminal app-server error Codex sent when the request
// right after its own mid-turn compaction no longer fit the model's window.
const CONTEXT_WINDOW_EXCEEDED = '{"type":"error","error":{"message":"Your input exceeds the context window of this model. '
  + 'Please adjust your input and try again.","type":"invalid_request_error","param":"input","code":"context_length_exceeded"},'
  + '"status":400,"sequence_number":3} - [codex_error_info: other]';

function sendFailing(error: Error, statuses: InstanceStatus[]): Promise<void> {
  return runCodexInputSend({
    isSpawned: () => true,
    isAppServerMode: () => true,
    hasAppServerClient: () => true,
    hasActiveTurn: () => false,
    isProviderCompacting: () => false,
    isRecoverableTurnError: isRecoverableCodexTurnError,
    sendAppServer: async () => { throw error; },
    sendExec: vi.fn(),
    emitStatus: (status) => statuses.push(status),
    emitOutput: vi.fn(),
    emitTurnError: vi.fn(),
  });
}

describe('Codex input send lifecycle', () => {
  it('keeps the instance usable when a turn fails on a context-window overflow', async () => {
    // The thread and app-server are intact; only the turn failed. Settling on
    // `error` left Harness's compact-and-retry owner facing an illegal
    // error → busy transition, and the idle monitor then killed the runtime.
    const statuses: InstanceStatus[] = [];

    await expect(sendFailing(new Error(CONTEXT_WINDOW_EXCEEDED), statuses)).rejects.toThrow('context_length_exceeded');

    expect(statuses).toEqual(['busy', 'idle']);
  });

  it('still settles on error for a failure that leaves the runtime unusable', async () => {
    const statuses: InstanceStatus[] = [];

    await expect(sendFailing(new Error('unauthorized: login required'), statuses)).rejects.toThrow('unauthorized');

    expect(statuses).toEqual(['busy', 'error']);
  });
});
