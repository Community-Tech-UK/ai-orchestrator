import { describe, expect, it, vi } from 'vitest';
import { initializeCodexAppServer } from './app-server-initializer';
import { validateGeneratedRequest } from './app-server-client-protocol';
import { buildCodexTurnInputDispatch } from './turn-input-dispatch';
import { resumeThreadWithRetry } from './thread-resume-retry';
import type { AppServerClient } from './app-server-client';
import type { CodexSessionScanner } from './session-scanner';

describe('Harness requests against the generated Codex manifest', () => {
  it('accepts every key Harness sends on thread/start, thread/resume and turn/start', async () => {
    const requests: { method: string; params: Record<string, unknown> }[] = [];
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      validateGeneratedRequest(method, params);
      requests.push({ method, params });
      return { threadId: 'fixture-thread' };
    });
    await initializeCodexAppServer({
      client: { request, close: vi.fn() } as unknown as AppServerClient,
      config: { model: 'fixture-model', approvalMode: 'full-auto', fastMode: true, ephemeral: true },
      cwd: '/workspace/example', sandbox: 'danger-full-access', sessionId: null,
      sessionScanner: {} as CodexSessionScanner, shouldResume: false,
      isCurrent: () => true, onFailedAttempt: vi.fn(),
    });
    await resumeThreadWithRetry({ request: (method, params) => request(method, { ...params }) }, {
      threadId: 'fixture-thread', cwd: '/workspace/example', model: 'fixture-model',
      approvalPolicy: 'never', sandbox: 'danger-full-access',
    });
    const { turnParams } = buildCodexTurnInputDispatch({
      outputSchema: { type: 'object' }, reasoningEffort: 'high', fastMode: true,
    }, undefined, () => false, () => false);
    const turn = {
      threadId: 'fixture-thread', input: [{ type: 'text', text: 'Read the task.', text_elements: [] }],
      ...turnParams,
    };
    expect(() => validateGeneratedRequest('turn/start', turn)).not.toThrow();
    expect(requests.map(({ method }) => method)).toEqual(['thread/start', 'thread/resume']);
    expect(Object.keys(requests[0]!.params).sort()).toEqual([
      'approvalPolicy', 'cwd', 'ephemeral', 'model', 'sandbox', 'serviceName', 'serviceTier',
    ]);
    expect(requests[1]!.params['excludeTurns']).toBe(true);
    expect(turnParams).toEqual({ outputSchema: { type: 'object' }, effort: 'high', serviceTier: 'priority' });
  });

  it('accepts the per-thread config key on thread/start and thread/resume', () => {
    const config = { 'tool_output_token_limit': 6000 };
    expect(() => validateGeneratedRequest('thread/start', { cwd: '/workspace/example', config })).not.toThrow();
    expect(() => validateGeneratedRequest('thread/resume', { threadId: 'fixture-thread', config })).not.toThrow();
  });

  it('rejects unsupported top-level keys while allowing nested granular policy fields', () => {
    expect(() => validateGeneratedRequest('thread/start', { granular: {} })).toThrow('unsupported parameter: granular');
    expect(() => validateGeneratedRequest('thread/start', { approvalPolicy: { granular: { mcp_elicitations: true } } })).not.toThrow();
    expect(() => validateGeneratedRequest('turn/start', { threadId: 'fixture-thread' })).toThrow('missing required parameter: input');
  });
});
