/**
 * Copilot Model Selector Component
 *
 * A dropdown to select which model to use when Copilot is the provider.
 * Fetches available models dynamically from the Copilot CLI.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  OnInit,
  output,
  signal
} from '@angular/core';
import { ElectronIpcService, CopilotModelInfo } from '../../core/services/ipc';

export interface CopilotModel {
  id: string;
  name: string;
  tier: 'flagship' | 'high' | 'fast';
  supportsVision?: boolean;
  contextWindow?: number;
}

// Default fallback models (used when CLI is unavailable)
// These are the latest and best models available through GitHub Copilot
export const DEFAULT_COPILOT_MODELS: CopilotModel[] = [
  // Flagship tier - latest and best
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', tier: 'flagship', supportsVision: true, contextWindow: 1000000 },
  { id: 'o3', name: 'OpenAI o3', tier: 'flagship', supportsVision: true, contextWindow: 200000 },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)', tier: 'flagship', supportsVision: true, contextWindow: 2000000 },
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (Preview)', tier: 'flagship', supportsVision: true, contextWindow: 2000000 },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'flagship', supportsVision: true, contextWindow: 2000000 },
  // High performance tier
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', tier: 'high', supportsVision: true, contextWindow: 1000000 },
  { id: 'gpt-5.4', name: 'GPT-5.4', tier: 'high', supportsVision: true, contextWindow: 200000 },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (Preview)', tier: 'high', supportsVision: true, contextWindow: 1000000 },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', tier: 'high', supportsVision: true, contextWindow: 1000000 },
  // Fast/efficient tier
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'fast', supportsVision: true, contextWindow: 1000000 },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', tier: 'fast', supportsVision: true, contextWindow: 200000 },
  { id: 'gemini-2.0-flash-lite', name: 'Gemini Flash Lite', tier: 'fast', supportsVision: true, contextWindow: 1000000 },
];

/**
 * Infer tier from model ID based on common patterns
 */
function inferTier(modelId: string, modelName: string): 'flagship' | 'high' | 'fast' {
  const id = modelId.toLowerCase();
  const name = modelName.toLowerCase();

  // Flagship models
  if (id.includes('opus') || id.includes('o3') || id.includes('o1') ||
      name.includes('opus') || id.includes('2.5-pro') || id.includes('pro-2.5')) {
    return 'flagship';
  }

  // Fast/lite models
  if (id.includes('haiku') || id.includes('mini') || id.includes('lite') ||
      id.includes('flash-lite') || name.includes('haiku') || name.includes('mini') || name.includes('lite')) {
    return 'fast';
  }

  // Everything else is high performance (sonnet, gpt-5.4, flash, etc.)
  return 'high';
}

/**
 * Convert CLI model info to component model format
 */
function convertToModel(info: CopilotModelInfo): CopilotModel {
  return {
    id: info.id,
    name: info.name,
    tier: inferTier(info.id, info.name),
    supportsVision: info.supportsVision,
    contextWindow: info.contextWindow,
  };
}

