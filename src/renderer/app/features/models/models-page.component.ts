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
import { ModelIpcService } from '../../core/services/ipc/model-ipc.service';
import { CustomModelsPanelComponent } from './custom-models-panel.component';

// ─── Local interfaces ────────────────────────────────────────────────────────

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  status: 'available' | 'verified' | 'error';
  capabilities?: string[];
  maxTokens?: number;
}

interface VerificationFailure {
  id: string;
  name: string;
  provider: string;
  message: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-models-page',
  standalone: true,
  imports: [CommonModule, CustomModelsPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="models-page">

      <!-- Page header -->
      <div class="page-header">
        <div class="header-title">
          <span class="title">Models</span>
          <span class="subtitle">Model discovery, verification, and provider management</span>
        </div>
        <div class="header-actions">
          <button
            class="header-btn verify-all-btn"
            type="button"
            (click)="verifyAllVisibleModels()"
            [disabled]="loading() || verifyingAll() || filteredModels().length === 0"
          >
            {{ verifyingAll() ? 'Verifying...' : 'Verify all' }}
          </button>
          <button
            class="header-btn refresh-btn"
            type="button"
            (click)="refresh()"
            [disabled]="loading() || verifyingAll()"
          >
          {{ loading() ? 'Loading...' : 'Refresh' }}
          </button>
        </div>
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
            [disabled]="loading() || verifyingAll()"
            (click)="selectProvider(provider)"
          >
            {{ provider }}
          </button>
        }
      </div>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      @if (verificationSummary()) {
        <div
          class="verification-results"
          [class.has-failures]="verificationFailures().length > 0"
          role="status"
        >
          <div class="verification-results-title">{{ verificationSummary() }}</div>
          @if (verificationFailures().length > 0) {
            <ul class="verification-failure-list">
              @for (failure of verificationFailures(); track failure.provider + ':' + failure.id) {
                <li>
                  <span class="verification-failure-name">{{ failure.name }}</span>
                  <span class="verification-failure-message">{{ failure.message }}</span>
                </li>
              }
            </ul>
          }
        </div>
      }

      <app-custom-models-panel
        [provider]="activeProvider()"
        [availableModelIds]="availableModelIdsForActiveProvider()"
      />

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
                [disabled]="loading() || verifyingAll() || verifyingId() === model.id"
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
            <span class="field-label">Catalog metadata JSON</span>
            <textarea
              class="textarea"
              placeholder='{ "name": "Future Opus", "tier": "powerful" }'
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
  styleUrl: './models-page.component.scss',
})
export class ModelsPageComponent implements OnInit {
  private readonly modelIpc = inject(ModelIpcService);

  readonly models = signal<ModelInfo[]>([]);
  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly activeProvider = signal('claude');
  readonly verifyingId = signal<string | null>(null);
  readonly verifyingAll = signal(false);
  readonly verificationFailures = signal<VerificationFailure[]>([]);
  readonly verificationSummary = signal<string | null>(null);

  readonly overrideModelId = signal('');
  readonly overrideConfig = signal('');
  readonly overrideMessage = signal<string | null>(null);
  readonly overrideIsError = signal(false);

  readonly knownProviders = ['claude', 'copilot', 'codex', 'gemini', 'antigravity', 'cursor'];

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

  readonly availableModelIdsForActiveProvider = computed(() =>
    this.filteredModels().map((model) => model.id)
  );

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.loading() || this.verifyingAll()) return;
    this.errorMessage.set(null);
    this.clearVerificationReport();
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
    if (this.verifyingAll()) return;
    this.activeProvider.set(provider);
    this.clearVerificationReport();
    await this.loadProviderModels(provider);
  }

  async verifyModel(model: ModelInfo): Promise<void> {
    if (this.loading() || this.verifyingAll() || this.verifyingId() === model.id) return;
    this.clearVerificationReport();
    this.verifyingId.set(model.id);
    try {
      const response = await this.modelIpc.verifyModel(model.id);
      if (response.success) {
        this.updateModelStatus(model, 'verified');
      } else {
        this.updateModelStatus(model, 'error');
        this.errorMessage.set(
          response.error?.message ?? `Verification failed for ${model.name}.`
        );
      }
    } finally {
      this.verifyingId.set(null);
    }
  }

  async verifyAllVisibleModels(): Promise<void> {
    if (this.loading() || this.verifyingAll()) return;

    const models = this.filteredModels();
    if (models.length === 0) return;

    const failures: VerificationFailure[] = [];
    this.errorMessage.set(null);
    this.clearVerificationReport();
    this.verifyingAll.set(true);

    try {
      for (const model of models) {
        this.verifyingId.set(model.id);
        const response = await this.modelIpc.verifyModel(model.id);
        if (response.success) {
          this.updateModelStatus(model, 'verified');
          continue;
        }

        const message = response.error?.message ?? `Verification failed for ${model.name}.`;
        this.updateModelStatus(model, 'error');
        failures.push({
          id: model.id,
          name: model.name,
          provider: model.provider,
          message,
        });
      }

      this.verificationFailures.set(failures);
      this.verificationSummary.set(
        failures.length > 0
          ? `${failures.length} of ${models.length} ${models.length === 1 ? 'model' : 'models'} did not pass verification.`
          : `All ${models.length} ${models.length === 1 ? 'model' : 'models'} passed verification.`,
      );
    } finally {
      this.verifyingId.set(null);
      this.verifyingAll.set(false);
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

    const response = await this.modelIpc.setOverride(this.activeProvider(), modelId, config);
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

  private updateModelStatus(model: ModelInfo, status: ModelInfo['status']): void {
    this.models.update((list) =>
      list.map((candidate) =>
        this.isSameModel(candidate, model) ? { ...candidate, status } : candidate,
      ),
    );
  }

  private isSameModel(left: ModelInfo, right: ModelInfo): boolean {
    return left.id === right.id && left.provider === right.provider;
  }

  private clearVerificationReport(): void {
    this.verificationFailures.set([]);
    this.verificationSummary.set(null);
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
