import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillActivationRecord } from '../../../../shared/types/skill-observability.types';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import { OrchestrationIpcService } from '../services/ipc/orchestration-ipc.service';
import { ToastService } from '../services/toast.service';
import { SkillStore } from './skill.store';

function activation(overrides: Partial<SkillActivationRecord> = {}): SkillActivationRecord {
  return {
    id: `act-${Math.random()}`,
    skillName: 'ui-audit',
    skillSource: 'builtin',
    instanceId: 'inst-1',
    sessionId: 'sess-1',
    turnKey: 'turn-1',
    matchedBy: 'trigger',
    matchedTrigger: '/ui-audit',
    matchScore: 1,
    tokensInjected: 300,
    autoSelected: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('SkillStore observability', () => {
  let deltaListener: ((activation: unknown) => void) | null;
  const unsubscribe = vi.fn();
  const api = {
    onSkillActivationDelta: vi.fn((listener: (activation: unknown) => void) => {
      deltaListener = listener;
      return unsubscribe;
    }),
  };
  const orchestration = {
    skillsActivationsRecent: vi.fn(),
    skillsListControls: vi.fn(),
    skillsSetControl: vi.fn(),
  };
  const toast = { show: vi.fn() };

  beforeEach(() => {
    deltaListener = null;
    vi.clearAllMocks();
    orchestration.skillsActivationsRecent.mockResolvedValue({ success: true, data: [] });
    orchestration.skillsListControls.mockResolvedValue({ success: true, data: [] });
    orchestration.skillsSetControl.mockResolvedValue({
      success: true,
      data: { skillName: 'ui-audit', mode: 'disabled', reason: null, updatedAt: Date.now() },
    });
    TestBed.configureTestingModule({
      providers: [
        SkillStore,
        { provide: ElectronIpcService, useValue: { getApi: () => api } },
        { provide: OrchestrationIpcService, useValue: orchestration },
        { provide: ToastService, useValue: toast },
      ],
    });
  });

  it('subscribes once and prepends pushed activations', () => {
    const store = TestBed.inject(SkillStore);
    store.initObservability();
    store.initObservability();

    expect(api.onSkillActivationDelta).toHaveBeenCalledOnce();

    deltaListener?.(activation({ id: 'a1' }));
    deltaListener?.(activation({ id: 'a2', instanceId: 'inst-2' }));

    expect(store.activations()).toHaveLength(2);
    expect(store.activations()[0].id).toBe('a2');
    expect(store.activationsForInstance('inst-1')).toHaveLength(1);
  });

  it('toasts on auto activation with the matched trigger, honouring the cooldown', () => {
    const store = TestBed.inject(SkillStore);
    store.initObservability();

    deltaListener?.(activation());
    deltaListener?.(activation()); // same skill+instance within cooldown

    expect(toast.show).toHaveBeenCalledTimes(1);
    expect(toast.show.mock.calls[0][0]).toContain('ui-audit');
    expect(toast.show.mock.calls[0][0]).toContain('/ui-audit');
  });

  it('does not toast for explicit (manually loaded) activations', () => {
    const store = TestBed.inject(SkillStore);
    store.initObservability();

    deltaListener?.(activation({ autoSelected: false, matchedBy: 'explicit' }));

    expect(toast.show).not.toHaveBeenCalled();
  });

  it('persists a control change and reflects it in controlModeFor', async () => {
    const store = TestBed.inject(SkillStore);
    store.initObservability();

    expect(store.controlModeFor('ui-audit')).toBeNull();
    const ok = await store.setSkillControl('ui-audit', 'disabled', 'test');

    expect(ok).toBe(true);
    expect(orchestration.skillsSetControl).toHaveBeenCalledWith('ui-audit', 'disabled', 'test');
    expect(store.controlModeFor('ui-audit')).toBe('disabled');
  });

  it('surfaces a failure toast when the control write fails', async () => {
    orchestration.skillsSetControl.mockResolvedValue({
      success: false,
      error: { message: 'nope' },
    });
    const store = TestBed.inject(SkillStore);

    const ok = await store.setSkillControl('ui-audit', 'disabled');

    expect(ok).toBe(false);
    expect(toast.show).toHaveBeenCalledWith('Could not update skill "ui-audit"', 'error');
  });
});
