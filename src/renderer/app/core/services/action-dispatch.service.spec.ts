import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionDispatchService } from './action-dispatch.service';
import { CommandStore } from '../state/command.store';
import { InstanceStore } from '../state/instance.store';
import { FeatureUsageService } from '../../shared/tips/feature-usage.service';

describe('action dispatch tip retirement', () => {
  beforeEach(() => {
    TestBed.resetTestingModule(); localStorage.removeItem('working-tips:v1');
    TestBed.configureTestingModule({ providers: [
      { provide: CommandStore, useValue: { executeCommand: vi.fn() } },
      { provide: InstanceStore, useValue: { selectedInstance: () => null } },
    ] });
  });
  it('records a successful action but does not record an ineligible, missing or rejected action', async () => {
    const dispatch = TestBed.inject(ActionDispatchService);
    const usage = TestBed.inject(FeatureUsageService);
    dispatch.register({ id: 'toggle-side-chat', run: () => undefined, when: ['instance-selected'] });
    expect(await dispatch.dispatch('toggle-side-chat')).toBe(false);
    expect(usage.count('toggle-side-chat')).toBe(0);
    dispatch.setState({ instanceSelected: true });
    expect(await dispatch.dispatch('toggle-side-chat')).toBe(true);
    expect(usage.count('toggle-side-chat')).toBe(1);
    expect(await dispatch.dispatch('missing')).toBe(false);
    dispatch.register({ id: 'rejected', run: () => { throw new Error('Unavailable'); } });
    await expect(dispatch.dispatch('rejected')).rejects.toThrow('Unavailable');
    expect(usage.count('rejected')).toBe(0);
  });
});
