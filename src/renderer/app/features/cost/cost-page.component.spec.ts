/**
 * Spec: CostPageComponent — computed signal logic
 *
 * Tests that derived signals (totalCost, totalTokens, modelRows,
 * sessionRows, avgCostPerSession, formatTokens) produce correct values
 * from mocked IPC data, without spinning up the full Angular app.
 */

import { TestBed } from '@angular/core/testing';
import {
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { RouterTestingModule } from '@angular/router/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CostPageComponent, type CostSummaryData, type CostEntry } from './cost-page.component';
import { CostIpcService } from '../../core/services/ipc/cost-ipc.service';

await resolveComponentResources((url) => {
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

    const fixture = TestBed.createComponent(CostPageComponent);
    component = fixture.componentInstance;
  });

  // ── Total cost ──────────────────────────────────────────────────────────

  it('totalCost reflects summary.totalCost', () => {
    component.summary.set(MOCK_SUMMARY);
    expect(component.totalCost()).toBeCloseTo(0.012345, 6);
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
  });

  it('refreshAll populates entries signal', async () => {
    await component.refreshAll(false);
    expect(component.entries()).toHaveLength(MOCK_ENTRIES.length);
  });

  it('refreshAll populates summary signal', async () => {
    await component.refreshAll(false);
    expect(component.totalCost()).toBeCloseTo(MOCK_SUMMARY.totalCost, 6);
  });
});
