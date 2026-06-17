/**
 * Agent Configuration Panel Component
 *
 * Modal panel for configuring verification agents:
 * - Per-agent settings (personality, model, timeout)
 * - Synthesis settings (strategy, rounds, thresholds)
 * - Add/remove agents
 */

import {
  Component,
  inject,
  output,
  signal,
  ChangeDetectionStrategy, OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { VerificationStore } from '../../../core/state/verification.store';
import type { CliType } from '../../../../../shared/types/unified-cli-response';
import type { PersonalityType, SynthesisStrategy } from '../../../../../shared/types/verification.types';

interface AgentConfig {
  name: CliType;
  displayName: string;
  personality: PersonalityType;
  timeout: number;
  autoApprove: boolean;
}

@Component({
  selector: 'app-agent-config-panel',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel-overlay" (click)="handleOverlayClick($event)" (keydown.enter)="handleOverlayClick($event)" (keydown.space)="handleOverlayClick($event)" tabindex="0" role="button">
      <div class="panel-container">
        <!-- Header -->
        <div class="panel-header">
          <h2 class="panel-title">Configure Verification Agents</h2>
          <button class="close-btn" (click)="closePanel.emit()">×</button>
        </div>

        <!-- Content -->
        <div class="panel-content">
          <!-- Selected Agents -->
          <section class="config-section">
            <h3 class="section-title">Selected Agents ({{ store.selectedAgents().length }})</h3>

            @for (agent of agentConfigs(); track agent.name; let i = $index) {
              <div class="agent-config-card">
                <div class="config-header">
                  <span class="agent-number">Agent {{ i + 1 }}: {{ agent.displayName }}</span>
                  <button
                    class="remove-btn"
                    (click)="removeAgent(agent.name)"
                    [disabled]="store.selectedAgents().length <= 1"
                  >
                    Remove
                  </button>
                </div>

                <div class="config-fields">
                  <div class="field-row">
                    <div class="field">
                      <span class="field-label">Personality</span>
                      <select
                        class="field-select"
                        [(ngModel)]="agent.personality"
                        (change)="updateAgentConfig(agent)"
                      >
                        @for (p of personalities; track p.value) {
                          <option [value]="p.value">{{ p.label }}</option>
                        }
                      </select>
                      <span class="field-hint">{{ getPersonalityDescription(agent.personality) }}</span>
                    </div>

                    <div class="field">
                      <span class="field-label">Timeout (seconds)</span>
                      <input
                        type="number"
                        class="field-input"
                        [(ngModel)]="agent.timeout"
                        min="30"
                        max="600"
                      />
                    </div>
                  </div>

                  <div class="field checkbox-field">
                    <label class="checkbox-label">
                      <input
                        type="checkbox"
                        [(ngModel)]="agent.autoApprove"
                      />
                      Auto-approve tool use
                    </label>
                  </div>
                </div>
              </div>
            }

            <!-- Add Agent Button -->
            @if (canAddAgent()) {
              <button class="add-agent-btn" (click)="showAgentPicker = true">
                + Add Another Agent
              </button>

              @if (showAgentPicker) {
                <div class="agent-picker">
                  <h4>Select Agent to Add</h4>
                  <div class="picker-options">
                    @for (cli of availableToAdd(); track cli.name) {
                      <button
                        class="picker-option"
                        (click)="addAgent(cli.name)"
                      >
                        {{ cli.displayName || cli.name }}
                      </button>
                    }
                  </div>
                  <button class="cancel-btn" (click)="showAgentPicker = false">Cancel</button>
                </div>
              }
            }
          </section>

          <!-- Synthesis Settings -->
          <section class="config-section">
            <h3 class="section-title">Synthesis Settings</h3>

            <div class="config-fields">
              <div class="field-row">
                <div class="field">
                  <span class="field-label">Strategy</span>
                  <select
                    class="field-select"
                    [(ngModel)]="synthesisStrategy"
                    (change)="updateSynthesisConfig()"
                  >
                    @for (s of strategies; track s.value) {
                      <option [value]="s.value">{{ s.label }}</option>
                    }
                  </select>
                </div>

                @if (synthesisStrategy === 'debate') {
                  <div class="field">
                    <span class="field-label">Debate Rounds</span>
                    <input
                      type="number"
                      class="field-input"
                      [(ngModel)]="debateRounds"
                      min="2"
                      max="6"
                      (change)="updateSynthesisConfig()"
                    />
                    <span class="field-hint">Independent → Critique → Defense → Synthesis</span>
                  </div>
                }
              </div>

              <div class="field-row">
                <div class="field">
                  <span class="field-label">Convergence Threshold</span>
                  <input
                    type="range"
                    class="field-range"
                    [(ngModel)]="convergenceThreshold"
                    min="0.5"
                    max="1"
                    step="0.05"
                    (change)="updateSynthesisConfig()"
                  />
                  <span class="range-value">{{ (convergenceThreshold * 100).toFixed(0) }}%</span>
                </div>

                <div class="field">
                  <span class="field-label">Min Agreement</span>
                  <input
                    type="range"
                    class="field-range"
                    [(ngModel)]="minAgreement"
                    min="0.3"
                    max="0.9"
                    step="0.05"
                    (change)="updateSynthesisConfig()"
                  />
                  <span class="range-value">{{ (minAgreement * 100).toFixed(0) }}%</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <!-- Footer -->
        <div class="panel-footer">
          <button class="action-btn secondary" (click)="closePanel.emit()">
            Cancel
          </button>
          <button class="action-btn primary" (click)="saveAndClose()">
            Save & Continue
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .panel-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .panel-container {
      background: var(--bg-secondary);
      border-radius: 12px;
      width: 90%;
      max-width: 700px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 24px;
      border-bottom: 1px solid var(--border-color);
    }

    .panel-title {
      font-size: 18px;
      font-weight: 600;
      margin: 0;
    }

    .close-btn {
      background: none;
      border: none;
      font-size: 24px;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 4px;
      line-height: 1;
    }

    .close-btn:hover {
      color: var(--text-primary);
    }

    .panel-content {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
    }

    .config-section {
      margin-bottom: 24px;
    }

    .section-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-secondary);
      margin: 0 0 16px 0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .agent-config-card {
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
    }

    .config-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .agent-number {
      font-weight: 600;
      color: var(--text-primary);
    }

    .remove-btn {
      background: none;
      border: none;
      color: #ef4444;
      font-size: 13px;
      cursor: pointer;
    }

    .remove-btn:disabled {
      color: var(--text-muted);
      cursor: not-allowed;
    }

    .config-fields {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .field-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .field-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .field-select,
    .field-input {
      padding: 8px 12px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-secondary);
      color: var(--text-primary);
      font-size: 14px;
    }

    .field-select:focus,
    .field-input:focus {
      outline: none;
      border-color: var(--accent-color, #3b82f6);
    }

    .field-hint {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
    }

    .field-range {
      width: 100%;
    }

    .range-value {
      font-size: 13px;
      font-weight: 500;
      color: var(--accent-color, #3b82f6);
    }

    .checkbox-field {
      flex-direction: row;
    }

    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      cursor: pointer;
    }

    .add-agent-btn {
      width: 100%;
      padding: 12px;
      border: 2px dashed var(--border-color);
      border-radius: 8px;
      background: transparent;
      color: var(--text-secondary);
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .add-agent-btn:hover {
      border-color: var(--accent-color, #3b82f6);
      color: var(--accent-color, #3b82f6);
    }

    .agent-picker {
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      margin-top: 12px;
    }

    .agent-picker h4 {
      margin: 0 0 12px 0;
      font-size: 14px;
    }

    .picker-options {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
    }

    .picker-option {
      padding: 8px 16px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-secondary);
      color: var(--text-primary);
      font-size: 14px;
      cursor: pointer;
    }

    .picker-option:hover {
      border-color: var(--accent-color, #3b82f6);
    }

    .cancel-btn {
      background: none;
      border: none;
      color: var(--text-secondary);
      font-size: 13px;
      cursor: pointer;
    }

    .panel-footer {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      padding: 16px 24px;
      border-top: 1px solid var(--border-color);
    }

    .action-btn {
      padding: 10px 20px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border: none;
    }

    .action-btn.primary {
      background: var(--accent-color, #3b82f6);
      color: white;
    }

    .action-btn.primary:hover {
      background: var(--accent-hover, #2563eb);
    }

    .action-btn.secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
    }

    .action-btn.secondary:hover {
      background: var(--bg-hover);
    }
  `],
})
export class AgentConfigPanelComponent implements OnInit {
  store = inject(VerificationStore);

  closePanel = output<void>();

  // UI state
  showAgentPicker = false;

  // Config state
  synthesisStrategy: SynthesisStrategy = 'merge';
  debateRounds = 2;
  convergenceThreshold = 0.8;
  minAgreement = 0.6;

  // Options
  personalities: { value: PersonalityType; label: string }[] = [
    { value: 'methodical-analyst', label: 'Methodical Analyst' },
    { value: 'creative-solver', label: 'Creative Solver' },
    { value: 'devils-advocate', label: "Devil's Advocate" },
    { value: 'pragmatic-engineer', label: 'Pragmatic Engineer' },
    { value: 'security-focused', label: 'Security Expert' },
    { value: 'domain-expert', label: 'Domain Expert' },
    { value: 'user-advocate', label: 'User Advocate' },
    { value: 'generalist', label: 'Generalist' },
  ];

  strategies: { value: SynthesisStrategy; label: string }[] = [
    { value: 'consensus', label: 'Consensus' },
    { value: 'debate', label: 'Debate' },
    { value: 'best-of', label: 'Best-of' },
    { value: 'merge', label: 'Merge' },
  ];

  personalityDescriptions: Record<PersonalityType, string> = {
    'methodical-analyst': 'Accuracy-focused, questions assumptions',
    'creative-solver': 'Outside-the-box thinking, innovative',
    'devils-advocate': 'Contrarian, stress-testing ideas',
    'pragmatic-engineer': 'Real-world constraints, proven solutions',
    'security-focused': 'Security-first, risk assessment',
    'domain-expert': 'Deep expertise in specific domain',
    'user-advocate': 'User experience and usability focus',
    'generalist': 'Broad perspective, balanced approach',
  };

  constructor() {
    // Initialize from store
    const config = this.store.defaultConfig();
    this.synthesisStrategy = config.synthesisStrategy;
    this.debateRounds = config.maxDebateRounds;
    this.convergenceThreshold = config.confidenceThreshold;
  }

  // ============================================
  // Agent Config
  // ============================================

  agentConfigs = signal<AgentConfig[]>([]);

  private initAgentConfigs(): void {
    const configs = this.store.selectedAgents().map((name, i) => ({
      name,
      displayName: this.getDisplayName(name),
      personality: this.store.defaultConfig().personalities[i] || 'methodical-analyst' as PersonalityType,
      timeout: 300,
      autoApprove: true,
    }));
    this.agentConfigs.set(configs);
  }

  ngOnInit(): void {
    this.initAgentConfigs();
  }

  getDisplayName(name: string): string {
    const names: Record<string, string> = {
      claude: 'Claude CLI',
      codex: 'Codex CLI',
      gemini: 'Gemini CLI',
      ollama: 'Ollama (Local)',
      aider: 'Aider',
      continue: 'Continue',
      cursor: 'Cursor',
      copilot: 'GitHub Copilot',
    };
    return names[name] || name;
  }

  getPersonalityDescription(personality: PersonalityType): string {
    return this.personalityDescriptions[personality] || '';
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  updateAgentConfig(_agent?: unknown): void {
    // Update personality in store config
    const personalities = this.agentConfigs().map(a => a.personality);
    this.store.setDefaultConfig({ personalities });
  }

  removeAgent(name: CliType): void {
    this.store.removeSelectedAgent(name);
    this.initAgentConfigs();
  }

  // ============================================
  // Add Agent
  // ============================================

  canAddAgent(): boolean {
    return this.store.selectedAgents().length < this.store.availableClis().length;
  }

  availableToAdd(): { name: CliType; displayName: string }[] {
    const selected = this.store.selectedAgents();
    return this.store.availableClis()
      .filter(cli => !selected.includes(cli.name as CliType))
      .map(cli => ({
        name: cli.name as CliType,
        displayName: cli.displayName || cli.name,
      }));
  }

  addAgent(name: CliType): void {
    this.store.addSelectedAgent(name);
    this.initAgentConfigs();
    this.showAgentPicker = false;
  }

  // ============================================
  // Synthesis Config
  // ============================================

  updateSynthesisConfig(): void {
    this.store.setDefaultConfig({
      synthesisStrategy: this.synthesisStrategy,
      maxDebateRounds: this.debateRounds,
      confidenceThreshold: this.convergenceThreshold,
    });
  }

  // ============================================
  // Actions
  // ============================================

  handleOverlayClick(event: Event): void {
    if ((event.target as HTMLElement).classList.contains('panel-overlay')) {
      this.closePanel.emit();
    }
  }

  saveAndClose(): void {
    this.updateSynthesisConfig();
    this.closePanel.emit();
  }
}
