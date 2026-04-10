import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { KnowledgeStore } from '../../core/state/knowledge.store';

@Component({
  selector: 'app-knowledge-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-header">
        <button class="header-btn" type="button" (click)="goBack()">&larr; Back</button>
        <div class="header-title">
          <span class="title">Knowledge Graph</span>
          <span class="subtitle">Entities, facts, wake context, and codebase intelligence</span>
        </div>
      </div>

      @if (store.error(); as err) {
        <div class="error-banner">
          <span>{{ err }}</span>
          <button class="btn-dismiss" type="button" (click)="store.clearError()">x</button>
        </div>
      }

      <div class="toolbar">
        <label class="field field-wide">
          <span class="label">Query Entity</span>
          <input
            class="input"
            type="text"
            [value]="entityQuery()"
            placeholder="e.g. my_project, Alice, TypeScript"
            (input)="onEntityQueryInput($event)"
            (keyup.enter)="queryEntity()"
          />
        </label>

        <label class="field">
          <span class="label">Query by Predicate</span>
          <input
            class="input"
            type="text"
            [(ngModel)]="predicateQuery"
            placeholder="e.g. uses_database"
            (keyup.enter)="queryRelationship()"
          />
        </label>

        <div class="actions">
          <button class="btn primary" type="button" [disabled]="store.loading()" (click)="queryEntity()">
            Search
          </button>
          <button class="btn" type="button" [disabled]="store.loading()" (click)="refresh()">
            Refresh Stats
          </button>
        </div>
      </div>

      <div class="content">
        <div class="main-panel">
          <div class="panel-card full-width">
            <div class="panel-title" style="display: flex; justify-content: space-between; align-items: center;">
              <span>
                @if (store.selectedEntity(); as entity) {
                  Facts for "{{ entity }}"
                } @else {
                  Entity Facts
                }
              </span>
              <button class="btn btn-sm" type="button" (click)="showAddFact.set(!showAddFact())">
                {{ showAddFact() ? 'Cancel' : '+ Add Fact' }}
              </button>
            </div>

            @if (showAddFact()) {
              <div class="inline-form">
                <div class="form-row">
                  <label class="field">
                    <span class="label">Subject</span>
                    <input class="input" type="text" [(ngModel)]="newSubject" placeholder="e.g. my_project" />
                  </label>
                  <label class="field">
                    <span class="label">Predicate</span>
                    <input class="input" type="text" [(ngModel)]="newPredicate" placeholder="e.g. uses_database" />
                  </label>
                  <label class="field">
                    <span class="label">Object</span>
                    <input class="input" type="text" [(ngModel)]="newObject" placeholder="e.g. PostgreSQL" />
                  </label>
                </div>
                <div class="form-row">
                  <label class="field">
                    <span class="label">Confidence (0-1)</span>
                    <input class="input" type="number" [(ngModel)]="newConfidence" min="0" max="1" step="0.1" placeholder="0.9" />
                  </label>
                  <label class="field">
                    <span class="label">Valid From (ISO)</span>
                    <input class="input" type="text" [(ngModel)]="newValidFrom" placeholder="2025-01-01" />
                  </label>
                  <div class="field" style="justify-content: flex-end;">
                    <button class="btn primary" type="button"
                      [disabled]="!newSubject() || !newPredicate() || !newObject() || store.loading()"
                      (click)="addFact()">
                      Add Fact
                    </button>
                  </div>
                </div>
              </div>
            }

            @if (store.loading()) {
              <div class="hint">Loading...</div>
            } @else if (store.entityFacts().length > 0) {
              <table class="fact-table">
                <thead>
                  <tr>
                    <th>Subject</th>
                    <th>Predicate</th>
                    <th>Object</th>
                    <th>Confidence</th>
                    <th>Validity</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  @for (fact of store.entityFacts(); track $index) {
                    <tr>
                      <td class="mono">{{ fact.subject }}</td>
                      <td class="mono predicate">{{ fact.predicate }}</td>
                      <td>{{ fact.object }}</td>
                      <td class="num">
                        {{ fact.confidence !== null && fact.confidence !== undefined ? (fact.confidence * 100).toFixed(0) + '%' : '-' }}
                      </td>
                      <td class="muted">
                        @if (fact.validFrom) {
                          {{ fact.validFrom }}
                        } @else {
                          now
                        }
                        @if (fact.validTo) {
                          - {{ fact.validTo }}
                        }
                      </td>
                      <td>
                        @if (!fact.validTo) {
                          <button class="btn btn-sm btn-danger" type="button"
                            (click)="invalidateFact(fact)">
                            Invalidate
                          </button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <div class="hint">Search for an entity to inspect its facts and timeline.</div>
            }
          </div>

          @if (store.timeline().length > 0) {
            <div class="panel-card full-width">
              <div class="panel-title">Timeline for "{{ store.selectedEntity() }}"</div>
              <div class="timeline">
                @for (entry of store.timeline(); track $index) {
                  <div class="timeline-entry">
                    <span class="timeline-dot"></span>
                    <span class="mono">{{ entry.predicate }}</span>
                    <span>-> {{ entry.object }}</span>
                    @if (entry.validFrom) {
                      <span class="muted">({{ entry.validFrom }})</span>
                    }
                  </div>
                }
              </div>
            </div>
          }

          @if (store.recentFacts().length > 0) {
            <div class="panel-card full-width">
              <div class="panel-title">Recent Facts (Live)</div>
              <ul class="list">
                @for (fact of store.recentFacts(); track fact.tripleId) {
                  <li>
                    <span class="mono">{{ fact.subject }}</span>
                    <span class="predicate">{{ fact.predicate }}</span>
                    <span>{{ fact.object }}</span>
                  </li>
                }
              </ul>
            </div>
          }

          @if (store.relationshipResults().length > 0) {
            <div class="panel-card full-width">
              <div class="panel-title">Relationship: "{{ store.selectedPredicate() }}"</div>
              <table class="fact-table">
                <thead>
                  <tr>
                    <th>Subject</th>
                    <th>Object</th>
                    <th>Confidence</th>
                    <th>Current</th>
                  </tr>
                </thead>
                <tbody>
                  @for (result of store.relationshipResults(); track $index) {
                    <tr>
                      <td class="mono">{{ result.subject }}</td>
                      <td>{{ result.object }}</td>
                      <td class="num">{{ result.confidence !== null ? (result.confidence * 100).toFixed(0) + '%' : '-' }}</td>
                      <td>
                        <span [class]="result.current ? 'badge-success' : 'muted'">
                          {{ result.current ? 'Yes' : 'No' }}
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>

        <div class="side-panel">
          <div class="panel-card">
            <div class="panel-title">Graph Stats</div>
            @if (store.stats(); as stats) {
              <div class="stat-row"><span>Entities</span><span class="num">{{ stats.entities }}</span></div>
              <div class="stat-row"><span>Facts</span><span class="num">{{ stats.triples }}</span></div>
              <div class="stat-row"><span>Current facts</span><span class="num">{{ stats.currentFacts }}</span></div>
              <div class="stat-row"><span>Expired facts</span><span class="num">{{ stats.expiredFacts }}</span></div>
            } @else {
              <div class="hint">Stats unavailable.</div>
            }
          </div>

          <div class="panel-card">
            <div class="panel-title">Wake Context</div>
            @if (store.wakeContext(); as wakeContext) {
              <div class="stat-row"><span>Tokens</span><span class="num">~{{ wakeContext.totalTokens }}</span></div>
              @if (wakeContext.wing) {
                <div class="stat-row"><span>Wing</span><span>{{ wakeContext.wing }}</span></div>
              }
              <details class="wake-details">
                <summary>L0 Identity</summary>
                <pre class="wake-text">{{ wakeContext.identity.content }}</pre>
              </details>
              <details class="wake-details">
                <summary>L1 Essential Story</summary>
                <pre class="wake-text">{{ wakeContext.essentialStory.content }}</pre>
              </details>
            } @else {
              <div class="hint">No wake context generated yet.</div>
            }
          </div>

          <div class="panel-card">
            <div class="panel-title">Codebase Mining</div>
            @if (store.miningStatus(); as miningStatus) {
              <div class="stat-row">
                <span>Status</span>
                <span [class]="miningStatus.mined ? 'badge-success' : 'badge-pending'">
                  {{ miningStatus.mined ? 'Mined' : 'Pending' }}
                </span>
              </div>
              <div class="stat-row">
                <span>Path</span>
                <span class="mono small">{{ miningStatus.normalizedPath }}</span>
              </div>
            } @else {
              <div class="hint">No mining status available.</div>
            }

            <div class="mine-actions">
              <label class="field">
                <span class="label">Directory</span>
                <input
                  class="input"
                  type="text"
                  [value]="mineDir()"
                  placeholder="/path/to/project"
                  (input)="onMineDirInput($event)"
                />
              </label>
              <button class="btn" type="button" [disabled]="store.loading() || !mineDir()" (click)="triggerMine()">
                Mine
              </button>
            </div>
          </div>

          @if (store.importEvents().length > 0) {
            <div class="panel-card">
              <div class="panel-title">Recent Imports</div>
              <ul class="list compact">
                @for (event of store.importEvents(); track $index) {
                  <li>
                    <span class="mono small">{{ event.sourceFile }}</span>
                    <span class="muted">{{ event.segmentsCreated }} segments ({{ event.format }})</span>
                  </li>
                }
              </ul>
            </div>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      width: 100%;
      height: 100%;
    }

    .page {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      padding: var(--spacing-lg);
      background: var(--bg-primary);
      color: var(--text-primary);
      overflow-y: auto;
    }

    .page-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }

    .header-title {
      display: flex;
      flex-direction: column;
    }

    .title {
      font-size: 18px;
      font-weight: 700;
    }

    .subtitle {
      font-size: 12px;
      color: var(--text-muted);
    }

    .toolbar {
      display: flex;
      gap: var(--spacing-sm);
      align-items: end;
      padding: var(--spacing-md);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .field-wide {
      flex: 1;
    }

    .label {
      font-size: 11px;
      color: var(--text-muted);
    }

    .input {
      width: 100%;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
    }

    .actions {
      display: flex;
      gap: var(--spacing-xs);
    }

    .header-btn,
    .btn {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }

    .btn.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #fff;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .btn-dismiss {
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      margin-left: var(--spacing-sm);
      font-size: 14px;
    }

    .error-banner {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #f87171;
      font-size: 12px;
    }

    .content {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: var(--spacing-md);
      flex: 1;
      min-height: 0;
    }

    .main-panel,
    .side-panel {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      min-height: 0;
    }

    .main-panel {
      overflow-y: auto;
    }

    .side-panel {
      overflow-y: auto;
    }

    .panel-card {
      padding: var(--spacing-md);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .full-width {
      width: 100%;
    }

    .panel-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: var(--spacing-sm);
    }

    .stat-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 2px 0;
      font-size: 12px;
      gap: var(--spacing-sm);
    }

    .hint {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
    }

    .mono {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
    }

    .small {
      font-size: 10px;
      word-break: break-all;
    }

    .num {
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }

    .muted {
      color: var(--text-muted);
      font-size: 11px;
    }

    .predicate {
      color: var(--primary-color);
    }

    .fact-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .fact-table th {
      text-align: left;
      font-size: 11px;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border-color);
      padding: 4px 8px;
    }

    .fact-table td {
      padding: 4px 8px;
      border-bottom: 1px solid var(--border-color);
      vertical-align: top;
    }

    .timeline {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .timeline-entry {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      font-size: 12px;
      flex-wrap: wrap;
    }

    .timeline-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--primary-color);
      flex-shrink: 0;
    }

    .list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .list li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-xs);
      padding: 4px 0;
      font-size: 12px;
      border-bottom: 1px solid var(--border-color);
    }

    .list.compact li {
      padding: 2px 0;
      font-size: 11px;
    }

    .wake-details {
      margin-top: var(--spacing-xs);
    }

    .wake-details summary {
      font-size: 12px;
      cursor: pointer;
      color: var(--primary-color);
    }

    .wake-text {
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 200px;
      overflow-y: auto;
      padding: var(--spacing-sm);
      background: var(--bg-primary);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      margin-top: var(--spacing-xs);
    }

    .badge-success {
      color: #4ade80;
      font-weight: 600;
      font-size: 11px;
    }

    .badge-pending {
      color: var(--text-muted);
      font-size: 11px;
    }

    .mine-actions {
      display: flex;
      gap: var(--spacing-xs);
      align-items: end;
      margin-top: var(--spacing-sm);
    }

    .mine-actions .field {
      flex: 1;
    }

    .btn-sm {
      padding: 2px 6px;
      font-size: 10px;
    }

    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.3);
      color: #f87171;
    }

    .inline-form {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
      border: 1px dashed var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
    }

    .form-row {
      display: flex;
      gap: var(--spacing-sm);
      align-items: end;
    }

    .form-row .field {
      flex: 1;
    }

    @media (max-width: 1100px) {
      .content {
        grid-template-columns: 1fr;
      }

      .toolbar {
        flex-direction: column;
        align-items: stretch;
      }

      .actions,
      .mine-actions {
        width: 100%;
      }
    }
  `],
})
export class KnowledgePageComponent implements OnInit {
  protected store = inject(KnowledgeStore);
  private router = inject(Router);

  protected entityQuery = signal('');
  protected mineDir = signal('');

  // Add-fact form state
  protected showAddFact = signal(false);
  protected newSubject = signal('');
  protected newPredicate = signal('');
  protected newObject = signal('');
  protected newConfidence = signal('');
  protected newValidFrom = signal('');

  // Relationship query
  protected predicateQuery = signal('');

  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.store.loadStats(),
      this.store.loadWakeContext(),
    ]);
  }

  goBack(): void {
    void this.router.navigate(['/']);
  }

  onEntityQueryInput(event: Event): void {
    this.entityQuery.set((event.target as HTMLInputElement).value);
  }

  onMineDirInput(event: Event): void {
    this.mineDir.set((event.target as HTMLInputElement).value);
  }

  async queryEntity(): Promise<void> {
    const entityName = this.entityQuery().trim();
    if (!entityName) {
      return;
    }

    await Promise.all([
      this.store.queryEntity(entityName),
      this.store.loadTimeline(entityName),
    ]);
  }

  async refresh(): Promise<void> {
    await Promise.all([
      this.store.loadStats(),
      this.store.loadWakeContext(),
    ]);

    const entityName = this.store.selectedEntity().trim();
    if (entityName) {
      await Promise.all([
        this.store.queryEntity(entityName),
        this.store.loadTimeline(entityName),
      ]);
    }

    const dirPath = this.mineDir().trim();
    if (dirPath) {
      await this.store.checkMiningStatus(dirPath);
    }
  }

  async triggerMine(): Promise<void> {
    const dirPath = this.mineDir().trim();
    if (!dirPath) {
      return;
    }

    await this.store.triggerMining(dirPath);
  }

  async addFact(): Promise<void> {
    const subject = this.newSubject().trim();
    const predicate = this.newPredicate().trim();
    const object = this.newObject().trim();
    if (!subject || !predicate || !object) return;

    const payload: {
      subject: string;
      predicate: string;
      object: string;
      confidence?: number;
      validFrom?: string;
    } = { subject, predicate, object };

    const conf = this.newConfidence().toString().trim();
    if (conf) {
      payload.confidence = parseFloat(conf);
    }
    const vf = this.newValidFrom().trim();
    if (vf) {
      payload.validFrom = vf;
    }

    const ok = await this.store.addFact(payload);
    if (ok) {
      this.newSubject.set('');
      this.newPredicate.set('');
      this.newObject.set('');
      this.newConfidence.set('');
      this.newValidFrom.set('');
      this.showAddFact.set(false);
    }
  }

  async invalidateFact(fact: { subject: string; predicate: string; object: string }): Promise<void> {
    await this.store.invalidateFact({
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
    });
  }

  async queryRelationship(): Promise<void> {
    const predicate = this.predicateQuery().trim();
    if (!predicate) return;
    await this.store.queryRelationship(predicate);
  }
}
