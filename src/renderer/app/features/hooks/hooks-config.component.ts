/**
 * Hooks Config Component
 *
 * Hook management interface for:
 * - Hook rule CRUD
 * - Event selector
 * - Condition builder
 * - Action configuration
 * - Rule testing/dry-run
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import type {
  HookRule,
  HookEvent,
  HookCondition,
  HookAction,
  ConditionOperator,
} from '../../../../shared/types/hook.types';

interface HookFormData {
  id: string;
  name: string;
  message: string;
  event: HookEvent | 'all';
  toolMatcher: string;
  conditions: HookCondition[];
  action: HookAction;
  enabled: boolean;
}

@Component({
  selector: 'app-hooks-config',
  standalone: true,
  template: `
    <div class="hooks-container">
      <!-- Header -->
      <div class="hooks-header">
        <div class="header-left">
          <span class="hooks-icon">🪝</span>
          <span class="hooks-title">Hooks</span>
          <span class="hook-count">{{ hooks().length }} rules</span>
        </div>
        <button class="add-btn" (click)="startCreate()">
          + Add Hook
        </button>
      </div>

      <!-- Built-in Rules Section -->
      @if (builtInRules().length > 0) {
        <div class="section">
          <div class="section-header">
            <span class="section-title">Built-in Rules</span>
            <span class="section-count">{{ enabledBuiltInCount() }} enabled</span>
          </div>
          <div class="rules-list">
            @for (rule of builtInRules(); track rule.id) {
              <div class="rule-item" [class.disabled]="!rule.enabled">
                <div class="rule-info">
                  <span class="rule-name">{{ rule.name }}</span>
                  <span class="rule-event">{{ rule.event }}</span>
                  @if (rule.message) {
                    <span class="rule-message">{{ rule.message }}</span>
                  }
                </div>
                <label class="toggle-switch">
                  <input
                    type="checkbox"
                    [checked]="rule.enabled"
                    (change)="toggleBuiltIn(rule)"
                  />
                  <span class="toggle-slider"></span>
                </label>
              </div>
            }
          </div>
        </div>
      }

      <!-- Custom Rules Section -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">Custom Rules</span>
        </div>
        @if (customRules().length > 0) {
          <div class="rules-list">
            @for (rule of customRules(); track rule.id) {
              <div class="rule-item" [class.disabled]="!rule.enabled">
                <div class="rule-info">
                  <span class="rule-name">{{ rule.name }}</span>
                  <span class="rule-event">{{ rule.event }}</span>
                  <span class="rule-action" [class]="'action-' + rule.action">
                    {{ rule.action }}
                  </span>
                  @if (rule.message) {
                    <span class="rule-message">{{ rule.message }}</span>
                  }
                </div>
                <div class="rule-actions">
                  <button class="icon-btn" (click)="testRule(rule)" title="Test">
                    ▶
                  </button>
                  <button class="icon-btn" (click)="editRule(rule)" title="Edit">
                    ✎
                  </button>
                  <button class="icon-btn danger" (click)="deleteRule(rule)" title="Delete">
                    ✕
                  </button>
                  <label class="toggle-switch">
                    <input
                      type="checkbox"
                      [checked]="rule.enabled"
                      (change)="toggleRule(rule)"
                    />
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
            }
          </div>
        } @else {
          <div class="empty-state">
            <span class="empty-text">No custom hooks configured</span>
          </div>
        }
      </div>

      <!-- Edit/Create Form -->
      @if (isEditing()) {
        <div class="form-overlay" (click)="cancelEdit()">
          <div class="form-modal" (click)="$event.stopPropagation()">
            <div class="form-header">
              <span class="form-title">
                {{ editingRule() ? 'Edit Hook' : 'Create Hook' }}
              </span>
              <button class="close-btn" (click)="cancelEdit()">✕</button>
            </div>

            <div class="form-body">
              <!-- Name -->
              <div class="form-group">
                <label class="form-label">Name</label>
                <input
                  type="text"
                  class="form-input"
                  [value]="formData().name"
                  (input)="updateForm('name', $any($event.target).value)"
                  placeholder="My Hook"
                />
              </div>

              <!-- Message -->
              <div class="form-group">
                <label class="form-label">Message (shown when triggered)</label>
                <input
                  type="text"
                  class="form-input"
                  [value]="formData().message"
                  (input)="updateForm('message', $any($event.target).value)"
                  placeholder="Warning message to display"
                />
              </div>

              <!-- Event -->
              <div class="form-group">
                <label class="form-label">Event</label>
                <select
                  class="form-select"
                  [value]="formData().event"
                  (change)="updateForm('event', $any($event.target).value)"
                >
                  @for (event of events; track event) {
                    <option [value]="event">{{ event }}</option>
                  }
                </select>
              </div>

              <!-- Tool Matcher -->
              <div class="form-group">
                <label class="form-label">Tool Matcher (optional, regex)</label>
                <input
                  type="text"
                  class="form-input"
                  [value]="formData().toolMatcher"
                  (input)="updateForm('toolMatcher', $any($event.target).value)"
                  placeholder="e.g., Bash|Edit|Write"
                />
              </div>

              <!-- Action -->
              <div class="form-group">
                <label class="form-label">Action</label>
                <div class="action-buttons">
                  <button
                    class="action-option"
                    [class.active]="formData().action === 'warn'"
                    (click)="updateForm('action', 'warn')"
                  >
                    ⚠️ Warn
                  </button>
                  <button
                    class="action-option"
                    [class.active]="formData().action === 'block'"
                    (click)="updateForm('action', 'block')"
                  >
                    🛑 Block
                  </button>
                </div>
              </div>

              <!-- Conditions -->
              <div class="form-group">
                <div class="conditions-header">
                  <label class="form-label">Conditions (AND)</label>
                  <button
                    class="add-condition-btn"
                    (click)="addCondition()"
                  >
                    + Add
                  </button>
                </div>
                @if (formData().conditions.length > 0) {
                  <div class="conditions-list">
                    @for (condition of formData().conditions; track $index; let i = $index) {
                      <div class="condition-row">
                        <select
                          class="condition-field"
                          [value]="condition.field"
                          (change)="updateCondition(i, 'field', $any($event.target).value)"
                        >
                          <option value="toolName">Tool Name</option>
                          <option value="filePath">File Path</option>
                          <option value="newContent">Content</option>
                          <option value="command">Command</option>
                        </select>
                        <select
                          class="condition-operator"
                          [value]="condition.operator"
                          (change)="updateCondition(i, 'operator', $any($event.target).value)"
                        >
                          <option value="equals">equals</option>
                          <option value="contains">contains</option>
                          <option value="not_contains">not contains</option>
                          <option value="regex_match">matches (regex)</option>
                          <option value="starts_with">starts with</option>
                          <option value="ends_with">ends with</option>
                        </select>
                        <input
                          type="text"
                          class="condition-pattern"
                          [value]="condition.pattern"
                          (input)="updateCondition(i, 'pattern', $any($event.target).value)"
                          placeholder="pattern"
                        />
                        <button
                          class="remove-condition-btn"
                          (click)="removeCondition(i)"
                        >
                          ✕
                        </button>
                      </div>
                    }
                  </div>
                } @else {
                  <span class="no-conditions">
                    No conditions (matches all {{ formData().event }} events)
                  </span>
                }
              </div>

              <!-- Enabled -->
              <div class="form-group row">
                <label class="form-label">Enabled</label>
                <label class="toggle-switch">
                  <input
                    type="checkbox"
                    [checked]="formData().enabled"
                    (change)="updateForm('enabled', $any($event.target).checked)"
                  />
                  <span class="toggle-slider"></span>
                </label>
              </div>
            </div>

            <div class="form-footer">
              <button class="form-btn secondary" (click)="cancelEdit()">
                Cancel
              </button>
              <button class="form-btn secondary" (click)="testFormRule()">
                Test
              </button>
              <button class="form-btn primary" (click)="saveRule()">
                {{ editingRule() ? 'Update' : 'Create' }}
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Test Results -->
      @if (testResult()) {
        <div class="test-result" [class.success]="testResult()?.passed">
          <span class="result-icon">
            {{ testResult()?.passed ? '✓' : '✕' }}
          </span>
          <span class="result-message">{{ testResult()?.message }}</span>
          <button class="dismiss-btn" (click)="clearTestResult()">✕</button>
        </div>
      }
    </div>
  `,
  styles: [`
    .hooks-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      display: flex;
      flex-direction: column;
    }

    .hooks-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .hooks-icon {
      font-size: 18px;
    }

    .hooks-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .hook-count {
      padding: 2px 6px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-size: 11px;
      color: var(--text-secondary);
    }

    .add-btn {
      padding: 6px 12px;
      background: var(--primary-color);
      border: none;
      border-radius: var(--radius-sm);
      color: white;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background var(--transition-fast);

      &:hover {
        background: var(--primary-hover);
      }
    }

    .section {
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);

      &:last-child {
        border-bottom: none;
      }
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-sm);
    }

    .section-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .section-count {
      font-size: 11px;
      color: var(--text-muted);
    }

    .rules-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .rule-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm);
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      transition: opacity var(--transition-fast);

      &.disabled {
        opacity: 0.5;
      }
    }

    .rule-info {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--spacing-sm);
      flex: 1;
    }

    .rule-name {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .rule-event {
      padding: 2px 6px;
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      font-size: 10px;
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }

    .rule-action {
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      font-size: 10px;
      font-weight: 600;

      &.action-warn {
        background: var(--warning-color);
        color: black;
      }

      &.action-block {
        background: var(--error-color);
        color: white;
      }
    }

    .rule-message {
      width: 100%;
      font-size: 11px;
      color: var(--text-muted);
    }

    .rule-actions {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
    }

    .icon-btn {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 12px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.danger:hover {
        background: var(--error-color);
        color: white;
      }
    }

    .toggle-switch {
      position: relative;
      display: inline-block;
      width: 36px;
      height: 20px;

      input {
        opacity: 0;
        width: 0;
        height: 0;
      }

      .toggle-slider {
        position: absolute;
        cursor: pointer;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: var(--bg-tertiary);
        border-radius: 10px;
        transition: background var(--transition-fast);

        &::before {
          content: '';
          position: absolute;
          height: 16px;
          width: 16px;
          left: 2px;
          bottom: 2px;
          background: white;
          border-radius: 50%;
          transition: transform var(--transition-fast);
        }
      }

      input:checked + .toggle-slider {
        background: var(--primary-color);
      }

      input:checked + .toggle-slider::before {
        transform: translateX(16px);
      }
    }

    .empty-state {
      padding: var(--spacing-lg);
      text-align: center;
    }

    .empty-text {
      font-size: 13px;
      color: var(--text-muted);
    }

    /* Form Modal */
    .form-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }

    .form-modal {
      width: 480px;
      max-height: 90vh;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .form-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .form-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .close-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 18px;
      cursor: pointer;

      &:hover {
        color: var(--text-primary);
      }
    }

    .form-body {
      flex: 1;
      overflow-y: auto;
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);

      &.row {
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
      }
    }

    .form-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .form-input, .form-select {
      padding: 8px 12px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 13px;

      &:focus {
        outline: none;
        border-color: var(--primary-color);
      }
    }

    .action-buttons {
      display: flex;
      gap: var(--spacing-xs);
    }

    .action-option {
      flex: 1;
      padding: 8px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 12px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }

      &.active {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: white;
      }
    }

    .conditions-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .add-condition-btn {
      padding: 2px 8px;
      background: var(--bg-tertiary);
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 11px;
      cursor: pointer;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .conditions-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .condition-row {
      display: flex;
      gap: var(--spacing-xs);
      align-items: center;
    }

    .condition-field {
      width: 100px;
      padding: 6px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 11px;
    }

    .condition-operator {
      width: 110px;
      padding: 6px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 11px;
    }

    .condition-pattern {
      flex: 1;
      padding: 6px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 11px;
    }

    .remove-condition-btn {
      width: 24px;
      height: 24px;
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;

      &:hover {
        color: var(--error-color);
      }
    }

    .no-conditions {
      font-size: 11px;
      color: var(--text-muted);
      font-style: italic;
    }

    .form-footer {
      display: flex;
      justify-content: flex-end;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      border-top: 1px solid var(--border-color);
    }

    .form-btn {
      padding: 8px 16px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);

      &.primary {
        background: var(--primary-color);
        border: none;
        color: white;

        &:hover {
          background: var(--primary-hover);
        }
      }

      &.secondary {
        background: transparent;
        border: 1px solid var(--border-color);
        color: var(--text-secondary);

        &:hover {
          background: var(--bg-hover);
          color: var(--text-primary);
        }
      }
    }

    .test-result {
      position: fixed;
      bottom: 20px;
      right: 20px;
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--error-color);
      color: white;
      border-radius: var(--radius-md);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      z-index: 100;

      &.success {
        background: var(--success-color);
      }
    }

    .result-icon {
      font-size: 16px;
    }

    .result-message {
      font-size: 13px;
    }

    .dismiss-btn {
      background: transparent;
      border: none;
      color: white;
      opacity: 0.7;
      cursor: pointer;

      &:hover {
        opacity: 1;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HooksConfigComponent {
  /** All hook rules */
  hooks = input<HookRule[]>([]);

  /** Built-in rules */
  builtInRules = input<HookRule[]>([]);

  /** Events */
  ruleCreated = output<HookRule>();
  ruleUpdated = output<HookRule>();
  ruleDeleted = output<string>();
  ruleToggled = output<{ id: string; enabled: boolean }>();
  ruleTested = output<HookRule>();

  /** Available events */
  events: (HookEvent | 'all')[] = [
    'all',
    'PreToolUse',
    'PostToolUse',
    'Stop',
    'SessionStart',
    'SessionEnd',
    'BeforeCommit',
    'UserPromptSubmit',
  ];

  /** Available operators */
  operators: ConditionOperator[] = [
    'equals',
    'contains',
    'not_contains',
    'regex_match',
    'starts_with',
    'ends_with',
  ];

  /** Editing state */
  isEditing = signal(false);
  editingRule = signal<HookRule | null>(null);

  /** Form data */
  formData = signal<HookFormData>({
    id: '',
    name: '',
    message: '',
    event: 'PreToolUse',
    toolMatcher: '',
    conditions: [],
    action: 'warn',
    enabled: true,
  });

  /** Test result */
  testResult = signal<{ passed: boolean; message: string } | null>(null);

  /** Custom rules (non-builtin) */
  customRules = computed(() =>
    this.hooks().filter((h) => h.source !== 'built-in')
  );

  /** Count of enabled built-in rules */
  enabledBuiltInCount = computed(() =>
    this.builtInRules().filter((r) => r.enabled).length
  );

  startCreate(): void {
    this.formData.set({
      id: `hook-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: '',
      message: '',
      event: 'PreToolUse',
      toolMatcher: '',
      conditions: [],
      action: 'warn',
      enabled: true,
    });
    this.editingRule.set(null);
    this.isEditing.set(true);
  }

  editRule(rule: HookRule): void {
    this.formData.set({
      id: rule.id,
      name: rule.name,
      message: rule.message,
      event: rule.event,
      toolMatcher: rule.toolMatcher || '',
      conditions: [...rule.conditions],
      action: rule.action,
      enabled: rule.enabled,
    });
    this.editingRule.set(rule);
    this.isEditing.set(true);
  }

  cancelEdit(): void {
    this.isEditing.set(false);
    this.editingRule.set(null);
  }

  updateForm(field: keyof HookFormData, value: unknown): void {
    this.formData.update((data) => ({ ...data, [field]: value }));
  }

  addCondition(): void {
    this.formData.update((data) => ({
      ...data,
      conditions: [
        ...data.conditions,
        { field: 'toolName', operator: 'equals' as ConditionOperator, pattern: '' },
      ],
    }));
  }

  updateCondition(index: number, field: keyof HookCondition, value: string): void {
    this.formData.update((data) => {
      const conditions = [...data.conditions];
      conditions[index] = { ...conditions[index], [field]: value };
      return { ...data, conditions };
    });
  }

  removeCondition(index: number): void {
    this.formData.update((data) => ({
      ...data,
      conditions: data.conditions.filter((_, i) => i !== index),
    }));
  }

  saveRule(): void {
    const data = this.formData();
    const rule: HookRule = {
      id: data.id,
      name: data.name,
      enabled: data.enabled,
      event: data.event,
      toolMatcher: data.toolMatcher || undefined,
      conditions: data.conditions,
      action: data.action,
      message: data.message,
      source: 'user',
      createdAt: this.editingRule()?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };

    if (this.editingRule()) {
      this.ruleUpdated.emit(rule);
    } else {
      this.ruleCreated.emit(rule);
    }

    this.isEditing.set(false);
    this.editingRule.set(null);
  }

  deleteRule(rule: HookRule): void {
    this.ruleDeleted.emit(rule.id);
  }

  toggleRule(rule: HookRule): void {
    this.ruleToggled.emit({ id: rule.id, enabled: !rule.enabled });
  }

  toggleBuiltIn(rule: HookRule): void {
    this.ruleToggled.emit({ id: rule.id, enabled: !rule.enabled });
  }

  testRule(rule: HookRule): void {
    this.ruleTested.emit(rule);
    // Simulated test result
    this.testResult.set({
      passed: true,
      message: `Hook "${rule.name}" would trigger on matching events`,
    });
  }

  testFormRule(): void {
    const data = this.formData();
    this.testResult.set({
      passed: data.conditions.length === 0 || data.conditions.every((c) => c.pattern),
      message: data.conditions.length === 0
        ? `Hook will trigger on all ${data.event} events`
        : `Hook has ${data.conditions.length} condition(s) configured`,
    });
  }

  clearTestResult(): void {
    this.testResult.set(null);
  }
}
