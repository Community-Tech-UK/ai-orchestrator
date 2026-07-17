import { describe, expect, it } from 'vitest';
import { CopilotServerTurnBridge, type CopilotServerBridgeHost } from './copilot-server-turn-bridge';
import type { OutputMessage, ContextUsage } from '../../../../shared/types/instance.types';

function makeHost(): CopilotServerBridgeHost & {
  outputs: OutputMessage[];
  statuses: string[];
  contexts: ContextUsage[];
  errors: Error[];
  sessionNotFound: number;
} {
  const host = {
    outputs: [] as OutputMessage[],
    statuses: [] as string[],
    contexts: [] as ContextUsage[],
    errors: [] as Error[],
    sessionNotFound: 0,
    emitOutput(m: OutputMessage) { host.outputs.push(m); },
    emitStatus(s: string) { host.statuses.push(s); },
    emitContext(c: ContextUsage) { host.contexts.push(c); },
    emitError(e: Error) { host.errors.push(e); },
    noteSessionNotFound() { host.sessionNotFound++; },
  };
  return host as ReturnType<typeof makeHost>;
}

describe('CopilotServerTurnBridge', () => {
  it('accumulates deltas into streaming assistant updates and finalizes on the server message', () => {
    const host = makeHost();
    const bridge = new CopilotServerTurnBridge(host);

    bridge.handleEffect({ kind: 'assistant-delta', messageId: 'm-1', delta: 'Hel' });
    bridge.handleEffect({ kind: 'assistant-delta', messageId: 'm-1', delta: 'lo' });
    bridge.handleEffect({ kind: 'assistant-message', messageId: 'm-1', content: 'Hello!' });

    expect(host.outputs.map((o) => o.content)).toEqual(['Hel', 'Hello', 'Hello!']);
    expect(host.outputs[0].metadata?.['streaming']).toBe(true);
    expect(host.outputs[2].metadata?.['streaming']).toBeUndefined();
    expect(host.outputs.every((o) => o.id === 'm-1')).toBe(true);
  });

  it('starts fresh accumulation when a second assistant message begins mid-turn', () => {
    const host = makeHost();
    const bridge = new CopilotServerTurnBridge(host);
    bridge.handleEffect({ kind: 'assistant-delta', messageId: 'm-1', delta: 'first' });
    bridge.handleEffect({ kind: 'assistant-delta', messageId: 'm-2', delta: 'second' });
    expect(host.outputs[1].content).toBe('second');
    expect(host.outputs[1].id).toBe('m-2');
  });

  it('attaches accumulated reasoning to assistant output and resets per turn', () => {
    const host = makeHost();
    const bridge = new CopilotServerTurnBridge(host);
    bridge.handleEffect({ kind: 'reasoning', content: 'pondering…' });
    bridge.handleEffect({ kind: 'assistant-message', messageId: 'm-1', content: 'Done.' });
    expect(host.outputs[0].thinking?.[0]?.content).toBe('pondering…');

    bridge.resetTurn();
    bridge.handleEffect({ kind: 'assistant-message', messageId: 'm-2', content: 'Next.' });
    expect(host.outputs[1].thinking).toBeUndefined();
  });

  it('pairs tool completion with the recorded start (name + input carry over)', () => {
    const host = makeHost();
    const bridge = new CopilotServerTurnBridge(host);
    bridge.handleEffect({ kind: 'tool-start', toolCallId: 't-1', toolName: 'bash', args: { cmd: 'ls' } });
    bridge.handleEffect({ kind: 'tool-complete', toolCallId: 't-1', success: false, errorMessage: 'denied' });

    expect(host.outputs[0].type).toBe('tool_use');
    expect(host.outputs[1].type).toBe('tool_result');
    expect(host.outputs[1].content).toBe('Tool bash failed: denied');
    expect(host.outputs[1].metadata?.['input']).toEqual({ cmd: 'ls' });
    expect(host.outputs[1].metadata?.['is_error']).toBe(true);
  });

  it('emits REAL context occupancy (provider-usage source, not an estimate)', () => {
    const host = makeHost();
    new CopilotServerTurnBridge(host).handleEffect({ kind: 'context', used: 32_000, total: 128_000 });
    expect(host.contexts[0]).toEqual({
      used: 32_000,
      total: 128_000,
      percentage: 25,
      source: 'provider-usage',
    });
    expect(host.contexts[0].isEstimated).toBeUndefined();
  });

  it('routes session errors to output+error and flags session-not-found for resume proof', () => {
    const host = makeHost();
    const bridge = new CopilotServerTurnBridge(host);
    bridge.handleEffect({ kind: 'session-error', message: 'session not found: cop-1' });
    expect(host.sessionNotFound).toBe(1);
    expect(host.outputs[0].type).toBe('error');
    expect(host.errors).toHaveLength(1);

    bridge.handleEffect({ kind: 'session-error', message: 'weekly rate limit', errorType: 'rate_limit' });
    expect(host.sessionNotFound).toBe(1); // not a session-not-found signal
    expect(host.outputs[1].metadata?.['errorType']).toBe('rate_limit');
  });

  it('drives turn lifecycle: turn-start → busy, idle → idle; turn-end/ignored are silent', () => {
    const host = makeHost();
    const bridge = new CopilotServerTurnBridge(host);
    bridge.handleEffect({ kind: 'turn-start' });
    bridge.handleEffect({ kind: 'turn-end' });
    bridge.handleEffect({ kind: 'ignored', type: 'session.plan_changed' });
    bridge.handleEffect({ kind: 'idle' });
    expect(host.statuses).toEqual(['busy', 'idle']);
  });
});
