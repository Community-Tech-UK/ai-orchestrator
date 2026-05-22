import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ViewLayoutService, WORKSPACE_PRESETS } from './view-layout.service';

describe('ViewLayoutService workspace presets', () => {
  let service: ViewLayoutService;

  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* storage unavailable — service falls back to defaults */
    }
    TestBed.configureTestingModule({});
    service = TestBed.inject(ViewLayoutService);
  });

  it('exposes the four built-in presets in display order', () => {
    expect(service.presets.map((preset) => preset.id)).toEqual([
      'coding',
      'research',
      'review',
      'monitoring',
    ]);
  });

  it('starts with no active preset (custom layout)', () => {
    expect(service.activePreset()).toBeNull();
  });

  it('records the active preset', () => {
    service.setActivePreset('review');
    expect(service.activePreset()).toBe('review');
  });

  it('clears the active preset when passed null', () => {
    service.setActivePreset('coding');
    service.setActivePreset(null);
    expect(service.activePreset()).toBeNull();
  });

  it('getPreset returns the matching definition', () => {
    expect(service.getPreset('monitoring').panels.controlPlane).toBe(true);
    expect(service.getPreset('coding').panels.fileExplorer).toBe(true);
    expect(service.getPreset('research').panels.fileExplorer).toBe(false);
  });

  it('reset clears the active preset', () => {
    service.setActivePreset('research');
    service.reset();
    expect(service.activePreset()).toBeNull();
  });

  it('every preset keeps the wide sidebar visible', () => {
    for (const preset of Object.values(WORKSPACE_PRESETS)) {
      expect(preset.panels.sidebar).toBe(true);
    }
  });
});

describe('ViewLayoutService control plane pinning', () => {
  let service: ViewLayoutService;

  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* storage unavailable — service falls back to defaults */
    }
    TestBed.configureTestingModule({});
    service = TestBed.inject(ViewLayoutService);
  });

  it('starts with the control plane unpinned', () => {
    expect(service.controlPlanePinned()).toBe(false);
  });

  it('records the control plane as pinned', () => {
    service.setControlPlanePinned(true);
    expect(service.controlPlanePinned()).toBe(true);
  });

  it('clears the pinned state when set back to false', () => {
    service.setControlPlanePinned(true);
    service.setControlPlanePinned(false);
    expect(service.controlPlanePinned()).toBe(false);
  });

  it('reset returns the control plane to unpinned', () => {
    service.setControlPlanePinned(true);
    service.reset();
    expect(service.controlPlanePinned()).toBe(false);
  });

  it('defaults to unpinned for a stored payload that predates the field', () => {
    // A v2 payload written before controlPlanePinned existed: the field merges
    // in from DEFAULT_LAYOUT while the older widths are preserved.
    localStorage.setItem(
      'view-layout',
      JSON.stringify({
        __v: 2,
        value: {
          sidebarWidth: 300,
          fileExplorerWidth: 260,
          historySidebarWidth: 350,
          sourceControlWidth: 320,
          activePreset: null,
        },
      }),
    );

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const reloaded = TestBed.inject(ViewLayoutService);

    expect(reloaded.controlPlanePinned()).toBe(false);
    expect(reloaded.sidebarWidth).toBe(300);
  });

  it('persists the pinned state so it survives a reload', () => {
    vi.useFakeTimers();
    try {
      service.setControlPlanePinned(true);
      // Flush the debounced localStorage write.
      vi.advanceTimersByTime(500);
    } finally {
      vi.useRealTimers();
    }

    // Re-create the service to simulate an app reload.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const reloaded = TestBed.inject(ViewLayoutService);

    expect(reloaded.controlPlanePinned()).toBe(true);
  });
});
