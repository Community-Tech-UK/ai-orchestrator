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
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { RouterTestingModule } from '@angular/router/testing';
import { CommonModule } from '@angular/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CostPageComponent, type CostSummaryData, type CostEntry } from './cost-page.component';
import { CostIpcService } from '../../core/services/ipc/cost-ipc.service';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import type { EChartsOption } from 'echarts';

@Component({ selector: 'app-echarts-themed', template: '' })
class CostChartStubComponent {
  readonly options = input<EChartsOption | null>(null);
  readonly loading = input(false);
  readonly height = input('300px');
  readonly emptyMessage = input('No data available');
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
    costGetPurposeSummary: vi.fn().mockResolvedValue({success:true,data:null}),
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

    await TestBed.configureTestingModule({
      imports: [CostPageComponent, RouterTestingModule],
      providers: [
        { provide: CostIpcService, useValue: mockIpc },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CostPageComponent);
    component = fixture.componentInstance;
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
    expect(mockIpc.costGetPurposeSummary).toHaveBeenCalledWith({startTime:expect.any(Number),endTime:expect.any(Number)});
  });

  it('refreshAll populates entries signal', async () => {
    await component.refreshAll(false);
    expect(component.entries()).toHaveLength(MOCK_ENTRIES.length);
  });

  it('refreshAll populates summary signal', async () => {
    await component.refreshAll(false);
    expect(component.totalCost()).toBeCloseTo(MOCK_SUMMARY.totalCost, 6);
  });
  it('renders separate cache cards and switches the purpose table to providers', async()=>{
    await component.refreshAll(false);
    const row={key:'helper',calls:2,inputTokens:10,cacheReadTokens:20,cacheWriteTokens:30,outputTokens:40,
      reasoningTokens:0,cost:0.1,estimatedCost:0.1,estimatedShare:1,unknownCostCalls:0,freeCalls:1};
    component.purposeSummary.set({enabled:true,totals:row,byPurpose:[{...row,key:'helper'}],byProvider:[{...row,key:'ollama'}]});
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Cache read');
    expect(fixture.nativeElement.textContent).toContain('Cache write');
    expect(fixture.nativeElement.querySelector('[aria-label="Spend by purpose"]').textContent).toContain('helper');
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

});


describe('Cost estimate focus hints', () => {
  it('adds estimate-description tab stops only to costs that include estimates', async () => {
    TestBed.resetTestingModule();
    TestBed.overrideComponent(CostPageComponent, {
      set: {
        imports: [CommonModule, CostChartStubComponent, AioTooltipDirective],
        template: readFileSync(resolve(specDirectory, 'cost-page.component.html'), 'utf8'),
        templateUrl: undefined,
        styles: [],
        styleUrl: undefined,
        styleUrls: [],
      },
    });
    await TestBed.configureTestingModule({
      imports: [CostPageComponent, RouterTestingModule],
      providers: [{ provide: CostIpcService, useValue: buildMockIpc() }],
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
