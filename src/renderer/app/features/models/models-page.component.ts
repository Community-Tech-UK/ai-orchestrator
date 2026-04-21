/**
 * Models Page
 * Model discovery, verification, and provider management.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ModelIpcService } from '../../core/services/ipc/model-ipc.service';

// ─── Local interfaces ────────────────────────────────────────────────────────

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  status: 'available' | 'verified' | 'error';
  capabilities?: string[];
  maxTokens?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-models-page',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="models-page">

      <!-- Page header -->
      <div class="page-header">
        <button class="header-btn" type="button" (click)="goBack()">← Back</button>
        <div class="header-title">
          <span class="title">Models</span>
          <span class="subtitle">Model discovery, verification, and provider management</span>
        </div>
        <button class="header-btn refresh-btn" type="button" (click)="refresh()" [disabled]="loading()">
          {{ loading() ? 'Loading...' : 'Refresh' }}
        </button>
      </div>

      <!-- Metric cards -->
      <div class="metrics-row">
        <div class="metric-card">
          <span class="metric-label">Total Models</span>
          <span class="metric-value">{{ totalModels() }}</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">Providers</span>
          <span class="metric-value">{{ providerCount() }}</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">Verified</span>
          <span class="metric-value">{{ verifiedCount() }}</span>
        </div>
      </div>

      <!-- Provider selector bar -->
      <div class="provider-bar">
        @for (provider of knownProviders; track provider) {
          <button
            class="provider-btn"
            type="button"
            [class.active]="activeProvider() === provider"
            [disabled]="loading()"
            (click)="selectProvider(provider)"
          >
            {{ provider }}
          </button>
        }
      </div>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      <!-- Model cards grid -->
      <div class="models-grid">
        @for (model of filteredModels(); track model.id) {
          <div class="model-card" [class]="'status-' + model.status">
            <div class="card-header">
              <span class="model-name">{{ model.name }}</span>
              <div class="badges">
                <span class="badge provider-badge">{{ model.provider }}</span>
                <span class="badge" [class]="'status-badge ' + model.status">
                  {{ model.status }}
                </span>
              </div>
            </div>

            @if (model.capabilities && model.capabilities.length > 0) {
              <div class="capabilities">
                @for (cap of model.capabilities; track cap) {
                  <span class="capability-tag">{{ cap }}</span>
                }
              </div>
            }

            @if (model.maxTokens) {
              <div class="token-info">
                <span class="token-label">Context</span>
                <span class="token-value">{{ formatTokens(model.maxTokens) }}</span>
              </div>
            }

            <div class="card-footer">
              <button
                class="btn verify-btn"
                type="button"
                [disabled]="loading() || verifyingId() === model.id"
                (click)="verifyModel(model)"
              >
                {{ verifyingId() === model.id ? 'Verifying...' : 'Verify' }}
              </button>
            </div>
          </div>
        } @empty {
          <div class="empty-state">
            @if (loading()) {
              <span>Loading models...</span>
            } @else {
              <span>No models found for the selected provider. Click Refresh to try again.</span>
            }
          </div>
        }
      </div>

      <!-- Override config panel -->
      <div class="override-panel">
        <div class="override-title">Override Configuration</div>
        <div class="override-fields">
          <label class="field">
            <span class="field-label">Model ID</span>
            <input
              class="input"
              type="text"
              placeholder="e.g. claude-3-5-sonnet-20241022"
              [value]="overrideModelId()"
              (input)="onOverrideModelIdInput($event)"
            />
          </label>
          <label class="field field-wide">
            <span class="field-label">JSON Config</span>
            <textarea
              class="textarea"
              placeholder='{ "temperature": 0.7 }'
              [value]="overrideConfig()"
              (input)="onOverrideConfigInput($event)"
            ></textarea>
          </label>
        </div>
        <div class="override-actions">
          <button
            class="btn primary"
            type="button"
            [disabled]="loading() || !overrideModelId().trim()"
            (click)="setOverride()"
          >
            Set Override
          </button>
          @if (overrideMessage()) {
            <span class="override-message" [class.is-error]="overrideIsError()">
              {{ overrideMessage() }}
            </span>
          }
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

    .models-page {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      gap: var(--spacing-md);
      padding: var(--spacing-lg);
      background: var(--bg-primary);
      color: var(--text-primary);
      overflow-y: auto;
    }

    /* ── Header ── */

    .page-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      flex-shrink: 0;
    }

    .header-btn {
      padding: var(--spacing-xs) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
    }

    .header-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .refresh-btn {
      margin-left: auto;
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

    /* ── Notices / Banners ── */

    .notice-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid color-mix(in srgb, var(--warning-color, #f59e0b) 50%, transparent);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--warning-color, #f59e0b) 12%, transparent);
      color: var(--text-primary);
      font-size: 12px;
      flex-shrink: 0;
    }

    .error-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
      font-size: 12px;
      flex-shrink: 0;
    }

    /* ── Metric cards ── */

    .metrics-row {
      display: flex;
      gap: var(--spacing-md);
      flex-shrink: 0;
    }

    .metric-card {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--spacing-xs);
      padding: var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
    }

    .metric-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .metric-value {
      font-size: 28px;
      font-weight: 700;
      color: var(--text-primary);
    }

    /* ── Provider selector bar ── */

    .provider-bar {
      display: flex;
      gap: var(--spacing-sm);
      flex-wrap: wrap;
      flex-shrink: 0;
    }

    .provider-btn {
      padding: var(--spacing-xs) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 12px;
      text-transform: capitalize;
    }

    .provider-btn.active {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #fff;
    }

    .provider-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    /* ── Model cards grid ── */

    .models-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: var(--spacing-md);
      flex-shrink: 0;
    }

    .model-card {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
    }

    .model-card.status-verified {
      border-color: color-mix(in srgb, var(--success-color, #22c55e) 50%, var(--border-color));
    }

    .model-card.status-error {
      border-color: color-mix(in srgb, var(--error-color) 50%, var(--border-color));
    }

    .card-header {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .model-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      word-break: break-word;
    }

    .badges {
      display: flex;
      gap: var(--spacing-xs);
      flex-wrap: wrap;
    }

    .badge {
      padding: 2px 8px;
      border-radius: 9999px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    .provider-badge {
      background: color-mix(in srgb, var(--primary-color) 18%, transparent);
      color: var(--primary-color);
      border: 1px solid color-mix(in srgb, var(--primary-color) 35%, transparent);
      text-transform: capitalize;
    }

    .status-badge.available {
      background: color-mix(in srgb, var(--text-muted) 14%, transparent);
      color: var(--text-muted);
      border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
    }

    .status-badge.verified {
      background: color-mix(in srgb, var(--success-color, #22c55e) 14%, transparent);
      color: var(--success-color, #22c55e);
      border: 1px solid color-mix(in srgb, var(--success-color, #22c55e) 35%, transparent);
    }

    .status-badge.error {
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
      border: 1px solid color-mix(in srgb, var(--error-color) 35%, transparent);
    }

    .capabilities {
      display: flex;
      gap: var(--spacing-xs);
      flex-wrap: wrap;
    }

    .capability-tag {
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      font-size: 10px;
      color: var(--text-muted);
    }

    .token-info {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
    }

    .token-label {
      color: var(--text-muted);
    }

    .token-value {
      font-weight: 600;
      color: var(--text-primary);
    }

    .card-footer {
      margin-top: auto;
      display: flex;
      justify-content: flex-end;
    }

    .empty-state {
      grid-column: 1 / -1;
      padding: var(--spacing-lg);
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
      border: 1px dashed var(--border-color);
      border-radius: var(--radius-md);
    }

    /* ── Buttons ── */

    .btn {
      padding: var(--spacing-xs) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 12px;
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

    .verify-btn {
      font-size: 11px;
      padding: 3px 10px;
    }

    /* ── Override panel ── */

    .override-panel {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      padding: var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      flex-shrink: 0;
    }

    .override-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .override-fields {
      display: flex;
      gap: var(--spacing-md);
      flex-wrap: wrap;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      min-width: 200px;
    }

    .field-wide {
      flex: 1;
    }

    .field-label {
      font-size: 12px;
      color: var(--text-muted);
    }

    .input {
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 12px;
    }

    .textarea {
      min-height: 72px;
      resize: vertical;
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 12px;
      font-family: var(--font-family-mono);
    }

    .override-actions {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }

    .override-message {
      font-size: 12px;
      color: var(--success-color, #22c55e);
    }

    .override-message.is-error {
      color: var(--error-color);
    }

    @media (max-width: 768px) {
      .metrics-row {
        flex-direction: column;
      }

      .override-fields {
        flex-direction: column;
      }

      .models-grid {
        grid-template-columns: 1fr;
      }
    }
  `],
})
export class ModelsPageComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly modelIpc = inject(ModelIpcService);

  readonly models = signal<ModelInfo[]>([]);
  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly activeProvider = signal('claude');
  readonly verifyingId = signal<string | null>(null);

  readonly overrideModelId = signal('');
  readonly overrideConfig = signal('');
  readonly overrideMessage = signal<string | null>(null);
  readonly overrideIsError = signal(false);

  readonly knownProviders = ['claude', 'copilot', 'codex', 'gemini', 'cursor'];

  readonly filteredModels = computed(() => {
    const provider = this.activeProvider();
    return this.models().filter((m) => m.provider === provider);
  });

  readonly totalModels = computed(() => this.models().length);

  readonly providerCount = computed(() => {
    const providers = new Set(this.models().map((m) => m.provider));
    return providers.size;
  });

  readonly verifiedCount = computed(
    () => this.models().filter((m) => m.status === 'verified').length
  );

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  goBack(): void {
    this.router.navigate(['/']);
  }

  async refresh(): Promise<void> {
    if (this.loading()) return;
    this.errorMessage.set(null);
    this.loading.set(true);
    try {
      // Attempt discovery first; fall back to listing the active provider's models.
      const discoverResponse = await this.modelIpc.discoverModels();
      if (discoverResponse.success) {
        this.models.set(this.normalizeModels(discoverResponse.data));
        return;
      }

      // Fallback: load from the currently selected provider.
      await this.loadProviderModels(this.activeProvider());
    } finally {
      this.loading.set(false);
    }
  }

  async selectProvider(provider: string): Promise<void> {
    this.activeProvider.set(provider);
    await this.loadProviderModels(provider);
  }

  async verifyModel(model: ModelInfo): Promise<void> {
    if (this.loading() || this.verifyingId() === model.id) return;
    this.verifyingId.set(model.id);
    try {
      const response = await this.modelIpc.verifyModel(model.id);
      if (response.success) {
        this.models.update((list) =>
          list.map((m) => (m.id === model.id ? { ...m, status: 'verified' } : m))
        );
      } else {
        this.models.update((list) =>
          list.map((m) => (m.id === model.id ? { ...m, status: 'error' } : m))
        );
        this.errorMessage.set(
          response.error?.message ?? `Verification failed for ${model.name}.`
        );
      }
    } finally {
      this.verifyingId.set(null);
    }
  }

  async setOverride(): Promise<void> {
    const modelId = this.overrideModelId().trim();
    if (!modelId || this.loading()) return;

    this.overrideMessage.set(null);
    this.overrideIsError.set(false);

    let config: Record<string, unknown> = {};
    const raw = this.overrideConfig().trim();
    if (raw) {
      try {
        config = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        this.overrideMessage.set('Invalid JSON config.');
        this.overrideIsError.set(true);
        return;
      }
    }

    const response = await this.modelIpc.setOverride(modelId, config);
    if (response.success) {
      this.overrideMessage.set('Override applied.');
      this.overrideIsError.set(false);
    } else {
      this.overrideMessage.set(
        response.error?.message ?? 'Failed to apply override.'
      );
      this.overrideIsError.set(true);
    }
  }

  onOverrideModelIdInput(event: Event): void {
    this.overrideModelId.set((event.target as HTMLInputElement).value);
  }

  onOverrideConfigInput(event: Event): void {
    this.overrideConfig.set((event.target as HTMLTextAreaElement).value);
  }

  formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
    return tokens.toString();
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async loadProviderModels(provider: string): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const response =
        provider === 'copilot'
          ? await this.modelIpc.listCopilotModels()
          : await this.modelIpc.listProviderModels(provider);

      if (!response.success) {
        this.errorMessage.set(
          response.error?.message ?? `Failed to list models for ${provider}.`
        );
        return;
      }

      const incoming = this.normalizeModels(response.data, provider);
      this.models.update((existing) => {
        // Replace entries for this provider; keep entries from other providers.
        const others = existing.filter((m) => m.provider !== provider);
        return [...others, ...incoming];
      });
    } finally {
      this.loading.set(false);
    }
  }

  private normalizeModels(data: unknown, fallbackProvider?: string): ModelInfo[] {
    if (!Array.isArray(data)) return [];
    return data.map((raw: unknown): ModelInfo => {
      const entry = raw as Record<string, unknown>;
      const id = String(entry['id'] ?? entry['modelId'] ?? '');
      const name = String(entry['name'] ?? entry['displayName'] ?? id);
      const providerRaw = String(
        entry['provider'] ?? entry['source'] ?? fallbackProvider ?? 'unknown'
      );
      const provider = providerRaw === 'openai' ? 'codex' : providerRaw;
      const status: ModelInfo['status'] =
        entry['status'] === 'verified'
          ? 'verified'
          : entry['status'] === 'error'
          ? 'error'
          : 'available';
      const capabilities = Array.isArray(entry['capabilities'])
        ? (entry['capabilities'] as unknown[]).map(String)
        : undefined;
      const maxTokens =
        typeof entry['maxTokens'] === 'number'
          ? entry['maxTokens']
          : typeof entry['contextWindow'] === 'number'
          ? entry['contextWindow']
          : undefined;
      return { id, name, provider, status, capabilities, maxTokens };
    });
  }

}
