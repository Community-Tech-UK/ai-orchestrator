/**
 * Enhanced Debate Visualization Component
 *
 * Comprehensive debate visualization with:
 * - Real-time network graph
 * - Position timeline
 * - Consensus heatmap
 * - Streaming contributions
 * - Configuration panel
 * - Export functionality
 */

import {
  Component,
  signal,
  computed,
  inject,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SlicePipe } from '@angular/common';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

// Import visualization components
import { DebateNetworkGraphComponent, type NetworkNode, type NetworkLink } from './components/debate-network-graph.component';
import { DebateTimelineComponent, type AgentPosition } from './components/debate-timeline.component';
import { DebateConsensusHeatmapComponent, type TopicConsensus } from './components/debate-consensus-heatmap.component';
import { DebateConfigPanelComponent, type DebateConfig } from './components/debate-config-panel.component';
import { DebateExportService } from './services/debate-export.service';
import { DebateStreamingService, type StreamingContribution } from './services/debate-streaming.service';
import type { DebateResult, DebateContribution } from '../../../../shared/types/debate.types';

type VisualizationView = 'network' | 'timeline' | 'heatmap' | 'split';

@Component({
  selector: 'app-enhanced-debate-visualization',
  standalone: true,
  imports: [
    FormsModule,
    SlicePipe,
    DebateNetworkGraphComponent,
    DebateTimelineComponent,
    DebateConsensusHeatmapComponent,
    DebateConfigPanelComponent,
  ],
  template: `
    <div class="visualization-container">
      <!-- Header -->
      <div class="viz-header">
        <div class="header-left">
          <span class="viz-icon">💬</span>
          <h2 class="viz-title">Debate Visualization</h2>
          @if (streamingService.isStreaming()) {
            <span class="streaming-badge">
              <span class="pulse-dot"></span>
              Live
            </span>
          }
        </div>

        <div class="header-center">
          <!-- Query Input -->
          <div class="query-input-wrapper">
            <input
              type="text"
              class="query-input"
              placeholder="Enter debate query..."
              [(ngModel)]="queryInput"
              (keydown.enter)="startDebate()"
              [disabled]="streamingService.isStreaming()"
            />
            @if (streamingService.isStreaming()) {
              <button class="control-btn stop" (click)="stopDebate()">
                ⏹️ Stop
              </button>
            } @else {
              <button class="control-btn start" (click)="startDebate()" [disabled]="!queryInput">
                ▶️ Start
              </button>
            }
          </div>
        </div>

        <div class="header-right">
          <!-- View Toggle -->
          <div class="view-toggle">
            @for (view of views; track view.id) {
              <button
                class="view-btn"
                [class.active]="activeView() === view.id"
                (click)="setActiveView(view.id)"
              >
                {{ view.icon }}
              </button>
            }
          </div>

          <!-- Export -->
          <div class="export-dropdown">
            <button class="action-btn" (click)="toggleExportMenu()">
              📥
            </button>
            @if (showExportMenu()) {
              <div class="export-menu">
                <button (click)="exportAs('html')">HTML Report</button>
                <button (click)="exportAs('json')">JSON Data</button>
                <button (click)="exportAs('markdown')">Markdown</button>
                <button (click)="exportAs('pdf')">PDF Report</button>
              </div>
            }
          </div>

          <!-- Config Toggle -->
          <button
            class="action-btn"
            [class.active]="showConfig()"
            (click)="toggleConfig()"
          >
            ⚙️
          </button>
        </div>
      </div>

      <!-- Status Bar -->
      <div class="status-bar">
        <span class="status-item">
          Round {{ streamingService.currentRound() }} / {{ config().maxRounds }}
        </span>
        <span class="status-item">
          Consensus: {{ (streamingService.consensusScore() * 100).toFixed(0) }}%
        </span>
        <span class="status-item">
          {{ contributions().length }} contributions
        </span>
        @if (streamingService.state().lastUpdate) {
          <span class="status-item">
            Updated: {{ formatTime(streamingService.state().lastUpdate!) }}
          </span>
        }
      </div>

      <!-- Main Content -->
      <div class="main-content">
        <!-- Config Panel (Sidebar) -->
        @if (showConfig()) {
          <div class="config-sidebar">
            <app-debate-config-panel
              [config]="config()"
              (configChange)="onConfigChange($event)"
            />
          </div>
        }

        <!-- Visualization Area -->
        <div class="visualization-area" [class.with-sidebar]="showConfig()">
          @switch (activeView()) {
            @case ('network') {
              <div class="viz-panel full">
                <app-debate-network-graph
                  [nodes]="networkNodes()"
                  [links]="networkLinks()"
                  (nodeClick)="onNodeClick($event)"
                />
              </div>
            }

            @case ('timeline') {
              <div class="viz-panel full">
                <app-debate-timeline
                  [agentPositions]="agentPositions()"
                />
              </div>
            }

            @case ('heatmap') {
              <div class="viz-panel full">
                <app-debate-consensus-heatmap
                  [data]="consensusData()"
                />
              </div>
            }

            @case ('split') {
              <div class="split-view">
                <div class="viz-panel half">
                  <app-debate-network-graph
                    [nodes]="networkNodes()"
                    [links]="networkLinks()"
                    (nodeClick)="onNodeClick($event)"
                  />
                </div>
                <div class="viz-panel half">
                  <app-debate-timeline
                    [agentPositions]="agentPositions()"
                  />
                </div>
              </div>
            }
          }

          <!-- Live Contributions Feed -->
          @if (streamingService.isStreaming()) {
            <div class="live-feed">
              <h4 class="feed-title">Live Contributions</h4>
              <div class="feed-content">
                @for (contrib of contributions() | slice:-3; track contrib.id) {
                  <div class="live-contribution" [class.streaming]="contrib.isStreaming">
                    <span class="agent-badge">{{ contrib.agentId }}</span>
                    <span class="contrib-text">
                      {{ contrib.isStreaming ? contrib.streamedContent : contrib.content }}
                      @if (contrib.isStreaming) {
                        <span class="cursor">|</span>
                      }
                    </span>
                  </div>
                }
              </div>
            </div>
          }
        </div>
      </div>

      <!-- Consensus Timeline -->
      <div class="consensus-timeline">
        <div class="timeline-track">
          @for (point of consensusHistory(); track point.round) {
            <div
              class="timeline-point"
              [style.left.%]="(point.round / config().maxRounds) * 100"
              [style.bottom.%]="point.score * 100"
            >
              <span class="point-marker"></span>
              <span class="point-label">{{ (point.score * 100).toFixed(0) }}%</span>
            </div>
          }
        </div>
        <div class="timeline-labels">
          <span>Consensus Evolution</span>
          <span class="timeline-legend">
            <span class="legend-item">
              <span class="legend-marker low"></span> Low
            </span>
            <span class="legend-item">
              <span class="legend-marker high"></span> High
            </span>
          </span>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .visualization-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-primary);
    }

    .viz-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .viz-icon {
      font-size: 20px;
    }

    .viz-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }

    .streaming-badge {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 12px;
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
      font-size: 10px;
      font-weight: 600;
    }

    .pulse-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ef4444;
      animation: pulse 1s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }

    .header-center {
      flex: 1;
      max-width: 500px;
      margin: 0 var(--spacing-md);
    }

    .query-input-wrapper {
      display: flex;
      gap: var(--spacing-sm);
    }

    .query-input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-size: 12px;

      &:focus {
        outline: none;
        border-color: var(--primary-color);
      }

      &:disabled {
        opacity: 0.5;
      }
    }

    .control-btn {
      padding: 8px 16px;
      border: none;
      border-radius: var(--radius-sm);
      font-size: 12px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &.start {
        background: var(--primary-color);
        color: white;

        &:hover:not(:disabled) {
          filter: brightness(1.1);
        }
      }

      &.stop {
        background: #ef4444;
        color: white;
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .view-toggle {
      display: flex;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }

    .view-btn {
      padding: 6px 10px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        color: var(--text-primary);
      }

      &.active {
        background: var(--primary-color);
        color: white;
      }
    }

    .action-btn {
      padding: 6px 10px;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }

      &.active {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: white;
      }
    }

    .export-dropdown {
      position: relative;
    }

    .export-menu {
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 4px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      overflow: hidden;
      z-index: 100;

      button {
        display: block;
        width: 100%;
        padding: 8px 16px;
        border: none;
        background: transparent;
        color: var(--text-primary);
        font-size: 12px;
        text-align: left;
        cursor: pointer;
        white-space: nowrap;

        &:hover {
          background: var(--bg-hover);
        }
      }
    }

    .status-bar {
      display: flex;
      gap: var(--spacing-lg);
      padding: var(--spacing-xs) var(--spacing-md);
      background: var(--bg-tertiary);
      border-bottom: 1px solid var(--border-color);
    }

    .status-item {
      font-size: 10px;
      color: var(--text-muted);
    }

    .main-content {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    .config-sidebar {
      width: 280px;
      border-right: 1px solid var(--border-color);
      overflow-y: auto;
    }

    .visualization-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: var(--spacing-md);
      overflow: hidden;
      position: relative;

      &.with-sidebar {
        padding-left: var(--spacing-sm);
      }
    }

    .viz-panel {
      background: var(--bg-secondary);
      border-radius: var(--radius-md);
      overflow: hidden;

      &.full {
        flex: 1;
      }

      &.half {
        flex: 1;
      }
    }

    .split-view {
      display: flex;
      gap: var(--spacing-md);
      flex: 1;
    }

    .live-feed {
      position: absolute;
      bottom: var(--spacing-md);
      right: var(--spacing-md);
      width: 300px;
      max-height: 200px;
      background: rgba(30, 30, 30, 0.95);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }

    .feed-title {
      padding: var(--spacing-xs) var(--spacing-sm);
      margin: 0;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-primary);
      background: var(--bg-tertiary);
      border-bottom: 1px solid var(--border-color);
    }

    .feed-content {
      padding: var(--spacing-sm);
      max-height: 160px;
      overflow-y: auto;
    }

    .live-contribution {
      padding: var(--spacing-xs);
      margin-bottom: var(--spacing-xs);
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-size: 11px;

      &.streaming {
        border-left: 2px solid var(--primary-color);
      }
    }

    .agent-badge {
      display: inline-block;
      padding: 1px 6px;
      margin-right: 6px;
      border-radius: 4px;
      background: var(--primary-color);
      color: white;
      font-size: 9px;
      font-weight: 600;
    }

    .contrib-text {
      color: var(--text-secondary);
    }

    .cursor {
      animation: blink 1s step-end infinite;
    }

    @keyframes blink {
      50% { opacity: 0; }
    }

    .consensus-timeline {
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-color);
    }

    .timeline-track {
      position: relative;
      height: 40px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
    }

    .timeline-point {
      position: absolute;
      transform: translateX(-50%);
    }

    .point-marker {
      display: block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--primary-color);
    }

    .point-label {
      position: absolute;
      top: -16px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 9px;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .timeline-labels {
      display: flex;
      justify-content: space-between;
      margin-top: var(--spacing-xs);
      font-size: 10px;
      color: var(--text-muted);
    }

    .timeline-legend {
      display: flex;
      gap: var(--spacing-md);
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .legend-marker {
      width: 8px;
      height: 8px;
      border-radius: 50%;

      &.low {
        background: #ef4444;
      }

      &.high {
        background: #10b981;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnhancedDebateVisualizationComponent implements OnInit, OnDestroy {
  streamingService = inject(DebateStreamingService);
  private exportService = inject(DebateExportService);
  private destroy$ = new Subject<void>();

  // View configuration
  views = [
    { id: 'network' as const, icon: '🕸️', label: 'Network' },
    { id: 'timeline' as const, icon: '📈', label: 'Timeline' },
    { id: 'heatmap' as const, icon: '🔥', label: 'Heatmap' },
    { id: 'split' as const, icon: '⬜', label: 'Split' },
  ];

  // State
  activeView = signal<VisualizationView>('split');
  showConfig = signal<boolean>(false);
  showExportMenu = signal<boolean>(false);
  queryInput = '';

  config = signal<DebateConfig>({
    agentCount: 3,
    convergenceThreshold: 0.8,
    maxRounds: 4,
    temperatureMin: 0.3,
    temperatureMax: 0.9,
    enableHumanIntervention: false,
    timeout: 300000,
  });

  // Computed data
  contributions = computed(() => this.streamingService.state().contributions);
  networkNodes = computed(() => this.streamingService.state().networkNodes);
  networkLinks = computed(() => this.streamingService.state().networkLinks);
  consensusHistory = computed(() => this.streamingService.state().consensusHistory);

  // Transform data for components
  agentPositions = computed(() => {
    const contributions = this.contributions();
    const agentMap = new Map<string, StreamingContribution[]>();

    for (const contrib of contributions) {
      const existing = agentMap.get(contrib.agentId) || [];
      existing.push(contrib);
      agentMap.set(contrib.agentId, existing);
    }

    return Array.from(agentMap.entries()).map(([agentId, contribs]) => ({
      agentId,
      positions: contribs.map((c, i) => ({
        roundNumber: c.roundNumber,
        roundType: this.getRoundType(c.roundNumber) as 'initial' | 'critique' | 'defense' | 'synthesis',
        summary: c.content.substring(0, 100) + '...',
        confidence: c.confidence,
        changed: i > 0 && this.hasPositionChanged(contribs[i - 1], c),
      })),
    }));
  });

  consensusData = computed(() => {
    const contributions = this.contributions();
    const data: TopicConsensus[] = [];

    // Extract topics from contributions (simplified)
    const topics = ['Main Question', 'Approach', 'Evidence', 'Conclusion'];

    for (const contrib of contributions) {
      for (const topic of topics) {
        data.push({
          topic,
          agentId: contrib.agentId,
          stance: (contrib.confidence - 0.5) * 2, // Convert to -1 to 1
          confidence: contrib.confidence,
        });
      }
    }

    return data;
  });

  ngOnInit(): void {
    // Subscribe to streaming events
    this.streamingService.getEventStream()
      .pipe(takeUntil(this.destroy$))
      .subscribe(event => {
        // Handle events if needed
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  setActiveView(view: VisualizationView): void {
    this.activeView.set(view);
  }

  toggleConfig(): void {
    this.showConfig.update(v => !v);
  }

  toggleExportMenu(): void {
    this.showExportMenu.update(v => !v);
  }

  async startDebate(): Promise<void> {
    if (!this.queryInput.trim()) return;

    try {
      await this.streamingService.startDebate(this.queryInput, {
        agentCount: this.config().agentCount,
        maxRounds: this.config().maxRounds,
        convergenceThreshold: this.config().convergenceThreshold,
      });
    } catch (error) {
      console.error('Failed to start debate:', error);
    }
  }

  async stopDebate(): Promise<void> {
    await this.streamingService.stopDebate();
  }

  onConfigChange(newConfig: DebateConfig): void {
    this.config.set(newConfig);
  }

  onNodeClick(nodeId: string): void {
    console.log('Node clicked:', nodeId);
  }

  async exportAs(format: 'html' | 'json' | 'markdown' | 'pdf'): Promise<void> {
    this.showExportMenu.set(false);

    const result = await this.streamingService.getResult();
    if (!result) {
      console.error('No debate result to export');
      return;
    }

    switch (format) {
      case 'html':
        this.exportService.exportAsHTML(result);
        break;
      case 'json':
        this.exportService.exportAsJSON(result);
        break;
      case 'markdown':
        this.exportService.exportAsMarkdown(result);
        break;
      case 'pdf':
        await this.exportService.exportAsPDF(result);
        break;
    }
  }

  formatTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(timestamp).toLocaleTimeString();
  }

  private getRoundType(roundNumber: number): string {
    const types = ['initial', 'critique', 'defense', 'synthesis'];
    return types[(roundNumber - 1) % types.length];
  }

  private hasPositionChanged(prev: StreamingContribution, current: StreamingContribution): boolean {
    // Simple heuristic: position changed if confidence changed significantly
    return Math.abs(prev.confidence - current.confidence) > 0.1;
  }
}
