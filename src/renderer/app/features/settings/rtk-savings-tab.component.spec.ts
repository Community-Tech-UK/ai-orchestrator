import { TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RtkSavingsTabComponent } from './rtk-savings-tab.component';
import { RtkIpcService } from '../../core/services/ipc/rtk-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';

await resolveComponentResources(() => Promise.resolve(''));

describe('RTK Savings refresh', () => {
  const summary = { commands: 1234, totalInput: 100, totalOutput: 20, totalSaved: 80,
    avgSavingsPct: 80, byCommand: [], lastCommandAt: null,
    projectBursts: [{ projectPath: '/busy-project', commands: 2345 }] };
  let resolveSummary: (value: unknown) => void;
  let ipc: { lastSummary: { value: typeof summary }; getStatus: ReturnType<typeof vi.fn>; getSummary: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    ipc = {
      lastSummary: { value: summary },
      getStatus: vi.fn(async () => ({ success: true, data: null })),
      getSummary: vi.fn(() => new Promise(resolve => { resolveSummary = resolve; })),
    };
    TestBed.configureTestingModule({
      imports: [RtkSavingsTabComponent],
      providers: [
        { provide: RtkIpcService, useValue: ipc },
        { provide: SettingsStore, useValue: { rtkSettings: () => [], get: vi.fn(), set: vi.fn() } },
      ],
    });
    TestBed.overrideComponent(RtkSavingsTabComponent, { set: { styleUrl: undefined, styleUrls: [], styles: [] } });
    await TestBed.compileComponents();
  });

  it('shows the previous result immediately while requesting only the last seven days', async () => {
    const before = Date.now();
    const fixture = TestBed.createComponent(RtkSavingsTabComponent);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('1,234');
    expect(text).toContain('Refreshing…');
    expect(text).toContain('Last 7 days');
    expect(text).toContain('/busy-project called RTK 2,345 times in the last hour');
    const options = ipc.getSummary.mock.calls[0][0];
    expect(options.topN).toBe(10);
    expect(options.sinceMs).toBeGreaterThanOrEqual(before - 7 * 86_400_000);
    expect(options.sinceMs).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000);
    resolveSummary({ success: true, data: { ...summary, commands: 5678 } });
    await vi.waitFor(() => { fixture.detectChanges(); expect(fixture.nativeElement.textContent).toContain('5,678'); });
    expect(fixture.nativeElement.textContent).not.toContain('Refreshing…');
    fixture.destroy();
  });

  it('keeps the last successful result visible after a refresh failure', async () => {
    const fixture = TestBed.createComponent(RtkSavingsTabComponent);
    fixture.detectChanges();
    resolveSummary({ success: false, error: { message: 'Worker failed' } });
    await vi.waitFor(() => { fixture.detectChanges(); expect(fixture.nativeElement.textContent).toContain('Worker failed'); });
    expect(fixture.nativeElement.textContent).toContain('1,234');
    fixture.destroy();
  });
});
