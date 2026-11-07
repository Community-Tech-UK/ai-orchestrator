import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TodoIpcService } from '../../core/services/ipc/todo-ipc.service';
import { SessionTodoPeekService } from './session-todo-peek.service';

describe('SessionTodoPeekService', () => {
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });
  it('loads once per 30 seconds, shares inflight work, counts only non-cancelled steps', async () => {
    vi.useFakeTimers();
    const todoGetList = vi.fn().mockResolvedValue({ success: true, data: { items: [
      { status: 'cancelled', content: 'Skipped' }, { status: 'completed', content: 'Read' },
      { status: 'in_progress', content: 'Implement' }, { status: 'pending', content: 'Test' },
      { status: 'pending', content: 'Review' }, { status: 'pending', content: 'Finish' },
    ] } });
    TestBed.configureTestingModule({ providers: [{ provide: TodoIpcService, useValue: { todoGetList } }] });
    const service = TestBed.inject(SessionTodoPeekService);
    const first = service.peek('s'); const second = service.peek('s');
    expect(await first).toBe('Step 2 of 5: Implement'); expect(await second).toBe('Step 2 of 5: Implement');
    await service.peek('s'); expect(todoGetList).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_001); await service.peek('s'); expect(todoGetList).toHaveBeenCalledTimes(2);
  });
  it('returns no step for no list or no active step', async () => {
    const todoGetList = vi.fn().mockResolvedValueOnce({ success: true, data: null }).mockResolvedValueOnce({ success: true, data: { items: [] } });
    TestBed.configureTestingModule({ providers: [{ provide: TodoIpcService, useValue: { todoGetList } }] });
    const service = TestBed.inject(SessionTodoPeekService);
    expect(await service.peek('a')).toBeNull(); expect(await service.peek('b')).toBeNull();
  });
});
