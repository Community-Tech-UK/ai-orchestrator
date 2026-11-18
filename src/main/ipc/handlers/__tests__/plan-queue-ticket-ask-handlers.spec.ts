/**
 * The two page-only channels for the question a changed Linear ticket opens: read it (the approved text and the held text, as
 * plain strings) and answer it. From the preload to the coordinator; a bad payload is refused, and a refusal comes back in
 * the shared response shape.
 */
import type { IpcRenderer } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type IpcResponse } from '../../../../shared/types/ipc.types';
import { createPlanQueueDomain } from '../../../../preload/domains/plan-queue.preload';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<IpcResponse>>(),
  coordinator: { on: vi.fn(), answer: vi.fn(), answerTicketAsk: vi.fn() },
  readTicketAsk: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, callback: (event: unknown, payload: unknown) => Promise<IpcResponse>) => state.handlers.set(channel, callback) },
}));
vi.mock('../../../plan-queue/plan-queue-coordinator', () => ({ getPlanQueueCoordinator: () => state.coordinator }));
vi.mock('../../../plan-queue/plan-queue-ticket-answer', () => ({ readTicketAsk: state.readTicketAsk }));
vi.mock('../../../plan-queue/plan-queue-livetest-fixture', () => ({
  getPlanQueueLiveTestFixtures: () => ({}), PlanQueueLiveTestFixtureRemoveSchema: { parse: (value: unknown) => value }, PlanQueueLiveTestFixtureStartSchema: { parse: (value: unknown) => value },
}));
vi.mock('../../../plan-queue/plan-queue-discovery', () => ({ previewPlanQueueDocuments: vi.fn() }));
vi.mock('../../../plan-queue/plan-queue-git', () => ({ repositoryRoot: vi.fn() }));
import { registerPlanQueueHandlers } from '../plan-queue-handlers';

function api() {
  registerPlanQueueHandlers({ windowManager: { sendToRenderer: vi.fn() } as never });
  return createPlanQueueDomain(
    { invoke: (channel: string, payload: unknown) => {
      const callback = state.handlers.get(channel);
      if (!callback) throw new Error(`No handler registered for ${channel}`);
      return callback({}, payload);
    } } as unknown as IpcRenderer,
    IPC_CHANNELS,
  );
}

afterEach(() => {
  state.handlers.clear();
  state.coordinator.answer.mockReset();
  state.coordinator.answerTicketAsk.mockReset();
  state.readTicketAsk.mockReset();
});

describe('the ticket question channels', () => {
  it('registers both channels', () => {
    api();
    expect(state.handlers.has(IPC_CHANNELS.PLAN_QUEUE_TICKET_ASK_READ)).toBe(true);
    expect(state.handlers.has(IPC_CHANNELS.PLAN_QUEUE_TICKET_ASK_ANSWER)).toBe(true);
  });

  it('reads the question for an item and returns it as the page shows it', async () => {
    const view = { itemId: 'item-1', identifier: 'ORC-12', kind: 'changed', askHash: 'a'.repeat(64), openedAt: 5, approved: { title: 'T', text: 'old', hash: 'b'.repeat(64), approvedAt: 1 }, held: { title: 'T', text: 'new', hash: 'a'.repeat(64), changed: ['description'] }, options: [] };
    state.readTicketAsk.mockReturnValue(view);
    await expect(api().planQueueTicketAskRead({ itemId: 'item-1' })).resolves.toEqual({ success: true, data: { ask: view } });
    expect(state.readTicketAsk).toHaveBeenCalledWith('item-1');
  });

  it('answers through the coordinator\'s own method with the hash the page was shown, and never through the ordinary answer', async () => {
    state.coordinator.answerTicketAsk.mockResolvedValue(undefined);
    await expect(api().planQueueTicketAskAnswer({ itemId: 'item-1', optionId: 'use-now', askHash: 'a'.repeat(64) })).resolves.toEqual({ success: true, data: null });
    expect(state.coordinator.answerTicketAsk).toHaveBeenCalledWith({ itemId: 'item-1', optionId: 'use-now', askHash: 'a'.repeat(64) });
    expect(state.coordinator.answer).not.toHaveBeenCalled();
  });

  it('returns a refusal in the shared response shape', async () => {
    state.coordinator.answerTicketAsk.mockRejectedValue(new Error('The ticket changed again. Read the new version.'));
    await expect(api().planQueueTicketAskAnswer({ itemId: 'item-1', optionId: 'stop', askHash: 'x' })).resolves.toMatchObject({
      success: false, error: { code: 'PLAN_QUEUE_TICKET_ASK_ANSWER_FAILED', message: 'The ticket changed again. Read the new version.' },
    });
  });

  it('refuses a payload with a missing hash or an extra field, before reaching the coordinator', async () => {
    const domain = api();
    await expect(domain.planQueueTicketAskAnswer({ itemId: 'item-1', optionId: 'stop' } as never)).resolves.toMatchObject({ success: false });
    await expect(domain.planQueueTicketAskAnswer({ itemId: 'item-1', optionId: 'stop', askHash: 'x', extra: 1 } as never)).resolves.toMatchObject({ success: false });
    await expect(domain.planQueueTicketAskRead({} as never)).resolves.toMatchObject({ success: false });
    expect(state.coordinator.answerTicketAsk).not.toHaveBeenCalled();
    expect(state.readTicketAsk).not.toHaveBeenCalled();
  });
});
