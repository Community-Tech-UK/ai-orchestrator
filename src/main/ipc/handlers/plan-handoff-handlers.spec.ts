import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../../instance/instance-manager';
import { registerPlanHandoffHandlers } from './plan-handoff-handlers';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  start: vi.fn(),
  requests: [] as Array<{ id: string; requestType: string; targetMode?: string }>,
}));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => mocks.handlers.set(channel, handler),
} }));
vi.mock('../../instance/plan-handoff/plan-build-handoff', () => ({
  PlanBuildHandoff: class {
    start = mocks.start;
    preview = vi.fn();
  },
}));

describe('plan handoff request ownership', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.requests = [];
    mocks.start.mockReset().mockResolvedValue({ ok: true, newInstanceId: 'build-1' });
    registerPlanHandoffHandlers({
      getOrchestrationHandler: () => ({ getPendingUserActionsForInstance: () => mocks.requests }),
    } as unknown as InstanceManager);
  });

  it('refuses a request that does not belong to the planning session before starting any build', async () => {
    const response = await mocks.handlers.get('plan-handoff:start')!({}, {
      instanceId: 'plan-1', requestId: 'another-session-request', planText: 'Build this plan',
    });
    expect(response).toMatchObject({ success: false });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('accepts the source session build request and the Plan Mode page without a request', async () => {
    mocks.requests = [{ id: 'build-request', requestType: 'switch_mode', targetMode: 'build' }];
    const handler = mocks.handlers.get('plan-handoff:start')!;
    expect(await handler({}, { instanceId: 'plan-1', requestId: 'build-request' })).toMatchObject({ success: true });
    expect(await handler({}, { instanceId: 'plan-1' })).toMatchObject({ success: true });
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });
});
