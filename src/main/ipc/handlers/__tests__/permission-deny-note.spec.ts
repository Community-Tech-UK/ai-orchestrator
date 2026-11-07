import { describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../../../instance/instance-manager';
import { respondToInputRequired } from '../input-required-respond';
import { createThinClientCommandExecutor, type ThinClientCommandExecutorDeps } from '../../../event-bus/thin-client-command-executor';

vi.mock('../../../remote/observer-server', () => ({ getRemoteObserverServer: () => ({ clearPrompt: vi.fn() }) }));

describe('explicit typed denial notes', () => {
  it.each([undefined, '', '   ', 'typed marker'])('requires a nonblank note marker on desktop and thin-client routes (%s)', async marker => {
    const resumeAfterDeferredPermission = vi.fn().mockResolvedValue(undefined);
    const manager: ThinClientCommandExecutorDeps['instanceManager'] = {
      appendSyntheticUserMessage: vi.fn(), clearPendingInputRequiredPermission: vi.fn(), createInstance: vi.fn(),
      getAllInstancesForIpc: vi.fn(), getInstance: vi.fn(),
      getOrchestrationHandler: vi.fn(), hibernateInstance: vi.fn(),
      interruptInstance: vi.fn(), isPendingInputRequiredPermission: vi.fn(() => true), recordInputRequiredPermissionDecision: vi.fn(),
      resumeAfterDeferredPermission, sendInput: vi.fn(), sendInputResponse: vi.fn(), terminateInstance: vi.fn(), wakeInstance: vi.fn(),
    };
    const payload = { instanceId: 'fixture', requestId: 'card', response: '  Validated response  ', decisionAction: 'deny' as const,
      metadata: { type: 'deferred_permission', ...(marker === undefined ? {} : { denyNote: marker }) } };
    const expected = marker?.trim() ? 'Validated response' : undefined;
    const receipts = { beginReply: () => ({ commit: () => true, abort: () => undefined }) };
    await respondToInputRequired({ ...manager, getRequestReceipts: () => receipts } as unknown as InstanceManager, payload);
    expect(resumeAfterDeferredPermission.mock.calls.at(-1)?.[3]?.denyNote).toBe(expected);
    const execute = createThinClientCommandExecutor({ instanceManager: manager, pauseCoordinator: { isPaused: () => false }, remoteObserver: { clearPrompt: vi.fn() } });
    const result = await execute('instance:respond-input', payload);
    expect(result.success).toBe(true);
    expect(resumeAfterDeferredPermission.mock.calls.at(-1)?.[3]?.denyNote).toBe(expected);
  });
});
