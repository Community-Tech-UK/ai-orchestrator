import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../../core/state/settings.store';
import { listControlNavGroups, listDashboardNavGroups } from '../../shared/control-surface/control-surface.registry';
import { observationMemoryGuard } from './observation-memory.guard';

describe('Observation memory visibility', () => {
  it.each([false, true])('checks persisted opt-in before loading its page: %s', async enabled => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    const redirect = { target: '/knowledge' };
    TestBed.configureTestingModule({ providers: [
      { provide: SettingsStore, useValue: { initialize, settings: () => ({ observationMemoryEnabled: enabled }) } },
      { provide: Router, useValue: { parseUrl: () => redirect } },
    ] });
    const result = await TestBed.runInInjectionContext(() => observationMemoryGuard({}, [], {} as Parameters<typeof observationMemoryGuard>[2]));
    expect(initialize).toHaveBeenCalled();
    expect(result).toEqual(enabled ? true : redirect);
  });

  it('hides both navigation entries by default and restores them on explicit opt-in', () => {
    for (const groups of [listControlNavGroups, listDashboardNavGroups]) {
      expect(groups().flatMap(group => group.items).some(item => item.id === 'observations')).toBe(false);
      expect(groups(true).flatMap(group => group.items).some(item => item.id === 'observations')).toBe(true);
    }
  });
});
