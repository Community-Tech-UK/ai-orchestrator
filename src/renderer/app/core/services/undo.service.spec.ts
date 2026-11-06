import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastService } from './toast.service';
import { UndoService } from './undo.service';
describe('UndoService', () => {
  let service: UndoService; let toast: ToastService;
  beforeEach(() => { vi.useFakeTimers(); TestBed.configureTestingModule({}); service = TestBed.inject(UndoService); toast = TestBed.inject(ToastService); });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });
  it('reaches only the newest action from the keyboard; older notices keep their own buttons', async () => {
    const first = vi.fn(async () => true); const second = vi.fn(async () => true);
    service.register({ kind: 'archive', message: 'Archived A', undo: first });
    const olderButton = toast.toasts()[0].action!.run;
    service.register({ kind: 'draft', message: 'Draft discarded', undo: second });
    await service.undoLast(); expect(second).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled();
    await service.undoLast(); expect(first).not.toHaveBeenCalled();
    await olderButton(); expect(first).toHaveBeenCalledOnce();
  });
  it('re-arms the single keyboard slot when a new action is registered', async () => {
    const first = vi.fn(async () => true); const second = vi.fn(async () => true); const third = vi.fn(async () => true);
    service.register({ kind: 'archive', message: 'A', undo: first });
    service.register({ kind: 'draft', message: 'B', undo: second });
    await service.undoLast(); expect(second).toHaveBeenCalledOnce();
    await service.undoLast(); expect(first).not.toHaveBeenCalled();
    service.register({ kind: 'snooze', message: 'C', undo: third });
    await service.undoLast(); expect(third).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled();
  });
  it('expires old same-kind actions and cannot invoke their retained button', async () => {
    const old = vi.fn(async () => true); const fresh = vi.fn(async () => true);
    service.register({ kind: 'archive', message: 'Old', undo: old }); const stale = toast.toasts()[0].action!.run;
    service.register({ kind: 'archive', message: 'New', undo: fresh }); await stale();
    expect(old).not.toHaveBeenCalled(); await service.undoLast(); expect(fresh).toHaveBeenCalledOnce();
  });
  it('expires after five seconds but keeps a hovered action live', async () => {
    const undo = vi.fn(async () => true); service.register({ kind: 'a', message: 'A', undo });
    toast.pause(toast.toasts()[0].id, 'hover'); vi.advanceTimersByTime(10_000); await service.undoLast(); expect(undo).toHaveBeenCalledOnce();
    service.register({ kind: 'a', message: 'A', undo }); vi.advanceTimersByTime(5000); await service.undoLast(); expect(undo).toHaveBeenCalledOnce();
  });
  it.each([false, new Error('unavailable')])('shows an error for an unsuccessful restore', async (result) => {
    service.register({ kind: 'a', message: 'A', undo: async () => { if (result instanceof Error) throw result; return result; } });
    await service.undoLast(); expect(toast.toasts()[0]).toMatchObject({ type: 'error', text: expect.stringContaining("Couldn't undo that.") });
  });
  it('does nothing with no live entry', async () => { await service.undoLast(); expect(toast.toasts()).toEqual([]); });
});
