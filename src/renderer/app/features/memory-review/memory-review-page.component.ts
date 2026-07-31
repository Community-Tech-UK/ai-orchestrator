import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { MemoryReviewStore } from './memory-review.store';
import {
  decodeMemoryProposalText,
  decodeRuleProposalPayload,
  type GovernedProposal,
  type RuleProposalPayload,
} from './memory-review.types';

/** Static placeholder actor until an operator-identity setting exists. */
const DEFAULT_ACTOR = 'james';

@Component({
  selector: 'app-memory-review-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-header">
        <div class="header-title">
          <span class="title">Memory review</span>
          <span class="subtitle">Approve, edit, or reject lessons the agent captured on its own.</span>
        </div>
        <div class="actions">
          <button type="button" class="btn" [disabled]="store.loading()" (click)="refresh()">
            {{ store.loading() ? 'Refreshing…' : 'Refresh' }}
          </button>
          <button
            type="button"
            class="btn"
            [disabled]="store.scanning()"
            title="Manually scan settled sessions for repeated command corrections. Nothing auto-promotes — results appear below as reviewable proposals."
            (click)="runScan()"
          >
            {{ store.scanning() ? 'Scanning…' : 'Scan for corrections' }}
          </button>
          <button type="button" class="btn" (click)="store.toggleShowDecided()">
            {{ store.showDecided() ? 'Hide decided' : 'Show decided history' }}
          </button>
        </div>
      </header>

      @if (store.lastScanResult(); as scan) {
        <p class="scan-line">
          Last scan: {{ scan.sessionsScanned }} session{{ scan.sessionsScanned === 1 ? '' : 's' }} scanned,
          {{ scan.patternsFound }} pattern{{ scan.patternsFound === 1 ? '' : 's' }} found
          ({{ scan.proposalsCreated }} new, {{ scan.proposalsReinforced }} reinforced)
          @if (scan.error) {
            <span class="scan-error">— {{ scan.error }}</span>
          }
        </p>
      } @else if (store.scanStatus(); as status) {
        <p class="scan-line">
          Last scan: {{ formatAge(status.lastScanCompletedAt ?? status.updatedAt) }},
          {{ status.sessionsScannedTotal }} session{{ status.sessionsScannedTotal === 1 ? '' : 's' }} scanned in total.
        </p>
      }

      @if (store.error(); as err) {
        <div class="banner error" role="alert">
          {{ err }}
          <button type="button" (click)="store.clearError()">Dismiss</button>
        </div>
      }

      @if (store.pendingCount() === 0 && !store.loading()) {
        <p class="empty">No memory proposals waiting for review.</p>
      }

      <ul class="proposal-list" aria-label="Pending memory proposals">
        @for (proposal of store.pending(); track proposal.id) {
          <li class="proposal-card">
            <div class="proposal-main">
              <div class="proposal-head">
                <span class="badge provenance">{{ proposal.provenance }}</span>
                @if (proposal.kind === 'rule') {
                  <span class="badge rule-kind">Rule</span>
                }
                @if (proposal.reinforcements > 1) {
                  <span class="badge reinforced">Reinforced ×{{ proposal.reinforcements }}</span>
                }
                <span class="age">{{ formatAge(proposal.createdAt) }}</span>
              </div>

              @if (proposal.kind === 'rule' && ruleFor(proposal); as rule) {
                <p class="proposal-text rule-text">
                  When <code>{{ rule.pattern }}</code> fails with <strong>{{ rule.errorClass }}</strong>,
                  use <code>{{ rule.correction }}</code> instead.
                </p>
                <div class="proposal-meta">
                  <span>Seen {{ rule.occurrences }}× this scan · {{ formatConfidence(rule.confidence) }}% confidence</span>
                  @if (rule.evidence.length > 0) {
                    <button type="button" class="link-btn" (click)="toggleEvidence(proposal.id)">
                      {{ expandedEvidenceId() === proposal.id ? 'Hide examples' : 'Show ' + rule.evidence.length + ' example(s)' }}
                    </button>
                  }
                </div>
                @if (expandedEvidenceId() === proposal.id) {
                  <ul class="evidence-list">
                    @for (item of rule.evidence; track $index) {
                      <li class="evidence-item">
                        <span class="evidence-session">Session <code>{{ item.sessionId }}</code></span>
                        <div class="evidence-pair">
                          <code class="fail">{{ item.exampleFail }}</code>
                          <span class="arrow">→</span>
                          <code class="fix">{{ item.exampleFix }}</code>
                        </div>
                      </li>
                    }
                  </ul>
                }
              } @else {
                <p class="proposal-text">{{ textFor(proposal) }}</p>
                <div class="proposal-meta">
                  @if (proposal.sourceSessionId) {
                    <span class="source">Source session: <code>{{ proposal.sourceSessionId }}</code></span>
                  }
                </div>
              }
            </div>

            @if (editingId() === proposal.id) {
              <div class="edit-panel">
                <label class="field">
                  <span class="label">Edited text</span>
                  <textarea
                    class="textarea"
                    [value]="editText()"
                    (input)="onEditInput($event)"
                    aria-label="Edited lesson text"
                  ></textarea>
                </label>
                <div class="button-row">
                  <button
                    type="button"
                    class="btn primary"
                    [disabled]="store.busy() || editText().trim().length === 0"
                    (click)="confirmEditApprove(proposal)"
                  >
                    Save &amp; approve
                  </button>
                  <button type="button" class="btn" [disabled]="store.busy()" (click)="cancelEdit()">
                    Cancel
                  </button>
                </div>
              </div>
            } @else {
              <div class="button-row">
                <button
                  type="button"
                  class="btn primary"
                  [disabled]="store.busy()"
                  [attr.aria-label]="'Approve proposal: ' + textFor(proposal)"
                  (click)="approve(proposal)"
                >
                  Approve
                </button>
                <button
                  type="button"
                  class="btn"
                  [disabled]="store.busy()"
                  [attr.aria-label]="'Edit then approve proposal: ' + textFor(proposal)"
                  (click)="startEdit(proposal)"
                >
                  Edit then approve
                </button>
                <button
                  type="button"
                  class="btn danger"
                  [disabled]="store.busy()"
                  [attr.aria-label]="'Reject proposal: ' + textFor(proposal)"
                  (click)="reject(proposal)"
                >
                  Reject
                </button>
              </div>
            }
          </li>
        }
      </ul>

      @if (store.showDecided()) {
        <section class="decided-section">
          <h3>Decided history</h3>
          @if (store.decided().length === 0) {
            <p class="empty">No decisions recorded yet.</p>
          }
          <ul class="proposal-list decided">
            @for (proposal of store.decided(); track proposal.id) {
              <li class="proposal-card decided-card">
                <div class="proposal-head">
                  <span class="badge" [class]="statusClass(proposal.status)">{{ proposal.status }}</span>
                  @if (proposal.decidedBy) {
                    <span class="age">by {{ proposal.decidedBy }}</span>
                  }
                  @if (proposal.decidedAt) {
                    <span class="age">{{ formatAge(proposal.decidedAt) }}</span>
                  }
                </div>
                <p class="proposal-text">{{ textFor(proposal) }}</p>
                @if (proposal.decisionRationale) {
                  <p class="rationale">"{{ proposal.decisionRationale }}"</p>
                }
              </li>
            }
          </ul>
        </section>
      }
    </div>
  `,
  styles: [`
    :host { display: flex; width: 100%; height: 100%; }
    .page {
      display: flex; flex-direction: column; width: 100%; height: 100%;
      gap: var(--spacing-md); padding: var(--spacing-lg); overflow: auto;
      background: var(--bg-primary); color: var(--text-primary);
    }
    .page-header { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); }
    .header-title { display: flex; flex-direction: column; }
    .title { font-size: 18px; font-weight: 700; }
    .subtitle { font-size: 12px; color: var(--text-muted); }
    .actions { display: flex; gap: var(--spacing-sm); }
    .btn {
      padding: var(--spacing-xs) var(--spacing-md); border-radius: var(--radius-sm);
      border: 1px solid var(--border-color); background: var(--bg-tertiary);
      color: var(--text-primary); cursor: pointer; font-size: 12px;
    }
    .btn.primary { background: var(--primary-color); border-color: var(--primary-color); color: #fff; }
    .btn.danger { border-color: var(--error-color); color: var(--error-color); }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .banner {
      padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--radius-sm);
      display: flex; justify-content: space-between; align-items: center; gap: var(--spacing-sm);
    }
    .banner.error {
      border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color); font-size: 12px;
    }
    .empty { font-size: 12px; color: var(--text-muted); }
    .proposal-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing-sm); }
    .proposal-card {
      border: 1px solid var(--border-color); border-radius: var(--radius-md);
      background: var(--bg-secondary); padding: var(--spacing-md);
      display: flex; flex-direction: column; gap: var(--spacing-sm);
    }
    .proposal-head { display: flex; align-items: center; gap: var(--spacing-sm); flex-wrap: wrap; }
    .badge {
      font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
      background: var(--bg-tertiary); color: var(--text-muted);
    }
    .badge.provenance { color: var(--text-primary); }
    .badge.reinforced { color: var(--primary-color); }
    .badge.approved { color: var(--pill-ok-fg, #2e7d32); background: var(--pill-ok-bg, transparent); }
    .badge.rejected { color: var(--pill-error-fg, #c62828); background: var(--pill-error-bg, transparent); }
    .badge.superseded { color: var(--pill-warn-fg, #ef6c00); background: var(--pill-warn-bg, transparent); }
    .age { font-size: 11px; color: var(--text-muted); }
    .proposal-text { margin: 0; font-size: 13px; line-height: 1.5; }
    .proposal-meta { font-size: 11px; color: var(--text-muted); }
    .rationale { margin: 0; font-size: 12px; color: var(--text-muted); font-style: italic; }
    .button-row { display: flex; gap: var(--spacing-sm); flex-wrap: wrap; }
    .edit-panel { display: flex; flex-direction: column; gap: var(--spacing-sm); }
    .field { display: flex; flex-direction: column; gap: var(--spacing-xs); }
    .label { font-size: 12px; color: var(--text-muted); }
    .textarea {
      width: 100%; min-height: 72px; resize: vertical; border-radius: var(--radius-sm);
      border: 1px solid var(--border-color); background: var(--bg-primary);
      color: var(--text-primary); font-size: 12px; padding: var(--spacing-xs) var(--spacing-sm);
      font-family: var(--font-family-sans);
    }
    .decided-section { display: flex; flex-direction: column; gap: var(--spacing-sm); }
    .decided-section h3 { font-size: 13px; margin: 0; color: var(--text-muted); }
    .decided-card { opacity: 0.9; }
    .scan-line { margin: 0; font-size: 12px; color: var(--text-muted); }
    .scan-error { color: var(--error-color); }
    .badge.rule-kind { color: var(--primary-color); }
    .rule-text code { background: var(--bg-tertiary); border-radius: var(--radius-sm); padding: 1px 4px; font-size: 12px; }
    .link-btn {
      background: none; border: none; color: var(--primary-color); cursor: pointer;
      font-size: 11px; padding: 0; text-decoration: underline;
    }
    .evidence-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing-xs); }
    .evidence-item {
      border: 1px solid var(--border-color); border-radius: var(--radius-sm);
      padding: var(--spacing-xs) var(--spacing-sm); font-size: 11px;
    }
    .evidence-session { color: var(--text-muted); }
    .evidence-pair { display: flex; align-items: center; gap: var(--spacing-xs); margin-top: 2px; flex-wrap: wrap; }
    .evidence-pair code { background: var(--bg-tertiary); border-radius: var(--radius-sm); padding: 1px 4px; }
    .evidence-pair .fail { color: var(--error-color); }
    .evidence-pair .fix { color: var(--pill-ok-fg, #2e7d32); }
    .evidence-pair .arrow { color: var(--text-muted); }
  `],
})
export class MemoryReviewPageComponent implements OnInit {
  readonly store = inject(MemoryReviewStore);

  readonly editingId = signal<string | null>(null);
  readonly editText = signal('');
  readonly expandedEvidenceId = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    await this.refresh();
    await this.store.refreshScanStatus();
  }

  async refresh(): Promise<void> {
    await this.store.refresh();
  }

  async runScan(): Promise<void> {
    await this.store.runScan();
  }

  toggleEvidence(proposalId: string): void {
    this.expandedEvidenceId.update((current) => (current === proposalId ? null : proposalId));
  }

  ruleFor(proposal: GovernedProposal): RuleProposalPayload | null {
    return decodeRuleProposalPayload(proposal);
  }

  formatConfidence(confidence: number): number {
    return Math.round(confidence * 100);
  }

  textFor(proposal: GovernedProposal): string {
    return decodeMemoryProposalText(proposal);
  }

  async approve(proposal: GovernedProposal): Promise<void> {
    await this.store.approve(proposal.id, DEFAULT_ACTOR);
  }

  async reject(proposal: GovernedProposal): Promise<void> {
    await this.store.reject(proposal.id, DEFAULT_ACTOR);
  }

  startEdit(proposal: GovernedProposal): void {
    this.editingId.set(proposal.id);
    const rule = this.ruleFor(proposal);
    this.editText.set(
      rule
        ? `When \`${rule.pattern}\` fails with ${rule.errorClass}, use \`${rule.correction}\` instead.`
        : this.textFor(proposal),
    );
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.editText.set('');
  }

  onEditInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.editText.set(target.value);
  }

  async confirmEditApprove(proposal: GovernedProposal): Promise<void> {
    const text = this.editText().trim();
    if (!text) return;
    const ok = await this.store.approveEdited(proposal.id, text, DEFAULT_ACTOR);
    if (ok) this.cancelEdit();
  }

  statusClass(status: string): string {
    return status;
  }

  formatAge(timestamp: number): string {
    const deltaMs = Date.now() - timestamp;
    const minutes = Math.floor(deltaMs / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}
