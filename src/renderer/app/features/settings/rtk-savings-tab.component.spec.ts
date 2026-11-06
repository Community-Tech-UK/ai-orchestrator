import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RtkSavingsTabComponent } from './rtk-savings-tab.component';
import { RtkIpcService } from '../../core/services/ipc/rtk-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';

await resolveComponentResources((url) => {
  if (url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('RtkSavingsTabComponent', () => {
  const getSummary = vi.fn();
  const getStatus = vi.fn();

  beforeEach(() => {
    getSummary.mockReset().mockResolvedValue({ success: true, data: {
      commands: 100, commandsFiltered: 17, commandsRanInFull: 83,
      totalInput: 1, totalOutput: 1, totalSaved: 26_154_000_000,
      savedTokensCapped: 25_200_000, weightedReductionPct: 24.7,
      avgSavingsPct: 30, windowDays: 90,
      byCommand: [], byProgram: [{ program: 'git', count: 5, savedTokensCapped: 1_000 }],
      lastCommandAt: null,
    } });
    getStatus.mockReset().mockResolvedValue({ success: true, data: {
      enabled: true, available: true, binarySource: 'bundled', version: '0.51.0',
      trackingDbPath: '/tmp/tracking.db', trackingDbAvailable: true,
      coverage: [{ surface: 'Claude auto-approve', mode: 'Trial', note: 'Half get a hook.' }],
    } });
    TestBed.configureTestingModule({ providers: [
      { provide: RtkIpcService, useValue: { getSummary, getStatus, lastSummary: { value: null } } },
      { provide: SettingsStore, useValue: { rtkSettings: () => [], get: () => true, set: vi.fn() } },
    ] });
  });
  afterEach(() => TestBed.resetTestingModule());

  async function render() {
    const fixture = TestBed.createComponent(RtkSavingsTabComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('shows capped estimates and the coverage mode without the inflated raw total', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('25,200,000');
    expect(root.textContent).not.toContain('26,154,000,000');
    expect(root.textContent).toContain('Commands made shorter');
    expect(root.textContent).toContain('Ran in full (not shortened)');
    expect(root.textContent).toContain('Claude auto-approve');
    expect(root.textContent).toContain('Trial');
    expect(root.textContent).toContain('Rust Token Killer');
    expect(root.querySelectorAll('[title]')).toHaveLength(0);
  });

  it('passes the selected time window to the read-only summary request', async () => {
    const fixture = await render();
    expect(getSummary).toHaveBeenCalledWith({ topN: 10, sinceMs: expect.any(Number) });
    const buttons = fixture.nativeElement.querySelectorAll('.window-btn') as NodeListOf<HTMLButtonElement>;
    buttons[3].click();
    await fixture.whenStable();
    expect(getSummary).toHaveBeenLastCalledWith({ topN: 10, sinceMs: undefined });
  });

  it('keeps the latest window response when an older request finishes last', async () => {
    const fixture = await render();
    const oldSummary = deferred<unknown>();
    const newSummary = deferred<unknown>();
    const data = (await getSummary.mock.results[0].value).data;
    getSummary.mockReturnValueOnce(oldSummary.promise).mockReturnValueOnce(newSummary.promise);
    fixture.componentInstance.setWindow(7);
    fixture.componentInstance.setWindow(0);
    newSummary.resolve({ success: true, data: { ...data, savedTokensCapped: 1234 } });
    await new Promise(resolve => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('1,234');
    oldSummary.resolve({ success: true, data: { ...data, savedTokensCapped: 9876 } });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('1,234');
    expect(fixture.nativeElement.textContent).not.toContain('9,876');
    expect(fixture.nativeElement.querySelectorAll('.window-btn')[3].getAttribute('aria-pressed')).toBe('true');
  });

  it('ignores stale errors and loading completion while the newest window is pending', async () => {
    const fixture = await render();
    const oldSummary = deferred<unknown>();
    const newSummary = deferred<unknown>();
    getSummary.mockReturnValueOnce(oldSummary.promise).mockReturnValueOnce(newSummary.promise);
    fixture.componentInstance.setWindow(7);
    fixture.componentInstance.setWindow(30);
    oldSummary.reject(new Error('stale window failure'));
    await new Promise(resolve => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('stale window failure');
    expect(fixture.nativeElement.textContent).toContain('Refreshing');
    newSummary.resolve({ success: true, data: null });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Refreshing');
  });

  it('does not render raw compatibility command savings beside capped estimates', async () => {
    const data = (await getSummary()).data;
    getSummary.mockResolvedValue({ success: true, data: { ...data,
      byCommand: [{ rtkCmd: 'rtk proxy cargo test', count: 1, saved: 39990, avgSavingsPct: 99.9 }],
    } });
    const fixture = await render();
    expect(fixture.nativeElement.textContent).not.toContain('39,990');
    expect(fixture.nativeElement.textContent).not.toContain('99.9%');
    expect(fixture.nativeElement.textContent).toContain('25,200,000');
  });
});

describe('RTK Savings refresh', () => {
  const summary = { commands: 1234, commandsFiltered: 1234, commandsRanInFull: 0,
    totalInput: 100, totalOutput: 20, totalSaved: 80, savedTokensCapped: 0,
    weightedReductionPct: 0, windowDays: 7,
    avgSavingsPct: 80, byCommand: [], byProgram: [], lastCommandAt: null,
    projectBursts: [{ projectPath: '/busy-project', commands: 2345 }] };
  let resolveSummary: (value: unknown) => void;
  let ipc: { lastSummary: { value: typeof summary; windowDays: number }; getStatus: ReturnType<typeof vi.fn>; getSummary: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    ipc = {
      lastSummary: { value: summary, windowDays: 7 },
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
  afterEach(() => TestBed.resetTestingModule());

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
    resolveSummary({ success: true, data: { ...summary, commandsFiltered: 5678 } });
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
