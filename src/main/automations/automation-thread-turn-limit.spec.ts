import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordCostAttribution } from '../core/system/cost-attribution';
import type { AutomationAction, AutomationSchedule } from '../../shared/types/automation.types';
import { boundThreadWakeupTurn } from './automation-thread-turn-limit';

const schedule: AutomationSchedule = { type: 'oneTime', runAt: 1_000, timezone: 'UTC' };
const action = (limits: Partial<AutomationAction> = {}): AutomationAction => ({ prompt: 'Keep going', workingDirectory: '/repo', ...limits } as AutomationAction);

function host(settle: Promise<unknown>) {
  const waitForInstanceSettled = vi.fn(() => settle);
  const interruptInstance = vi.fn(() => true);
  return Object.assign(new EventEmitter(), { waitForInstanceSettled, interruptInstance }) as never as Parameters<typeof boundThreadWakeupTurn>[0] & EventEmitter & {
    waitForInstanceSettled: typeof waitForInstanceSettled; interruptInstance: typeof interruptInstance;
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const turn = (instanceId: string, inputTokens: number) =>
  recordCostAttribution({ source: 'instance-turn', taskType: 'chat', instanceId, usage: { inputTokens } });

describe('thread wake-up turn limit', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('waits for the turn to settle for the default minutes, counted from when the prompt was sent', () => {
    const h = host(new Promise(() => undefined));
    boundThreadWakeupTurn(h, 'thread-1', 5_000, action(), schedule);
    expect(h.waitForInstanceSettled).toHaveBeenCalledWith('thread-1', expect.objectContaining({ afterTimestamp: 5_000, timeoutMs: 90 * 60_000 }));
  });

  it('interrupts the conversation, without ending it, when the turn does not settle in time', async () => {
    const h = host(Promise.reject(new Error('Timed out waiting for instance thread-1 to settle')));
    boundThreadWakeupTurn(h, 'thread-1', 5_000, action({ maxRunMinutes: 2 } as never), schedule);
    await flush();
    expect(h.waitForInstanceSettled).toHaveBeenCalledWith('thread-1', expect.objectContaining({ timeoutMs: 120_000 }));
    expect(h.interruptInstance).toHaveBeenCalledOnce();
    expect(h.interruptInstance).toHaveBeenCalledWith('thread-1');
  });

  it('interrupts once the turn passes the processed-token cap, counting only that thread', async () => {
    const h = host(new Promise(() => undefined));
    boundThreadWakeupTurn(h, 'thread-1', 5_000, action({ maxProcessedTokens: 100 } as never), schedule);
    turn('other-thread', 500);
    turn('thread-1', 60);
    expect(h.interruptInstance).not.toHaveBeenCalled();
    turn('thread-1', 41);
    expect(h.interruptInstance).toHaveBeenCalledOnce();
    turn('thread-1', 500);
    expect(h.interruptInstance).toHaveBeenCalledOnce();
  });

  it('leaves a turn that settles in time alone, and stops counting its tokens', async () => {
    const h = host(Promise.resolve({}));
    boundThreadWakeupTurn(h, 'thread-1', 5_000, action({ maxProcessedTokens: 100 } as never), schedule);
    await flush();
    turn('thread-1', 500);
    expect(h.interruptInstance).not.toHaveBeenCalled();
  });

  it.each([
    ['the turn completes without a reply', 'provider:normalized-event', { instanceId: 'thread-1', event: { kind: 'complete' } }],
    ['the person interrupts it', 'instance:interrupt-requested', { instanceId: 'thread-1', origin: 'renderer-ipc' }],
    ['the person sends their own message', 'instance:input-started', { instanceId: 'thread-1', autoContinuation: false }],
  ])('stops watching when %s, so a later turn is never counted or interrupted', (_name, event, payload) => {
    const h = host(new Promise(() => undefined));
    boundThreadWakeupTurn(h, 'thread-1', 5_000, action({ maxProcessedTokens: 100 } as never), schedule);
    h.emit(event, payload);
    turn('thread-1', 500);
    expect(h.interruptInstance).not.toHaveBeenCalled();
    expect(h.listenerCount('provider:normalized-event')).toBe(0);
  });

  it('keeps watching through other threads, automatic input and this thread working', () => {
    const h = host(new Promise(() => undefined));
    boundThreadWakeupTurn(h, 'thread-1', 5_000, action({ maxProcessedTokens: 100 } as never), schedule);
    h.emit('provider:normalized-event', { instanceId: 'other', event: { kind: 'complete' } });
    h.emit('instance:interrupt-requested', { instanceId: 'other' });
    h.emit('instance:input-started', { instanceId: 'thread-1', autoContinuation: true });
    h.emit('provider:normalized-event', { instanceId: 'thread-1', event: { kind: 'output' } });
    turn('thread-1', 500);
    expect(h.interruptInstance).toHaveBeenCalledOnce();
  });
});
