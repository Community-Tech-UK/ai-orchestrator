/**
 * A/B Testing Component
 * Manage and monitor prompt experiments
 */

import {
  Component,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
} from '@angular/core';
import { CommonModule, DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ElectronIpcService } from '../../core/services/ipc';

// ============================================
// Types
// ============================================

interface Variant {
  id: string;
  name: string;
  template: string;
  weight: number;
  metadata?: Record<string, unknown>;
}

interface Experiment {
  id: string;
  name: string;
  description?: string;
  taskType: string;
  variants: Variant[];
  status: 'draft' | 'running' | 'paused' | 'completed';
  startedAt?: number;
  endedAt?: number;
  minSamples: number;
  confidenceThreshold: number;
  createdAt: number;
  updatedAt: number;
}

interface ExperimentResult {
  variantId: string;
  samples: number;
  successes: number;
  successRate: number;
  avgDuration: number;
  avgTokens: number;
  totalDuration: number;
  totalTokens: number;
}

interface ExperimentWinner {
  variant: Variant;
  confidence: number;
  improvement: number;
}

interface ExperimentStats {
  totalExperiments: number;
  running: number;
  completed: number;
  draft: number;
  paused: number;
  totalOutcomes: number;
}

interface NewVariant {
  name: string;
  template: string;
  weight: number;
}

// ============================================
// Component
// ============================================

