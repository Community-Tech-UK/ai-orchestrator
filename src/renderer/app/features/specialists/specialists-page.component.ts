/**
 * Specialists Page
 * Container that wires specialist picker UI to specialist IPC APIs.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type {
  SpecialistInstance,
  SpecialistProfile,
  SpecialistRecommendation,
} from '../../../../shared/types/specialist.types';
import { SpecialistPickerComponent } from './specialist-picker.component';
import { OrchestrationIpcService } from '../../core/services/ipc/orchestration-ipc.service';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

interface InstanceOption {
  id: string;
  displayName: string;
  status: string;
}

@Component({
  selector: 'app-specialists-page',
  standalone: true,
  imports: [CommonModule, SpecialistPickerComponent],
  template: `
    <div class="page">
      <div class="page-header">
        <div class="header-title">
          <span class="title">Specialists</span>
          <span class="subtitle">Recommendations, spawning, and findings tracking</span>
        </div>
      </div>

      <div class="toolbar">
        <label class="field">
          <span class="label">Orchestrator Instance</span>
          <select class="select" [value]="selectedInstanceId()" (change)="onInstanceChange($event)">
            <option value="">Select instance</option>
            @for (instance of instances(); track instance.id) {
              <option [value]="instance.id">
                {{ instance.displayName }} ({{ instance.status }})
              </option>
            }
          </select>
        </label>

        <label class="field field-wide">
          <span class="label">Task Context (for recommendations)</span>
          <input
            class="input"
            type="text"
            [value]="taskDescription()"
            placeholder="e.g. review auth middleware for vulnerabilities"
            (input)="onTaskDescriptionInput($event)"
          />
        </label>

        <div class="actions">
          <button class="btn" type="button" [disabled]="working()" (click)="recommendSpecialists()">
            Recommend
          </button>
          <button class="btn" type="button" [disabled]="working()" (click)="refreshAll()">
            Refresh
          </button>
        </div>
      </div>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      <div class="content">
        <div class="main-panel">
          <app-specialist-picker
            [specialists]="orderedSpecialists()"
            (create)="createSpecialist($event)"
          />
        </div>

        <div class="side-panel">
          <div class="panel-card">
            <div class="panel-title">Recommendations</div>
            @if (recommendations().length > 0) {
              <div class="recommendation-list">
                @for (rec of recommendations(); track rec.profileId) {
                  <div class="recommendation-item">
                    <div class="rec-header">
                      <span class="rec-id">{{ rec.profileId }}</span>
                      <span class="rec-score">{{ (rec.relevanceScore * 100).toFixed(0) }}%</span>
                    </div>
                    <div class="rec-reason">{{ rec.reason }}</div>
                  </div>
                }
              </div>
            } @else {
              <div class="hint">No recommendation results yet.</div>
            }
          </div>

          <div class="panel-card">
            <div class="panel-title">Active Specialist Instances</div>
            @if (activeInstances().length > 0) {
              <div class="active-list">
                @for (instance of activeInstances(); track instance.id) {
                  <div class="active-item">
                    <div class="active-header">
                      <span class="active-name">{{ instance.profile.name }}</span>
                      <span class="status" [class]="'status-' + instance.status">
                        {{ instance.status }}
                      </span>
                    </div>
                    <div class="meta-row">
                      <span>Findings: {{ instance.findings.length }}</span>
                      <span>Files: {{ instance.metrics.filesAnalyzed }}</span>
                    </div>
                    @if (instance.findings.length > 0) {
                      <div class="findings">
                        @for (finding of instance.findings.slice(0, 2); track finding.id) {
                          <div class="finding">
                            <span class="severity" [class]="'sev-' + finding.severity">
                              {{ finding.severity }}
                            </span>
                            <span class="finding-title">{{ finding.title }}</span>
                          </div>
                        }
                      </div>
                    }
                    <div class="status-actions">
                      @if (instance.status === 'active') {
                        <button class="btn tiny" type="button" (click)="updateStatus(instance.id, 'paused')">
                          Pause
                        </button>
                        <button class="btn tiny" type="button" (click)="updateStatus(instance.id, 'completed')">
                          Complete
                        </button>
                      } @else if (instance.status === 'paused') {
                        <button class="btn tiny" type="button" (click)="updateStatus(instance.id, 'active')">
                          Resume
                        </button>
                      }
                    </div>
                  </div>
                }
              </div>
            } @else {
              <div class="hint">No active specialist instances.</div>
            }
          </div>
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
      display: grid;
      grid-template-columns: minmax(220px, 1fr) minmax(280px, 2fr) auto;
      align-items: end;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      min-width: 0;
    }

    .field-wide {
      grid-column: span 1;
    }

    .label {
      font-size: 12px;
      color: var(--text-muted);
    }

    .select,
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
      justify-content: flex-end;
    }

    .btn {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      cursor: pointer;
    }

    .btn.tiny {
      padding: 2px 8px;
      font-size: 11px;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .error-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
      font-size: 12px;
    }

    .content {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr);
      gap: var(--spacing-md);
    }

    .main-panel,
    .side-panel {
      min-height: 0;
    }

    .side-panel {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    .panel-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .panel-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .recommendation-list,
    .active-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      overflow: auto;
    }

    .recommendation-item,
    .active-item {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-tertiary);
      padding: var(--spacing-xs) var(--spacing-sm);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .rec-header,
    .active-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--spacing-xs);
    }

    .rec-id,
    .active-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .rec-score {
      font-size: 11px;
      color: var(--primary-color);
      font-weight: 700;
    }

    .rec-reason {
      font-size: 11px;
      color: var(--text-secondary);
      line-height: 1.4;
    }

    .status {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .status-active { color: var(--success-color); }
    .status-paused { color: var(--warning-color); }
    .status-completed { color: var(--text-muted); }
    .status-failed,
    .status-error { color: var(--error-color); }

    .meta-row {
      display: flex;
      justify-content: space-between;
      gap: var(--spacing-xs);
      font-size: 10px;
      color: var(--text-muted);
    }

    .findings {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .finding {
      display: flex;
      gap: var(--spacing-xs);
      align-items: center;
      font-size: 11px;
      color: var(--text-secondary);
    }

    .severity {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .sev-critical,
    .sev-high { color: var(--error-color); }
    .sev-medium { color: var(--warning-color); }
    .sev-low,
    .sev-info { color: var(--text-muted); }

    .status-actions {
      display: flex;
      gap: var(--spacing-xs);
      padding-top: 2px;
    }

    .hint {
      font-size: 12px;
      color: var(--text-muted);
    }

    @media (max-width: 1100px) {
      .content {
        grid-template-columns: 1fr;
      }

      .toolbar {
        grid-template-columns: 1fr;
      }

      .actions {
        justify-content: flex-start;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpecialistsPageComponent implements OnInit, OnDestroy {
  private readonly orchestrationIpc = inject(OrchestrationIpcService);
  private readonly instanceIpc = inject(InstanceIpcService);

  readonly specialists = signal<SpecialistProfile[]>([]);
  readonly instances = signal<InstanceOption[]>([]);
  readonly selectedInstanceId = signal('');
  readonly taskDescription = signal('');
  readonly recommendations = signal<SpecialistRecommendation[]>([]);
  readonly activeInstances = signal<SpecialistInstance[]>([]);

  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private readonly recommendationScores = computed(() => {
    const scores = new Map<string, number>();
    for (const recommendation of this.recommendations()) {
      scores.set(recommendation.profileId, recommendation.relevanceScore);
    }
    return scores;
  });

  readonly orderedSpecialists = computed(() => {
    const scores = this.recommendationScores();
    return [...this.specialists()].sort((a, b) => {
      const scoreDiff = (scores.get(b.id) || 0) - (scores.get(a.id) || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return a.name.localeCompare(b.name);
    });
  });

  async ngOnInit(): Promise<void> {
    await this.refreshAll();
    this.pollTimer = setInterval(() => {
      void this.loadActiveInstances();
    }, 3000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async refreshAll(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);

    try {
      await Promise.all([
        this.loadSpecialists(),
        this.loadInstances(),
        this.loadActiveInstances(),
      ]);
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  async recommendSpecialists(): Promise<void> {
    if (!this.taskDescription().trim()) {
      this.errorMessage.set('Provide task context before requesting recommendations.');
      return;
    }

    this.errorMessage.set(null);
    this.working.set(true);

    try {
      const response = await this.orchestrationIpc.specialistRecommend({
        taskDescription: this.taskDescription().trim(),
      });
      const data = this.unwrapData<SpecialistRecommendation[]>(response, []);
      this.recommendations.set(
        [...data].sort((a, b) => b.relevanceScore - a.relevanceScore)
      );
    } finally {
      this.working.set(false);
    }
  }

  async createSpecialist(profile: SpecialistProfile): Promise<void> {
    if (!this.selectedInstanceId()) {
      this.errorMessage.set('Select an orchestrator instance before creating a specialist.');
      return;
    }

    this.errorMessage.set(null);
    this.working.set(true);

    try {
      const response = await this.orchestrationIpc.specialistCreateInstance(
        profile.id,
        this.selectedInstanceId()
      );
      this.unwrapData(response, null);
      await this.loadActiveInstances();
    } finally {
      this.working.set(false);
    }
  }

  async updateStatus(
    instanceId: string,
    status: 'active' | 'paused' | 'completed' | 'failed'
  ): Promise<void> {
    this.errorMessage.set(null);
    this.working.set(true);

    try {
      const response = await this.orchestrationIpc.specialistUpdateStatus(instanceId, status);
      this.unwrapData(response, null);
      await this.loadActiveInstances();
    } finally {
      this.working.set(false);
    }
  }

  onInstanceChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.selectedInstanceId.set(target.value);
  }

  onTaskDescriptionInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.taskDescription.set(target.value);
  }

  private async loadSpecialists(): Promise<void> {
    const response = await this.orchestrationIpc.specialistList();
    const profiles = this.unwrapData<SpecialistProfile[]>(response, []);
    this.specialists.set(profiles);
  }

  private async loadInstances(): Promise<void> {
    const response = await this.instanceIpc.listInstances();
    const data = this.unwrapData<unknown[]>(response, []);
    const options = data
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item) => ({
        id: String(item['id']),
        displayName: String(item['displayName'] || item['id']),
        status: String(item['status'] || 'unknown'),
      }));
    this.instances.set(options);

    if (!this.selectedInstanceId() && options.length > 0) {
      this.selectedInstanceId.set(options[0].id);
    }
  }

  private async loadActiveInstances(): Promise<void> {
    const response = await this.orchestrationIpc.specialistGetActiveInstances();
    const active = this.unwrapData<SpecialistInstance[]>(response, []);
    this.activeInstances.set(active);
  }

  private unwrapData<T>(response: IpcResponse, fallback: T): T {
    if (!response.success) {
      const message = response.error?.message || 'IPC request failed';
      this.errorMessage.set(message);
      return fallback;
    }
    return (response.data as T) ?? fallback;
  }
}
