/**
 * Verification Preferences Component
 *
 * Default settings for verification sessions:
 * - Default synthesis strategy
 * - Agent count and selection
 * - Threshold settings
 * - Timeout configurations
 * - Personality presets
 */

import {
  Component,
  signal,
  inject,
  OnInit,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { VerificationStore } from '../../../core/state/verification.store';
import type { CliType } from '../../../core/state/verification.store';
import type { PersonalityType } from '../../../../../shared/types/verification.types';

interface PersonalityPreset {
  id: string;
  name: string;
  description: string;
  personalities: PersonalityType[];
}

@Component({
  selector: 'app-verification-preferences',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="preferences-panel">
      <div class="section-header">
        <h2>Default Verification Settings</h2>
        <p class="section-description">
          Configure default settings for new verification sessions
        </p>
      </div>

      <!-- Synthesis Strategy -->
      <div class="setting-group">
        <h3>Synthesis Strategy</h3>
        <div class="strategy-grid">
          @for (strategy of strategies; track strategy.id) {
            <label
              class="strategy-card"
              [class.selected]="defaultStrategy() === strategy.id"
            >
              <input
                type="radio"
                name="strategy"
                [value]="strategy.id"
                [checked]="defaultStrategy() === strategy.id"
                (change)="defaultStrategy.set(strategy.id)"
              />
              <div class="strategy-content">
                <span class="strategy-icon">{{ strategy.icon }}</span>
                <span class="strategy-name">{{ strategy.name }}</span>
                <span class="strategy-desc">{{ strategy.description }}</span>
              </div>
            </label>
          }
        </div>
      </div>

      <!-- Agent Settings -->
      <div class="setting-group">
        <h3>Agent Configuration</h3>

        <div class="setting-row">
          <div class="setting-label">
            <span>Default Agent Count</span>
            <span class="setting-hint">Number of agents for quick start</span>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="1"
              max="6"
              [value]="defaultAgentCount()"
              (input)="defaultAgentCount.set(+$any($event.target).value)"
            />
            <span class="range-value">{{ defaultAgentCount() }}</span>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-label">
            <span>Preferred Agents</span>
            <span class="setting-hint">Agents selected by default</span>
          </div>
          <div class="agent-checkboxes">
            @for (agent of availableAgents; track agent.id) {
              <label class="agent-checkbox">
                <input
                  type="checkbox"
                  [checked]="preferredAgents().includes(agent.id)"
                  (change)="togglePreferredAgent(agent.id, $any($event.target).checked)"
                />
                <span class="agent-name">{{ agent.name }}</span>
              </label>
            }
          </div>
        </div>
      </div>

      <!-- Thresholds -->
      <div class="setting-group">
        <h3>Thresholds</h3>

        <div class="setting-row">
          <div class="setting-label">
            <span>Minimum Agreement</span>
            <span class="setting-hint">Required for consensus (0.0 - 1.0)</span>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="0.3"
              max="0.95"
              step="0.05"
              [value]="minAgreement()"
              (input)="minAgreement.set(+$any($event.target).value)"
            />
            <span class="range-value">{{ (minAgreement() * 100).toFixed(0) }}%</span>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-label">
            <span>Confidence Threshold</span>
            <span class="setting-hint">Minimum confidence for results</span>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="0.3"
              max="0.95"
              step="0.05"
              [value]="confidenceThreshold()"
              (input)="confidenceThreshold.set(+$any($event.target).value)"
            />
            <span class="range-value">{{ (confidenceThreshold() * 100).toFixed(0) }}%</span>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-label">
            <span>Convergence Threshold</span>
            <span class="setting-hint">When to stop debate rounds</span>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="0.5"
              max="0.99"
              step="0.01"
              [value]="convergenceThreshold()"
              (input)="convergenceThreshold.set(+$any($event.target).value)"
            />
            <span class="range-value">{{ (convergenceThreshold() * 100).toFixed(0) }}%</span>
          </div>
        </div>
      </div>

      <!-- Debate Settings -->
      <div class="setting-group">
        <h3>Debate Settings</h3>

        <div class="setting-row">
          <div class="setting-label">
            <span>Maximum Debate Rounds</span>
            <span class="setting-hint">Limit on debate iterations</span>
          </div>
          <div class="setting-control">
            <input
              type="number"
              min="1"
              max="10"
              [value]="maxDebateRounds()"
              (change)="maxDebateRounds.set(+$any($event.target).value)"
            />
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-label">
            <span>Auto-continue Debate</span>
            <span class="setting-hint">Continue until convergence</span>
          </div>
          <div class="setting-control">
            <label class="toggle">
              <input
                type="checkbox"
                [checked]="autoContinueDebate()"
                (change)="autoContinueDebate.set($any($event.target).checked)"
              />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <!-- Timeouts -->
      <div class="setting-group">
        <h3>Timeouts</h3>

        <div class="setting-row">
          <div class="setting-label">
            <span>Response Timeout</span>
            <span class="setting-hint">Per-agent response limit</span>
          </div>
          <div class="setting-control inline">
            <input
              type="number"
              min="30"
              max="600"
              [value]="responseTimeout()"
              (change)="responseTimeout.set(+$any($event.target).value)"
            />
            <span class="unit">seconds</span>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-label">
            <span>Session Timeout</span>
            <span class="setting-hint">Total verification time limit</span>
          </div>
          <div class="setting-control inline">
            <input
              type="number"
              min="60"
              max="3600"
              [value]="sessionTimeout()"
              (change)="sessionTimeout.set(+$any($event.target).value)"
            />
            <span class="unit">seconds</span>
          </div>
        </div>
      </div>

      <!-- Personality Presets -->
      <div class="setting-group">
        <h3>Personality Presets</h3>
        <p class="group-description">
          Predefined agent personality combinations for quick setup
        </p>

        <div class="presets-grid">
          @for (preset of presets; track preset.id) {
            <button
              class="preset-card"
              [class.active]="activePreset() === preset.id"
              (click)="applyPreset(preset)"
            >
              <span class="preset-name">{{ preset.name }}</span>
              <span class="preset-desc">{{ preset.description }}</span>
              <div class="preset-personalities">
                @for (p of preset.personalities; track p) {
                  <span class="personality-tag">{{ p }}</span>
                }
              </div>
            </button>
          }
        </div>
      </div>

      <!-- Custom Personalities -->
      <div class="setting-group">
        <h3>Default Personalities</h3>

        <div class="personalities-list">
          @for (p of defaultPersonalities(); track p; let i = $index) {
            <div class="personality-item">
              <span class="personality-index">Agent {{ i + 1 }}:</span>
              <select
                [value]="p"
                (change)="updatePersonality(i, $any($event.target).value)"
              >
                @for (opt of personalityOptions; track opt.id) {
                  <option [value]="opt.id">{{ opt.name }}</option>
                }
              </select>
              <button
                class="btn-icon-small"
                (click)="removePersonality(i)"
                [disabled]="defaultPersonalities().length <= 1"
              >
                ✕
              </button>
            </div>
          }
        </div>

        @if (defaultPersonalities().length < 6) {
          <button class="btn-add" (click)="addPersonality()">
            + Add Personality
          </button>
        }
      </div>

      <!-- Actions -->
      <div class="preferences-actions">
        <button class="btn-secondary" (click)="resetDefaults()">
          Reset to Defaults
        </button>
        <button class="btn-primary" (click)="savePreferences()">
          Save Preferences
        </button>
      </div>
    </div>
  `,
  styles: [`
    .preferences-panel {
      padding: 0;
    }

    .section-header {
      margin-bottom: 24px;
    }

    .section-header h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }

    .section-description {
      margin: 4px 0 0;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .setting-group {
      margin-bottom: 28px;
      padding-bottom: 28px;
      border-bottom: 1px solid var(--border-color);
    }

    .setting-group:last-of-type {
      border-bottom: none;
    }

    .setting-group h3 {
      margin: 0 0 16px;
      font-size: 14px;
      font-weight: 600;
    }

    .group-description {
      margin: -8px 0 16px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .strategy-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    .strategy-card {
      display: flex;
      padding: 16px;
      border: 2px solid var(--border-color);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .strategy-card:hover {
      border-color: var(--accent-color);
    }

    .strategy-card.selected {
      border-color: var(--accent-color);
      background: rgba(59, 130, 246, 0.05);
    }

    .strategy-card input {
      margin-right: 12px;
      margin-top: 2px;
    }

    .strategy-content {
      display: flex;
      flex-direction: column;
    }

    .strategy-icon {
      font-size: 20px;
      margin-bottom: 4px;
    }

    .strategy-name {
      font-size: 14px;
      font-weight: 500;
    }

    .strategy-desc {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 4px;
    }

    .setting-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .setting-row:last-child {
      margin-bottom: 0;
    }

    .setting-label {
      display: flex;
      flex-direction: column;
    }

    .setting-label > span:first-child {
      font-size: 13px;
      font-weight: 500;
    }

    .setting-hint {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .setting-control {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .setting-control.inline {
      gap: 8px;
    }

    .setting-control input[type="range"] {
      width: 150px;
    }

    .setting-control input[type="number"] {
      width: 80px;
      padding: 8px 12px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      font-size: 13px;
    }

    .range-value {
      min-width: 45px;
      text-align: right;
      font-size: 13px;
      font-weight: 500;
      color: var(--accent-color);
    }

    .unit {
      font-size: 13px;
      color: var(--text-secondary);
    }

    .agent-checkboxes {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }

    .agent-checkbox {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      background: var(--bg-secondary);
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
    }

    .agent-checkbox:hover {
      background: var(--bg-tertiary);
    }

    /* Toggle Switch */
    .toggle {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 24px;
    }

    .toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .toggle-slider {
      position: absolute;
      cursor: pointer;
      inset: 0;
      background: var(--bg-tertiary);
      border-radius: 24px;
      transition: 0.3s;
    }

    .toggle-slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background: white;
      border-radius: 50%;
      transition: 0.3s;
    }

    .toggle input:checked + .toggle-slider {
      background: var(--accent-color);
    }

    .toggle input:checked + .toggle-slider:before {
      transform: translateX(20px);
    }

    .presets-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    .preset-card {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      padding: 12px;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background: var(--bg-secondary);
      cursor: pointer;
      text-align: left;
      transition: all 0.2s;
    }

    .preset-card:hover {
      border-color: var(--accent-color);
    }

    .preset-card.active {
      border-color: var(--accent-color);
      background: rgba(59, 130, 246, 0.05);
    }

    .preset-name {
      font-size: 13px;
      font-weight: 500;
    }

    .preset-desc {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 4px;
    }

    .preset-personalities {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
    }

    .personality-tag {
      padding: 2px 8px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      font-size: 11px;
      color: var(--text-secondary);
    }

    .personalities-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .personality-item {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .personality-index {
      width: 70px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .personality-item select {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      font-size: 13px;
      background: var(--bg-primary);
    }

    .btn-icon-small {
      width: 28px;
      height: 28px;
      padding: 0;
      background: none;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }

    .btn-icon-small:hover {
      background: var(--bg-tertiary);
    }

    .btn-icon-small:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    .btn-add {
      margin-top: 12px;
      padding: 8px 16px;
      background: none;
      border: 1px dashed var(--border-color);
      border-radius: 6px;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 13px;
    }

    .btn-add:hover {
      border-color: var(--accent-color);
      color: var(--accent-color);
    }

    .preferences-actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid var(--border-color);
    }

    /* Buttons */
    .btn-primary {
      padding: 10px 20px;
      background: var(--accent-color);
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }

    .btn-primary:hover {
      opacity: 0.9;
    }

    .btn-secondary {
      padding: 10px 16px;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
    }

    .btn-secondary:hover {
      background: var(--bg-hover);
    }
  `],
})
export class VerificationPreferencesComponent implements OnInit {
  private store = inject(VerificationStore);

  // Strategies
  strategies = [
    { id: 'consensus', name: 'Consensus', icon: '🤝', description: 'Find common ground between agents' },
    { id: 'debate', name: 'Debate', icon: '⚔️', description: 'Agents critique and defend positions' },
    { id: 'best-of', name: 'Best-of', icon: '🏆', description: 'Select highest quality response' },
    { id: 'merge', name: 'Merge', icon: '🔀', description: 'Combine insights from all agents' },
  ];

  // Available agents
  availableAgents: { id: CliType; name: string }[] = [
    { id: 'claude', name: 'Claude' },
    { id: 'gemini', name: 'Gemini' },
    { id: 'codex', name: 'Codex' },
    { id: 'copilot', name: 'Copilot' },
    { id: 'cursor', name: 'Cursor' },
    { id: 'ollama', name: 'Ollama' },
  ];

  // Personality options
  personalityOptions = [
    { id: 'methodical-analyst', name: 'Methodical Analyst' },
    { id: 'creative-solver', name: 'Creative Solver' },
    { id: 'devils-advocate', name: "Devil's Advocate" },
    { id: 'pragmatic-engineer', name: 'Pragmatic Engineer' },
    { id: 'detail-oriented', name: 'Detail Oriented' },
    { id: 'big-picture', name: 'Big Picture Thinker' },
  ];

  // Presets
  presets: PersonalityPreset[] = [
    {
      id: 'balanced',
      name: 'Balanced Team',
      description: 'Mix of analytical and creative perspectives',
      personalities: ['methodical-analyst', 'creative-solver', 'pragmatic-engineer'],
    },
    {
      id: 'adversarial',
      name: 'Adversarial Review',
      description: 'Challenge assumptions and find weaknesses',
      personalities: ['methodical-analyst', 'devils-advocate', 'security-focused'],
    },
    {
      id: 'innovative',
      name: 'Innovation Focus',
      description: 'Maximize creative and novel solutions',
      personalities: ['creative-solver', 'generalist', 'pragmatic-engineer'],
    },
    {
      id: 'thorough',
      name: 'Thorough Analysis',
      description: 'Comprehensive coverage of all aspects',
      personalities: ['methodical-analyst', 'domain-expert', 'generalist', 'devils-advocate'],
    },
  ];

  // State
  defaultStrategy = signal('merge');
  defaultAgentCount = signal(1);
  preferredAgents = signal<CliType[]>(['gemini', 'codex', 'copilot']);
  minAgreement = signal(0.6);
  confidenceThreshold = signal(0.7);
  convergenceThreshold = signal(0.8);
  maxDebateRounds = signal(2);
  autoContinueDebate = signal(true);
  responseTimeout = signal(300);
  sessionTimeout = signal(1200);
  defaultPersonalities = signal<PersonalityType[]>(['methodical-analyst']);
  activePreset = signal<string | null>(null);

  ngOnInit(): void {
    this.loadPreferences();
  }

  private loadPreferences(): void {
    const config = this.store.config();
    if (config) {
      this.defaultStrategy.set(config.synthesisStrategy || 'merge');
      this.defaultAgentCount.set(config.agentCount || 1);
      this.minAgreement.set(config.minAgreement || 0.6);
      this.confidenceThreshold.set(config.confidenceThreshold || 0.7);
      this.maxDebateRounds.set(config.maxDebateRounds || 2);
      this.preferredAgents.set([...config.cliAgents]);
      if (config.personalities) {
        this.defaultPersonalities.set([...config.personalities]);
      }
    }
  }

  togglePreferredAgent(cli: CliType, checked: boolean): void {
    this.preferredAgents.update(agents => {
      if (checked) {
        return [...agents, cli];
      } else {
        return agents.filter(a => a !== cli);
      }
    });
  }

  applyPreset(preset: PersonalityPreset): void {
    this.activePreset.set(preset.id);
    this.defaultPersonalities.set([...preset.personalities]);
    this.defaultAgentCount.set(preset.personalities.length);
  }

  updatePersonality(index: number, value: string): void {
    this.defaultPersonalities.update(personalities => {
      const updated = [...personalities];
      updated[index] = value as PersonalityType;
      return updated;
    });
    this.activePreset.set(null);
  }

  addPersonality(): void {
    if (this.defaultPersonalities().length < 6) {
      this.defaultPersonalities.update(p => [...p, 'methodical-analyst']);
      this.defaultAgentCount.update(c => c + 1);
      this.activePreset.set(null);
    }
  }

  removePersonality(index: number): void {
    if (this.defaultPersonalities().length > 1) {
      this.defaultPersonalities.update(p => p.filter((_, i) => i !== index));
      this.defaultAgentCount.update(c => Math.max(1, c - 1));
      this.activePreset.set(null);
    }
  }

  resetDefaults(): void {
    this.defaultStrategy.set('merge');
    this.defaultAgentCount.set(1);
    this.preferredAgents.set(['gemini', 'codex', 'copilot']);
    this.minAgreement.set(0.6);
    this.confidenceThreshold.set(0.7);
    this.convergenceThreshold.set(0.8);
    this.maxDebateRounds.set(2);
    this.autoContinueDebate.set(true);
    this.responseTimeout.set(300);
    this.sessionTimeout.set(1200);
    this.defaultPersonalities.set(['methodical-analyst']);
    this.activePreset.set(null);
  }

  savePreferences(): void {
    this.store.updateConfig({
      synthesisStrategy: this.defaultStrategy() as 'consensus' | 'debate' | 'best-of' | 'merge',
      agentCount: this.defaultAgentCount(),
      cliAgents: this.preferredAgents(),
      minAgreement: this.minAgreement(),
      confidenceThreshold: this.confidenceThreshold(),
      maxDebateRounds: this.maxDebateRounds(),
      personalities: this.defaultPersonalities(),
      timeout: this.sessionTimeout() * 1000,
    });
  }
}
