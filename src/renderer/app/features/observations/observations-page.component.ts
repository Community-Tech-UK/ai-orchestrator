/**
 * Observations Page Component
 *
 * Displays agent observations, reflections, and recognized patterns.
 * Gracefully handles missing backend services for all three panels.
 */

import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ObservationIpcService } from '../../core/services/ipc/observation-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

interface Observation {
  id: string;
  timestamp: number;
  type: string;
  content: string;
  instanceId?: string;
}

interface Reflection {
  id: string;
  timestamp: number;
  content: string;
  confidence: number;
  evidence: string[];
  patterns: string[];
}

interface Pattern {
  type: string;
  frequency: number;
  description: string;
  lastSeen?: number;
}

type PanelState = 'loading' | 'unavailable' | 'empty' | 'loaded';

@Component({
  selector: 'app-observations-page',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-root">

      <!-- Page header -->
      <header class="page-header">
        <div class="header-left">
          <button class="back-btn" type="button" (click)="goBack()" aria-label="Back to dashboard">
            &larr; Back
          </button>
          <div class="header-text">
            <h1 class="page-title">Observations &amp; Reflections</h1>
            <p class="page-subtitle">Auto-reflection on agent actions and pattern recognition</p>
          </div>
        </div>
        <button class="refresh-btn" (click)="refresh()" [disabled]="isLoading()">
          <span [class.spinning]="isLoading()">&#8635;</span>
          Refresh
        </button>
      </header>

      <!-- Metric cards -->
      <section class="metrics-grid">
        <div class="metric-card">
          <div class="metric-value">{{ observations().length }}</div>
          <div class="metric-label">Total Observations</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">{{ reflections().length }}</div>
          <div class="metric-label">Total Reflections</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">{{ patterns().length }}</div>
          <div class="metric-label">Patterns Found</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">{{ lastReflectionLabel() }}</div>
          <div class="metric-label">Last Reflection</div>
        </div>
      </section>

      <!-- 3-column layout -->
      <div class="content-grid">

        <!-- Left: Observation Feed -->
        <aside class="panel observation-feed">
          <h2 class="panel-title">Observation Feed</h2>

          @if (observationState() === 'loading') {
            <div class="panel-placeholder">Loading observations...</div>
          } @else if (observationState() === 'unavailable') {
            <div class="panel-placeholder muted">Observation data unavailable</div>
          } @else if (observationState() === 'empty') {
            <div class="panel-placeholder muted">No observations yet</div>
          } @else {
            <ul class="observation-list">
              @for (obs of observations(); track obs.id) {
                <li
                  class="observation-item"
                  [class.expanded]="expandedObservationId() === obs.id"
                  (click)="toggleObservation(obs.id)"
                  (keydown.enter)="toggleObservation(obs.id)"
                  (keydown.space)="toggleObservation(obs.id)"
                  tabindex="0"
                  role="button"
                >
                  <div class="obs-header">
                    <span class="obs-type-badge">{{ obs.type }}</span>
                    <span class="obs-time">{{ formatTimestamp(obs.timestamp) }}</span>
                  </div>
                  <p class="obs-snippet">
                    {{ expandedObservationId() === obs.id ? obs.content : truncate(obs.content, 100) }}
                  </p>
                  @if (obs.instanceId) {
                    <span class="obs-instance">{{ obs.instanceId }}</span>
                  }
                </li>
              }
            </ul>
          }
        </aside>

        <!-- Center: Reflection Timeline -->
        <main class="panel reflection-timeline">
          <div class="panel-title-row">
            <h2 class="panel-title">Reflection Timeline</h2>
            <button
              class="force-reflect-btn"
              (click)="forceReflect()"
              [disabled]="isForceReflecting()"
            >
              {{ isForceReflecting() ? 'Reflecting...' : 'Force Reflect' }}
            </button>
          </div>

          @if (reflectionState() === 'loading') {
            <div class="panel-placeholder">Loading reflections...</div>
          } @else if (reflectionState() === 'unavailable') {
            <div class="panel-placeholder muted">Reflection data unavailable</div>
          } @else if (reflectionState() === 'empty') {
            <div class="panel-placeholder muted">No reflections recorded yet</div>
          } @else {
            <div class="reflection-cards">
              @for (ref of reflections(); track ref.id) {
                <div class="reflection-card">
                  <div class="reflection-header">
                    <span class="reflection-id">{{ truncate(ref.id, 12) }}</span>
                    <span class="reflection-time">{{ formatTimestamp(ref.timestamp) }}</span>
                  </div>

                  <p class="reflection-content">{{ ref.content }}</p>

                  @if (ref.evidence.length > 0) {
                    <div class="evidence-section">
                      <span class="section-label">Evidence</span>
                      <ul class="evidence-list">
                        @for (item of ref.evidence; track item) {
                          <li class="evidence-item">{{ item }}</li>
                        }
                      </ul>
                    </div>
                  }

                  <div class="confidence-row">
                    <span class="confidence-label">Confidence</span>
                    <div class="confidence-bar-track">
                      <div
                        class="confidence-bar-fill"
                        [style.width.%]="ref.confidence * 100"
                        [class.high]="ref.confidence >= 0.7"
                        [class.mid]="ref.confidence >= 0.4 && ref.confidence < 0.7"
                        [class.low]="ref.confidence < 0.4"
                      ></div>
                    </div>
                    <span class="confidence-value">{{ (ref.confidence * 100).toFixed(0) }}%</span>
                  </div>
                </div>
              }
            </div>
          }
        </main>

        <!-- Right: Pattern Panel -->
        <aside class="panel pattern-panel">
          <h2 class="panel-title">Patterns</h2>

          @if (patternState() === 'loading') {
            <div class="panel-placeholder">Loading patterns...</div>
          } @else if (patternState() === 'unavailable') {
            <div class="panel-placeholder muted">Pattern data unavailable</div>
          } @else if (patternState() === 'empty') {
            <div class="panel-placeholder muted">No patterns detected yet</div>
          } @else {
            <div class="pattern-cards">
              @for (pat of patterns(); track pat.type) {
                <div class="pattern-card">
                  <div class="pattern-type">{{ pat.type }}</div>
                  <p class="pattern-description">{{ pat.description }}</p>
                  <div class="pattern-stats">
                    <span class="pattern-stat">
                      <span class="stat-label">Freq</span>
                      <span class="stat-value">{{ pat.frequency }}</span>
                    </span>
                    @if (pat.lastSeen) {
                      <span class="pattern-stat">
                        <span class="stat-label">Last</span>
                        <span class="stat-value">{{ formatTimestamp(pat.lastSeen) }}</span>
                      </span>
                    }
                  </div>
                </div>
              }
            </div>
          }
        </aside>

      </div>
    </div>
  `,
  styles: [`
    .page-root {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding: 1.5rem;
      height: 100%;
      box-sizing: border-box;
      overflow-y: auto;
      color: var(--text-primary);
    }

    /* Header */
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .back-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.4rem 0.75rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.15s;

      &:hover {
        background: var(--bg-hover);
      }
    }

    .page-title {
      margin: 0;
      font-size: 1.25rem;
      font-weight: 600;
    }

    .page-subtitle {
      margin: 0.125rem 0 0;
      font-size: 0.8125rem;
      color: var(--text-muted);
    }

    .refresh-btn {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.5rem 1rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 0.875rem;
      cursor: pointer;
      transition: background 0.15s;

      &:hover:not(:disabled) {
        background: var(--bg-hover);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .spinning {
      display: inline-block;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }

    /* Notice banner */
    .notice-banner {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.625rem 1rem;
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.35);
      border-radius: var(--radius-sm);
      font-size: 0.8125rem;
      color: #f59e0b;
    }

    .notice-icon {
      font-size: 1rem;
      flex-shrink: 0;
    }

    /* Metrics */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1rem;

      @media (max-width: 900px) {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    .metric-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: 1rem 1.25rem;
      text-align: center;
    }

    .metric-value {
      font-size: 1.75rem;
      font-weight: 700;
      line-height: 1.2;
    }

    .metric-label {
      margin-top: 0.25rem;
      font-size: 0.8125rem;
      color: var(--text-muted);
    }

    /* 3-column content layout */
    .content-grid {
      display: grid;
      grid-template-columns: 300px 1fr 280px;
      gap: 1rem;
      align-items: start;

      @media (max-width: 1100px) {
        grid-template-columns: 1fr;
      }
    }

    /* Shared panel */
    .panel {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: 1rem;
      min-height: 400px;
    }

    .panel-title {
      margin: 0 0 0.75rem;
      font-size: 0.9375rem;
      font-weight: 600;
    }

    .panel-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.75rem;
      gap: 0.5rem;

      .panel-title {
        margin: 0;
      }
    }

    .panel-placeholder {
      padding: 2rem 1rem;
      text-align: center;
      font-size: 0.875rem;
      color: var(--text-secondary);

      &.muted {
        color: var(--text-muted);
      }
    }

    /* Observation list */
    .observation-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-height: 600px;
      overflow-y: auto;
    }

    .observation-item {
      padding: 0.625rem 0.75rem;
      background: var(--bg-tertiary);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: border-color 0.15s;
      outline: none;

      &:hover,
      &:focus-visible {
        border-color: var(--border-color);
      }

      &.expanded {
        border-color: var(--primary-color);
      }
    }

    .obs-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.375rem;
      gap: 0.5rem;
    }

    .obs-type-badge {
      padding: 0.125rem 0.4rem;
      background: rgba(99, 102, 241, 0.15);
      color: #818cf8;
      border-radius: 3px;
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
    }

    .obs-time {
      font-size: 0.6875rem;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .obs-snippet {
      margin: 0;
      font-size: 0.8125rem;
      color: var(--text-primary);
      line-height: 1.45;
    }

    .obs-instance {
      display: inline-block;
      margin-top: 0.375rem;
      padding: 0.0625rem 0.375rem;
      background: var(--bg-secondary);
      border-radius: 3px;
      font-size: 0.6875rem;
      color: var(--text-muted);
      font-family: monospace;
    }

    /* Force reflect button */
    .force-reflect-btn {
      padding: 0.35rem 0.75rem;
      background: var(--primary-color);
      border: none;
      border-radius: var(--radius-sm);
      color: #fff;
      font-size: 0.8125rem;
      cursor: pointer;
      transition: opacity 0.15s;
      white-space: nowrap;

      &:hover:not(:disabled) {
        opacity: 0.85;
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    /* Reflection cards */
    .reflection-cards {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      max-height: 600px;
      overflow-y: auto;
    }

    .reflection-card {
      padding: 0.875rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
    }

    .reflection-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.5rem;
    }

    .reflection-id {
      font-family: monospace;
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .reflection-time {
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .reflection-content {
      margin: 0 0 0.625rem;
      font-size: 0.875rem;
      line-height: 1.5;
      color: var(--text-primary);
    }

    .evidence-section {
      margin-bottom: 0.625rem;
    }

    .section-label {
      display: block;
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 0.25rem;
    }

    .evidence-list {
      margin: 0;
      padding-left: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }

    .evidence-item {
      font-size: 0.8125rem;
      color: var(--text-secondary);
    }

    /* Confidence bar */
    .confidence-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.25rem;
    }

    .confidence-label {
      font-size: 0.75rem;
      color: var(--text-muted);
      width: 70px;
      flex-shrink: 0;
    }

    .confidence-bar-track {
      flex: 1;
      height: 6px;
      background: var(--bg-secondary);
      border-radius: 3px;
      overflow: hidden;
    }

    .confidence-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s ease;

      &.high { background: #10b981; }
      &.mid  { background: #f59e0b; }
      &.low  { background: #ef4444; }
    }

    .confidence-value {
      font-size: 0.75rem;
      color: var(--text-secondary);
      width: 36px;
      text-align: right;
      flex-shrink: 0;
    }

    /* Pattern cards */
    .pattern-cards {
      display: flex;
      flex-direction: column;
      gap: 0.625rem;
      max-height: 600px;
      overflow-y: auto;
    }

    .pattern-card {
      padding: 0.75rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
    }

    .pattern-type {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      color: #818cf8;
      margin-bottom: 0.375rem;
    }

    .pattern-description {
      margin: 0 0 0.5rem;
      font-size: 0.8125rem;
      color: var(--text-primary);
      line-height: 1.45;
    }

    .pattern-stats {
      display: flex;
      gap: 0.75rem;
    }

    .pattern-stat {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .stat-label {
      font-size: 0.625rem;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .stat-value {
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--text-primary);
    }
  `],
})
export class ObservationsPageComponent implements OnInit {
  private router = inject(Router);
  private observationIpc = inject(ObservationIpcService);

  readonly observations = signal<Observation[]>([]);
  readonly reflections = signal<Reflection[]>([]);
  readonly patterns = signal<Pattern[]>([]);

  readonly observationState = signal<PanelState>('loading');
  readonly reflectionState = signal<PanelState>('loading');
  readonly patternState = signal<PanelState>('loading');

  readonly isLoading = signal(false);
  readonly isForceReflecting = signal(false);
  readonly expandedObservationId = signal<string | null>(null);

  readonly lastReflectionLabel = computed(() => {
    const refs = this.reflections();
    if (refs.length === 0) return 'Never';
    const latest = refs.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
    return this.formatTimestamp(latest.timestamp);
  });

  ngOnInit(): void {
    this.loadAll();
  }

  refresh(): void {
    this.loadAll();
  }

  goBack(): void {
    void this.router.navigate(['/']);
  }

  toggleObservation(id: string): void {
    this.expandedObservationId.update(current => (current === id ? null : id));
  }

  async forceReflect(): Promise<void> {
    this.isForceReflecting.set(true);
    try {
      const res: IpcResponse = await this.observationIpc.forceReflect();
      if (res.success) {
        await this.loadReflections();
      }
    } catch {
      // Gracefully ignore errors — service may not be available
    } finally {
      this.isForceReflecting.set(false);
    }
  }

  private async loadAll(): Promise<void> {
    this.isLoading.set(true);
    this.observationState.set('loading');
    this.reflectionState.set('loading');
    this.patternState.set('loading');

    await Promise.all([
      this.loadObservations(),
      this.loadReflections(),
      this.loadPatterns(),
    ]);

    this.isLoading.set(false);
  }

  private async loadObservations(): Promise<void> {
    try {
      const res: IpcResponse = await this.observationIpc.getObservations({ limit: 100 });
      if (res.success && Array.isArray(res.data)) {
        this.observations.set(res.data as Observation[]);
        this.observationState.set(res.data.length === 0 ? 'empty' : 'loaded');
      } else {
        this.observations.set([]);
        this.observationState.set('unavailable');
      }
    } catch {
      this.observations.set([]);
      this.observationState.set('unavailable');
    }
  }

  private async loadReflections(): Promise<void> {
    try {
      const res: IpcResponse = await this.observationIpc.getReflections({ limit: 50 });
      if (res.success && Array.isArray(res.data)) {
        this.reflections.set(res.data as Reflection[]);
        this.reflectionState.set(res.data.length === 0 ? 'empty' : 'loaded');
      } else {
        this.reflections.set([]);
        this.reflectionState.set('unavailable');
      }
    } catch {
      this.reflections.set([]);
      this.reflectionState.set('unavailable');
    }
  }

  private async loadPatterns(): Promise<void> {
    try {
      const res: IpcResponse = await this.observationIpc.getPatterns();
      if (res.success && Array.isArray(res.data)) {
        this.patterns.set(res.data as Pattern[]);
        this.patternState.set(res.data.length === 0 ? 'empty' : 'loaded');
      } else {
        this.patterns.set([]);
        this.patternState.set('unavailable');
      }
    } catch {
      this.patterns.set([]);
      this.patternState.set('unavailable');
    }
  }

  formatTimestamp(ts: number): string {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
  }
}
