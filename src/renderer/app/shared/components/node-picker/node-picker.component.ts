import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RemoteNodeStore } from '../../../core/state/remote-node.store';
import { SettingsStore } from '../../../core/state/settings.store';
import type { WorkerNodeInfo } from '../../../../../shared/types/worker-node.types';

@Component({
  standalone: true,
  selector: 'app-node-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isVisible()) {
      <div class="node-picker" [class.open]="isOpen()">
        <button
          class="node-picker-trigger"
          type="button"
          (click)="toggleOpen()"
          [title]="selectedTooltip()"
        >
          <span class="node-health-dot" [class]="selectedHealthClass()"></span>
          <span class="node-picker-label">{{ selectedLabel() }}</span>
          <span class="node-picker-caret">▾</span>
        </button>

        @if (isOpen()) {
          <div class="node-picker-dropdown">
            <button
              class="node-option"
              [class.selected]="!selectedNodeId()"
              type="button"
              (click)="selectNode(null)"
            >
              <span class="node-health-dot health-local"></span>
              <div class="node-option-content">
                <span class="node-option-name">Local</span>
                <span class="node-option-detail">This machine</span>
              </div>
            </button>

            @if (sortedNodes().length > 0) {
              <div class="node-option-separator"></div>
            }

            @for (node of sortedNodes(); track node.id) {
              <button
                class="node-option"
                [class.selected]="selectedNodeId() === node.id"
                [class.disabled]="!isNodeSelectable(node)"
                [disabled]="!isNodeSelectable(node)"
                [title]="nodeDisabledReason(node)"
                type="button"
                (click)="selectNode(node.id)"
              >
                <span class="node-health-dot" [class]="healthClass(node)"></span>
                <div class="node-option-content">
                  <span class="node-option-name">{{ node.name }}</span>
                  <span class="node-option-detail">{{ nodeSubtitle(node) }}</span>
                </div>
                @if (node.latencyMs !== null && node.latencyMs !== undefined) {
                  <span class="node-option-latency">{{ node.latencyMs }}ms</span>
                }
              </button>
            }
          </div>

          <button
            type="button"
            class="node-picker-backdrop"
            aria-label="Close node picker"
            (click)="isOpen.set(false)"
          ></button>
        }
      </div>
    }
  `,
  styles: [`
    .node-picker { position: relative; display: inline-flex; }

    .node-picker-trigger {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 12px;
      cursor: pointer;
      transition: all var(--transition-fast);
      white-space: nowrap;
    }

    .node-picker-trigger:hover { border-color: var(--border-light); }

    .node-picker-caret { font-size: 10px; color: var(--text-muted); }

    .node-picker-dropdown {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      z-index: 100;
      min-width: 280px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.3));
      padding: 4px;
      display: flex;
      flex-direction: column;
    }

    .node-option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border: none;
      background: transparent;
      color: var(--text-primary);
      font-size: 12px;
      cursor: pointer;
      border-radius: var(--radius-sm);
      text-align: left;
      width: 100%;
    }

    .node-option:hover:not(:disabled) { background: var(--bg-hover); }
    .node-option.selected { background: var(--bg-hover); }
    .node-option.disabled { opacity: 0.4; cursor: not-allowed; }

    .node-option-content { display: flex; flex-direction: column; flex: 1; min-width: 0; }
    .node-option-name { font-weight: 500; }
    .node-option-detail { font-size: 11px; color: var(--text-muted); }
    .node-option-latency { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono, monospace); }

    .node-option-separator {
      height: 1px;
      background: var(--border-color);
      margin: 4px 0;
    }

    .node-health-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .health-connected { background: var(--success-color, #22c55e); }
    .health-degraded { background: #eab308; }
    .health-disconnected { background: var(--text-muted, #6b7280); }
    .health-local { background: var(--primary-color, #3b82f6); }

    .node-picker-backdrop {
      position: fixed;
      inset: 0;
      z-index: 99;
      background: transparent;
      border: none;
      cursor: default;
    }
  `],
})
export class NodePickerComponent {
  private readonly nodeStore = inject(RemoteNodeStore);
  private readonly settingsStore = inject(SettingsStore);

  selectedNodeId = input<string | null>(null);
  selectedCli = input<string>('auto');
  nodeSelected = output<string | null>();

  isOpen = signal(false);

  readonly isVisible = computed(() =>
    this.settingsStore.remoteNodesEnabled() && this.nodeStore.hasNodes(),
  );

  readonly sortedNodes = computed(() => {
    const order: Record<string, number> = { connected: 0, degraded: 1, connecting: 2, disconnected: 3 };
    return [...this.nodeStore.nodes()].sort(
      (a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9),
    );
  });

  readonly selectedLabel = computed(() => {
    const id = this.selectedNodeId();
    if (!id) return 'Local';
    const node = this.nodeStore.nodeById(id);
    return node?.name ?? id.slice(0, 8);
  });

  readonly selectedHealthClass = computed(() => {
    const id = this.selectedNodeId();
    if (!id) return 'health-local';
    const node = this.nodeStore.nodeById(id);
    if (!node) return 'health-disconnected';
    return 'health-' + node.status;
  });

  readonly selectedTooltip = computed(() => {
    const id = this.selectedNodeId();
    if (!id) return 'Running on this machine';
    const node = this.nodeStore.nodeById(id);
    if (!node) return 'Node not found';
    return `Running on ${node.name} (${node.capabilities.platform})`;
  });

  toggleOpen(): void {
    this.isOpen.set(!this.isOpen());
  }

  selectNode(nodeId: string | null): void {
    this.nodeSelected.emit(nodeId);
    this.isOpen.set(false);
  }

  isNodeSelectable(node: WorkerNodeInfo): boolean {
    if (node.status !== 'connected' && node.status !== 'degraded') return false;
    const cli = this.selectedCli();
    if (cli === 'auto') return true;
    return node.capabilities.supportedClis.includes(cli as never);
  }

  nodeDisabledReason(node: WorkerNodeInfo): string {
    if (node.status === 'disconnected') return 'Node is disconnected';
    if (node.status === 'connecting') return 'Node is connecting...';
    const cli = this.selectedCli();
    if (cli !== 'auto' && !node.capabilities.supportedClis.includes(cli as never)) {
      return `${cli} CLI not installed on this node`;
    }
    return '';
  }

  healthClass(node: WorkerNodeInfo): string {
    return 'health-' + node.status;
  }

  nodeSubtitle(node: WorkerNodeInfo): string {
    const caps = node.capabilities;
    const parts: string[] = [];
    const platformLabel = caps.platform === 'win32' ? 'Win32' : caps.platform === 'darwin' ? 'macOS' : 'Linux';
    parts.push(platformLabel);
    if (caps.gpuName) parts.push('GPU');
    if (caps.hasBrowserRuntime) parts.push('Chrome');
    if (caps.hasDocker) parts.push('Docker');
    parts.push(`${caps.supportedClis.length} CLI${caps.supportedClis.length !== 1 ? 's' : ''}`);
    return parts.join(' \u00b7 ');
  }
}
