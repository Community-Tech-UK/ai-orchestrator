import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaudeCostReconcileGroup,
  ClaudeCostReconcileReport,
  ClaudeCostReconcileSnapshot,
} from '../../../../shared/types/claude-cost-reconcile.types';
import { ClaudeCostReconcileIpcService } from '../../core/services/ipc/claude-cost-reconcile-ipc.service';
import { RendererPollSchedulerService } from '../../core/services/renderer-poll-scheduler.service';
import { ClaudeCostDriftComponent, describeDrift } from './claude-cost-drift.component';

const group = (sessions: number, storedUsd: number, cliUsd: number): ClaudeCostReconcileGroup => ({
  sessions, storedUsd, cliUsd, gapUsd: storedUsd - cliUsd, driftPct: cliUsd > 0 ? ((storedUsd - cliUsd) / cliUsd) * 100 : null,
});
const report = (status: ClaudeCostReconcileReport['status'], over: Partial<ClaudeCostReconcileReport> = {}): ClaudeCostReconcileReport => ({
  version: 1, checkedAt: Date.UTC(2026, 9, 21, 9, 5), windowStart: 0, thresholdPct: 5, status,
  total: group(4, 90, 100),
  byEra: { 'per-turn': group(1, 10, 10), repaired: group(3, 80, 90) },
  coverage: { candidates: 9, notClaude: 2, noTranscript: 1, unsettled: 1, unknownModelCost: 1, compared: 4 },
  largestGaps: [{ sessionId: 'abcdef1234567890', era: 'repaired', storedUsd: 40, cliUsd: 50, gapUsd: -10, gapPct: -20, rows: 5, lastRowAt: 1 }],
  ...over,
});
const snapshot = (latest: ClaudeCostReconcileReport | null, over: Partial<ClaudeCostReconcileSnapshot> = {}): ClaudeCostReconcileSnapshot =>
  ({ latest, history: [], running: false, lastError: null, ...over });

describe('describeDrift', () => {
  it('words the direction plainly and handles the edges', () => {
    expect(describeDrift(-9.04)).toBe("9.0% below Claude's figure");
    expect(describeDrift(12.34)).toBe("12.3% above Claude's figure");
    expect(describeDrift(0.01)).toBe('matches exactly');
    expect(describeDrift(null)).toBe('no Claude spend to compare');
  });
});

