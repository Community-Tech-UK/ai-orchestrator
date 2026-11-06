/**
 * Spec: CostPageComponent — computed signal logic
 *
 * Tests that derived signals (totalCost, totalTokens, modelRows,
 * sessionRows, avgCostPerSession, formatTokens) produce correct values
 * from mocked IPC data, without spinning up the full Angular app.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  Component,
  input,
  signal,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { RouterTestingModule } from '@angular/router/testing';
import { CommonModule } from '@angular/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CostPageComponent, type CostSummaryData, type CostEntry } from './cost-page.component';
import { CostHistoryRestoreComponent } from './cost-history-restore.component';
import { CostIpcService } from '../../core/services/ipc/cost-ipc.service';
import { UsageInsightIpcService } from '../../core/services/ipc/usage-insight-ipc.service';
import { InstanceStore } from '../../core/state/instance';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { UsageWhereWentCardComponent } from '../usage-insight/usage-where-went-card.component';
import { BiggestTurnsComponent } from './biggest-turns.component';
import { ClaudeCostDriftComponent } from './claude-cost-drift.component';
import type { EChartsOption } from 'echarts';
import type { UsageInsightResponse } from '../../../../shared/usage-insight/usage-insight.types';

const SCANNING: UsageInsightResponse = { status: 'scanning', progress: { filesDone: 1, filesTotal: 4, bytesDone: 10, bytesTotal: 40 } };

@Component({ selector: 'app-echarts-themed', template: '' })
class CostChartStubComponent {
  readonly options = input<EChartsOption | null>(null);
  readonly loading = input(false);
  readonly height = input('300px');
  readonly emptyMessage = input('No data available');
}

/**
 * The usage breakdown card on the page is the real one, fed from stand-ins
 * for its data sources. Its behaviour has its own spec.
 */
function usageInsightProviders() {
  return [
    { provide: UsageInsightIpcService, useValue: { get: vi.fn().mockResolvedValue({ success: true, data: SCANNING }) } },
    { provide: InstanceStore, useValue: { instancesMap: signal(new Map()), selectedInstance: signal(null) } },
    { provide: ProviderQuotaStore, useValue: { snapshots: signal({ claude: null }), accountSnapshots: signal([]) } },
  ];
}

