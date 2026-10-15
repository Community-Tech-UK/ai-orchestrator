import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopStore } from '../../core/state/loop.store';
import { LoopStopConfirmService } from './loop-stop-confirm.service';

describe('loop stop confirmation', () => {
  const cancel = vi.fn(); let active = true;
  beforeEach(() => {
    TestBed.resetTestingModule(); active = true; cancel.mockReset();
    cancel.mockImplementation(async () => { active = false; });
    TestBed.configureTestingModule({ providers: [{ provide: LoopStore, useValue: { cancel, activeForChat: () => () => active ? { id: 'loop' } : undefined } }] });
  });
  it('keeps cancellation behind confirmation and dismiss leaves work running', async () => {
    const service = TestBed.inject(LoopStopConfirmService);
    service.request('loop', true, { chatId: 'chat' }); expect(cancel).not.toHaveBeenCalled();
    expect(service.pending()).toEqual({ loopId: 'loop', isolated: true });
    service.dismiss(); await service.confirm(); expect(cancel).not.toHaveBeenCalled();
  });
  it('runs the continuation only after confirmed cancellation succeeds', async () => {
    const service = TestBed.inject(LoopStopConfirmService); const afterStopped = vi.fn();
    service.request('loop', false, { chatId: 'chat', afterStopped });
    await service.confirm(); expect(cancel).toHaveBeenCalledWith('loop'); expect(afterStopped).toHaveBeenCalledOnce();
    expect(service.pending()).toBeNull();
  });
  it('preserves confirmation and never starts a new run after rejected cancellation', async () => {
    const service = TestBed.inject(LoopStopConfirmService); const afterStopped = vi.fn(); cancel.mockResolvedValue(undefined);
    service.request('loop', false, { chatId: 'chat', afterStopped }); await service.confirm();
    expect(afterStopped).not.toHaveBeenCalled(); expect(service.pending()).not.toBeNull(); expect(service.error()).toContain('could not be stopped');
  });
});
