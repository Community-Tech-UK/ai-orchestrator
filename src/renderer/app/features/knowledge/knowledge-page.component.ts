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
import { SettingsStore } from '../../core/state/settings.store';
import { WakeManagementComponent } from './wake-management.component';
import { ConversationImportComponent } from './conversation-import.component';
import type {
  CodebaseMiningStatus,
  ProjectCodeIndexStatus,
  ProjectCodeSymbol,
  ProjectKnowledgeFact,
  ProjectKnowledgeWakeHintItem,
} from '../../../../shared/types/knowledge-graph.types';

interface FolderPickerApi {
  selectFolder: () => Promise<{
    success: boolean;
    data?: string | null;
    error?: { message?: string };
  }>;
}

@Component({
  selector: 'app-knowledge-page',
  standalone: true,
  imports: [CommonModule, FormsModule, WakeManagementComponent, ConversationImportComponent],
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

      <!-- Tab Bar -->
      <div class="tab-bar">
        <button class="tab" type="button"
          [class.active]="activeTab() === 'graph'"
          (click)="activeTab.set('graph')">
          Knowledge Graph
        </button>
        <button class="tab" type="button"
          [class.active]="activeTab() === 'wake'"
          (click)="activeTab.set('wake')">
          Wake Context
        </button>
        <button class="tab" type="button"
          [class.active]="activeTab() === 'import'"
          (click)="activeTab.set('import')">
          Conversation Import
        </button>
      </div>

      <div class="content">
        @switch (activeTab()) {
          @case ('graph') {
            <div class="main-panel">
              <div class="panel-card full-width">
                <div class="panel-title">Project Memory</div>
                @if (store.projectReadModel(); as projectMemory) {
                  <div class="project-memory-grid">
                    <div>
                      <div class="section-title">Current Facts</div>
                      @if (projectMemory.facts.length > 0) {
                        <ul class="list compact">
                          @for (fact of projectMemory.facts; track fact.targetId) {
                            <li>
                              <span class="mono">{{ fact.subject }}</span>
                              <span class="predicate">{{ fact.predicate }}</span>
                              <span>{{ fact.object }}</span>
                              <button class="btn btn-sm" type="button" (click)="inspectProjectFact(fact)">
                                Evidence
                              </button>
                            </li>
                          }
                        </ul>
                      } @else {
                        <div class="hint">No source-backed project facts yet.</div>
                      }
                    </div>

                    <div>
                      <div class="section-title">Project Hints</div>
                      @if (projectMemory.wakeHints.length > 0) {
                        <ul class="list compact">
                          @for (hint of projectMemory.wakeHints; track hint.targetId) {
                            <li>
                              <span>{{ hint.content }}</span>
                              <span class="muted">Importance {{ hint.importance }}</span>
                              <button class="btn btn-sm" type="button" (click)="inspectProjectHint(hint)">
                                Evidence
                              </button>
                            </li>
                          }
                        </ul>
                      } @else {
                        <div class="hint">No source-backed project hints yet.</div>
                      }
                    </div>

                    <div>
                      <div class="section-title">Code Symbols</div>
                      @if (projectMemory.codeSymbols.length > 0) {
                        <div class="muted symbol-preview-label">
                          Showing {{ projectMemory.codeSymbols.length }} of {{ projectMemory.codeIndex.symbolCount }}
                        </div>
                        <ul class="list compact">
                          @for (symbol of projectMemory.codeSymbols; track symbol.id) {
                            <li class="symbol-row">
                              <span class="mono symbol-name">{{ symbol.name }}</span>
                              <span class="muted">{{ symbol.kind }}</span>
                              <span class="mono small">{{ symbol.pathFromRoot }}:{{ symbol.startLine }}</span>
                              <button class="btn btn-sm" type="button" (click)="inspectProjectSymbol(symbol)">
                                Evidence
                              </button>
                            </li>
                          }
                        </ul>
                      } @else {
                        <div class="hint">No indexed code symbols yet.</div>
                      }
                    </div>
                  </div>

                  @if (store.selectedEvidence().length > 0) {
                    <div class="evidence-panel">
                      <div class="section-title">Evidence</div>
                      <ul class="list compact">
                        @for (evidence of store.selectedEvidence(); track evidence.link.id) {
                          <li>
                            <span class="mono">{{ relativeSourcePath(evidence.source.sourceUri, projectMemory.project.rootPath) }}</span>
                            <span class="muted">{{ evidence.source.sourceKind }}</span>
                            @if (evidence.link.sourceSpan.kind === 'file_lines') {
                              <span class="muted">L{{ evidence.link.sourceSpan.startLine }}-{{ evidence.link.sourceSpan.endLine }}</span>
                            }
                            @if (evidence.link.metadata['evidenceKind'] === 'definition_location') {
                              <span class="muted">definition location</span>
                            }
                          </li>
                        }
                      </ul>
                    </div>
                  }
                } @else {
                  <div class="hint">Select or mine a project to inspect source-backed memory.</div>
                }
              </div>

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
                <div class="panel-title">Projects</div>
                @if (store.projectSummaries().length > 0) {
                  <label class="field">
                    <span class="label">Project</span>
                    <select
                      class="input"
                      [ngModel]="store.selectedProjectKey()"
                      (ngModelChange)="onProjectSelection($event)"
                    >
                      @for (project of store.projectSummaries(); track project.projectKey) {
                        <option [ngValue]="project.projectKey">{{ project.displayName }}</option>
                      }
                    </select>
                  </label>
                  @if (store.selectedProjectSummary(); as project) {
                    <div class="stat-row"><span>Sources</span><span class="num">{{ project.inventory.totalSources }}</span></div>
                    <div class="stat-row"><span>Evidence links</span><span class="num">{{ project.inventory.totalLinks }}</span></div>
                    <div class="stat-row"><span>Code symbols</span><span class="num">{{ project.inventory.totalCodeSymbols }}</span></div>
                    @if (project.inventory.byKind.manifest) {
                      <div class="stat-row"><span>Manifests</span><span class="num">{{ project.inventory.byKind.manifest }}</span></div>
                    }
                    @if (project.inventory.byKind.readme) {
                      <div class="stat-row"><span>Readmes</span><span class="num">{{ project.inventory.byKind.readme }}</span></div>
                    }
                    @if (project.inventory.byKind.instruction_doc) {
                      <div class="stat-row"><span>Instructions</span><span class="num">{{ project.inventory.byKind.instruction_doc }}</span></div>
                    }
                    @if (project.inventory.byKind.config) {
                      <div class="stat-row"><span>Configs</span><span class="num">{{ project.inventory.byKind.config }}</span></div>
                    }
                    @if (project.inventory.byKind.code_file) {
                      <div class="stat-row"><span>Code files</span><span class="num">{{ project.inventory.byKind.code_file }}</span></div>
                    }
                  }
                  @if (store.projectReadModel(); as projectMemory) {
                    <div class="code-index-box">
                      <div class="stat-row">
                        <span>Code index</span>
                        <span [class]="codeIndexStatusClass(projectMemory.codeIndex)">
                          {{ codeIndexStatusLabel(projectMemory.codeIndex) }}
                        </span>
                      </div>
                      <div class="stat-row"><span>Indexed files</span><span class="num">{{ projectMemory.codeIndex.fileCount }}</span></div>
                      <div class="stat-row"><span>Indexed symbols</span><span class="num">{{ projectMemory.codeIndex.symbolCount }}</span></div>
                      @if (projectMemory.codeIndex.lastSyncedAt) {
                        <div class="stat-row"><span>Last synced</span><span class="mono small">{{ projectMemory.codeIndex.lastSyncedAt | date:'short' }}</span></div>
                      }
                      @if (projectMemory.codeIndex.error) {
                        <div class="mine-errors">{{ projectMemory.codeIndex.error }}</div>
                      }
                      <button class="btn btn-sm" type="button" [disabled]="store.loading()" (click)="reindexSelectedProjectCode()">
                        Re-index code
                      </button>
                    </div>
                    <div class="source-list">
                      @for (source of projectMemory.sources.slice(0, 6); track source.id) {
                        <div class="source-row">
                          <span class="mono">{{ relativeSourcePath(source.sourceUri, projectMemory.project.rootPath) }}</span>
                          <span class="muted">{{ source.sourceKind }}</span>
                        </div>
                      }
                    </div>
                  }
                } @else {
                  <div class="hint">No projects registered yet.</div>
                }
              </div>

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
                <div class="panel-title">Codebase Mining</div>
                @if (store.miningStatus(); as miningStatus) {
                  <div class="stat-row">
                    <span>Status</span>
                    <span [class]="miningStatusClass(miningStatus)">
                      {{ miningStatusLabel(miningStatus) }}
                    </span>
                  </div>
                  <div class="stat-row">
                    <span>Path</span>
                    <span class="mono small">{{ miningStatus.normalizedPath }}</span>
                  </div>
                  @if (miningStatus.displayName) {
                    <div class="stat-row"><span>Project</span><span>{{ miningStatus.displayName }}</span></div>
                  }
                  @if (miningStatus.discoverySource) {
                    <div class="stat-row"><span>Discovered by</span><span class="mono small">{{ miningStatus.discoverySource }}</span></div>
                  }
                  <div class="stat-row">
                    <span>Auto mining</span>
                    <span [class]="miningStatus.autoMine === false ? 'badge-pending' : 'badge-success'">
                      {{ miningStatus.autoMine === false ? 'Off' : 'On' }}
                    </span>
                  </div>
                  @if (miningStatus.isPaused) {
                    <div class="stat-row"><span>Paused</span><span class="badge-pending">Yes</span></div>
                  }
                  @if (miningStatus.isExcluded) {
                    <div class="stat-row"><span>Excluded</span><span class="badge-danger">Yes</span></div>
                  }
                  @if (miningStatus.filesRead !== undefined) {
                    <div class="stat-row"><span>Files read</span><span class="num">{{ miningStatus.filesRead }}</span></div>
                  }
                  @if (miningStatus.factsExtracted !== undefined) {
                    <div class="stat-row"><span>Facts found</span><span class="num">{{ miningStatus.factsExtracted }}</span></div>
                  }
                  @if (miningStatus.hintsCreated !== undefined) {
                    <div class="stat-row"><span>Hints created</span><span class="num">{{ miningStatus.hintsCreated }}</span></div>
                  }
                  @if (miningStatus.completedAt) {
                    <div class="stat-row"><span>Last mined</span><span class="mono small">{{ miningStatus.completedAt | date:'short' }}</span></div>
                  }
                  @if (miningStatus.errors?.length) {
                    <div class="mine-errors">
                      @for (error of miningStatus.errors; track $index) {
                        <div>{{ error }}</div>
                      }
                    </div>
                  }
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
                  <button class="btn" type="button" [disabled]="store.loading()" (click)="browseMineDirectory()">
                    Browse
                  </button>
                  <button class="btn" type="button" [disabled]="store.loading() || !mineDir() || currentMiningExcluded()" (click)="triggerMine()">
                    Mine
                  </button>
                  @if (!store.miningStatus()?.isPaused && !store.miningStatus()?.isExcluded) {
                    <button class="btn" type="button" [disabled]="store.loading() || !mineDir()" (click)="pauseMine()">
                      Pause
                    </button>
                  }
                  @if (store.miningStatus()?.isPaused && !store.miningStatus()?.isExcluded) {
                    <button class="btn" type="button" [disabled]="store.loading() || !mineDir()" (click)="resumeMine()">
                      Resume
                    </button>
                  }
                  @if (!store.miningStatus()?.isExcluded) {
                    <button class="btn btn-danger" type="button" [disabled]="store.loading() || !mineDir()" (click)="excludeMine()">
                      Exclude
                    </button>
                  }
                </div>
              </div>
            </div>
          }
          @case ('wake') {
            <div class="tab-content-full">
              <app-wake-management />
            </div>
          }
          @case ('import') {
            <div class="tab-content-full">
              <app-conversation-import />
            </div>
          }
        }
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

    .section-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: var(--spacing-xs);
    }

    .project-memory-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--spacing-md);
    }

    .evidence-panel {
      margin-top: var(--spacing-md);
      padding-top: var(--spacing-sm);
      border-top: 1px solid var(--border-color);
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

    .badge-danger {
      color: #f87171;
      font-weight: 600;
      font-size: 11px;
    }

    .mine-errors {
      margin-top: var(--spacing-xs);
      padding: var(--spacing-xs);
      border-radius: var(--radius-sm);
      background: rgba(239, 68, 68, 0.12);
      color: #fca5a5;
      font-size: 11px;
      line-height: 1.4;
      word-break: break-word;
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

    .source-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: var(--spacing-sm);
      padding-top: var(--spacing-sm);
      border-top: 1px solid var(--border-color);
    }

    .source-row {
      display: flex;
      justify-content: space-between;
      gap: var(--spacing-xs);
      font-size: 11px;
      min-width: 0;
    }

    .code-index-box {
      margin-top: var(--spacing-sm);
      padding-top: var(--spacing-sm);
      border-top: 1px solid var(--border-color);
    }

    .symbol-preview-label {
      margin-bottom: 2px;
    }

    .symbol-row {
      align-items: center;
    }

    .symbol-name {
      font-weight: 600;
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

    .tab-bar {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border-color);
    }

    .tab {
      padding: var(--spacing-sm) var(--spacing-md);
      font-size: 13px;
      border: none;
      background: none;
      color: var(--text-muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
    }

    .tab.active {
      color: var(--text-primary);
      border-bottom-color: var(--primary-color);
    }

    .tab:hover {
      color: var(--text-primary);
    }

    .tab-content-full {
      grid-column: 1 / -1;
      max-width: 700px;
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

      .project-memory-grid {
        grid-template-columns: 1fr;
      }
    }
  `],
})
export class KnowledgePageComponent implements OnInit {
  protected store = inject(KnowledgeStore);
  private router = inject(Router);
  private settingsStore = inject(SettingsStore);

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

  // Tab navigation
  protected activeTab = signal<'graph' | 'wake' | 'import'>('graph');

  async ngOnInit(): Promise<void> {
    await this.settingsStore.initialize();

    await Promise.all([
      this.store.loadStats(),
      this.store.loadWakeContext(),
      this.store.loadProjectKnowledgeProjects(),
    ]);

    await this.initializeMineDirectory();
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

  async browseMineDirectory(): Promise<void> {
    const api = (window as unknown as { electronAPI?: FolderPickerApi }).electronAPI;
    if (!api?.selectFolder) {
      this.store.setError('Folder picker is only available in Electron.');
      return;
    }

    const result = await api.selectFolder();
    if (!result.success) {
      this.store.setError(result.error?.message ?? 'Failed to open folder picker.');
      return;
    }

    const selected = result.data?.trim();
    if (!selected) {
      return;
    }

    this.mineDir.set(selected);
    await this.store.checkMiningStatus(selected);
    const status = this.store.miningStatus();
    if (status?.projectKey) {
      await this.store.selectProject(status.projectKey);
    }
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
      this.store.loadProjectKnowledgeProjects(),
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

    await this.store.refreshProjectKnowledgeReadModel();
  }

  async triggerMine(): Promise<void> {
    const dirPath = this.mineDir().trim();
    if (!dirPath || this.currentMiningExcluded()) {
      return;
    }

    await this.store.triggerMining(dirPath);
  }

  async onProjectSelection(projectKey: string): Promise<void> {
    await this.store.selectProject(projectKey);
    const project = this.store.selectedProjectSummary();
    if (project?.rootPath) {
      this.mineDir.set(project.rootPath);
      await this.store.checkMiningStatus(project.rootPath);
    }
  }

  async inspectProjectFact(fact: ProjectKnowledgeFact): Promise<void> {
    await this.store.loadProjectEvidence(fact.targetKind, fact.targetId);
  }

  async inspectProjectHint(hint: ProjectKnowledgeWakeHintItem): Promise<void> {
    await this.store.loadProjectEvidence(hint.targetKind, hint.targetId);
  }

  async inspectProjectSymbol(symbol: ProjectCodeSymbol): Promise<void> {
    await this.store.loadProjectEvidence(symbol.targetKind, symbol.targetId);
  }

  async reindexSelectedProjectCode(): Promise<void> {
    const projectKey = this.store.selectedProjectKey().trim();
    if (!projectKey) {
      return;
    }
    await this.store.refreshProjectCodeIndex(projectKey);
  }

  async pauseMine(): Promise<void> {
    const dirPath = this.mineDir().trim();
    if (!dirPath) {
      return;
    }
    await this.store.pauseMining(dirPath);
  }

  async resumeMine(): Promise<void> {
    const dirPath = this.mineDir().trim();
    if (!dirPath) {
      return;
    }
    await this.store.resumeMining(dirPath);
  }

  async excludeMine(): Promise<void> {
    const dirPath = this.mineDir().trim();
    if (!dirPath) {
      return;
    }
    await this.store.excludeMining(dirPath);
  }

  protected currentMiningExcluded(): boolean {
    return this.store.miningStatus()?.isExcluded === true;
  }

  protected miningStatusLabel(status: CodebaseMiningStatus): string {
    if (status.isExcluded) {
      return 'Excluded';
    }
    if (status.isPaused) {
      return 'Paused';
    }
    if (status.status === 'failed') {
      return 'Failed';
    }
    if (status.status === 'running') {
      return 'Mining';
    }
    return status.mined ? 'Mined' : 'Pending';
  }

  protected miningStatusClass(status: CodebaseMiningStatus): string {
    if (status.isExcluded || status.status === 'failed') {
      return 'badge-danger';
    }
    if (status.isPaused) {
      return 'badge-pending';
    }
    return status.mined ? 'badge-success' : 'badge-pending';
  }

  protected codeIndexStatusLabel(status: ProjectCodeIndexStatus): string {
    if (status.status === 'ready') {
      return 'Ready';
    }
    if (status.status === 'indexing') {
      return 'Indexing';
    }
    if (status.status === 'disabled') {
      return 'Disabled';
    }
    if (status.status === 'paused') {
      return 'Paused';
    }
    if (status.status === 'excluded') {
      return 'Excluded';
    }
    if (status.status === 'failed') {
      return status.metadata['stale'] === true ? 'Stale' : 'Failed';
    }
    return 'Pending';
  }

  protected codeIndexStatusClass(status: ProjectCodeIndexStatus): string {
    if (status.status === 'ready') {
      return 'badge-success';
    }
    if (status.status === 'failed' || status.status === 'excluded') {
      return 'badge-danger';
    }
    return 'badge-pending';
  }

  private async initializeMineDirectory(): Promise<void> {
    const defaultDir = this.settingsStore.defaultWorkingDirectory().trim();
    if (!defaultDir) {
      return;
    }

    this.mineDir.set(defaultDir);
    await this.store.checkMiningStatus(defaultDir);

    const status = this.store.miningStatus();
    if (status?.projectKey) {
      await this.store.selectProject(status.projectKey);
    }
    if (!status?.mined && status?.status !== 'running' && !status?.isPaused && !status?.isExcluded) {
      await this.store.triggerMining(defaultDir);
    }
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

  protected relativeSourcePath(sourceUri: string, rootPath?: string): string {
    if (!rootPath || !sourceUri.startsWith(rootPath)) {
      return sourceUri;
    }
    const relative = sourceUri.slice(rootPath.length).replace(/^\/+/, '');
    return relative || sourceUri;
  }
}
