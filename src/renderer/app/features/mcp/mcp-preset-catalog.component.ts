/**
 * MCP Preset Catalog
 *
 * Displays the built-in preset server definitions returned by `mcp:get-presets`.
 * These are NOT from an external registry — they are hardcoded presets shipped
 * with Harness (filesystem, GitHub, Puppeteer, etc.).
 *
 * For each preset the component shows:
 *  - Name & description
 *  - The npx command that runs it
 *  - An "Add" button (disabled when the server ID already exists in the
 *    configured-server list) or an "Added" badge when already installed
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { McpIpcService } from '../../core/services/ipc/mcp-ipc.service';

export interface McpPreset {
  id: string;
  name: string;
  description?: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
}

@Component({
  selector: 'app-mcp-preset-catalog',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="preset-catalog">
      <div class="preset-catalog-header">
        <div>
          <span class="panel-heading">Preset Servers</span>
          <div class="panel-subtitle">
            Built-in server definitions — select Add to register one as an Orchestrator server.
          </div>
        </div>
      </div>

      @if (loadError()) {
        <div class="error-banner">{{ loadError() }}</div>
      }

      @if (loading()) {
        <div class="empty-hint">Loading presets…</div>
      } @else if (presets().length === 0 && !loadError()) {
        <div class="empty-hint">No presets available.</div>
      } @else {
        <div class="preset-grid">
          @for (preset of presets(); track preset.id) {
            <div class="preset-card" [class.preset-installed]="isInstalled(preset.id)">
              <div class="preset-card-top">
                <span class="preset-name">{{ preset.name }}</span>
                @if (isInstalled(preset.id)) {
                  <span class="preset-installed-badge">Added</span>
                } @else {
                  <button
                    class="btn small primary"
                    type="button"
                    [disabled]="working()"
                    (click)="addPreset(preset)"
                  >
                    Add
                  </button>
                }
              </div>
              @if (preset.description) {
                <div class="preset-desc">{{ preset.description }}</div>
              }
              <div class="preset-command">
                {{ presetCommandLabel(preset) }}
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .preset-catalog {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .preset-catalog-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
    }

    .panel-heading {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
    }

    .panel-subtitle {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .error-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      font-size: 12px;
      border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
    }

    .empty-hint {
      font-size: 12px;
      color: var(--text-muted);
    }

    .preset-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: var(--spacing-sm);
    }

    .preset-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
      padding: var(--spacing-sm);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .preset-card.preset-installed {
      border-color: color-mix(in srgb, var(--success-color) 40%, var(--border-color));
    }

    .preset-card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-xs);
    }

    .preset-name {
      font-size: 13px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .preset-installed-badge {
      font-size: 10px;
      font-weight: 600;
      color: var(--success-color);
      border: 1px solid currentColor;
      border-radius: 999px;
      padding: 1px 6px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .preset-desc {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.4;
    }

    .preset-command {
      font-size: 11px;
      font-family: var(--font-family-mono);
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .btn {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }

    .btn.small {
      padding: 2px 8px;
      font-size: 11px;
    }

    .btn.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #fff;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  `],
})
export class McpPresetCatalogComponent implements OnInit {
  private readonly mcpIpc = inject(McpIpcService);

  /** IDs of servers already configured in the orchestrator. Used to mark presets as installed. */
  readonly configuredServerIds = input<readonly string[]>([]);

  /** Emitted after a preset is successfully added (so the parent can reload its server list). */
  readonly presetAdded = output<string>();

  readonly presets = signal<McpPreset[]>([]);
  readonly loading = signal(true);
  readonly working = signal(false);
  readonly loadError = signal<string | null>(null);

  readonly installedIds = computed(() => new Set(this.configuredServerIds()));

  async ngOnInit(): Promise<void> {
    await this.loadPresets();
  }

  isInstalled(presetId: string): boolean {
    return this.installedIds().has(presetId);
  }

  presetCommandLabel(preset: McpPreset): string {
    if (preset.command) {
      const parts = [preset.command, ...(preset.args ?? [])];
      return parts.join(' ');
    }
    return preset.transport;
  }

  async addPreset(preset: McpPreset): Promise<void> {
    this.working.set(true);
    try {
      const response = await this.mcpIpc.mcpAddServer({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        transport: preset.transport,
        command: preset.command,
        args: preset.args,
        autoConnect: false,
      });
      if (response.success) {
        this.presetAdded.emit(preset.id);
      }
    } finally {
      this.working.set(false);
    }
  }

  private async loadPresets(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const response = await this.mcpIpc.mcpGetPresets();
      if (!response.success) {
        this.loadError.set(response.error?.message ?? 'Failed to load presets.');
        return;
      }
      const data = response.data;
      if (Array.isArray(data)) {
        this.presets.set(data as McpPreset[]);
      }
    } finally {
      this.loading.set(false);
    }
  }
}
