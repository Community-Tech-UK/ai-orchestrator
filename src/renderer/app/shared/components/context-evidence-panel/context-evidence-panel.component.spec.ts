/**
 * Unit tests for ContextEvidencePanelComponent.
 *
 * Uses ɵresolveComponentResources (same approach as
 * browser-approval-request.component.spec.ts) to load the real
 * templateUrl/styleUrl before TestBed compiles the component, so assertions
 * exercise the actual rendered DOM.
 *
 * Covers the Task 17 truthfulness/state matrix: normal, unknown-occupancy,
 * degraded (corrupt/failed/deleted/staging), paused, bounded,
 * metadata-only, bounded-inspection pagination, and basic accessibility.
 */

import {
  signal,
  ɵresolveComponentResources as resolveComponentResources,
  type WritableSignal,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContextEvidenceCardResponse,
  ContextEvidenceRendererMetrics,
  ContextEvidenceScope,
  EvidenceRecord,
  EvidenceRetrievalResponse,
} from '@contracts/types/context-evidence';
import { ContextEvidenceStore } from '../../../core/state/context-evidence.store';
import { ContextEvidencePanelComponent } from './context-evidence-panel.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));

await resolveComponentResources((url) => {
  if (url.endsWith('context-evidence-panel.component.html')) {
    return Promise.resolve(
      readFileSync(resolve(specDirectory, './context-evidence-panel.component.html'), 'utf8'),
    );
  }
  if (url.endsWith('context-evidence-panel.component.scss')) {
    return Promise.resolve(
      readFileSync(resolve(specDirectory, './context-evidence-panel.component.scss'), 'utf8'),
    );
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

class FakeContextEvidenceStore {
  readonly setScope = vi.fn();
  readonly refresh = vi.fn(async () => { /* noop */ });
  readonly loadCard = vi.fn(async () => { /* noop */ });
  /**
   * Mirrors the real store: applies the next queued response to
   * `readResultState` synchronously before resolving, so a caller awaiting
   * `read()` observes the updated `readResult()` immediately — exactly like
   * the production store's IPC round trip.
   */
  readonly read = vi.fn(async () => {
    const next = this.readQueue.shift();
    if (next) this.readResultState.set(next);
  });

  private readonly readQueue: EvidenceRetrievalResponse[] = [];
  private readonly metricsState = signal<ContextEvidenceRendererMetrics | null>(null);
  private readonly recordsState = signal<EvidenceRecord[]>([]);
  private readonly selectedCardState = signal<ContextEvidenceCardResponse | null>(null);
  private readonly readResultState = signal<EvidenceRetrievalResponse | null>(null);
  private readonly loadingState = signal(false);
  private readonly errorState = signal<string | null>(null);

  readonly metrics = this.metricsState.asReadonly();
  readonly records = this.recordsState.asReadonly();
  readonly selectedCard = this.selectedCardState.asReadonly();
  readonly readResult = this.readResultState.asReadonly();
  readonly loading = this.loadingState.asReadonly();
  readonly error = this.errorState.asReadonly();

  workingSet(): ContextEvidenceRendererMetrics['workingSet'] | null {
    return this.metricsState()?.workingSet ?? null;
  }

  lastAction(): ContextEvidenceRendererMetrics['lastAction'] | null {
    return this.metricsState()?.lastAction ?? null;
  }

  setMetrics(metrics: ContextEvidenceRendererMetrics | null): void {
    this.metricsState.set(metrics);
  }

  setRecords(records: EvidenceRecord[]): void {
    this.recordsState.set(records);
  }

  setSelectedCard(card: ContextEvidenceCardResponse | null): void {
    this.selectedCardState.set(card);
  }

  setReadResult(result: EvidenceRetrievalResponse | null): void {
    this.readResultState.set(result);
  }

  queueReadResult(result: EvidenceRetrievalResponse): void {
    this.readQueue.push(result);
  }

  setLoading(value: boolean): void {
    this.loadingState.set(value);
  }

  setError(value: string | null): void {
    this.errorState.set(value);
  }
}

function baseMetrics(overrides: Partial<ContextEvidenceRendererMetrics> = {}): ContextEvidenceRendererMetrics {
  return {
    occupancy: { status: 'known', used: 60_000, total: 100_000 },
    cumulativeTokens: 400_000,
    workingSet: {
      capacityTokens: 100_000,
      instructionsTokens: 15_000,
      recentDialogueTokens: 15_000,
      evidenceCardTokens: 15_000,
      exactExcerptTokens: 15_000,
      reasoningAndAnswerTokens: 25_000,
      emergencyReserveTokens: 15_000,
      normalWorkingSetTokens: 60_000,
      totalAllocatedTokens: 100_000,
      estimateKind: 'provider-tokenizer',
    },
    evidenceRecordCount: 8,
    evidenceCardCount: 6,
    exactExcerptCount: 2,
    externallyStoredBytes: 900_532,
    modelRequestCount: 44,
    toolCallCount: 31,
    toolResultBytes: 900_000,
    enforcementMode: 'shadow',
    lastAction: 'native-compaction',
    recoveryCount: 2,
    updatedAt: 500,
    ...overrides,
  };
}

function baseRecord(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: 'evidence-1',
    conversationId: 'conversation-1',
    provider: 'claude',
    toolName: 'Bash',
    sourceKind: 'command',
    status: 'complete',
    byteCount: 12_000,
    mimeType: 'text/plain',
    sensitivity: 'normal',
    provenanceTrust: 'runtime-authenticated',
    createdAt: 1_000,
    captureMode: 'pre-retention',
    captureCompleteness: 'complete',
    ...overrides,
  };
}

function scope(): ContextEvidenceScope {
  return { conversationId: 'conversation-1', owner: { kind: 'chat', chatId: 'chat-1' } };
}

function setScopeInput(
  component: ContextEvidencePanelComponent,
  value: () => ContextEvidenceScope | null,
): void {
  (component as unknown as { scope: () => ContextEvidenceScope | null }).scope = value;
}

async function settle(fixture: ComponentFixture<ContextEvidencePanelComponent>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();
  }
}

describe('ContextEvidencePanelComponent', () => {
  let fixture: ComponentFixture<ContextEvidencePanelComponent>;
  let component: ContextEvidencePanelComponent;
  let store: FakeContextEvidenceStore;
  let scopeInput: WritableSignal<ContextEvidenceScope | null>;

  beforeEach(async () => {
    store = new FakeContextEvidenceStore();
    scopeInput = signal<ContextEvidenceScope | null>(scope());

    await TestBed.configureTestingModule({
      imports: [ContextEvidencePanelComponent],
      providers: [{ provide: ContextEvidenceStore, useValue: store }],
    }).compileComponents();

    fixture = TestBed.createComponent(ContextEvidencePanelComponent);
    component = fixture.componentInstance;
    setScopeInput(component, scopeInput);
  });

  it('pushes the scope into the store and refreshes on init', async () => {
    fixture.detectChanges();
    await settle(fixture);

    expect(store.setScope).toHaveBeenCalledWith(scope());
    expect(store.refresh).toHaveBeenCalled();
  });

  describe('normal state', () => {
    beforeEach(() => {
      store.setMetrics(baseMetrics());
      fixture.detectChanges();
    });

    it('shows occupancy and cumulative input as separate figures', () => {
      const text = fixture.nativeElement.textContent as string;
      const occupancyEl = fixture.nativeElement.querySelector('[data-testid="occupancy-known"]');
      const cumulativeEl = fixture.nativeElement.querySelector('[data-testid="cumulative-input"]');
      expect(occupancyEl?.textContent).toContain('60,000');
      expect(occupancyEl?.textContent).toContain('100,000');
      expect(cumulativeEl?.textContent).toContain('400,000');
      // Neither figure is derived from the other — both appear verbatim, no combined math.
      expect(text).not.toContain('460,000');
    });

    it('labels provider-tokenizer estimates as provider-observed', () => {
      const badge = fixture.nativeElement.querySelector('[data-testid="estimate-provider-observed"]');
      expect(badge?.textContent).toContain('provider-observed');
    });

    it('shows evidence, card, tool, and enforcement metrics from real fields only', () => {
      const text = fixture.nativeElement.textContent as string;
      expect(text).toContain('8'); // evidence records
      expect(text).toContain('6'); // evidence cards
      expect(text).toContain('44'); // model requests
      expect(text).toContain('31'); // tool calls
      expect(fixture.nativeElement.querySelector('[data-testid="enforcement-mode"]')?.textContent)
        .toContain('shadow');
      expect(text).toContain('native-compaction');
      expect(text).toContain('Recovery count: 2');
    });

    it('never combines evidence storage size with provider context occupancy', () => {
      const occupancyEl = fixture.nativeElement.querySelector('[data-testid="occupancy-known"]');
      expect(occupancyEl?.textContent).not.toContain('900,532');
    });
  });

  it('shows an explicit unknown-occupancy state with its reason, never a fabricated percentage', () => {
    store.setMetrics(baseMetrics({
      occupancy: { status: 'unknown', reason: 'Provider does not report occupancy' },
    }));
    fixture.detectChanges();

    const el = fixture.nativeElement.querySelector('[data-testid="occupancy-unknown"]');
    expect(el?.textContent).toContain('Occupancy unknown');
    expect(el?.textContent).toContain('Provider does not report occupancy');
    expect(el?.textContent).not.toMatch(/%/);
  });

  it('shows "not reported" for cumulative input rather than a guessed value when absent', () => {
    const metrics = baseMetrics();
    delete (metrics as { cumulativeTokens?: number }).cumulativeTokens;
    store.setMetrics(metrics);
    fixture.detectChanges();

    const el = fixture.nativeElement.querySelector('[data-testid="cumulative-input"]');
    expect(el?.textContent).toContain('not reported');
  });

  it('labels the conservative-fallback estimate as AIO-estimated', () => {
    const metrics = baseMetrics();
    metrics.workingSet = { ...metrics.workingSet, estimateKind: 'conservative-fallback' };
    store.setMetrics(metrics);
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector('[data-testid="estimate-AIO-estimated"]');
    expect(badge?.textContent).toContain('AIO-estimated');
  });

  it('shows a paused badge only when lastAction is pause', () => {
    store.setMetrics(baseMetrics({ lastAction: 'pause' }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="paused-badge"]')).toBeTruthy();

    store.setMetrics(baseMetrics({ lastAction: 'controlled-recovery' }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="paused-badge"]')).toBeFalsy();
  });

  it('shows "None recorded" rather than a guessed action when lastAction is absent', () => {
    const metrics = baseMetrics();
    delete (metrics as { lastAction?: unknown }).lastAction;
    store.setMetrics(metrics);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Last action: None recorded');
  });

  describe('degraded evidence records', () => {
    it('visibly labels a corrupt record and disables inspection, never presenting it as complete', () => {
      store.setRecords([baseRecord({ id: 'ev-corrupt', status: 'corrupt' })]);
      fixture.detectChanges();

      const statusBadge = fixture.nativeElement.querySelector('[data-testid="status-ev-corrupt"]');
      expect(statusBadge?.textContent).toContain('Corrupt');
      expect(statusBadge?.classList.contains('degraded')).toBe(true);
      const disclosure = fixture.nativeElement.querySelector('[data-testid="disclosure-ev-corrupt"]');
      expect(disclosure?.textContent).toMatch(/corrupt/i);

      const inspectButton = fixture.nativeElement.querySelector(
        '[aria-label="Inspect evidence ev-corrupt"]',
      ) as HTMLButtonElement;
      expect(inspectButton.disabled).toBe(true);
    });

    it('visibly labels a failed record and disables inspection', () => {
      store.setRecords([baseRecord({ id: 'ev-failed', status: 'failed' })]);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="status-ev-failed"]')?.textContent)
        .toContain('Failed');
      const inspectButton = fixture.nativeElement.querySelector(
        '[aria-label="Inspect evidence ev-failed"]',
      ) as HTMLButtonElement;
      expect(inspectButton.disabled).toBe(true);
    });

    it('visibly labels a deleted record and discloses it is no longer available', () => {
      store.setRecords([baseRecord({ id: 'ev-deleted', status: 'deleted' })]);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="status-ev-deleted"]')?.textContent)
        .toContain('Deleted');
      expect(fixture.nativeElement.querySelector('[data-testid="disclosure-ev-deleted"]')?.textContent)
        .toMatch(/no longer available/i);
    });

    it('visibly labels a staging (in-progress) record', () => {
      store.setRecords([baseRecord({ id: 'ev-staging', status: 'staging' })]);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="status-ev-staging"]')?.textContent)
        .toContain('Staging');
    });
  });

  describe('capture completeness', () => {
    it('labels a bounded record as a partial capture, not complete', () => {
      store.setRecords([baseRecord({ id: 'ev-bounded', captureCompleteness: 'bounded' })]);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="completeness-ev-bounded"]')?.textContent)
        .toContain('Bounded capture (partial)');
    });

    it('labels a metadata-only record as having no captured content', () => {
      store.setRecords([baseRecord({ id: 'ev-metadata', captureCompleteness: 'metadata-only' })]);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="completeness-ev-metadata"]')?.textContent)
        .toContain('Metadata only');
    });
  });

  describe('card inspection', () => {
    it('opens a card via store.loadCard and renders its findings/citations', () => {
      store.setRecords([baseRecord({ id: 'ev-1' })]);
      fixture.detectChanges();

      const button = fixture.nativeElement.querySelector(
        '[aria-label="Open card for evidence ev-1"]',
      ) as HTMLButtonElement;
      button.click();

      expect(store.loadCard).toHaveBeenCalledWith('ev-1', 1_000);

      store.setSelectedCard({
        card: {
          id: 'card-1',
          evidenceId: 'ev-1',
          version: 1,
          status: 'validated',
          summary: 'Ran the test suite and it passed.',
          findings: [],
          citations: [{ evidenceId: 'ev-1', startByte: 0, endByte: 100, contentDigest: 'abc' }],
          contradictions: [],
          derivedBy: { kind: 'deterministic', version: '1' },
          createdAt: 1,
        },
        sensitivity: 'normal',
        provenanceTrust: 'runtime-authenticated',
        captureCompleteness: 'complete',
        tokenCount: 10,
        tokenLimit: 1_000,
        truncated: false,
      });
      fixture.detectChanges();

      const cardEl = fixture.nativeElement.querySelector('[data-testid="card-ev-1"]');
      expect(cardEl?.textContent).toContain('Ran the test suite and it passed.');
      expect(cardEl?.textContent).toContain('Bytes 0–100');
    });
  });

  describe('bounded inspection pagination', () => {
    it('advances startByte by the previously returned range on every page, never requesting the whole record at once', async () => {
      const record = baseRecord({ id: 'ev-1', byteCount: 10_000 });
      store.setRecords([record]);
      fixture.detectChanges();

      store.queueReadResult({
        evidenceId: 'ev-1',
        startByte: 0,
        endByte: 4_000,
        content: 'chunk one',
        tokenCount: 100,
        tokenLimit: 2_000,
        truncated: false,
        citation: { evidenceId: 'ev-1', startByte: 0, endByte: 4_000, contentDigest: 'd1' },
        captureCompleteness: 'complete',
      });
      const inspectButton = fixture.nativeElement.querySelector(
        '[aria-label="Inspect evidence ev-1"]',
      ) as HTMLButtonElement;
      inspectButton.click();
      await settle(fixture);

      expect(store.read).toHaveBeenNthCalledWith(1, 'ev-1', 0, 4_000, 2_000);

      const inspectionEl = fixture.nativeElement.querySelector('[data-testid="inspection-ev-1"]');
      expect(inspectionEl?.textContent).toContain('Bytes 0–4000');
      expect(inspectionEl?.textContent).toContain('chunk one');

      store.queueReadResult({
        evidenceId: 'ev-1',
        startByte: 4_000,
        endByte: 8_000,
        content: 'chunk two',
        tokenCount: 100,
        tokenLimit: 2_000,
        truncated: false,
        citation: { evidenceId: 'ev-1', startByte: 4_000, endByte: 8_000, contentDigest: 'd2' },
        captureCompleteness: 'complete',
      });
      const nextButton = fixture.nativeElement.querySelector(
        '[data-testid="inspection-ev-1"] button',
      ) as HTMLButtonElement;
      expect(nextButton.textContent).toContain('Load next chunk');
      nextButton.click();
      await settle(fixture);

      expect(store.read).toHaveBeenNthCalledWith(2, 'ev-1', 4_000, 8_000, 2_000);
      expect(fixture.nativeElement.querySelector('[data-testid="inspection-ev-1"]')?.textContent)
        .toContain('chunk two');
    });

    it('stops offering another page once the returned range reaches the record end', async () => {
      const record = baseRecord({ id: 'ev-1', byteCount: 2_000 });
      store.setRecords([record]);
      fixture.detectChanges();

      store.queueReadResult({
        evidenceId: 'ev-1',
        startByte: 0,
        endByte: 2_000,
        content: 'whole bounded record',
        tokenCount: 50,
        tokenLimit: 2_000,
        truncated: false,
        citation: { evidenceId: 'ev-1', startByte: 0, endByte: 2_000, contentDigest: 'd1' },
        captureCompleteness: 'bounded',
      });
      const inspectButton = fixture.nativeElement.querySelector(
        '[aria-label="Inspect evidence ev-1"]',
      ) as HTMLButtonElement;
      inspectButton.click();
      await settle(fixture);

      expect(store.read).toHaveBeenCalledWith('ev-1', 0, 2_000, 2_000);

      const inspectionEl = fixture.nativeElement.querySelector('[data-testid="inspection-ev-1"]');
      const buttons = Array.from(inspectionEl?.querySelectorAll('button') ?? []) as HTMLButtonElement[];
      expect(buttons.some((b) => b.textContent?.includes('Load next chunk'))).toBe(false);
      expect(buttons.some((b) => b.textContent?.includes('Close'))).toBe(true);
    });
  });

  describe('accessibility', () => {
    it('marks the error banner and loading state with live-region roles', () => {
      store.setError('Inspection unavailable');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent)
        .toContain('Inspection unavailable');

      store.setError(null);
      store.setLoading(true);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[role="status"]')?.textContent)
        .toContain('Loading');
    });

    it('gives every record action button a descriptive, evidence-specific aria-label', () => {
      store.setRecords([baseRecord({ id: 'ev-a11y' })]);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[aria-label="Open card for evidence ev-a11y"]'))
        .toBeTruthy();
      expect(fixture.nativeElement.querySelector('[aria-label="Inspect evidence ev-a11y"]'))
        .toBeTruthy();
    });
  });
});
