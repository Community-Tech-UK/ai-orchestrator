import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';
import type { OperatorRunEventRecord, OperatorRunNodeRecord } from '../../../../shared/types/operator.types';
import { OperatorStore } from '../../core/state/operator.store';

@Component({
  selector: 'app-operator-page',
  standalone: true,
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="operator-page">
      <header class="operator-header">
        <div class="operator-title-row">
          <button
            type="button"
            class="operator-back-button"
            aria-label="Back to dashboard"
            title="Back to dashboard"
            (click)="goBack()"
          >
            <svg class="operator-back-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M19 12H5"></path>
              <path d="M12 19L5 12L12 5"></path>
            </svg>
            <span>Back</span>
          </button>
          <div>
            <p class="operator-kicker">Global control plane</p>
            <h1>Orchestrator</h1>
          </div>
        </div>
        <div class="operator-status" [class.loading]="store.loading() || store.sending()">
          {{ store.sending() ? 'Sending' : store.loading() ? 'Loading' : 'Ready' }}
        </div>
      </header>

      @if (visibleTargets().length > 0) {
        <div class="operator-targets">
          @for (target of visibleTargets(); track target.path) {
            <span class="operator-target-chip" [title]="target.path">
              {{ target.label }}
            </span>
          }
        </div>
      }

      @if (store.runs().length > 0) {
        <div class="operator-runs">
          @for (run of store.runs(); track run.id) {
            <article class="operator-run">
              <div class="operator-run-main">
                <span>{{ run.title }}</span>
                <strong>{{ run.status }}</strong>
              </div>
              <div class="operator-run-actions">
                @if (canCancelRun(run.status)) {
                  <button type="button" class="operator-run-button" (click)="cancelRun(run.id)">
                    Cancel
                  </button>
                }
                @if (canRetryRun(run.status)) {
                  <button type="button" class="operator-run-button" (click)="retryRun(run.id)">
                    Retry
                  </button>
                }
              </div>
            </article>
          }
        </div>
      }

      @if (store.activeRunGraph(); as graph) {
        <section class="operator-run-graph" aria-label="Run graph">
          <div class="operator-run-graph-header">
            <span>Run graph</span>
            <strong>{{ graph.run.title }}</strong>
          </div>
          <div class="operator-run-graph-nodes">
            @for (node of graph.nodes; track node.id) {
              <article class="operator-run-node">
                <div class="operator-run-node-main">
                  <span>{{ node.type }}</span>
                  <strong>{{ node.title }}</strong>
                </div>
                <div class="operator-run-node-meta">
                  <span>{{ node.status }}</span>
                  @if (node.targetPath) {
                    <small [title]="node.targetPath">{{ node.targetPath }}</small>
                  }
                  @if (node.externalRefId) {
                    <small [title]="node.externalRefId">{{ node.externalRefKind }} {{ node.externalRefId }}</small>
                  }
                </div>
                @if (changedFilesForNode(node).length > 0) {
                  <div class="operator-run-node-detail">
                    <span>Changed files</span>
                    @for (file of changedFilesForNode(node); track file) {
                      <small [title]="file">{{ file }}</small>
                    }
                  </div>
                }
                @if (verificationChecksForNode(node).length > 0) {
                  <div class="operator-run-node-detail">
                    <span>Verification</span>
                    @for (check of verificationChecksForNode(node); track check.commandLine) {
                      <small [title]="check.commandLine">{{ check.commandLine }} · {{ check.status }}</small>
                    }
                  </div>
                }
              </article>
            }
          </div>
          @if (artifactEvents().length > 0) {
            <div class="operator-run-artifacts">
              <span>Artifacts</span>
              @for (artifact of artifactEvents(); track artifact.label) {
                <small [title]="artifact.path">{{ artifact.label }}</small>
              }
            </div>
          }
        </section>
      }

      <div class="operator-transcript" aria-live="polite">
        @if (store.error(); as error) {
          <div class="operator-error" role="alert">{{ error }}</div>
        }

        @if (store.messages().length === 0 && !store.loading()) {
          <div class="operator-empty">
            <span>No messages yet</span>
          </div>
        }

        @for (message of store.messages(); track message.id) {
          <article class="operator-message" [class.user]="message.role === 'user'">
            <div class="operator-message-meta">
              <span>{{ labelForRole(message.role) }}</span>
              <time [attr.datetime]="dateTimeFor(message.createdAt)">
                {{ message.createdAt | date:'shortTime' }}
              </time>
            </div>
            <p>{{ message.content }}</p>
          </article>
        }
      </div>

      <form class="operator-composer" (submit)="send($event)">
        <textarea
          [value]="draft()"
          (input)="onDraftInput($event)"
          rows="3"
          placeholder="Message Orchestrator"
          aria-label="Message Orchestrator"
        ></textarea>
        <button type="submit" [disabled]="!canSend()">
          Send
        </button>
      </form>
    </section>
  `,
  styles: [`
    :host {
      display: flex;
      flex: 1;
      min-width: 0;
      min-height: 0;
    }

    .operator-page {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: grid;
      grid-template-rows: auto auto auto auto 1fr auto;
      gap: 18px;
      max-width: 1100px;
      width: 100%;
      color: var(--text-primary);
    }

    .operator-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 4px 2px 0;
    }

    .operator-title-row {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .operator-back-button {
      flex: 0 0 auto;
      min-width: 78px;
      height: 36px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      border: 1px solid var(--glass-strong);
      border-radius: 8px;
      color: var(--text-secondary);
      background: var(--glass-light);
      padding: 0 10px;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 650;
      line-height: 1;
      text-transform: uppercase;
    }

    .operator-back-button:hover {
      color: var(--text-primary);
      border-color: rgba(var(--primary-rgb), 0.35);
      background: rgba(var(--primary-rgb), 0.12);
    }

    .operator-back-icon {
      flex: 0 0 auto;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .operator-kicker {
      margin: 0 0 4px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 650;
      letter-spacing: 0;
    }

    .operator-status {
      border: 1px solid var(--glass-strong);
      border-radius: 999px;
      padding: 7px 12px;
      color: var(--text-secondary);
      background: var(--glass-light);
      font-family: var(--font-mono);
      font-size: 11px;
      text-transform: uppercase;
    }

    .operator-status.loading {
      color: var(--text-primary);
      border-color: rgba(var(--primary-rgb), 0.3);
      background: rgba(var(--primary-rgb), 0.12);
    }

    .operator-targets {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 0;
    }

    .operator-target-chip {
      display: inline-flex;
      align-items: center;
      max-width: 210px;
      height: 30px;
      border: 1px solid var(--glass-border);
      border-radius: 8px;
      padding: 0 10px;
      color: var(--text-secondary);
      background: var(--glass-light);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: inherit;
      font-size: 12px;
    }

    .operator-runs {
      display: grid;
      gap: 8px;
    }

    .operator-run {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
      border: 1px solid var(--glass-border);
      border-radius: 8px;
      padding: 10px 12px;
      background: var(--glass-light);
      color: var(--text-secondary);
    }

    .operator-run-main {
      display: grid;
      gap: 4px;
      min-width: 0;
    }

    .operator-run-main span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .operator-run-main strong {
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 650;
      text-transform: uppercase;
    }

    .operator-run-actions {
      display: flex;
      flex: 0 0 auto;
      gap: 8px;
    }

    .operator-run-button {
      min-width: 0;
      height: 30px;
      padding: 0 10px;
      border-color: var(--glass-strong);
      background: var(--bg-primary);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 600;
    }

    .operator-run-graph {
      display: grid;
      gap: 10px;
      min-width: 0;
      border-top: 1px solid var(--glass-border);
      border-bottom: 1px solid var(--glass-border);
      padding: 12px 2px;
    }

    .operator-run-graph-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
      text-transform: uppercase;
    }

    .operator-run-graph-header strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-secondary);
      font-weight: 650;
      text-align: right;
    }

    .operator-run-graph-nodes {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 8px;
    }

    .operator-run-node {
      min-width: 0;
      border: 1px solid var(--glass-border);
      border-radius: 8px;
      padding: 10px;
      background: rgba(var(--primary-rgb), 0.06);
    }

    .operator-run-node-main {
      display: grid;
      gap: 4px;
      min-width: 0;
    }

    .operator-run-node-main span,
    .operator-run-node-meta span {
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 10px;
      text-transform: uppercase;
    }

    .operator-run-node-main strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 650;
    }

    .operator-run-node-meta {
      display: grid;
      gap: 4px;
      margin-top: 10px;
      min-width: 0;
    }

    .operator-run-node-meta small {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-secondary);
      font-size: 11px;
    }

    .operator-run-node-detail,
    .operator-run-artifacts {
      display: grid;
      gap: 5px;
      min-width: 0;
      margin-top: 10px;
      padding-top: 9px;
      border-top: 1px solid var(--glass-border);
    }

    .operator-run-node-detail span,
    .operator-run-artifacts span {
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 10px;
      text-transform: uppercase;
    }

    .operator-run-node-detail small,
    .operator-run-artifacts small {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-secondary);
      font-size: 11px;
    }

    .operator-transcript {
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 4px 2px;
    }

    .operator-empty,
    .operator-error,
    .operator-message {
      border: 1px solid var(--glass-border);
      border-radius: 8px;
      background: var(--glass-light);
    }

    .operator-empty {
      display: grid;
      place-items: center;
      min-height: 220px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 12px;
      text-transform: uppercase;
    }

    .operator-error {
      padding: 12px 14px;
      color: var(--danger-color, #ff6b6b);
      background: rgba(255, 107, 107, 0.08);
    }

    .operator-message {
      padding: 14px 16px;
      max-width: min(760px, 100%);
      color: var(--text-primary);
    }

    .operator-message.user {
      align-self: flex-end;
      border-color: rgba(var(--primary-rgb), 0.3);
      background: rgba(var(--primary-rgb), 0.12);
    }

    .operator-message-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
      text-transform: uppercase;
    }

    .operator-message p {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.5;
    }

    .operator-composer {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: end;
      padding: 14px;
      border: 1px solid var(--glass-border);
      border-radius: 8px;
      background: var(--glass-light);
    }

    textarea {
      width: 100%;
      min-height: 76px;
      max-height: 180px;
      resize: vertical;
      border: 1px solid var(--glass-strong);
      border-radius: 8px;
      padding: 12px;
      color: var(--text-primary);
      background: var(--bg-primary);
      font: inherit;
      line-height: 1.4;
    }

    textarea:focus {
      outline: none;
      border-color: rgba(var(--primary-rgb), 0.45);
      box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.12);
    }

    button {
      min-width: 82px;
      height: 42px;
      border: 1px solid rgba(var(--primary-rgb), 0.35);
      border-radius: 8px;
      color: var(--text-primary);
      background: rgba(var(--primary-rgb), 0.16);
      font-weight: 650;
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    @media (max-width: 720px) {
      .operator-composer {
        grid-template-columns: 1fr;
      }

      .operator-composer button {
        width: 100%;
      }
    }
  `],
})
export class OperatorPageComponent implements OnInit {
  protected readonly store = inject(OperatorStore);
  private readonly router = inject(Router);
  protected readonly draft = signal('');

  ngOnInit(): void {
    void this.store.initialize();
  }

  protected onDraftInput(event: Event): void {
    const target = event.target;
    this.draft.set(target instanceof HTMLTextAreaElement ? target.value : '');
  }

  protected canSend(): boolean {
    return this.draft().trim().length > 0 && !this.store.sending();
  }

  protected send(event: Event): void {
    event.preventDefault();
    const text = this.draft().trim();
    if (!text || this.store.sending()) {
      return;
    }
    this.draft.set('');
    void this.store.sendMessage(text);
  }

  protected cancelRun(runId: string): void {
    void this.store.cancelRun(runId);
  }

  protected retryRun(runId: string): void {
    void this.store.retryRun(runId);
  }

  protected goBack(): void {
    this.store.deselect();
    void this.router.navigate(['/']);
  }

  protected canCancelRun(status: string): boolean {
    return status === 'queued' || status === 'running' || status === 'waiting';
  }

  protected canRetryRun(status: string): boolean {
    return status === 'blocked' || status === 'failed' || status === 'cancelled';
  }

  protected visibleTargets() {
    return this.store.targetChips().slice(0, 8);
  }

  protected changedFilesForNode(node: OperatorRunNodeRecord): string[] {
    const changedFiles = node.outputJson?.['changedFiles'];
    return Array.isArray(changedFiles)
      ? changedFiles.filter((file): file is string => typeof file === 'string' && file.trim().length > 0)
      : [];
  }

  protected verificationChecksForNode(node: OperatorRunNodeRecord): { commandLine: string; status: string }[] {
    const checks = node.outputJson?.['checks'];
    if (!Array.isArray(checks)) {
      return [];
    }
    return checks.flatMap((check) => {
      if (!check || typeof check !== 'object' || Array.isArray(check)) {
        return [];
      }
      const record = check as Record<string, unknown>;
      const command = typeof record['command'] === 'string' ? record['command'] : null;
      const args = Array.isArray(record['args'])
        ? record['args'].filter((arg): arg is string => typeof arg === 'string')
        : [];
      if (!command) {
        return [];
      }
      const status = typeof record['status'] === 'string' ? record['status'] : 'unknown';
      return [{ commandLine: [command, ...args].join(' '), status }];
    });
  }

  protected artifactEvents(): { label: string; path: string }[] {
    const graph = this.store.activeRunGraph();
    if (!graph) {
      return [];
    }
    return graph.events
      .filter((event): event is OperatorRunEventRecord & { kind: 'fs-write' } => event.kind === 'fs-write')
      .flatMap((event) => {
        const filePath = typeof event.payload['path'] === 'string' ? event.payload['path'] : null;
        const kind = typeof event.payload['kind'] === 'string' ? event.payload['kind'] : 'modify';
        if (!filePath) {
          return [];
        }
        return [{
          path: filePath,
          label: `${filePath} ${fsWriteKindLabel(kind)}`,
        }];
      });
  }

  protected labelForRole(role: string): string {
    if (role === 'user') return 'You';
    if (role === 'assistant') return 'Orchestrator';
    return role;
  }

  protected dateTimeFor(timestamp: number): string {
    return new Date(timestamp).toISOString();
  }
}

function fsWriteKindLabel(kind: string): string {
  if (kind === 'create') return 'created';
  if (kind === 'delete') return 'deleted';
  return 'modified';
}
