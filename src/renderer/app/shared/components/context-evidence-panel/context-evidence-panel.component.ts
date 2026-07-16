/**
 * Context Evidence Panel — truthful renderer surface for the context-evidence
 * subsystem (see docs/superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan.md,
 * Task 17).
 *
 * Hard truthfulness rules enforced here (do not relax without re-reading the
 * plan's Task 17 checklist):
 * - Context occupancy and cumulative input are always rendered as separate
 *   figures; neither is ever derived from the other.
 * - `ContextOccupancy.status === 'unknown'` renders an explicit unknown state
 *   with its reason — never a fabricated percentage.
 * - Every number shown comes directly from `ContextEvidenceRendererMetrics` /
 *   `EvidenceRecord` / `EvidenceRetrievalResponse` / `ContextEvidenceCardResponse`.
 *   Nothing is guessed; absent fields render an explicit "not reported" state.
 * - Evidence storage size (`externallyStoredBytes`) is never combined with
 *   provider context occupancy in a single figure.
 * - "Full inspection" of raw evidence is always paginated bounded chunks —
 *   never one unbounded request — and degraded evidence statuses (corrupt,
 *   failed, deleted, staging) are always visibly labeled, never presented as
 *   complete.
 */

import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import type {
  ContextEvidenceScope,
  EvidenceCaptureCompleteness,
  EvidenceProvenanceTrust,
  EvidenceRecord,
  EvidenceSensitivity,
  EvidenceStatus,
  WorkingSetAllocation,
} from '@contracts/types/context-evidence';
import { ContextEvidenceStore } from '../../../core/state/context-evidence.store';

/** Bounded chunk size (UTF-8 bytes) requested per raw-evidence inspection page. Never unbounded. */
export const INSPECTION_CHUNK_BYTES = 4_000;
/** Token budget per bounded inspection chunk. */
export const INSPECTION_TOKEN_LIMIT = 2_000;
/** Token budget for a card retrieval request. */
export const CARD_TOKEN_LIMIT = 1_000;

export interface WorkingSetSection {
  label: string;
  tokens: number;
}

/** Pure helpers — exported so they can be unit tested directly without TestBed. */

export function workingSetSections(workingSet: WorkingSetAllocation | null): WorkingSetSection[] {
  if (!workingSet) return [];
  return [
    { label: 'Instructions', tokens: workingSet.instructionsTokens },
    { label: 'Recent dialogue', tokens: workingSet.recentDialogueTokens },
    { label: 'Evidence cards', tokens: workingSet.evidenceCardTokens },
    { label: 'Exact excerpts', tokens: workingSet.exactExcerptTokens },
    { label: 'Reasoning & answer', tokens: workingSet.reasoningAndAnswerTokens },
    { label: 'Emergency reserve', tokens: workingSet.emergencyReserveTokens },
  ];
}

export function estimateProvenanceLabel(
  kind: WorkingSetAllocation['estimateKind'] | undefined,
): string | null {
  if (kind === 'provider-tokenizer') return 'provider-observed';
  if (kind === 'conservative-fallback') return 'AIO-estimated';
  return null;
}

export function statusLabel(status: EvidenceStatus): string {
  switch (status) {
    case 'complete': return 'Complete';
    case 'staging': return 'Staging (capturing)';
    case 'failed': return 'Failed';
    case 'corrupt': return 'Corrupt';
    case 'deleted': return 'Deleted';
  }
}

/** Non-null only for degraded statuses that must never be presented as complete evidence. */
export function statusDisclosure(status: EvidenceStatus): string | null {
  switch (status) {
    case 'staging':
      return 'Still capturing — not yet available for inspection.';
    case 'failed':
      return 'Capture failed — no readable content is available.';
    case 'corrupt':
      return 'Evidence is corrupt — raw bytes cannot be trusted.';
    case 'deleted':
      return 'Evidence has been deleted — content is no longer available.';
    case 'complete':
      return null;
  }
}

export function isDegradedStatus(status: EvidenceStatus): boolean {
  return status === 'corrupt' || status === 'failed' || status === 'deleted' || status === 'staging';
}

export function captureCompletenessLabel(value: EvidenceCaptureCompleteness): string {
  switch (value) {
    case 'complete': return 'Complete capture';
    case 'bounded': return 'Bounded capture (partial)';
    case 'metadata-only': return 'Metadata only — no content captured';
  }
}

export function sensitivityLabel(value: EvidenceSensitivity): string {
  switch (value) {
    case 'normal': return 'Normal';
    case 'sensitive': return 'Sensitive';
    case 'restricted': return 'Restricted';
  }
}

export function provenanceTrustLabel(value: EvidenceProvenanceTrust): string {
  return value === 'runtime-authenticated' ? 'Runtime-authenticated' : 'Legacy (unverified)';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

@Component({
  selector: 'app-context-evidence-panel',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './context-evidence-panel.component.html',
  styleUrl: './context-evidence-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContextEvidencePanelComponent {
  readonly scope = input<ContextEvidenceScope | null>(null);

  readonly store = inject(ContextEvidenceStore);

  private readonly inspectingIdState = signal<string | null>(null);
  private readonly nextRangeStartState = signal(0);
  readonly inspectingId = this.inspectingIdState.asReadonly();

  private readonly syncScope = effect(() => {
    const scope = this.scope();
    this.store.setScope(scope);
    if (scope) void this.store.refresh();
  });

  readonly workingSetRows = computed(() => workingSetSections(this.store.workingSet()));
  readonly estimateProvenance = computed(() =>
    estimateProvenanceLabel(this.store.workingSet()?.estimateKind),
  );
  readonly isPaused = computed(() => this.store.lastAction() === 'pause');

  getStatusLabel(status: EvidenceStatus): string {
    return statusLabel(status);
  }

  getStatusDisclosure(status: EvidenceStatus): string | null {
    return statusDisclosure(status);
  }

  getIsDegradedStatus(status: EvidenceStatus): boolean {
    return isDegradedStatus(status);
  }

  getCaptureCompletenessLabel(value: EvidenceCaptureCompleteness): string {
    return captureCompletenessLabel(value);
  }

  getSensitivityLabel(value: EvidenceSensitivity): string {
    return sensitivityLabel(value);
  }

  getProvenanceTrustLabel(value: EvidenceProvenanceTrust): string {
    return provenanceTrustLabel(value);
  }

  getFormattedBytes(bytes: number): string {
    return formatBytes(bytes);
  }

  canInspect(record: EvidenceRecord): boolean {
    return record.status === 'complete';
  }

  hasMoreChunks(record: EvidenceRecord): boolean {
    return this.inspectingIdState() === record.id && this.nextRangeStartState() < record.byteCount;
  }

  async openCard(record: EvidenceRecord): Promise<void> {
    await this.store.loadCard(record.id, CARD_TOKEN_LIMIT);
  }

  async startInspection(record: EvidenceRecord): Promise<void> {
    this.inspectingIdState.set(record.id);
    this.nextRangeStartState.set(0);
    await this.readNextChunk(record);
  }

  async readNextChunk(record: EvidenceRecord): Promise<void> {
    const start = this.nextRangeStartState();
    const end = Math.min(start + INSPECTION_CHUNK_BYTES, record.byteCount);
    await this.store.read(record.id, start, end, INSPECTION_TOKEN_LIMIT);
    const result = this.store.readResult();
    if (result && result.evidenceId === record.id) {
      this.nextRangeStartState.set(result.endByte);
    }
  }

  closeInspection(): void {
    this.inspectingIdState.set(null);
    this.nextRangeStartState.set(0);
  }
}
