/**
 * Verification Launcher Component
 *
 * Form to start a verification session:
 * - Prompt input with validation
 * - Context input (optional)
 * - Agent selection
 * - Personality picker
 * - Configuration options
 * - Launch button
 */

import {
  Component,
  output,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { VerificationService } from '../shared/services/verification.service';
import { VerificationStore } from '../../../core/state/verification.store';
import { CliDetectionPanelComponent } from '../config/cli-detection-panel.component';
import { AgentPersonalityPickerComponent } from '../config/agent-personality-picker.component';
import type { VerificationLauncherForm, LauncherValidation } from '../../../../../shared/types/verification-ui.types';
import type { CliType } from '../../../../../shared/types/unified-cli-response';

@Component({
  selector: 'app-verification-launcher',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CliDetectionPanelComponent,
    AgentPersonalityPickerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="launcher">
      <!-- Prompt Section -->
      <div class="section">
        <label for="verification-prompt" class="section-label">
          Prompt
          <span class="required">*</span>
        </label>
        <textarea
          id="verification-prompt"
          class="prompt-input"
          [class.error]="validation().errors['prompt']"
          [(ngModel)]="form.prompt"
          (ngModelChange)="validateForm()"
          placeholder="Enter the question or task you want verified by multiple AI agents..."
          rows="4"
        ></textarea>
        @if (validation().errors['prompt']) {
          <span class="error-text">{{ validation().errors['prompt'] }}</span>
        }
      </div>

      <!-- Context Section (collapsible) -->
      <div class="section">
        <button class="section-toggle" (click)="showContext.set(!showContext())">
          <span class="toggle-icon">{{ showContext() ? '▼' : '▶' }}</span>
          Add Context (optional)
        </button>
        @if (showContext()) {
          <textarea
            class="context-input"
            [(ngModel)]="form.context"
            placeholder="Additional context, code snippets, or background information..."
            rows="3"
          ></textarea>
        }
      </div>

      <!-- Agent Selection -->
      <div class="section">
        <div class="section-label">Select Agents</div>
        <app-cli-detection-panel
          [selectedClis]="form.selectedAgents"
          (cliSelect)="addAgent($event)"
          (cliDeselect)="removeAgent($event)"
        />
        @if (validation().errors['agents']) {
          <span class="error-text">{{ validation().errors['agents'] }}</span>
        }
      </div>

      <!-- Personality Selection -->
      <div class="section">
        <div class="section-label">Agent Personalities</div>
        <app-agent-personality-picker
          [selected]="form.personalities"
          [maxSelections]="form.selectedAgents.length"
          (selectionChange)="form.personalities = $event; validateForm()"
        />
      </div>

      <!-- Advanced Options -->
      <div class="section">
        <button class="section-toggle" (click)="showAdvanced.set(!showAdvanced())">
          <span class="toggle-icon">{{ showAdvanced() ? '▼' : '▶' }}</span>
          Advanced Options
        </button>
        @if (showAdvanced()) {
          <div class="options-grid">
            <!-- Synthesis Strategy -->
            <div class="option-item">
              <label for="synthesis-strategy" class="option-label">Synthesis Strategy</label>
              <select
                id="synthesis-strategy"
                class="option-select"
                [(ngModel)]="form.synthesisStrategy"
              >
                <option value="consensus">Consensus</option>
                <option value="debate">Debate</option>
                <option value="majority-vote">Majority Vote</option>
                <option value="best-of">Best Of</option>
                <option value="merge">Merge</option>
              </select>
            </div>

            <!-- Confidence Threshold -->
            <div class="option-item">
              <label for="confidence-threshold" class="option-label">
                Confidence Threshold: {{ (form.confidenceThreshold * 100).toFixed(0) }}%
              </label>
              <input
                id="confidence-threshold"
                type="range"
                class="option-slider"
                [(ngModel)]="form.confidenceThreshold"
                min="0.1"
                max="1"
                step="0.05"
              />
            </div>

            <!-- Max Debate Rounds -->
            <div class="option-item">
              <label for="max-debate-rounds" class="option-label">
                Max Debate Rounds: {{ form.maxDebateRounds }}
              </label>
              <input
                id="max-debate-rounds"
                type="range"
                class="option-slider"
                [(ngModel)]="form.maxDebateRounds"
                min="1"
                max="10"
                step="1"
              />
            </div>
          </div>
        }
      </div>

      <!-- Warnings -->
      @if (validation().warnings.length > 0) {
        <div class="warnings">
          @for (warning of validation().warnings; track warning) {
            <div class="warning-item">
              <span class="warning-icon">⚠️</span>
              {{ warning }}
            </div>
          }
        </div>
      }

      <!-- Actions -->
      <div class="actions">
        <button
          class="cancel-btn"
          (click)="handleCancel()"
        >
          Cancel
        </button>
        <button
          class="launch-btn"
          [disabled]="!validation().isValid || isLaunching()"
          (click)="handleLaunch()"
        >
          @if (isLaunching()) {
            <span class="spinner"></span>
            Starting...
          } @else {
            🚀 Start Verification
          }
        </button>
      </div>

      <!-- Error Display -->
      @if (service.lastError()) {
        <div class="launch-error">
          {{ service.lastError() }}
        </div>
      }
    </div>
  `,
  styles: [`
    .launcher {
      display: flex;
      flex-direction: column;
      gap: 20px;
      padding: 20px;
      max-width: 800px;
    }

    /* Sections */
    .section {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .section-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .required {
      color: #ef4444;
    }

    .section-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      background: none;
      border: none;
      padding: 0;
      font-size: 13px;
      color: var(--text-secondary);
      cursor: pointer;
    }

    .section-toggle:hover {
      color: var(--text-primary);
    }

    .toggle-icon {
      font-size: 10px;
    }

    /* Inputs */
    .prompt-input,
    .context-input {
      width: 100%;
      padding: 12px;
      background: var(--bg-secondary, #1a1a1a);
      border: 1px solid var(--border-color, #374151);
      border-radius: 6px;
      font-size: 14px;
      color: var(--text-primary);
      resize: vertical;
      font-family: inherit;
    }

    .prompt-input:focus,
    .context-input:focus {
      outline: none;
      border-color: var(--accent-color, #3b82f6);
    }

    .prompt-input.error {
      border-color: #ef4444;
    }

    .error-text {
      font-size: 12px;
      color: #ef4444;
    }

    /* Options Grid */
    .options-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      padding: 12px;
      background: var(--bg-secondary, #1a1a1a);
      border-radius: 6px;
    }

    .option-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .option-label {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .option-select {
      padding: 8px 10px;
      background: var(--bg-tertiary, #262626);
      border: 1px solid var(--border-color, #374151);
      border-radius: 4px;
      font-size: 13px;
      color: var(--text-primary);
    }

    .option-slider {
      width: 100%;
      accent-color: var(--accent-color, #3b82f6);
    }

    /* Warnings */
    .warnings {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.3);
      border-radius: 6px;
    }

    .warning-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #f59e0b;
    }

    /* Actions */
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border-color, #374151);
    }

    .cancel-btn {
      padding: 10px 20px;
      background: var(--bg-tertiary, #262626);
      border: none;
      border-radius: 6px;
      font-size: 14px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: background 0.2s;
    }

    .cancel-btn:hover {
      background: var(--bg-secondary, #1a1a1a);
    }

    .launch-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 24px;
      background: var(--accent-color, #3b82f6);
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      color: white;
      cursor: pointer;
      transition: background 0.2s;
    }

    .launch-btn:hover:not(:disabled) {
      background: #2563eb;
    }

    .launch-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .launch-error {
      padding: 12px;
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 6px;
      font-size: 13px;
      color: #ef4444;
    }
  `],
})
export class VerificationLauncherComponent {
  service = inject(VerificationService);
  store = inject(VerificationStore);

  // Outputs
  launched = output<string>();
  cancelled = output<void>();

  // Internal state
  showContext = signal(false);
  showAdvanced = signal(false);
  isLaunching = signal(false);

  // Form data
  form: VerificationLauncherForm = {
    prompt: '',
    context: undefined,
    selectedAgents: [],
    personalities: [],
    synthesisStrategy: 'merge',
    confidenceThreshold: 0.7,
    maxDebateRounds: 2,
  };

  // Validation state
  private validationResult = signal<LauncherValidation>({
    isValid: false,
    errors: { prompt: 'Prompt is required' },
    warnings: [],
  });

  validation = computed(() => this.validationResult());

  constructor() {
    // Initialize from store defaults
    const config = this.store.defaultConfig();
    const defaultCount = Math.max(1, config.agentCount || 1);
    this.form.selectedAgents = [...config.cliAgents].slice(0, defaultCount);
    this.form.personalities = [...config.personalities];
    this.form.synthesisStrategy = config.synthesisStrategy;
    this.form.confidenceThreshold = config.confidenceThreshold;
    this.form.maxDebateRounds = config.maxDebateRounds;
  }

  // ============================================
  // Methods
  // ============================================

  addAgent(type: CliType): void {
    if (!this.form.selectedAgents.includes(type)) {
      this.form.selectedAgents = [...this.form.selectedAgents, type];
      this.validateForm();
    }
  }

  removeAgent(type: CliType): void {
    this.form.selectedAgents = this.form.selectedAgents.filter(a => a !== type);
    this.validateForm();
  }

  validateForm(): void {
    const result = this.service.validateForm(this.form);
    this.validationResult.set(result);
  }

  async handleLaunch(): Promise<void> {
    if (!this.validation().isValid) return;

    this.isLaunching.set(true);

    try {
      const sessionId = await this.service.startVerification(this.form);
      this.launched.emit(sessionId);
    } finally {
      this.isLaunching.set(false);
    }
  }

  handleCancel(): void {
    this.cancelled.emit();
  }
}