@Component({
  selector: 'app-copilot-model-selector',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="model-selector">
      <span class="selector-label">
        Copilot Model
        @if (isLoading()) {
          <span class="loading-indicator">Loading...</span>
        }
      </span>
      <div class="selector-dropdown" (click)="toggleDropdown()" (keydown.enter)="toggleDropdown()" (keydown.space)="toggleDropdown()" tabindex="0" role="button">
        <span class="selected-model">{{ selectedModel().name }}</span>
        <span class="tier-badge" [class]="selectedModel().tier">{{ getTierLabel(selectedModel().tier) }}</span>
        <span class="dropdown-arrow">{{ isOpen() ? '▲' : '▼' }}</span>
      </div>

      @if (isOpen()) {
        <div class="dropdown-menu">
          @if (flagshipModels().length > 0) {
            <div class="tier-group">
              <div class="tier-header flagship">Flagship</div>
              @for (model of flagshipModels(); track model.id) {
                <button
                  class="model-option"
                  [class.selected]="model.id === selectedModelId()"
                  (click)="selectModel(model)"
                >
                  <span class="model-name">{{ model.name }}</span>
                  @if (model.supportsVision) {
                    <span class="vision-badge" title="Supports vision">👁</span>
                  }
                  @if (model.id === selectedModelId()) {
                    <span class="check">✓</span>
                  }
                </button>
              }
            </div>
          }

          @if (highPerfModels().length > 0) {
            <div class="tier-group">
              <div class="tier-header high">High Performance</div>
              @for (model of highPerfModels(); track model.id) {
                <button
                  class="model-option"
                  [class.selected]="model.id === selectedModelId()"
                  (click)="selectModel(model)"
                >
                  <span class="model-name">{{ model.name }}</span>
                  @if (model.supportsVision) {
                    <span class="vision-badge" title="Supports vision">👁</span>
                  }
                  @if (model.id === selectedModelId()) {
                    <span class="check">✓</span>
                  }
                </button>
              }
            </div>
          }

          @if (fastModels().length > 0) {
            <div class="tier-group">
              <div class="tier-header fast">Fast & Efficient</div>
              @for (model of fastModels(); track model.id) {
                <button
                  class="model-option"
                  [class.selected]="model.id === selectedModelId()"
                  (click)="selectModel(model)"
                >
                  <span class="model-name">{{ model.name }}</span>
                  @if (model.supportsVision) {
                    <span class="vision-badge" title="Supports vision">👁</span>
                  }
                  @if (model.id === selectedModelId()) {
                    <span class="check">✓</span>
                  }
                </button>
              }
            </div>
          }
        </div>
      }
    </div>

    @if (isOpen()) {
      <div class="backdrop" (click)="closeDropdown()" (keydown.enter)="closeDropdown()" (keydown.space)="closeDropdown()" tabindex="0" role="button"></div>
    }
  `,
  styles: [`
    :host {
      display: block;
      position: relative;
    }

    .model-selector {
      position: relative;
      z-index: 50;
    }

    .selector-label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }

    .loading-indicator {
      font-size: 10px;
      color: var(--accent-color);
      font-weight: 400;
      text-transform: none;
    }

    .selector-dropdown {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .selector-dropdown:hover {
      border-color: var(--accent-color);
      background: var(--bg-tertiary);
    }

    .selected-model {
      flex: 1;
      font-size: 13px;
      font-weight: 500;
    }

    .tier-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .tier-badge.flagship {
      background: linear-gradient(135deg, #6e40c9, #9333ea);
      color: white;
    }

    .tier-badge.high {
      background: linear-gradient(135deg, #2563eb, #0891b2);
      color: white;
    }

    .tier-badge.fast {
      background: linear-gradient(135deg, #059669, #10b981);
      color: white;
    }

    .dropdown-arrow {
      font-size: 10px;
      color: var(--text-secondary);
    }

    .dropdown-menu {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      margin-top: 4px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      overflow: hidden;
      z-index: 51;
      max-height: 400px;
      overflow-y: auto;
    }

    .tier-group {
      padding: 4px 0;
    }

    .tier-group:not(:last-child) {
      border-bottom: 1px solid var(--border-color);
    }

    .tier-header {
      padding: 6px 12px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .tier-header.flagship {
      color: #9333ea;
    }

    .tier-header.high {
      color: #0891b2;
    }

    .tier-header.fast {
      color: #10b981;
    }

    .model-option {
      display: flex;
      align-items: center;
      width: 100%;
      padding: 8px 12px;
      background: transparent;
      border: none;
      color: var(--text-primary);
      cursor: pointer;
      text-align: left;
      transition: background 0.1s ease;
    }

    .model-option:hover {
      background: var(--bg-tertiary);
    }

    .model-option.selected {
      background: var(--bg-tertiary);
    }

    .model-name {
      flex: 1;
      font-size: 13px;
    }

    .vision-badge {
      font-size: 12px;
      margin-right: 6px;
      opacity: 0.7;
    }

    .check {
      color: var(--accent-color);
      font-size: 12px;
    }

    .backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 49;
    }
  `]
})
export class CopilotModelSelectorComponent implements OnInit {
  private ipcService = inject(ElectronIpcService);

  model = input<string | null | undefined>(undefined);

  // Output
  modelSelected = output<string>();

  // State
  protected isOpen = signal(false);
  protected isLoading = signal(false);
  protected models = signal<CopilotModel[]>(DEFAULT_COPILOT_MODELS);
  protected selectedModelId = signal<string>('claude-sonnet-4-5');

  // Computed - selected model
  protected selectedModel = computed(() =>
    this.models().find(m => m.id === this.selectedModelId()) || this.models()[0] || DEFAULT_COPILOT_MODELS[3]
  );

  // Computed - filtered model lists by tier
  protected flagshipModels = computed(() => this.models().filter(m => m.tier === 'flagship'));
  protected highPerfModels = computed(() => this.models().filter(m => m.tier === 'high'));
  protected fastModels = computed(() => this.models().filter(m => m.tier === 'fast'));

  constructor() {
    effect(() => {
      this.syncSelectedModel(false);
    });
  }

  ngOnInit(): void {
    void this.loadModelsFromCli();
  }

  /**
   * Load available models from the Copilot CLI
   */
  private async loadModelsFromCli(): Promise<void> {
    this.isLoading.set(true);

    try {
      const response = await this.ipcService.listCopilotModels();

      if (response.success && response.data && response.data.length > 0) {
        // Convert CLI models to component format
        const loadedModels = response.data
          .filter(m => m.enabled !== false) // Only show enabled models
          .map(convertToModel);

        if (loadedModels.length > 0) {
          this.models.set(loadedModels);
          console.log(`[CopilotModelSelector] Loaded ${loadedModels.length} models from CLI`);
        }
      } else {
        console.log('[CopilotModelSelector] Using default models (CLI unavailable)');
      }
    } catch (error) {
      console.error('[CopilotModelSelector] Failed to load models from CLI:', error);
      // Keep using default models
    } finally {
      this.syncSelectedModel(true);
      this.isLoading.set(false);
    }
  }

  toggleDropdown(): void {
    this.isOpen.update(v => !v);
  }

  closeDropdown(): void {
    this.isOpen.set(false);
  }

  selectModel(model: CopilotModel): void {
    this.selectedModelId.set(model.id);
    this.modelSelected.emit(model.id);
    this.closeDropdown();
  }

  getTierLabel(tier: string): string {
    switch (tier) {
      case 'flagship': return 'Best';
      case 'high': return 'Fast';
      case 'fast': return 'Lite';
      default: return tier;
    }
  }

  private syncSelectedModel(emitIfChanged: boolean): void {
    const configuredModel = this.model();
    const availableModels = this.models();
    if (availableModels.length === 0) {
      return;
    }

    const nextModel = (configuredModel
      ? availableModels.find(model => model.id === configuredModel)
      : undefined) || availableModels.find(model => model.id === this.selectedModelId())
      || availableModels.find(model => model.tier === 'high')
      || availableModels[0];

    if (!nextModel) {
      return;
    }

    const changed = this.selectedModelId() !== nextModel.id;
    if (changed) {
      this.selectedModelId.set(nextModel.id);
    }

    if (emitIfChanged && (changed || configuredModel !== nextModel.id)) {
      this.modelSelected.emit(nextModel.id);
    }
  }

  // Public getter
  getSelectedModel(): string {
    return this.selectedModelId();
  }
}
