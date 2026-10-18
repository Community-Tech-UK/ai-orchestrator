import { describe, expect, it, vi } from 'vitest';
import { MobileGatewayLoopHandlers, projectLoopRun, type GatewayLoopControl, type GatewayLoopRunRecord } from './mobile-gateway-loop-handlers';

const run: GatewayLoopRunRecord = { id: 'loop-1', chatId: 'session-1', status: 'running', currentStage: 'IMPLEMENT',
  iteration: 0, maxIterations: 3, startedAt: 1, endedAt: null, totalTokens: 0, totalCostCents: 0,
  workspaceCwd: '/example/workspace', endReason: null, pausedForInput: false };

describe('mobile loop failed attempts', () => {
  it('preserves the wire status and sends one failed push for the terminal transition', () => {
    let listener!: Parameters<GatewayLoopControl['subscribe']>[0];
    const control: GatewayLoopControl = { list: () => [run], get: () => null,
      pause: () => ({ ok: false, run: null }), resume: async () => ({ ok: false, run: null }),
      stop: async () => ({ ok: false, run: null }), subscribe: (callback) => { listener = callback; return () => undefined; } };
    const sendPush = vi.fn();
    const handlers = new MobileGatewayLoopHandlers({ getControl: () => control, broadcast: vi.fn(), sendPush });
    handlers.attach();
    const failed = { ...run, status: 'attempt-failed', endedAt: 2 };
    expect(projectLoopRun(failed).status).toBe('attempt-failed');
    listener(run.id, failed);
    listener(run.id, failed);
    expect(sendPush).toHaveBeenCalledOnce();
    expect(sendPush).toHaveBeenCalledWith(expect.objectContaining({ status: 'attempt-failed' }), 'failed');
    handlers.detach();
  });
});
