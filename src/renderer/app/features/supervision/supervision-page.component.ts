/**
 * Supervision Page
 * Container that wires supervision tree UI to supervision IPC APIs.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type { SupervisionTree } from '../../../../shared/types/supervision.types';
import { SupervisionTreeViewComponent } from './tree-view.component';
import { OrchestrationIpcService } from '../../core/services/ipc/orchestration-ipc.service';
import { BaseIpcService } from '../../core/services/ipc';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

interface SupervisionHealthData {
  stats?: {
    totalNodes?: number;
    runningNodes?: number;
    failedNodes?: number;
    activeWorkers?: number;
  };
  circuitBreakers?: Record<string, { state?: string; failureCount?: number }>;
}

@Component({
  selector: 'app-supervision-page',
  standalone: true,
  imports: [CommonModule, SupervisionTreeViewComponent],
  template: `
    <div class="page">
      <div class="page-header">
        <div class="header-title">
          <span class="title">Supervision</span>
          <span class="subtitle">Tree health, failures, and circuit breakers</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="working()" (click)="refreshAll()">Refresh</button>
        </div>
      </div>

      <div class="stats-bar">
        <span class="stat">Nodes: {{ health()?.stats?.totalNodes ?? 0 }}</span>
        <span class="stat">Running: {{ health()?.stats?.runningNodes ?? 0 }}</span>
        <span class="stat failed">Failed: {{ health()?.stats?.failedNodes ?? 0 }}</span>
        <span class="stat">Workers: {{ health()?.stats?.activeWorkers ?? 0 }}</span>
      </div>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      <div class="content">
        <div class="main-panel">
          <app-supervision-tree-view
            [tree]="tree()"
            (nodeAction)="onNodeAction($event)"
          />
        </div>

        <div class="side-panel">
          <div class="panel-card">
            <div class="panel-title">Circuit Breakers</div>
            @if (circuitBreakerEntries().length > 0) {
              <div class="breaker-list">
                @for (entry of circuitBreakerEntries(); track entry.id) {
                  <div class="breaker-item">
                    <div class="breaker-header">
                      <span class="breaker-id">{{ entry.id }}</span>
                      <span class="breaker-state" [class]="'state-' + entry.state">
                        {{ entry.state }}
                      </span>
                    </div>
                    <div class="breaker-meta">Failures: {{ entry.failureCount }}</div>
                  </div>
                }
              </div>
            } @else {
              <div class="hint">No circuit breakers registered.</div>
            }
          </div>

          <div class="panel-card">
            <div class="panel-title">Live Events</div>
            @if (events().length > 0) {
              <div class="event-list">
                @for (event of events(); track event.id) {
                  <div class="event-item">
                    <span class="event-type">{{ event.type }}</span>
                    <span class="event-time">{{ formatTime(event.timestamp) }}</span>
                  </div>
                }
              </div>
            } @else {
              <div class="hint">No supervision events yet.</div>
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
      flex: 1;
      min-width: 0;
    }

    .title {
      font-size: 18px;
      font-weight: 700;
    }

    .subtitle {
      font-size: 12px;
      color: var(--text-muted);
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

    .stats-bar {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
    }

    .stat {
      font-size: 11px;
      color: var(--text-secondary);
    }

    .stat.failed {
      color: var(--error-color);
      font-weight: 700;
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
      gap: var(--spacing-xs);
      overflow: auto;
    }

    .panel-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      margin-bottom: 2px;
    }

    .breaker-list,
    .event-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .breaker-item,
    .event-item {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-tertiary);
      padding: var(--spacing-xs) var(--spacing-sm);
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .breaker-header,
    .event-item {
      display: flex;
      justify-content: space-between;
      gap: var(--spacing-xs);
      align-items: center;
    }

    .breaker-id {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-primary);
      overflow-wrap: anywhere;
    }

    .breaker-state {
      font-size: 10px;
      font-weight: 700;
    }

    .state-open { color: var(--error-color); }
    .state-half-open { color: var(--warning-color); }
    .state-closed { color: var(--success-color); }

    .breaker-meta,
    .event-time {
      font-size: 10px;
      color: var(--text-muted);
    }

    .event-type {
      font-size: 11px;
      color: var(--text-primary);
    }

    .hint {
      font-size: 12px;
      color: var(--text-muted);
    }

    @media (max-width: 1100px) {
      .content {
        grid-template-columns: 1fr;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SupervisionPageComponent implements OnInit, OnDestroy {
  private readonly orchestrationIpc = inject(OrchestrationIpcService);
  private readonly baseIpc = inject(BaseIpcService);

  readonly tree = signal<SupervisionTree | null>(null);
  readonly health = signal<SupervisionHealthData | null>(null);
  readonly events = signal<{ id: string; type: string; timestamp: number }[]>([]);

  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: (() => void)[] = [];

  readonly circuitBreakerEntries = signal<{
    id: string;
    state: string;
    failureCount: number;
  }[]>([]);

  async ngOnInit(): Promise<void> {
    await this.refreshAll();
    this.subscribeToEvents();
    this.pollTimer = setInterval(() => {
      void this.refreshAll();
    }, 5000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  async refreshAll(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);

    try {
      const [treeResponse, healthResponse] = await Promise.all([
        this.orchestrationIpc.supervisionGetTree(),
        this.orchestrationIpc.supervisionGetHealth(),
      ]);

      const treeData = this.unwrapData<Record<string, unknown> | null>(treeResponse, null);
      const root = treeData && typeof treeData['root'] === 'object' ? treeData : null;
      this.tree.set(root as unknown as SupervisionTree | null);

      const healthData = this.unwrapData<SupervisionHealthData | null>(healthResponse, null);
      this.health.set(healthData);
      this.updateCircuitBreakers(healthData);
    } finally {
      this.working.set(false);
    }
  }

  async onNodeAction(payload: { nodeId: string; action: 'restart' | 'stop' | 'escalate' }): Promise<void> {
    if (payload.action !== 'escalate') {
      this.errorMessage.set(
        'Restart/stop controls are not exposed by IPC. Use the instance panel for direct lifecycle control.'
      );
      return;
    }

    this.working.set(true);
    this.errorMessage.set(null);

    try {
      const response = await this.orchestrationIpc.supervisionHandleFailure(
        payload.nodeId,
        'Manual escalation requested from supervision page'
      );
      this.unwrapData(response, null);
      await this.refreshAll();
    } finally {
      this.working.set(false);
    }
  }

  formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString();
  }

  private subscribeToEvents(): void {
    const channels = [
      'supervision:tree-updated',
      'supervision:worker-failed',
      'supervision:worker-restarted',
      'supervision:circuit-breaker-changed',
      'supervision:health-changed',
      'supervision:health-global',
      'supervision:exhausted',
    ];

    for (const channel of channels) {
      const unsubscribe = this.baseIpc.on(channel, () => {
        this.pushEvent(channel);
        void this.refreshAll();
      });
      this.unsubscribers.push(unsubscribe);
    }
  }

  private pushEvent(type: string): void {
    this.events.update((prev) => {
      const next = [
        { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type, timestamp: Date.now() },
        ...prev,
      ];
      return next.slice(0, 50);
    });
  }

  private updateCircuitBreakers(data: SupervisionHealthData | null): void {
    const entries = Object.entries(data?.circuitBreakers || {}).map(([id, state]) => ({
      id,
      state: String(state.state || 'unknown'),
      failureCount: Number(state.failureCount || 0),
    }));
    this.circuitBreakerEntries.set(entries);
  }

  private unwrapData<T>(response: IpcResponse, fallback: T): T {
    if (!response.success) {
      this.errorMessage.set(response.error?.message || 'IPC request failed');
      return fallback;
    }
    return (response.data as T) ?? fallback;
  }
}
