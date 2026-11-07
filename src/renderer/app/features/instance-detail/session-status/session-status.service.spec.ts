import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ActionDispatchService } from '../../../core/services/action-dispatch.service';
import { CostIpcService } from '../../../core/services/ipc/cost-ipc.service';
import { CommandStore } from '../../../core/state/command.store';
import { InstanceStore } from '../../../core/state/instance.store';
import { SessionStatusService } from './session-status.service';
describe('SessionStatusService', () => {
  it('opens the selected session via the shared action, loads once per opening and refreshes on matching usage', async () => {
    let usage: (data: unknown) => void = () => undefined;
    const load = vi.fn().mockResolvedValue({ success: true, data: { turns: 3 } });
    TestBed.configureTestingModule({ providers: [
      ActionDispatchService,
      { provide: CommandStore, useValue: { executeCommand: vi.fn() } },
      { provide: InstanceStore, useValue: { selectedInstance: () => ({ id: 'i' }), getInstance: () => ({ sessionId: 's' }) } },
      { provide: CostIpcService, useValue: { costGetSessionBreakdown: load, onCostUsageRecorded: (callback: typeof usage) => { usage = callback; return vi.fn(); } } },
    ] });
    const service = TestBed.inject(SessionStatusService);
    const actions = TestBed.inject(ActionDispatchService);
    // A secondary page has no Dashboard eligibility update or durable Chat selection.
    expect(actions.getState().chatSelected).toBe(false);
    expect(actions.getState().instanceSelected).toBe(false);
    expect(await actions.dispatch('session.open-status')).toBe(true);
    expect(service.instanceId()).toBe('i'); expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenLastCalledWith('i', 's');
    usage({ instanceId: 'other' }); expect(load).toHaveBeenCalledTimes(1);
    usage({ sessionId: 's' }); await Promise.resolve(); expect(load).toHaveBeenCalledTimes(2);
    service.close(); usage({ sessionId: 's' }); expect(load).toHaveBeenCalledTimes(2);
    service.openFor('i'); await Promise.resolve(); expect(load).toHaveBeenCalledTimes(3);
  });
  it('does not open or load when no live session is selected', async () => {
    const load = vi.fn();
    TestBed.configureTestingModule({ providers: [ActionDispatchService,
      { provide: CommandStore, useValue: { executeCommand: vi.fn() } },
      { provide: InstanceStore, useValue: { selectedInstance: () => null, getInstance: vi.fn() } },
      { provide: CostIpcService, useValue: { costGetSessionBreakdown: load, onCostUsageRecorded: () => vi.fn() } },
    ] });
    const service = TestBed.inject(SessionStatusService);
    await TestBed.inject(ActionDispatchService).dispatch('session.open-status');
    expect(service.instanceId()).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});
