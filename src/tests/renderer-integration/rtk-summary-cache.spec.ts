import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RtkIpcService, type RtkSavingsSummary } from '../../renderer/app/core/services/ipc/rtk-ipc.service';
import { ElectronIpcService } from '../../renderer/app/core/services/ipc/electron-ipc.service';
import { SettingsStore } from '../../renderer/app/core/state/settings.store';
import { RtkSavingsTabComponent } from '../../renderer/app/features/settings/rtk-savings-tab.component';

await resolveComponentResources(() => Promise.resolve(''));

const summary = (saved: number, windowDays: number): RtkSavingsSummary => ({
  commands: 1, commandsFiltered: 1, commandsRanInFull: 0, totalInput: saved + 10,
  totalOutput: 10, totalSaved: saved, savedTokensCapped: saved, weightedReductionPct: 50,
  windowDays, avgSavingsPct: 50, byCommand: [], byProgram: [], lastCommandAt: null,
});

describe('RTK cached summaries through the real service and tab', () => {
  const rtkGetSummary = vi.fn();
  let ipc: RtkIpcService;
  beforeEach(() => {
    rtkGetSummary.mockReset();
    TestBed.configureTestingModule({ providers: [
      { provide: ElectronIpcService, useValue: { getApi: () => ({ rtkGetSummary,
        rtkGetStatus: async () => ({ success: true, data: null }) }) } },
      { provide: SettingsStore, useValue: { rtkSettings: () => [], get: vi.fn(), set: vi.fn() } },
    ] });
    ipc = TestBed.inject(RtkIpcService);
  });
  afterEach(() => TestBed.resetTestingModule());

  it.each([0, 7, 30, 90])('restores the requested %s-day period after remount and failed refresh', async days => {
    // Summary.windowDays is the span of recorded commands, not the requested range.
    rtkGetSummary.mockResolvedValueOnce({ success: true, data: summary(987654321, 2) });
    await ipc.getSummary({ topN: 10, sinceMs: days ? Date.now() - days * 86_400_000 : undefined });
    rtkGetSummary.mockResolvedValue({ success: false, error: { message: 'Refresh failed' } });
    const fixture = TestBed.createComponent(RtkSavingsTabComponent);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => { fixture.detectChanges(); expect(root.textContent).toContain('Refresh failed'); });
    expect(root.textContent).toContain('987,654,321');
    expect(root.textContent).toContain(days ? `Last ${days} days` : 'All time');
    expect(root.querySelector('[aria-pressed="true"]')?.textContent?.trim()).toBe(days ? `${days} days` : 'All');
    fixture.destroy();
  });

  it('does not let a late older request replace a newer cached period on remount', async () => {
    let resolveOld!: (value: unknown) => void;
    rtkGetSummary.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    const old = ipc.getSummary({ topN: 10, sinceMs: Date.now() - 7 * 86_400_000 });
    rtkGetSummary.mockResolvedValueOnce({ success: true, data: summary(1234, 2) });
    await ipc.getSummary({ topN: 10 });
    resolveOld({ success: true, data: summary(9876, 2) });
    await old;
    rtkGetSummary.mockResolvedValue({ success: false, error: { message: 'Refresh failed' } });
    const fixture = TestBed.createComponent(RtkSavingsTabComponent);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    await vi.waitFor(() => { fixture.detectChanges(); expect(fixture.nativeElement.textContent).toContain('Refresh failed'); });
    expect(fixture.nativeElement.textContent).toContain('1,234');
    expect(fixture.nativeElement.textContent).not.toContain('9,876');
    expect(fixture.nativeElement.textContent).toContain('All time');
    fixture.destroy();
  });
});
