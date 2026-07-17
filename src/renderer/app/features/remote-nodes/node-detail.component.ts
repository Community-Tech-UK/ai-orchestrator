import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type {
  RemoteNodeRosterEntry,
  WorkerLocalModelCapability,
} from '../../../../shared/types/worker-node.types';
import { NodeServicePanelComponent } from './node-service-panel/node-service-panel.component';

@Component({
  selector: 'app-node-detail',
  standalone: true,
  imports: [NodeServicePanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="detail-card">
      <div class="detail-header">
        <div>
          <h3>{{ node().name }}</h3>
          <p>{{ node().id }} · {{ node().address }}</p>
        </div>
        <span class="detail-status" [class]="'status-' + node().status">{{ node().status }}</span>
      </div>

      <div class="detail-grid">
        <div>
          <span class="label">Browser runtime</span>
          <span>{{ node().capabilities.hasBrowserRuntime ? 'Available' : 'Unavailable' }}</span>
        </div>
        <div>
          <span class="label">Browser MCP</span>
          <span>{{ node().capabilities.hasBrowserMcp ? 'Available' : 'Unavailable' }}</span>
        </div>
        <div>
          <span class="label">Working directories</span>
          <span>{{ node().capabilities.workingDirectories.length }}</span>
        </div>
        <div>
          <span class="label">Browsable roots</span>
          <span>{{ node().capabilities.browsableRoots.length }}</span>
        </div>
      </div>

      <div class="detail-section">
        <h4>Discovered Projects</h4>
        @if (projectPaths().length > 0) {
          <ul>
            @for (projectPath of projectPaths(); track projectPath) {
              <li>{{ projectPath }}</li>
            }
          </ul>
        } @else {
          <p class="muted">No projects advertised by this node.</p>
        }
      </div>

      <div class="detail-section">
        <h4>Working Directories</h4>
        <ul>
          @for (workingDirectory of node().capabilities.workingDirectories; track workingDirectory) {
            <li>{{ workingDirectory }}</li>
          }
        </ul>
      </div>

      <div class="detail-section">
        <h4>Local Models</h4>
        @if (localModelEndpoints().length > 0) {
          <div class="local-model-endpoints">
            @for (endpoint of localModelEndpoints(); track endpoint.endpointId ?? endpoint.provider) {
              <section class="local-model-endpoint">
                <h5>
                  {{ localModelProviderLabel(endpoint.provider) }}
                  <span>{{ localModelHealthLabel(endpoint) }}</span>
                </h5>
                <ul>
                  @for (model of endpoint.models; track model) {
                    <li>{{ model }}{{ loadedContextLabel(endpoint, model) }}</li>
                  }
                </ul>
              </section>
            }
          </div>
        } @else {
          <p class="muted">No local model endpoints advertised by this node.</p>
        }
      </div>

      <div class="detail-section">
        <app-node-service-panel [nodeId]="node().id" />
      </div>
    </section>
  `,
  styles: [`
    .detail-card {
      margin-top: 20px;
      padding: 20px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    .detail-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }

    .detail-header h3 {
      margin: 0 0 4px;
      color: var(--color-text-primary);
      font-size: 18px;
      font-weight: 600;
    }

    .detail-header p {
      margin: 0;
      color: var(--color-text-secondary);
      font-size: 12px;
    }

    .detail-status {
      padding: 4px 10px;
      border-radius: 999px;
      text-transform: capitalize;
      font-size: 12px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--color-text-primary);
    }

    .detail-status.status-connected {
      color: var(--color-success);
    }

    .detail-status.status-degraded {
      color: var(--color-warning);
    }

    .detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
      margin-bottom: 18px;
    }

    .detail-grid div {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .label {
      color: var(--color-text-secondary);
      font-size: 11px;
      font-weight: 600;
    }

    .detail-section + .detail-section {
      margin-top: 18px;
    }

    .detail-section h4 {
      margin: 0 0 10px;
      color: var(--color-text-primary);
      font-size: 13px;
      font-weight: 600;
    }

    .detail-section ul {
      margin: 0;
      padding-left: 18px;
      color: var(--color-text-secondary);
      font-size: 13px;
    }

    .detail-section li + li {
      margin-top: 4px;
    }

    .muted {
      margin: 0;
      color: var(--color-text-secondary);
      font-size: 13px;
    }

    .local-model-endpoints {
      display: grid;
      gap: 10px;
    }

    .local-model-endpoint {
      padding: 10px 12px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .local-model-endpoint h5 {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin: 0 0 8px;
      color: var(--color-text-primary);
      font-size: 12px;
      font-weight: 600;
    }

    .local-model-endpoint h5 span {
      color: var(--color-text-secondary);
      font-size: 11px;
      font-weight: 500;
    }
  `],
})
export class NodeDetailComponent {
  readonly node = input.required<RemoteNodeRosterEntry>();

  readonly projectPaths = computed(() =>
    this.node().capabilities.discoveredProjects
      .map((project) => project.path)
      .filter((projectPath, index, all) => all.indexOf(projectPath) === index),
  );

  readonly localModelEndpoints = computed(() =>
    this.node().capabilities.localModelEndpoints ?? [],
  );

  localModelProviderLabel(provider: WorkerLocalModelCapability['provider']): string {
    return provider === 'ollama' ? 'Ollama' : 'LM Studio';
  }

  localModelHealthLabel(endpoint: WorkerLocalModelCapability): string {
    if (!this.node().connected || this.node().status === 'disconnected') {
      return 'Unavailable';
    }
    return endpoint.healthy ? 'Running' : 'Installed but not running';
  }

  loadedContextLabel(endpoint: WorkerLocalModelCapability, modelId: string): string {
    const loaded = endpoint.loadedModels?.find((model) => model.id === modelId);
    return loaded ? ` · ${loaded.contextLength} ctx` : '';
  }
}
