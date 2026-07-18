import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { SettingsIpcService } from '../../core/services/ipc/settings-ipc.service';
import { MAX_MODEL_ID_LENGTH } from '../../../../shared/types/provider.types';

@Component({
  selector: 'app-custom-models-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="custom-models-panel">
      <div class="custom-models-header">
        <div class="custom-models-title">Custom models</div>
        <span class="custom-models-provider">{{ activeProvider() }}</span>
      </div>
      <div class="custom-models-form">
        <label class="field field-wide">
          <span class="field-label">Model ID</span>
          <input
            class="input"
            type="text"
            placeholder="e.g. claude-future-opus"
            [value]="customModelInput()"
            (input)="onCustomModelInput($event)"
            (keydown.enter)="addCustomModel()"
          />
        </label>
        <button
          class="btn primary"
          type="button"
          [disabled]="saving()"
          (click)="addCustomModel()"
        >
          Add
        </button>
      </div>
      @if (error()) {
        <div class="custom-models-message is-error">{{ error() }}</div>
      } @else if (message()) {
        <div class="custom-models-message">{{ message() }}</div>
      }
      <div class="custom-models-list">
        @for (modelId of customModelsForProvider(); track modelId) {
          <div class="custom-model-row">
            <span class="custom-model-id">{{ modelId }}</span>
            <button
              class="btn remove-btn"
              type="button"
              [disabled]="saving()"
              (click)="removeCustomModel(modelId)"
            >
              Remove
            </button>
          </div>
        } @empty {
          <div class="custom-models-empty">No custom models for this provider.</div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      flex-shrink: 0;
    }

    .custom-models-panel {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
    }

    .custom-models-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-sm);
    }

    .custom-models-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      letter-spacing: 0;
    }

    .custom-models-provider {
      padding: 2px 8px;
      border: 1px solid color-mix(in srgb, var(--primary-color) 35%, transparent);
      border-radius: var(--radius-sm);
      color: var(--primary-color);
      font-size: 11px;
      text-transform: capitalize;
    }

    .custom-models-form {
      display: flex;
      align-items: flex-end;
      gap: var(--spacing-sm);
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
      color: var(--button-on-primary);
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .custom-models-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .custom-model-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
    }

    .custom-model-id {
      min-width: 0;
      color: var(--text-primary);
      font-family: var(--font-family-mono);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .custom-models-empty,
    .custom-models-message {
      font-size: 12px;
      color: var(--text-muted);
    }

    .custom-models-message {
      color: var(--success-color);
    }

    .custom-models-message.is-error {
      color: var(--error-color);
    }

    .remove-btn {
      font-size: 11px;
      padding: 3px 10px;
    }

    @media (max-width: 768px) {
      .custom-models-form {
        align-items: stretch;
        flex-direction: column;
      }
    }
  `],
})
export class CustomModelsPanelComponent implements OnInit {
  private readonly settingsIpc = inject(SettingsIpcService);

  readonly provider = input<string | null | undefined>();
  readonly availableModelIds = input<string[] | null | undefined>();

  readonly activeProvider = computed(() =>
    this.provider()?.trim().toLowerCase() || 'claude',
  );
  readonly availableModelIdsValue = computed(() => {
    const modelIds = this.availableModelIds();
    return Array.isArray(modelIds) ? modelIds : [];
  });

  readonly customModelsByProvider = signal<Record<string, string[]>>({});
  readonly customModelInput = signal('');
  readonly error = signal<string | null>(null);
  readonly message = signal<string | null>(null);
  readonly saving = signal(false);

  readonly customModelsForProvider = computed(() => {
    return this.customModelsByProvider()[this.normalizedProvider()] ?? [];
  });

  async ngOnInit(): Promise<void> {
    await this.loadCustomModelSettings();
  }

  onCustomModelInput(event: Event): void {
    this.customModelInput.set((event.target as HTMLInputElement).value);
    this.error.set(null);
    this.message.set(null);
  }

  async addCustomModel(): Promise<void> {
    const modelId = this.customModelInput().trim();
    if (!modelId) {
      this.error.set('Enter a model id.');
      return;
    }
    if (modelId.length > MAX_MODEL_ID_LENGTH) {
      this.error.set(`Model id must be ${MAX_MODEL_ID_LENGTH} characters or fewer.`);
      return;
    }

    const current = this.customModelsForProvider();
    if (current.includes(modelId)) {
      this.error.set('That model is already in this provider list.');
      return;
    }
    if (this.availableModelIdsValue().includes(modelId)) {
      this.error.set('That model is already available for this provider.');
      return;
    }

    await this.persistCustomModels({
      ...this.customModelsByProvider(),
      [this.normalizedProvider()]: [...current, modelId],
    }, 'Custom model added.');
    if (!this.error()) {
      this.customModelInput.set('');
    }
  }

  async removeCustomModel(modelId: string): Promise<void> {
    const provider = this.normalizedProvider();
    const remaining = this.customModelsForProvider().filter((candidate) => candidate !== modelId);
    const next = { ...this.customModelsByProvider() };
    if (remaining.length > 0) {
      next[provider] = remaining;
    } else {
      delete next[provider];
    }
    await this.persistCustomModels(next, 'Custom model removed.');
  }

  private normalizedProvider(): string {
    return this.activeProvider().trim().toLowerCase();
  }

  private async loadCustomModelSettings(): Promise<void> {
    try {
      const response = await this.settingsIpc.getSettings();
      if (!response.success || !response.data || typeof response.data !== 'object') {
        this.error.set(response.error?.message ?? 'Failed to load custom models.');
        return;
      }
      const raw = (response.data as Record<string, unknown>)['customModelsByProvider'];
      this.customModelsByProvider.set(normalizeCustomModelsByProvider(raw));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to load custom models.');
    }
  }

  private async persistCustomModels(
    customModelsByProvider: Record<string, string[]>,
    message: string,
  ): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    this.message.set(null);
    try {
      const normalized = normalizeCustomModelsByProvider(customModelsByProvider);
      const response = await this.settingsIpc.setSetting('customModelsByProvider', normalized);
      if (!response.success) {
        this.error.set(response.error?.message ?? 'Failed to save custom models.');
        return;
      }
      this.customModelsByProvider.set(normalized);
      this.message.set(message);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to save custom models.');
    } finally {
      this.saving.set(false);
    }
  }
}

function normalizeCustomModelsByProvider(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, string[]> = {};
  for (const [provider, models] of Object.entries(raw)) {
    if (!Array.isArray(models)) {
      continue;
    }
    const seen = new Set<string>();
    const normalizedModels: string[] = [];
    for (const model of models) {
      if (typeof model !== 'string') {
        continue;
      }
      const modelId = model.trim();
      if (!modelId || modelId.length > MAX_MODEL_ID_LENGTH || seen.has(modelId)) {
        continue;
      }
      seen.add(modelId);
      normalizedModels.push(modelId);
    }
    if (normalizedModels.length > 0) {
      result[provider.trim().toLowerCase()] = normalizedModels;
    }
  }
  return result;
}