describe('ClaudeCostDriftComponent', () => {
  let fixture: ComponentFixture<ClaudeCostDriftComponent>;
  let ipc: { get: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> };
  let polls: { run: () => unknown; everyMs: number; stop: ReturnType<typeof vi.fn> }[];
  const text = (): string => (fixture.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ');
  const settle = async (): Promise<void> => { await fixture.whenStable(); fixture.detectChanges(); };
  const mount = async (first: unknown): Promise<void> => {
    ipc.get.mockResolvedValue(first);
    fixture = TestBed.createComponent(ClaudeCostDriftComponent);
    fixture.detectChanges();
    await settle();
  };

  const providers = (): unknown[] => [
    provideZonelessChangeDetection(),
    { provide: ClaudeCostReconcileIpcService, useValue: ipc },
    { provide: RendererPollSchedulerService, useValue: { register: (run: () => unknown, everyMs: number) => { const stop = vi.fn(); polls.push({ run, everyMs, stop }); return stop; } } },
  ];
  beforeEach(() => {
    ipc = { get: vi.fn(), run: vi.fn() };
    polls = [];
    TestBed.configureTestingModule({ providers: providers() as never });
  });
  afterEach(() => TestBed.resetTestingModule());

  it('refreshes itself every minute while the page is open, so a finished daily check appears without a reload', async () => {
    await mount({ success: true, data: snapshot(null) });
    expect(polls).toHaveLength(1);
    expect(polls[0].everyMs).toBe(60_000);
    ipc.get.mockResolvedValue({ success: true, data: snapshot(report('ok')) });
    await polls[0].run();
    await settle();
    expect(text()).toContain("agree with Claude's own figures");
    expect(polls[0].stop).not.toHaveBeenCalled();
    fixture.destroy();
    expect(polls[0].stop).toHaveBeenCalledTimes(1);
  });

  it('says nothing has been checked yet when there is no report', async () => {
    await mount({ success: true, data: snapshot(null) });
    expect(text()).toContain('Not checked yet');
    expect(text()).not.toContain('Over 5% apart');
  });

  it('warns in plain words when the totals are more than 5% apart and lists the biggest differences', async () => {
    await mount({ success: true, data: snapshot(report('drift')) });
    const shown = text();
    expect(shown).toContain('Over 5% apart.');
    expect(shown).toContain("10.0% below Claude's figure");
    expect(shown).toContain('Compared 4 sessions: Harness $90.00, Claude $100.00.');
    expect(shown).toContain('Booked turn by turn: 1 sessions, matches exactly.');
    expect(shown).toContain("Older sessions, rebuilt from running totals: 3 sessions, 11.1% below Claude's figure.");
    expect(shown).toContain('Left out: 1 still running or unfinished, 1 with no transcript on this computer, 1 Claude could not price.');
    expect(shown).toContain('abcdef12');
    expect(shown).toContain('-$10.00');
    expect((fixture.nativeElement as HTMLElement).querySelector('.verdict')!.classList.contains('warn')).toBe(true);
  });

  it('says so plainly when Harness booked spend for sessions where Claude reports none', async () => {
    const zero = report('drift', { total: group(2, 3, 0), byEra: { 'per-turn': group(2, 3, 0), repaired: group(0, 0, 0) }, largestGaps: [] });
    await mount({ success: true, data: snapshot(zero) });
    expect(text()).toContain('Over 5% apart.');
    expect(text()).toContain('Harness booked $3.00 for sessions where Claude reports no spend.');
    expect(text()).toContain('Booked turn by turn: 2 sessions, booked $3.00 where Claude reports none.');
    expect(text()).not.toContain('NaN');
  });

  it('is calm when the totals agree, and explains too little data', async () => {
    await mount({ success: true, data: snapshot(report('ok', { total: group(4, 100, 101) })) });
    expect(text()).toContain("agree with Claude's own figures (within 5%)");
    expect(text()).not.toContain('Biggest differences');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: providers() as never });
    await mount({ success: true, data: snapshot(report('insufficient-data')) });
    expect(text()).toContain('Not enough finished Claude sessions to compare yet.');
  });

  it('Check now runs once, is disabled while running, and shows the new result', async () => {
    await mount({ success: true, data: snapshot(null) });
    let release!: (value: unknown) => void;
    ipc.run.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    button.click();
    button.click();
    fixture.detectChanges();
    expect(ipc.run).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Checking');
    release({ success: true, data: snapshot(report('ok')) });
    await settle();
    expect(button.disabled).toBe(false);
    expect(text()).toContain('Harness\'s Claude costs agree');
  });

  it('does not let a slower background refresh overwrite a Check now result that finished first', async () => {
    await mount({ success: true, data: snapshot(null) });
    let releaseGet!: (value: unknown) => void;
    ipc.get.mockReturnValue(new Promise(resolve => { releaseGet = resolve; }));
    const refresh = polls[0].run() as Promise<void>;
    ipc.run.mockResolvedValue({ success: true, data: snapshot(report('ok')) });
    (fixture.nativeElement as HTMLElement).querySelector('button')!.click();
    await settle();
    expect(text()).toContain("Harness's Claude costs agree");
    releaseGet({ success: true, data: snapshot(null) });
    await refresh;
    await settle();
    expect(text()).toContain("Harness's Claude costs agree");
    expect(text()).not.toContain('Not checked yet');
  });

  it('reports a failed load or a failed last check without hiding the older result', async () => {
    await mount({ success: false, error: { message: 'Not in Electron' } });
    expect(text()).toContain('Not in Electron');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: providers() as never });
    await mount({ success: true, data: snapshot(report('ok'), { lastError: 'database is locked' }) });
    expect(text()).toContain('The last check failed, so these figures may be out of date.');
    expect(text()).toContain('Compared 4 sessions');
    expect(text()).not.toContain('database is locked');
  });
});
