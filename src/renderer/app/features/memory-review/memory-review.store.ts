import { Injectable, computed, inject, signal } from '@angular/core';
import { GovernedProposalIpcService } from '../../core/services/ipc/governed-proposal-ipc.service';
import { LearningScanIpcService } from '../../core/services/ipc/learning-scan-ipc.service';
import type {
  GovernedProposal,
  LearningScanCheckpoint,
  LearningScanResultSummary,
  ProposalAuditEntry,
} from './memory-review.types';

/**
 * Signal store for the Memory review inbox: pending governed proposals
 * (agent-derived lessons awaiting a human decision) plus decided history.
 * Writes (approve/reject) go through James-driven UI only — never an agent.
 */
@Injectable({ providedIn: 'root' })
export class MemoryReviewStore {
  private readonly ipc = inject(GovernedProposalIpcService);
  private readonly scanIpc = inject(LearningScanIpcService);

  private readonly _proposals = signal<GovernedProposal[]>([]);
  private readonly _loading = signal(false);
  private readonly _busy = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _selectedId = signal<string | null>(null);
  private readonly _selectedAudit = signal<ProposalAuditEntry[]>([]);
  private readonly _showDecided = signal(false);
  private readonly _scanning = signal(false);
  private readonly _lastScanResult = signal<LearningScanResultSummary | null>(null);
  private readonly _scanStatus = signal<LearningScanCheckpoint | null>(null);

  readonly proposals = this._proposals.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly busy = this._busy.asReadonly();
  readonly error = this._error.asReadonly();
  readonly selectedId = this._selectedId.asReadonly();
  readonly selectedAudit = this._selectedAudit.asReadonly();
  readonly showDecided = this._showDecided.asReadonly();
  readonly scanning = this._scanning.asReadonly();
  readonly lastScanResult = this._lastScanResult.asReadonly();
  readonly scanStatus = this._scanStatus.asReadonly();

  readonly pending = computed(() => this._proposals().filter((p) => p.status === 'pending'));
  readonly decided = computed(() =>
    this._proposals()
      .filter((p) => p.status !== 'pending')
      .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0)),
  );
  readonly pendingCount = computed(() => this.pending().length);
  readonly selected = computed(() => {
    const id = this._selectedId();
    return id ? this._proposals().find((p) => p.id === id) ?? null : null;
  });

  async refresh(): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await this.ipc.list({ limit: 500 });
      if (!response.success) {
        this._error.set(response.error?.message ?? 'Failed to load memory review proposals.');
        return;
      }
      this._proposals.set(response.data ?? []);
    } finally {
      this._loading.set(false);
    }
  }

  toggleShowDecided(): void {
    this._showDecided.update((v) => !v);
  }

  /** Load the last-run scan status/counters (does not trigger a new scan). */
  async refreshScanStatus(workspaceId?: string): Promise<void> {
    const response = await this.scanIpc.getStatus(workspaceId);
    if (response.success) this._scanStatus.set(response.data ?? null);
  }

  /**
   * WS-B8: manually trigger a fail->fix correction scan. Nothing it produces
   * auto-promotes — new/reinforced proposals land as `pending` rows and this
   * only refreshes the list so they appear alongside memory proposals.
   */
  async runScan(workspaceId?: string): Promise<void> {
    this._scanning.set(true);
    this._error.set(null);
    try {
      const response = await this.scanIpc.run({ workspaceId });
      if (!response.success) {
        this._error.set(response.error?.message ?? 'Correction scan failed.');
        return;
      }
      this._lastScanResult.set(response.data ?? null);
      await this.refreshScanStatus(workspaceId);
      await this.refresh(); // refresh() resets _error, so an in-band scan error is applied after
      if (response.data?.error) {
        this._error.set(response.data.error);
      }
    } finally {
      this._scanning.set(false);
    }
  }

  async select(id: string | null): Promise<void> {
    this._selectedId.set(id);
    this._selectedAudit.set([]);
    if (!id) return;
    const response = await this.ipc.get(id);
    if (response.success && response.data) {
      this._selectedAudit.set(response.data.audit);
    }
  }

  /** Approve a proposal as-is, promoting the linked lesson's provenance to user-approved. */
  async approve(id: string, actor: string, rationale?: string): Promise<boolean> {
    return this.decide(() => this.ipc.approve({ id, actor, rationale }));
  }

  /** Approve with edited text: supersedes the original agent-derived lesson with a new user-authored one. */
  async approveEdited(id: string, editedText: string, actor: string, rationale?: string): Promise<boolean> {
    return this.decide(() => this.ipc.approve({ id, editedText, actor, rationale }));
  }

  async reject(id: string, actor: string, rationale?: string): Promise<boolean> {
    return this.decide(() => this.ipc.reject({ id, actor, rationale }));
  }

  clearError(): void {
    this._error.set(null);
  }

  private async decide(fn: () => ReturnType<GovernedProposalIpcService['approve']>): Promise<boolean> {
    this._busy.set(true);
    this._error.set(null);
    try {
      const response = await fn();
      if (!response.success) {
        this._error.set(response.error?.message ?? 'Failed to record decision.');
        return false;
      }
      if (response.data) this.upsert(response.data);
      if (this._selectedId() === response.data?.id) {
        await this.select(response.data.id);
      }
      return true;
    } finally {
      this._busy.set(false);
    }
  }

  private upsert(proposal: GovernedProposal): void {
    this._proposals.update((items) => {
      const index = items.findIndex((p) => p.id === proposal.id);
      if (index === -1) return [proposal, ...items];
      const next = [...items];
      next[index] = proposal;
      return next;
    });
  }
}
