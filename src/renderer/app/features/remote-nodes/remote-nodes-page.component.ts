// src/renderer/app/features/remote-nodes/remote-nodes-page.component.ts
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { NodeCardComponent } from './node-card.component';
import { NodeDetailComponent } from './node-detail.component';
import { RemoteNodesStore } from './remote-nodes.store';
import { RemoteNodeIpcService } from '../../core/services/ipc/remote-node-ipc.service';

@Component({
  selector: 'app-remote-nodes-page',
  standalone: true,
  imports: [NodeCardComponent, NodeDetailComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-container">
      <div class="page-header">
        <div class="header-left">
          <button class="back-button" type="button" (click)="goBack()" aria-label="Back to dashboard">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M12.7 4.3 7 10l5.7 5.7-1.4 1.4L4.2 10l7.1-7.1 1.4 1.4Z" />
            </svg>
            <span>Back</span>
          </button>
          <h2>Worker Nodes</h2>
        </div>
        <div class="header-actions">
          <span class="node-count">
            {{ store.connectedNodes().length }} connected
          </span>
          <button class="btn btn-secondary" (click)="refresh()">
            Refresh
          </button>
          <button
            class="btn btn-primary"
            (click)="toggleServer()"
          >
            {{ serverRunning ? 'Stop Server' : 'Start Server' }}
          </button>
        </div>
      </div>

      @if (store.loading()) {
        <div class="loading-state">Loading nodes...</div>
      } @else if (store.nodes().length === 0) {
        <div class="empty-state">
          <p>No worker nodes connected.</p>
          <p class="hint">Start the worker agent on a remote machine to connect it here.</p>
        </div>
      } @else {
        <div class="nodes-grid">
          @for (node of store.nodes(); track node.id) {
            <button
              type="button"
              class="node-button"
              [class.selected]="selectedNodeId() === node.id"
              (click)="selectNode(node.id)"
            >
              <app-node-card [node]="node" />
            </button>
          }
        </div>

        @if (selectedNode(); as node) {
          <app-node-detail [node]="node" />
        }
      }
    </div>
  `,
  styles: [`
    .page-container {
      padding: 24px;
      max-width: 1200px;
    }

    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 24px;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .page-header h2 {
      font-size: 20px;
      font-weight: 600;
      color: var(--color-text-primary);
      margin: 0;
    }

    .back-button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 32px;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.06);
      color: var(--color-text-primary);
      font-size: 13px;
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .back-button:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .back-button svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
      flex: 0 0 auto;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .node-count {
      font-size: 13px;
      color: var(--color-text-secondary);
    }

    .btn {
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      border: none;
      transition: all var(--transition-fast);
    }

    .btn-primary {
      background: var(--color-primary);
      color: white;
    }

    .btn-primary:hover {
      filter: brightness(1.1);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.06);
      color: var(--color-text-primary);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .nodes-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 16px;
    }

    .node-button {
      padding: 0;
      border: 0;
      background: transparent;
      text-align: left;
      cursor: pointer;
    }

    .node-button.selected {
      border-radius: 12px;
      outline: 2px solid rgba(var(--primary-rgb), 0.45);
      outline-offset: 2px;
    }

    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--color-text-secondary);
    }

    .empty-state .hint {
      font-size: 13px;
      margin-top: 8px;
      opacity: 0.7;
    }

    .loading-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--color-text-secondary);
    }
  `],
})
export class RemoteNodesPageComponent implements OnInit {
  readonly store = inject(RemoteNodesStore);
  private readonly ipc = inject(RemoteNodeIpcService);
  private readonly router = inject(Router);
  readonly selectedNodeId = signal<string | null>(null);
  readonly selectedNode = computed(() => {
    const selectedNodeId = this.selectedNodeId();
    if (!selectedNodeId) {
      return null;
    }
    return this.store.nodes().find((node) => node.id === selectedNodeId) ?? null;
  });
  serverRunning = false;

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    void this.store.refresh().then(() => {
      const selectedNodeId = this.selectedNodeId();
      const nodes = this.store.nodes();
      if (!nodes.length) {
        this.selectedNodeId.set(null);
        return;
      }
      if (!selectedNodeId || !nodes.some((node) => node.id === selectedNodeId)) {
        this.selectedNodeId.set(nodes[0].id);
      }
    });
  }

  async toggleServer(): Promise<void> {
    if (this.serverRunning) {
      await this.ipc.stopServer();
      this.serverRunning = false;
    } else {
      await this.ipc.startServer();
      this.serverRunning = true;
    }
  }

  selectNode(nodeId: string): void {
    this.selectedNodeId.set(nodeId);
  }

  goBack(): void {
    void this.router.navigate(['/']);
  }
}
