// src/renderer/app/features/remote-nodes/node-card.component.ts
import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';
import type { WorkerNodeInfo } from '../../../../shared/types/worker-node.types';

@Component({
  selector: 'app-node-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="node-card" [class]="'status-' + node().status">
      <div class="node-header">
        <span class="status-dot" [class]="'dot-' + node().status"></span>
        <span class="node-name">{{ node().name }}</span>
        <span class="node-platform">{{ platformLabel() }}</span>
      </div>

      <div class="node-metrics">
        <div class="metric">
          <span class="metric-label">CPU</span>
          <span class="metric-value">{{ node().capabilities.cpuCores }} cores</span>
        </div>
        <div class="metric">
          <span class="metric-label">Memory</span>
          <span class="metric-value">{{ memoryLabel() }}</span>
        </div>
        @if (node().capabilities.gpuName) {
          <div class="metric">
            <span class="metric-label">GPU</span>
            <span class="metric-value">{{ node().capabilities.gpuName }}</span>
          </div>
        }
        <div class="metric">
          <span class="metric-label">Instances</span>
          <span class="metric-value">{{ node().activeInstances }} / {{ node().capabilities.maxConcurrentInstances }}</span>
        </div>
        @if (node().latencyMs !== undefined) {
          <div class="metric">
            <span class="metric-label">Latency</span>
            <span class="metric-value">{{ node().latencyMs }}ms</span>
          </div>
        }
      </div>

      <div class="node-capabilities">
        @for (cli of node().capabilities.supportedClis; track cli) {
          <span class="cap-badge">{{ cli }}</span>
        }
        @if (node().capabilities.hasBrowserRuntime) {
          <span class="cap-badge browser">browser</span>
        }
        @if (node().capabilities.hasDocker) {
          <span class="cap-badge docker">docker</span>
        }
      </div>
    </div>
  `,
  styles: [`
    .node-card {
      padding: 16px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      transition: all var(--transition-fast);
    }

    .node-card:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.1);
    }

    .node-card.status-disconnected {
      opacity: 0.5;
    }

    .node-card.status-degraded {
      border-color: rgba(var(--warning-rgb), 0.3);
    }

    .node-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .dot-connected { background: var(--color-success); }
    .dot-connecting { background: var(--color-info); animation: pulse 1.5s infinite; }
    .dot-degraded { background: var(--color-warning); }
    .dot-disconnected { background: var(--color-muted); }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .node-name {
      font-weight: 600;
      font-size: 14px;
      color: var(--color-text-primary);
    }

    .node-platform {
      margin-left: auto;
      font-size: 11px;
      color: var(--color-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .node-metrics {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }

    .metric {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .metric-label {
      font-size: 10px;
      color: var(--color-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .metric-value {
      font-size: 13px;
      color: var(--color-text-primary);
    }

    .node-capabilities {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .cap-badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--color-text-secondary);
    }

    .cap-badge.browser {
      background: rgba(var(--info-rgb), 0.15);
      color: var(--color-info);
    }

    .cap-badge.docker {
      background: rgba(var(--primary-rgb), 0.15);
      color: var(--color-primary);
    }
  `],
})
export class NodeCardComponent {
  readonly node = input.required<WorkerNodeInfo>();

  readonly platformLabel = computed(() => {
    const p = this.node().capabilities.platform;
    return p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : 'Linux';
  });

  readonly memoryLabel = computed(() => {
    const c = this.node().capabilities;
    const used = c.totalMemoryMB - c.availableMemoryMB;
    return `${Math.round(used / 1024)}/${Math.round(c.totalMemoryMB / 1024)} GB`;
  });
}
