// src/renderer/app/features/remote-nodes/remote-nodes-page.component.ts
import { Component, inject, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { NodeCardComponent } from './node-card.component';
import { RemoteNodesStore } from './remote-nodes.store';
import { RemoteNodeIpcService } from '../../core/services/ipc/remote-node-ipc.service';

@Component({
  selector: 'app-remote-nodes-page',
  standalone: true,
  imports: [NodeCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-container">
      <div class="page-header">
        <h2>Worker Nodes</h2>
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
            <app-node-card [node]="node" />
          }
        </div>
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
      margin-bottom: 24px;
    }

    .page-header h2 {
      font-size: 20px;
      font-weight: 600;
      color: var(--color-text-primary);
      margin: 0;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
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
  serverRunning = false;

  ngOnInit(): void {
    this.store.refresh();
  }

  refresh(): void {
    this.store.refresh();
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
}