@Component({
  selector: 'app-ab-testing',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe, DecimalPipe, PercentPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ab-testing-container">
      <!-- Header -->
      <header class="ab-header">
        <div class="header-left">
          <div class="header-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
              <path d="M9 14l2 2 4-4"/>
            </svg>
          </div>
          <div>
            <h1>A/B Testing</h1>
            <p class="subtitle">Experiment with prompt variations to optimize outcomes</p>
          </div>
        </div>
        <div class="header-actions">
          <button class="btn btn-primary" (click)="showCreateDialog = true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            New Experiment
          </button>
          <button class="btn btn-secondary" (click)="refreshData()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
              <path d="M23 4v6h-6M1 20v-6h6"/>
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
            </svg>
            Refresh
          </button>
        </div>
      </header>

      <!-- Stats Overview -->
      <section class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">{{ stats()?.totalExperiments || 0 }}</div>
          <div class="stat-label">Total Experiments</div>
        </div>
        <div class="stat-card running">
          <div class="stat-value">{{ stats()?.running || 0 }}</div>
          <div class="stat-label">Running</div>
        </div>
        <div class="stat-card completed">
          <div class="stat-value">{{ stats()?.completed || 0 }}</div>
          <div class="stat-label">Completed</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats()?.totalOutcomes || 0 }}</div>
          <div class="stat-label">Total Outcomes</div>
        </div>
      </section>

      <!-- Filter Tabs -->
      <nav class="filter-tabs">
        <button
          [class.active]="statusFilter() === 'all'"
          (click)="statusFilter.set('all')"
        >All</button>
        <button
          [class.active]="statusFilter() === 'running'"
          (click)="statusFilter.set('running')"
        >Running</button>
        <button
          [class.active]="statusFilter() === 'draft'"
          (click)="statusFilter.set('draft')"
        >Draft</button>
        <button
          [class.active]="statusFilter() === 'completed'"
          (click)="statusFilter.set('completed')"
        >Completed</button>
        <button
          [class.active]="statusFilter() === 'paused'"
          (click)="statusFilter.set('paused')"
        >Paused</button>
      </nav>

      <!-- Experiments List -->
      <section class="experiments-list">
        @if (filteredExperiments().length === 0) {
          <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
            </svg>
            <p>No experiments found</p>
            <button class="btn btn-primary" (click)="showCreateDialog = true">Create your first experiment</button>
          </div>
        } @else {
          @for (experiment of filteredExperiments(); track experiment.id) {
            <div class="experiment-card" [class]="experiment.status">
              <div class="experiment-header">
                <div class="experiment-info">
                  <h3>{{ experiment.name }}</h3>
                  <span class="status-badge" [class]="experiment.status">{{ experiment.status }}</span>
                </div>
                <div class="experiment-actions">
                  @if (experiment.status === 'draft') {
                    <button class="btn btn-sm btn-success" (click)="startExperiment(experiment.id)">Start</button>
                    <button class="btn btn-sm btn-secondary" (click)="editExperiment(experiment)">Edit</button>
                    <button class="btn btn-sm btn-danger" (click)="deleteExperiment(experiment.id)">Delete</button>
                  }
                  @if (experiment.status === 'running') {
                    <button class="btn btn-sm btn-warning" (click)="pauseExperiment(experiment.id)">Pause</button>
                    <button class="btn btn-sm btn-secondary" (click)="completeExperiment(experiment.id)">Complete</button>
                  }
                  @if (experiment.status === 'paused') {
                    <button class="btn btn-sm btn-success" (click)="startExperiment(experiment.id)">Resume</button>
                    <button class="btn btn-sm btn-secondary" (click)="completeExperiment(experiment.id)">Complete</button>
                  }
                  @if (experiment.status === 'completed') {
                    <button class="btn btn-sm btn-secondary" (click)="viewResults(experiment)">View Results</button>
                  }
                </div>
              </div>

              <div class="experiment-meta">
                <span class="meta-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                    <polyline points="22,6 12,13 2,6"/>
                  </svg>
                  {{ experiment.taskType }}
                </span>
                <span class="meta-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                  </svg>
                  {{ experiment.variants.length }} variants
                </span>
                <span class="meta-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/>
                    <line x1="8" y1="2" x2="8" y2="6"/>
                    <line x1="3" y1="10" x2="21" y2="10"/>
                  </svg>
                  {{ experiment.createdAt | date:'short' }}
                </span>
              </div>

              @if (experiment.description) {
                <p class="experiment-description">{{ experiment.description }}</p>
              }

              <!-- Variants Progress -->
              @if (experimentResults().get(experiment.id); as results) {
                <div class="variants-progress">
                  @for (variant of experiment.variants; track variant.id) {
                    @if (getVariantResult(experiment.id, variant.id); as result) {
                      <div class="variant-row">
                        <div class="variant-info">
                          <span class="variant-name">{{ variant.name }}</span>
                          <span class="variant-samples">{{ result.samples }} samples</span>
                        </div>
                        <div class="variant-bar-container">
                          <div
                            class="variant-bar"
                            [style.width.%]="result.successRate * 100"
                            [class.winning]="isWinningVariant(experiment.id, variant.id)"
                          ></div>
                        </div>
                        <span class="variant-rate">{{ result.successRate | percent:'1.1-1' }}</span>
                      </div>
                    }
                  }
                </div>
              }

              <!-- Winner Badge -->
              @if (experimentWinners().get(experiment.id); as winner) {
                <div class="winner-badge">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="8" r="6"/>
                    <path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11"/>
                  </svg>
                  <span>Winner: <strong>{{ winner.variant.name }}</strong> ({{ winner.confidence | percent:'1.0-0' }} confidence)</span>
                </div>
              }
            </div>
          }
        }
      </section>

      <!-- Create/Edit Dialog -->
      @if (showCreateDialog) {
        <div class="dialog-overlay" (click)="closeDialog()" (keydown.enter)="closeDialog()" (keydown.space)="closeDialog()" tabindex="0" role="button">
          <div class="dialog" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()" role="dialog">
            <div class="dialog-header">
              <h2>{{ editingExperiment ? 'Edit' : 'Create' }} Experiment</h2>
              <button class="close-btn" (click)="closeDialog()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>

            <div class="dialog-body">
              <div class="form-group">
                <label for="exp-name">Experiment Name</label>
                <input
                  id="exp-name"
                  type="text"
                  [(ngModel)]="newExperiment.name"
                  placeholder="e.g., Code Review Prompt Test"
                />
              </div>

              <div class="form-group">
                <label for="exp-desc">Description</label>
                <textarea
                  id="exp-desc"
                  [(ngModel)]="newExperiment.description"
                  placeholder="What are you testing?"
                  rows="2"
                ></textarea>
              </div>

              <div class="form-group">
                <label for="exp-task">Task Type</label>
                <input
                  id="exp-task"
                  type="text"
                  [(ngModel)]="newExperiment.taskType"
                  placeholder="e.g., code_review, bug_fix, documentation"
                />
              </div>

              <div class="form-row">
                <div class="form-group">
                  <label for="exp-samples">Min Samples per Variant</label>
                  <input
                    id="exp-samples"
                    type="number"
                    [(ngModel)]="newExperiment.minSamples"
                    min="10"
                    max="1000"
                  />
                </div>
                <div class="form-group">
                  <label for="exp-confidence">Confidence Threshold</label>
                  <input
                    id="exp-confidence"
                    type="number"
                    [(ngModel)]="newExperiment.confidenceThreshold"
                    min="0.5"
                    max="0.99"
                    step="0.05"
                  />
                </div>
              </div>

              <!-- Variants -->
              <div class="variants-section">
                <div class="variants-header">
                  <h3>Variants</h3>
                  <button class="btn btn-sm btn-secondary" (click)="addVariant()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
                      <path d="M12 5v14M5 12h14"/>
                    </svg>
                    Add Variant
                  </button>
                </div>

                @for (variant of newExperiment.variants; track $index; let i = $index) {
                  <div class="variant-form">
                    <div class="variant-form-header">
                      <span class="variant-letter">{{ getVariantLetter(i) }}</span>
                      <button class="remove-btn" (click)="removeVariant(i)" [disabled]="newExperiment.variants.length <= 2">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M18 6L6 18M6 6l12 12"/>
                        </svg>
                      </button>
                    </div>
                    <div class="form-group">
                      <span class="label">Name</span>
                      <input type="text" [(ngModel)]="variant.name" placeholder="Variant name" />
                    </div>
                    <div class="form-group">
                      <span class="label">Template/Prompt</span>
                      <textarea
                        [(ngModel)]="variant.template"
                        placeholder="Enter the prompt template for this variant..."
                        rows="3"
                      ></textarea>
                    </div>
                    <div class="form-group">
                      <span class="label">Weight (0-1)</span>
                      <input
                        type="number"
                        [(ngModel)]="variant.weight"
                        min="0"
                        max="1"
                        step="0.1"
                      />
                    </div>
                  </div>
                }
              </div>
            </div>

            <div class="dialog-footer">
              <button class="btn btn-secondary" (click)="closeDialog()">Cancel</button>
              <button
                class="btn btn-primary"
                (click)="saveExperiment()"
                [disabled]="!isFormValid()"
              >
                {{ editingExperiment ? 'Update' : 'Create' }} Experiment
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Results Dialog -->
      @if (showResultsDialog && selectedExperiment()) {
        <div class="dialog-overlay" (click)="closeResultsDialog()" (keydown.enter)="closeResultsDialog()" (keydown.space)="closeResultsDialog()" tabindex="0" role="button">
          <div class="dialog dialog-large" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()" role="dialog">
            <div class="dialog-header">
              <h2>Results: {{ selectedExperiment()!.name }}</h2>
              <button class="close-btn" (click)="closeResultsDialog()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>

            <div class="dialog-body">
              @if (experimentResults().get(selectedExperiment()!.id); as results) {
                <table class="results-table">
                  <thead>
                    <tr>
                      <th>Variant</th>
                      <th>Samples</th>
                      <th>Successes</th>
                      <th>Success Rate</th>
                      <th>Avg Duration</th>
                      <th>Avg Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (variant of selectedExperiment()!.variants; track variant.id) {
                      @if (getVariantResult(selectedExperiment()!.id, variant.id); as result) {
                        <tr [class.winner]="isWinningVariant(selectedExperiment()!.id, variant.id)">
                          <td>
                            <strong>{{ variant.name }}</strong>
                            @if (isWinningVariant(selectedExperiment()!.id, variant.id)) {
                              <span class="winner-icon">🏆</span>
                            }
                          </td>
                          <td>{{ result.samples }}</td>
                          <td>{{ result.successes }}</td>
                          <td>{{ result.successRate | percent:'1.1-1' }}</td>
                          <td>{{ result.avgDuration | number:'1.0-0' }}ms</td>
                          <td>{{ result.avgTokens | number:'1.0-0' }}</td>
                        </tr>
                      }
                    }
                  </tbody>
                </table>

                @if (experimentWinners().get(selectedExperiment()!.id); as winner) {
                  <div class="results-summary">
                    <h4>Conclusion</h4>
                    <p>
                      <strong>{{ winner.variant.name }}</strong> is the winning variant with
                      <strong>{{ winner.confidence | percent:'1.0-0' }}</strong> statistical confidence
                      and a <strong>{{ winner.improvement | number:'1.1-1' }}%</strong> improvement
                      over the second-best variant.
                    </p>
                  </div>
                }
              }
            </div>

            <div class="dialog-footer">
              <button class="btn btn-secondary" (click)="closeResultsDialog()">Close</button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .ab-testing-container {
      padding: 24px;
      max-width: 1200px;
      margin: 0 auto;
    }

    .ab-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 24px;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .header-icon {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .header-icon svg {
      width: 24px;
      height: 24px;
      color: white;
    }

    .ab-header h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
      color: var(--text-primary, #fff);
    }

    .subtitle {
      margin: 4px 0 0;
      color: var(--text-secondary, #888);
      font-size: 14px;
    }

    .header-actions {
      display: flex;
      gap: 8px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-icon {
      width: 16px;
      height: 16px;
    }

    .btn-primary {
      background: #6366f1;
      color: white;
    }

    .btn-primary:hover {
      background: #4f46e5;
    }

    .btn-secondary {
      background: var(--bg-tertiary, #333);
      color: var(--text-primary, #fff);
    }

    .btn-secondary:hover {
      background: var(--bg-hover, #444);
    }

    .btn-success {
      background: #22c55e;
      color: white;
    }

    .btn-warning {
      background: #f59e0b;
      color: white;
    }

    .btn-danger {
      background: #ef4444;
      color: white;
    }

    .btn-sm {
      padding: 6px 12px;
      font-size: 13px;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: var(--bg-secondary, #1a1a1a);
      border: 1px solid var(--border-color, #333);
      border-radius: 12px;
      padding: 20px;
      text-align: center;
    }

    .stat-card.running {
      border-color: #6366f1;
      background: rgba(99, 102, 241, 0.1);
    }

    .stat-card.completed {
      border-color: #22c55e;
      background: rgba(34, 197, 94, 0.1);
    }

    .stat-value {
      font-size: 32px;
      font-weight: 700;
      color: var(--text-primary, #fff);
    }

    .stat-label {
      font-size: 14px;
      color: var(--text-secondary, #888);
      margin-top: 4px;
    }

    /* Filter Tabs */
    .filter-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 24px;
      padding: 4px;
      background: var(--bg-secondary, #1a1a1a);
      border-radius: 10px;
      width: fit-content;
    }

    .filter-tabs button {
      padding: 8px 16px;
      border: none;
      background: transparent;
      color: var(--text-secondary, #888);
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s;
    }

    .filter-tabs button.active {
      background: var(--bg-tertiary, #333);
      color: var(--text-primary, #fff);
    }

    .filter-tabs button:hover:not(.active) {
      color: var(--text-primary, #fff);
    }

    /* Experiments List */
    .experiments-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      background: var(--bg-secondary, #1a1a1a);
      border: 1px dashed var(--border-color, #333);
      border-radius: 12px;
    }

    .empty-state svg {
      width: 48px;
      height: 48px;
      color: var(--text-secondary, #888);
      margin-bottom: 16px;
    }

    .empty-state p {
      color: var(--text-secondary, #888);
      margin-bottom: 16px;
    }

    /* Experiment Card */
    .experiment-card {
      background: var(--bg-secondary, #1a1a1a);
      border: 1px solid var(--border-color, #333);
      border-radius: 12px;
      padding: 20px;
    }

    .experiment-card.running {
      border-left: 4px solid #6366f1;
    }

    .experiment-card.completed {
      border-left: 4px solid #22c55e;
    }

    .experiment-card.paused {
      border-left: 4px solid #f59e0b;
    }

    .experiment-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 12px;
    }

    .experiment-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .experiment-info h3 {
      margin: 0;
      font-size: 18px;
      color: var(--text-primary, #fff);
    }

    .status-badge {
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      text-transform: capitalize;
    }

    .status-badge.draft {
      background: rgba(156, 163, 175, 0.2);
      color: #9ca3af;
    }

    .status-badge.running {
      background: rgba(99, 102, 241, 0.2);
      color: #818cf8;
    }

    .status-badge.paused {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
    }

    .status-badge.completed {
      background: rgba(34, 197, 94, 0.2);
      color: #4ade80;
    }

    .experiment-actions {
      display: flex;
      gap: 8px;
    }

    .experiment-meta {
      display: flex;
      gap: 20px;
      margin-bottom: 12px;
    }

    .meta-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: var(--text-secondary, #888);
    }

    .meta-item svg {
      width: 14px;
      height: 14px;
    }

    .experiment-description {
      color: var(--text-secondary, #888);
      font-size: 14px;
      margin: 0 0 16px;
    }

    /* Variants Progress */
    .variants-progress {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border-color, #333);
    }

    .variant-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .variant-info {
      width: 150px;
      flex-shrink: 0;
    }

    .variant-name {
      display: block;
      font-size: 14px;
      color: var(--text-primary, #fff);
    }

    .variant-samples {
      font-size: 12px;
      color: var(--text-secondary, #888);
    }

    .variant-bar-container {
      flex: 1;
      height: 8px;
      background: var(--bg-tertiary, #333);
      border-radius: 4px;
      overflow: hidden;
    }

    .variant-bar {
      height: 100%;
      background: #6366f1;
      border-radius: 4px;
      transition: width 0.3s ease;
    }

    .variant-bar.winning {
      background: #22c55e;
    }

    .variant-rate {
      width: 60px;
      text-align: right;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary, #fff);
    }

    /* Winner Badge */
    .winner-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 16px;
      padding: 12px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 8px;
      color: #4ade80;
      font-size: 14px;
    }

    .winner-badge svg {
      width: 20px;
      height: 20px;
    }

    /* Dialog */
    .dialog-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .dialog {
      background: var(--bg-primary, #0d0d0d);
      border: 1px solid var(--border-color, #333);
      border-radius: 16px;
      width: 90%;
      max-width: 600px;
      max-height: 90vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .dialog-large {
      max-width: 800px;
    }

    .dialog-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 24px;
      border-bottom: 1px solid var(--border-color, #333);
    }

    .dialog-header h2 {
      margin: 0;
      font-size: 20px;
      color: var(--text-primary, #fff);
    }

    .close-btn {
      background: none;
      border: none;
      color: var(--text-secondary, #888);
      cursor: pointer;
      padding: 4px;
    }

    .close-btn svg {
      width: 20px;
      height: 20px;
    }

    .dialog-body {
      padding: 24px;
      overflow-y: auto;
    }

    .dialog-footer {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      padding: 16px 24px;
      border-top: 1px solid var(--border-color, #333);
    }

    /* Form */
    .form-group {
      margin-bottom: 16px;
    }

    .form-group label,
    .form-group .label {
      display: block;
      margin-bottom: 6px;
      font-size: 14px;
      color: var(--text-secondary, #888);
    }

    .form-group input,
    .form-group textarea {
      width: 100%;
      padding: 10px 12px;
      background: var(--bg-secondary, #1a1a1a);
      border: 1px solid var(--border-color, #333);
      border-radius: 8px;
      color: var(--text-primary, #fff);
      font-size: 14px;
    }

    .form-group textarea {
      resize: vertical;
      font-family: inherit;
    }

    .form-group input:focus,
    .form-group textarea:focus {
      outline: none;
      border-color: #6366f1;
    }

    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    /* Variants Section */
    .variants-section {
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid var(--border-color, #333);
    }

    .variants-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .variants-header h3 {
      margin: 0;
      font-size: 16px;
      color: var(--text-primary, #fff);
    }

    .variant-form {
      background: var(--bg-secondary, #1a1a1a);
      border: 1px solid var(--border-color, #333);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
    }

    .variant-form-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .variant-letter {
      width: 28px;
      height: 28px;
      background: #6366f1;
      color: white;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 14px;
    }

    .remove-btn {
      background: none;
      border: none;
      color: var(--text-secondary, #888);
      cursor: pointer;
      padding: 4px;
    }

    .remove-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    .remove-btn svg {
      width: 16px;
      height: 16px;
    }

    /* Results Table */
    .results-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
    }

    .results-table th,
    .results-table td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid var(--border-color, #333);
    }

    .results-table th {
      color: var(--text-secondary, #888);
      font-weight: 500;
      font-size: 13px;
    }

    .results-table td {
      color: var(--text-primary, #fff);
      font-size: 14px;
    }

    .results-table tr.winner {
      background: rgba(34, 197, 94, 0.1);
    }

    .winner-icon {
      margin-left: 8px;
    }

    .results-summary {
      background: var(--bg-secondary, #1a1a1a);
      border-radius: 12px;
      padding: 20px;
    }

    .results-summary h4 {
      margin: 0 0 12px;
      color: var(--text-primary, #fff);
    }

    .results-summary p {
      margin: 0;
      color: var(--text-secondary, #888);
      line-height: 1.6;
    }

    @media (max-width: 768px) {
      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
      }

      .ab-header {
        flex-direction: column;
        gap: 16px;
      }

      .form-row {
        grid-template-columns: 1fr;
      }
    }
  `],
})
export class ABTestingComponent implements OnInit, OnDestroy {
  private ipc = inject(ElectronIpcService);

  // State
  experiments = signal<Experiment[]>([]);
  experimentResults = signal<Map<string, ExperimentResult[]>>(new Map());
  experimentWinners = signal<Map<string, ExperimentWinner>>(new Map());
  stats = signal<ExperimentStats | null>(null);
  statusFilter = signal<'all' | Experiment['status']>('all');
  selectedExperiment = signal<Experiment | null>(null);

  // Computed
  filteredExperiments = computed(() => {
    const filter = this.statusFilter();
    const exps = this.experiments();
    if (filter === 'all') return exps;
    return exps.filter((e) => e.status === filter);
  });

  // Dialog state
  showCreateDialog = false;
  showResultsDialog = false;
  editingExperiment: Experiment | null = null;

  // New experiment form
  newExperiment = this.getEmptyExperiment();

  // Lifecycle
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  private get api() {
    return this.ipc.getApi();
  }

  ngOnInit(): void {
    this.refreshData();
    // Auto-refresh every 30 seconds for running experiments
    this.refreshInterval = setInterval(() => this.refreshData(), 30000);
  }

  ngOnDestroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  // Data Loading
  async refreshData(): Promise<void> {
    await Promise.all([this.loadExperiments(), this.loadStats()]);
  }

  async loadExperiments(): Promise<void> {
    try {
      const response = await this.api?.abListExperiments() as { success: boolean; data?: Experiment[] } | undefined;
      if (response?.success && response.data) {
        this.experiments.set(response.data);

        // Load results and winners for each experiment
        for (const exp of response.data) {
          await this.loadExperimentResults(exp.id);
          if (exp.status === 'completed' || exp.status === 'running') {
            await this.loadExperimentWinner(exp.id);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load experiments:', error);
    }
  }

  async loadExperimentResults(experimentId: string): Promise<void> {
    try {
      const response = await this.api?.abGetResults(experimentId) as { success: boolean; data?: ExperimentResult[] } | undefined;
      if (response?.success && response.data) {
        const current = this.experimentResults();
        const newMap = new Map(current);
        newMap.set(experimentId, response.data);
        this.experimentResults.set(newMap);
      }
    } catch (error) {
      console.error('Failed to load experiment results:', error);
    }
  }

  async loadExperimentWinner(experimentId: string): Promise<void> {
    try {
      const response = await this.api?.abGetWinner(experimentId) as { success: boolean; data?: ExperimentWinner | null } | undefined;
      if (response?.success && response.data) {
        const current = this.experimentWinners();
        const newMap = new Map(current);
        newMap.set(experimentId, response.data);
        this.experimentWinners.set(newMap);
      }
    } catch (error) {
      console.error('Failed to load experiment winner:', error);
    }
  }

  async loadStats(): Promise<void> {
    try {
      const response = await this.api?.abGetStats() as { success: boolean; data?: ExperimentStats } | undefined;
      if (response?.success && response.data) {
        this.stats.set(response.data);
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  }

  // Experiment Actions
  async startExperiment(experimentId: string): Promise<void> {
    try {
      const response = await this.api?.abStartExperiment(experimentId) as { success: boolean } | undefined;
      if (response?.success) {
        await this.refreshData();
      }
    } catch (error) {
      console.error('Failed to start experiment:', error);
    }
  }

  async pauseExperiment(experimentId: string): Promise<void> {
    try {
      const response = await this.api?.abPauseExperiment(experimentId) as { success: boolean } | undefined;
      if (response?.success) {
        await this.refreshData();
      }
    } catch (error) {
      console.error('Failed to pause experiment:', error);
    }
  }

  async completeExperiment(experimentId: string): Promise<void> {
    try {
      const response = await this.api?.abCompleteExperiment(experimentId) as { success: boolean } | undefined;
      if (response?.success) {
        await this.refreshData();
      }
    } catch (error) {
      console.error('Failed to complete experiment:', error);
    }
  }

  async deleteExperiment(experimentId: string): Promise<void> {
    if (!confirm('Are you sure you want to delete this experiment?')) return;

    try {
      const response = await this.api?.abDeleteExperiment(experimentId) as { success: boolean } | undefined;
      if (response?.success) {
        await this.refreshData();
      }
    } catch (error) {
      console.error('Failed to delete experiment:', error);
    }
  }

  // Dialog Management
  editExperiment(experiment: Experiment): void {
    this.editingExperiment = experiment;
    this.newExperiment = {
      name: experiment.name,
      description: experiment.description || '',
      taskType: experiment.taskType,
      minSamples: experiment.minSamples,
      confidenceThreshold: experiment.confidenceThreshold,
      variants: experiment.variants.map((v) => ({
        name: v.name,
        template: v.template,
        weight: v.weight,
      })),
    };
    this.showCreateDialog = true;
  }

  viewResults(experiment: Experiment): void {
    this.selectedExperiment.set(experiment);
    this.showResultsDialog = true;
  }

  closeDialog(): void {
    this.showCreateDialog = false;
    this.editingExperiment = null;
    this.newExperiment = this.getEmptyExperiment();
  }

  closeResultsDialog(): void {
    this.showResultsDialog = false;
    this.selectedExperiment.set(null);
  }

  // Form Management
  getEmptyExperiment(): {
    name: string;
    description: string;
    taskType: string;
    minSamples: number;
    confidenceThreshold: number;
    variants: NewVariant[];
  } {
    return {
      name: '',
      description: '',
      taskType: '',
      minSamples: 30,
      confidenceThreshold: 0.95,
      variants: [
        { name: 'Control', template: '', weight: 0.5 },
        { name: 'Variant B', template: '', weight: 0.5 },
      ],
    };
  }

  addVariant(): void {
    const letter = this.getVariantLetter(this.newExperiment.variants.length);
    this.newExperiment.variants.push({
      name: `Variant ${letter}`,
      template: '',
      weight: 0.5,
    });
  }

  removeVariant(index: number): void {
    if (this.newExperiment.variants.length > 2) {
      this.newExperiment.variants.splice(index, 1);
    }
  }

  getVariantLetter(index: number): string {
    return String.fromCharCode(65 + index); // A, B, C, ...
  }

  isFormValid(): boolean {
    return (
      this.newExperiment.name.trim() !== '' &&
      this.newExperiment.taskType.trim() !== '' &&
      this.newExperiment.variants.length >= 2 &&
      this.newExperiment.variants.every(
        (v) => v.name.trim() !== '' && v.template.trim() !== ''
      )
    );
  }

  async saveExperiment(): Promise<void> {
    if (!this.isFormValid()) return;

    try {
      if (this.editingExperiment) {
        await this.api?.abUpdateExperiment({
          experimentId: this.editingExperiment.id,
          updates: {
            name: this.newExperiment.name,
            description: this.newExperiment.description,
            minSamples: this.newExperiment.minSamples,
            confidenceThreshold: this.newExperiment.confidenceThreshold,
          },
        });
      } else {
        await this.api?.abCreateExperiment({
          name: this.newExperiment.name,
          description: this.newExperiment.description,
          taskType: this.newExperiment.taskType,
          minSamples: this.newExperiment.minSamples,
          confidenceThreshold: this.newExperiment.confidenceThreshold,
          variants: this.newExperiment.variants,
        });
      }

      this.closeDialog();
      await this.refreshData();
    } catch (error) {
      console.error('Failed to save experiment:', error);
    }
  }

  // Helpers
  getVariantResult(experimentId: string, variantId: string): ExperimentResult | null {
    const results = this.experimentResults().get(experimentId);
    return results?.find((r) => r.variantId === variantId) || null;
  }

  isWinningVariant(experimentId: string, variantId: string): boolean {
    const winner = this.experimentWinners().get(experimentId);
    return winner?.variant.id === variantId;
  }
}