const specDirectory = dirname(fileURLToPath(import.meta.url));
await resolveComponentResources((url) => {
  if (url.endsWith('cost-page.component.html')) return Promise.resolve(readFileSync(resolve(specDirectory,'cost-page.component.html'),'utf8'));
  if (
    url.endsWith('cost-page.component.html') ||
    url.endsWith('cost-page.component.scss')
  ) {
    return Promise.resolve('');
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MOCK_SUMMARY: CostSummaryData = {
  totalCost: 0.012345,
  totalInputTokens: 10_000,
  totalOutputTokens: 2_500,
  totalCacheReadTokens: 500,
  totalCacheWriteTokens: 200,
  totalReasoningTokens: 0,
  byModel: {
    'claude-3-5-sonnet-20241022': {
      cost: 0.009000,
      inputTokens: 7_000,
      outputTokens: 1_800,
      requests: 5,
    },
    'claude-3-haiku-20240307': {
      cost: 0.003345,
      inputTokens: 3_000,
      outputTokens: 700,
      requests: 3,
    },
  },
  bySession: {
    'sess-aaa': { cost: 0.007000, tokens: 4_000, requests: 4 },
    'sess-bbb': { cost: 0.005345, tokens: 6_700, requests: 4 },
  },
  requestCount: 8,
  startTime: 0,
  endTime: Date.now(),
};

const MOCK_ENTRIES: CostEntry[] = [
  {
    id: 'e1',
    timestamp: 1_700_000_000_000,
    instanceId: 'inst-1',
    sessionId: 'sess-aaa',
    model: 'claude-3-5-sonnet-20241022',
    inputTokens: 3_500,
    outputTokens: 900,
    cost: 0.004500,
  },
  {
    id: 'e2',
    timestamp: 1_700_000_001_000,
    instanceId: 'inst-1',
    sessionId: 'sess-bbb',
    model: 'claude-3-haiku-20240307',
    inputTokens: 1_500,
    outputTokens: 350,
    cost: 0.001672,
  },
];

// ─── Mock CostIpcService ──────────────────────────────────────────────────────

function buildMockIpc(
  summaryData: CostSummaryData = MOCK_SUMMARY,
  entriesData: CostEntry[] = MOCK_ENTRIES,
) {
  return {
    costGetEphemeralUsage: vi.fn().mockResolvedValue({success:true,data:{entries:[],truncated:false,skippedLines:0}}),
    costGetPurposeSummary: vi.fn().mockResolvedValue({ success: true, data: null }),
    costGetSummary: vi.fn().mockResolvedValue({ success: true, data: summaryData }),
    costGetEntries: vi.fn().mockResolvedValue({ success: true, data: entriesData }),
    costGetBudgetStatus: vi.fn().mockResolvedValue({
      success: true,
      data: {
        daily: { usage: 0.005, limit: 10, percentage: 0.05 },
        weekly: { usage: 0.012, limit: 50, percentage: 0.024 },
        monthly: { usage: 0.012, limit: 200, percentage: 0.006 },
      },
    }),
    costHistoryRestoreStatus: vi.fn().mockResolvedValue({ success: true, data: null }),
    costHistoryRestoreApply: vi.fn().mockResolvedValue({ success: true, data: null }),
    costHistoryRestoreRollback: vi.fn().mockResolvedValue({ success: true, data: null }),
    costSetBudget: vi.fn().mockResolvedValue({ success: true }),
    onCostUsageRecorded: vi.fn().mockReturnValue(() => { /* noop */ }),
    onCostBudgetWarning: vi.fn().mockReturnValue(() => { /* noop */ }),
    onCostBudgetExceeded: vi.fn().mockReturnValue(() => { /* noop */ }),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CostPageComponent — computed signals', () => {
  let component: CostPageComponent;
  let fixture: ComponentFixture<CostPageComponent>;
  let mockIpc: ReturnType<typeof buildMockIpc>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    mockIpc = buildMockIpc();
    TestBed.overrideComponent(CostPageComponent, {
      set: { imports: [CommonModule, CostChartStubComponent, AioTooltipDirective, UsageWhereWentCardComponent, BiggestTurnsComponent, ClaudeCostDriftComponent],
        template: readFileSync(resolve(specDirectory, 'cost-page.component.html'), 'utf8'),
        templateUrl: undefined, styles: [], styleUrl: undefined, styleUrls: [] },
    });

    await TestBed.configureTestingModule({
      imports: [CostPageComponent, RouterTestingModule],
      providers: [
        { provide: CostIpcService, useValue: mockIpc },
        ...usageInsightProviders(),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CostPageComponent);
    component = fixture.componentInstance;
  });

  it('loads temporary Codex receipts and displays missing metrics without claiming an exact price', async () => {
    mockIpc.costGetEphemeralUsage.mockResolvedValue({ success: true, data: { entries: [{
      threadId: 'example-thread', jobId: 'example-job', instanceId: 'example-instance', kind: 'plan-queue',
      trialKey: 'group-example', trialArm: 'candidate', requests: null, requestsAvailable: false,
      tokens: { input: 100, cache: 80, output: 20, reasoning: null, total: 120, estimated: false },
      helpers: { count: 1, tokens: { input: 30, cache: 10, output: 5, reasoning: 0, total: 35, estimated: false } },
      compactions: 2, durationMs: 2500, endedAt: 1000,
    }], truncated: true, skippedLines: 1 } } as never);
    await component.refreshAll(false); fixture.detectChanges();
    const section: HTMLElement = fixture.nativeElement.querySelector('[aria-label="Temporary Codex sessions"]');
    expect(section).not.toBeNull();
    expect(section.textContent).toContain('100'); expect(section.textContent).toContain('80');
    expect(section.textContent).toContain('Unavailable'); expect(section.textContent).toContain('Price unavailable');
    expect(section.textContent).toContain('Helper agent tokens');
    expect(section.textContent).toContain('Latest records only');
    expect(section.textContent).not.toContain('$0.00');
    expect(section.querySelector('details')?.textContent).toContain('example-thread');
  });
  it('shows an unavailable receipt log separately from an empty receipt log', async () => {
    mockIpc.costGetEphemeralUsage.mockResolvedValue({ success: false, error: { message: 'read failed' } } as never);
    await component.refreshAll(false); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Temporary Codex usage is unavailable');
    mockIpc.costGetEphemeralUsage.mockResolvedValue({success:true,data:{entries:[],truncated:false,skippedLines:0}});
    await component.refreshAll(false); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No finished temporary Codex sessions recorded');
  });

  // ── Total cost ──────────────────────────────────────────────────────────

  it('totalCost reflects summary.totalCost', () => {
    component.summary.set(MOCK_SUMMARY);
    expect(component.totalCost()).toBeCloseTo(0.012345, 6);
  });

  // ── LT-100: estimated-vs-measured cost stays visibly distinguishable ────

  it('hasEstimatedEntries is false and totalEstimatedCost is 0 for an all-measured summary', () => {
    component.summary.set(MOCK_SUMMARY);
    expect(component.hasEstimatedEntries()).toBe(false);
    expect(component.totalEstimatedCost()).toBe(0);
  });

  it('hasEstimatedEntries reflects the summary when it mixes in an estimate', () => {
    component.summary.set({ ...MOCK_SUMMARY, hasEstimatedEntries: true, totalEstimatedCost: 0.002 });
    expect(component.hasEstimatedEntries()).toBe(true);
    expect(component.totalEstimatedCost()).toBeCloseTo(0.002, 6);
  });



  it('modelRows carries hasEstimated per model from the summary', () => {
    component.summary.set({
      ...MOCK_SUMMARY,
      byModel: {
        ...MOCK_SUMMARY.byModel,
        'claude-3-5-sonnet-20241022': { ...MOCK_SUMMARY.byModel['claude-3-5-sonnet-20241022'], hasEstimated: true },
      },
    });
    const sonnetRow = component.modelRows().find((r) => r.model === 'claude-3-5-sonnet-20241022');
    const haikuRow = component.modelRows().find((r) => r.model === 'claude-3-haiku-20240307');
    expect(sonnetRow?.hasEstimated).toBe(true);
    expect(haikuRow?.hasEstimated).toBe(false);
  });

  it('sessionRows carries hasEstimated per session from the summary', () => {
    component.summary.set({
      ...MOCK_SUMMARY,
      bySession: {
        ...MOCK_SUMMARY.bySession,
        'sess-aaa': { ...MOCK_SUMMARY.bySession['sess-aaa'], hasEstimated: true },
      },
    });
    const aaaRow = component.sessionRows().find((r) => r.sessionId === 'sess-aaa');
    const bbbRow = component.sessionRows().find((r) => r.sessionId === 'sess-bbb');
    expect(aaaRow?.hasEstimated).toBe(true);
    expect(bbbRow?.hasEstimated).toBe(false);
  });

  // ── Token totals ────────────────────────────────────────────────────────

  it('totalInputTokens sums from summary', () => {
    component.summary.set(MOCK_SUMMARY);
    expect(component.totalInputTokens()).toBe(10_000);
  });

  it('totalOutputTokens sums from summary', () => {
    component.summary.set(MOCK_SUMMARY);
    expect(component.totalOutputTokens()).toBe(2_500);
  });

  it('totalCacheTokens adds read + write cache tokens', () => {
    component.summary.set(MOCK_SUMMARY);
    expect(component.totalCacheTokens()).toBe(700); // 500 + 200
  });

  it('totalTokens sums input + output + cache', () => {
    component.summary.set(MOCK_SUMMARY);
    expect(component.totalTokens()).toBe(10_000 + 2_500 + 700);
  });

  // ── Session / request counts ─────────────────────────────────────────────

  it('sessionCount is the number of sessions in bySession', () => {
    component.summary.set(MOCK_SUMMARY);
    expect(component.sessionCount()).toBe(2);
  });

  it('requestCount comes from summary.requestCount', () => {
    component.summary.set(MOCK_SUMMARY);
    expect(component.requestCount()).toBe(8);
  });

  it('modelCount is the number of models in byModel', () => {
    component.summary.set(MOCK_SUMMARY);
    expect(component.modelCount()).toBe(2);
  });

  // ── Average cost per session ─────────────────────────────────────────────

  it('avgCostPerSession divides totalCost by sessionCount', () => {
    component.summary.set(MOCK_SUMMARY);
    expect(component.avgCostPerSession()).toBeCloseTo(0.012345 / 2, 6);
  });

  it('avgCostPerSession returns 0 when no sessions', () => {
    component.summary.set({ ...MOCK_SUMMARY, bySession: {}, totalCost: 0 });
    expect(component.avgCostPerSession()).toBe(0);
  });

  // ── modelRows ────────────────────────────────────────────────────────────

  it('modelRows has one entry per model', () => {
    component.summary.set(MOCK_SUMMARY);
    expect(component.modelRows().length).toBe(2);
  });

  it('modelRows are sorted descending by cost', () => {
    component.summary.set(MOCK_SUMMARY);
    const rows = component.modelRows();
    expect(rows[0].model).toBe('claude-3-5-sonnet-20241022');
    expect(rows[1].model).toBe('claude-3-haiku-20240307');
  });

  it('modelRows costPct sums to ~100', () => {
    component.summary.set(MOCK_SUMMARY);
    const total = component.modelRows().reduce((s, r) => s + r.costPct, 0);
    expect(total).toBeCloseTo(100, 1);
  });

  it('modelRows carries correct token counts', () => {
    component.summary.set(MOCK_SUMMARY);
    const sonnet = component.modelRows().find(r => r.model === 'claude-3-5-sonnet-20241022')!;
    expect(sonnet.inputTokens).toBe(7_000);
    expect(sonnet.outputTokens).toBe(1_800);
    expect(sonnet.requests).toBe(5);
  });

  it('modelRows is empty when byModel is empty', () => {
    component.summary.set({ ...MOCK_SUMMARY, byModel: {} });
    expect(component.modelRows().length).toBe(0);
  });

  // ── sessionRows ──────────────────────────────────────────────────────────

  it('sessionRows has one entry per session', () => {
    component.summary.set(MOCK_SUMMARY);
    expect(component.sessionRows().length).toBe(2);
  });

  it('sessionRows are sorted descending by cost', () => {
    component.summary.set(MOCK_SUMMARY);
    const rows = component.sessionRows();
    expect(rows[0].sessionId).toBe('sess-aaa');
    expect(rows[0].cost).toBeGreaterThan(rows[1].cost);
  });

  it('sessionRows costPct sums to ~100', () => {
    component.summary.set(MOCK_SUMMARY);
    const total = component.sessionRows().reduce((s, r) => s + r.costPct, 0);
    expect(total).toBeCloseTo(100, 1);
  });

  it('sessionRows is empty when bySession is empty', () => {
    component.summary.set({ ...MOCK_SUMMARY, bySession: {} });
    expect(component.sessionRows().length).toBe(0);
  });

  // ── Empty state (no data at all) ─────────────────────────────────────────

  it('all totals are 0 on empty summary', () => {
    // default EMPTY_SUMMARY is already set in the component constructor
    expect(component.totalCost()).toBe(0);
    expect(component.totalTokens()).toBe(0);
    expect(component.sessionCount()).toBe(0);
    expect(component.requestCount()).toBe(0);
    expect(component.modelRows().length).toBe(0);
    expect(component.sessionRows().length).toBe(0);
  });

  // ── formatTokens ────────────────────────────────────────────────────────

  it('formatTokens shows raw number below 1K', () => {
    expect(component.formatTokens(999)).toBe('999');
  });

  it('formatTokens shows K suffix at 1000+', () => {
    expect(component.formatTokens(1_500)).toBe('1.5K');
  });

  it('formatTokens shows M suffix at 1M+', () => {
    expect(component.formatTokens(2_500_000)).toBe('2.5M');
  });

  // ── refreshAll wires to costGetEntries (not costGetHistory) ─────────────

  it('refreshAll calls costGetEntries, not costGetHistory', async () => {
    await component.refreshAll(false);
    expect(mockIpc.costGetEntries).toHaveBeenCalledWith(100);
    expect(mockIpc.costGetSummary).toHaveBeenCalled();
    expect(mockIpc.costGetBudgetStatus).toHaveBeenCalled();
    expect(mockIpc.costGetPurposeSummary).toHaveBeenCalledWith({ startTime: expect.any(Number), endTime: expect.any(Number) });
  });

  it('refreshAll populates entries signal', async () => {
    await component.refreshAll(false);
    expect(component.entries()).toHaveLength(MOCK_ENTRIES.length);
  });

  it('refreshAll populates summary signal', async () => {
    await component.refreshAll(false);
    expect(component.totalCost()).toBeCloseTo(MOCK_SUMMARY.totalCost, 6);
  });
  it('renders dollar text without backslashes in metrics, budgets and every cost table', async () => {
    await component.refreshAll(false);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.metric-value')?.textContent?.trim()).toBe('$0.0123');
    const tableFor = (title: string) => Array.from(root.querySelectorAll('.panel-card'))
      .find(panel => panel.querySelector('.panel-title')?.textContent?.trim() === title)
      ?.querySelector('table');
    expect(tableFor('Per-Model Breakdown')?.querySelector('tbody tr td:nth-child(2)')?.textContent?.trim()).toBe('$0.009000');
    expect(tableFor('Per-Session Breakdown')?.querySelector('tbody tr td:nth-child(2)')?.textContent?.trim()).toBe('$0.007000');
    expect(tableFor('Recent Entries')?.querySelector('tbody tr td:nth-child(7)')?.textContent?.trim()).toBe('$0.004500');
    expect(root.textContent).not.toContain('\\$');
    component.entries.set([{ ...MOCK_ENTRIES[0], isEstimated: true }]);
    component.summary.set({ ...MOCK_SUMMARY, hasEstimatedEntries: true, totalEstimatedCost: 0.002 });
    fixture.detectChanges();
    expect(root.querySelector('.metric-value')?.textContent?.trim()).toBe('~$0.0123');
    expect(root.textContent).toContain('~$0.004500');
    expect(root.textContent).toContain('~ estimated');
  });

  it('renders readable purpose labels while preserving the raw provider grouping', async () => {
    await component.refreshAll(false);
    const row = { key: 'all', calls: 1, inputTokens: 10, cacheReadTokens: 20,
      cacheWriteTokens: 30, outputTokens: 40, reasoningTokens: 0,
      cost: 0.5, estimatedCost: 0, estimatedShare: 0,
      unknownCostCalls: 0, freeCalls: 0 };
    component.purposeSummary.set({ enabled: true, totals: row,
      byPurpose: ['plan-queue', 'repo-job', 'remote-node', 'quick-ask', 'helper']
        .map(key => ({ ...row, key })), byProvider: [{ ...row, key: 'claude' }] });
    fixture.detectChanges();
    const section = fixture.nativeElement.querySelector('[aria-label="Spend by purpose"]') as HTMLElement;
    for (const label of ['Plan queue', 'Repo jobs', 'Remote machines', 'Quick ask', 'Helpers']) {
      expect(section.textContent).toContain(label);
    }
    expect(section.textContent).not.toContain('plan-queue');
    expect(fixture.nativeElement.textContent).toContain('Cache read');
    expect(fixture.nativeElement.textContent).toContain('Cache write');
    const providerButton = Array.from(section.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'By provider')!;
    providerButton.click();
    fixture.detectChanges();
    expect(section.querySelector('tbody')?.textContent).toContain('claude');
    expect(section.querySelector('tbody')?.textContent).not.toContain('Plan queue');
  });

  it('shows unknown quick-ask dollars as unknown and discloses legacy exclusions', async () => {
    await component.refreshAll(false);
    const row = { key: 'quick-ask', calls: 1, inputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0,
      cost: 0, estimatedCost: 0, estimatedShare: 0,
      unknownCostCalls: 1, historicalCostUnknownCalls: 1, freeCalls: 0 };
    component.purposeSummary.set({ enabled: true, totals: row,
      byPurpose: [row], byProvider: [] });
    fixture.detectChanges();
    const section = fixture.nativeElement.querySelector('[aria-label="Spend by purpose"]') as HTMLElement;
    const quickAsk = section.querySelector('tbody tr') as HTMLTableRowElement;
    expect(quickAsk.textContent).toContain('Quick ask');
    expect(quickAsk.textContent).toContain('Unknown');
    expect(quickAsk.textContent).not.toContain('$0.0000');
    expect(section.querySelector('[data-testid="unknown-cost-footnote"]')?.textContent).toContain('1 calls have no reliable cost');
    expect(section.querySelector('[data-testid="historical-cost-footnote"]')?.textContent).toContain('1 historical Claude turns');
    component.purposeSummary.set({ enabled: false, totals: row, byPurpose: [], byProvider: [] });
    fixture.detectChanges();
    expect(section.textContent).toContain('Cost log is switched off');
  });
  it('renders separate cache cards and switches the purpose table to providers', async()=>{
    await component.refreshAll(false);
    const row={key:'helper',calls:2,inputTokens:10,cacheReadTokens:20,cacheWriteTokens:30,outputTokens:40,
      reasoningTokens:0,cost:0.1,estimatedCost:0.1,estimatedShare:1,unknownCostCalls:0,freeCalls:1};
    component.purposeSummary.set({enabled:true,totals:row,byPurpose:[{...row,key:'helper'}],byProvider:[{...row,key:'ollama'}]});
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Cache read');
    expect(fixture.nativeElement.textContent).toContain('Cache write');
    expect(fixture.nativeElement.querySelector('[aria-label="Spend by purpose"]').textContent).toContain('Helpers');
    const buttons=Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    buttons.find(button=>button.textContent?.trim()==='By provider')!.click();fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[aria-label="Spend by purpose"]').textContent).toContain('ollama');
    expect(fixture.nativeElement.querySelector('[data-testid="unknown-cost-footnote"]')).toBeNull();
  });
  it('shows unknown-cost/free-call footnote only when calls have no price and shows log opt-out',()=>{
    const row={key:'all',calls:2,inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,
      reasoningTokens:0,cost:0,estimatedCost:0,estimatedShare:0,unknownCostCalls:1,freeCalls:1};
    component.purposeSummary.set({enabled:true,totals:row,byPurpose:[],byProvider:[]});fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="unknown-cost-footnote"]').textContent).toContain('1 calls have no reliable cost');
    component.purposeSummary.set({enabled:false,totals:row,byPurpose:[],byProvider:[]});fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Cost log is switched off');
    expect(fixture.nativeElement.querySelector('[data-testid="unknown-cost-footnote"]')).toBeNull();
  });
  it('shows "Where your usage went" first, ahead of every dollar figure', async () => {
    // No chart data, so the page does not try to draw canvases in the test browser.
    mockIpc.costGetEntries.mockResolvedValue({ success: true, data: [] });
    mockIpc.costGetSummary.mockResolvedValue({ success: true, data: { ...MOCK_SUMMARY, byModel: {} } });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const cards = root.querySelectorAll('app-usage-where-went-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain('Where your usage went');
    expect(cards[0].textContent).toContain('Reading your Claude records: 1 of 4 files.');
    const firstFigures = root.querySelector('.metrics-row')!;
    expect(cards[0].compareDocumentPosition(firstFigures) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('discloses excluded historical Claude dollar amounts only when present', () => {
    const row = { key: 'all', calls: 2, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      outputTokens: 0, reasoningTokens: 0, cost: 0, estimatedCost: 0, estimatedShare: 0,
      unknownCostCalls: 2, freeCalls: 0, historicalCostUnknownCalls: 2 };
    component.purposeSummary.set({ enabled: true, totals: row, byPurpose: [], byProvider: [] });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="historical-cost-footnote"]').textContent)
      .toContain('2 historical Claude turns have uncorrected running totals');
    expect(fixture.nativeElement.querySelector('[data-testid="historical-cost-footnote"]').textContent)
      .toContain('Their dollar amounts are excluded here');
    component.purposeSummary.set({ enabled: true, totals: { ...row, historicalCostUnknownCalls: 0 }, byPurpose: [], byProvider: [] });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="historical-cost-footnote"]')).toBeNull();
  });

  it('shows the biggest turns and Codex credits from the purpose summary on the page', () => {
    const row = { key: 'all', calls: 1, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      outputTokens: 0, reasoningTokens: 0, cost: 0, estimatedCost: 0, estimatedShare: 0, unknownCostCalls: 0, freeCalls: 0 };
    component.purposeSummary.set({ enabled: true, totals: row, byPurpose: [], byProvider: [],
      biggestTurns: [{ at: Date.UTC(2026, 9, 20, 9, 30), instanceId: 'abcdef1234567890', kind: 'plan-queue', provider: 'codex',
        processedTokens: 310_000_000, helperTokens: 110_000_000, helperShare: 0.35, stopRequested: true, source: 'codex-round' }],
      codexCredits: { threads: 1, credits: 9, estimatedUsd: null, byKind: [{ kind: 'plan-queue', threads: 1, credits: 9 }] } });
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('Biggest turns this week');
    expect(text).toContain('310M');
    expect(text).toContain('Stopped by Harness');
    expect(text).toContain('Codex reports 9 credits used by 1 session');
  });

});


describe('Cost estimate focus hints', () => {
  it('adds estimate-description tab stops only to costs that include estimates', async () => {
    TestBed.resetTestingModule();
    TestBed.overrideComponent(CostPageComponent, {
      set: {
        imports: [CommonModule, CostChartStubComponent, AioTooltipDirective, CostHistoryRestoreComponent, UsageWhereWentCardComponent, BiggestTurnsComponent, ClaudeCostDriftComponent],
        template: readFileSync(resolve(specDirectory, 'cost-page.component.html'), 'utf8'),
        templateUrl: undefined,
        styles: [],
        styleUrl: undefined,
        styleUrls: [],
      },
    });
    await TestBed.configureTestingModule({
      imports: [CostPageComponent, RouterTestingModule],
      providers: [{ provide: CostIpcService, useValue: buildMockIpc() }, ...usageInsightProviders()],
      errorOnUnknownElements: true,
    }).compileComponents();
    const fixture = TestBed.createComponent(CostPageComponent);
    const component = fixture.componentInstance;
    component.summary.set(MOCK_SUMMARY);
    fixture.detectChanges();
    const estimateHosts = () => fixture.nativeElement.querySelectorAll('.metric-value[tabindex="0"], td.num-col.mono[tabindex="0"]');
    expect(estimateHosts()).toHaveLength(0);
    component.summary.set({
      ...MOCK_SUMMARY,
      hasEstimatedEntries: true,
      totalEstimatedCost: 0.002,
      byModel: { ...MOCK_SUMMARY.byModel, 'claude-3-5-sonnet-20241022': { ...MOCK_SUMMARY.byModel['claude-3-5-sonnet-20241022'], hasEstimated: true } },
      bySession: { ...MOCK_SUMMARY.bySession, 'sess-aaa': { ...MOCK_SUMMARY.bySession['sess-aaa'], hasEstimated: true } },
    });
    fixture.detectChanges();
    expect(estimateHosts()).toHaveLength(3);
  });
});
