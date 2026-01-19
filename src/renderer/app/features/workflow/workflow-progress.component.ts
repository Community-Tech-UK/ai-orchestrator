/**
 * Workflow Progress Component
 *
 * Displays workflow execution progress with phases and gates:
 * - Current phase indicator
 * - Phase gates (user_confirmation, user_selection, user_approval)
 * - Phase data display and user input forms
 * - Gate satisfaction status
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
  WorkflowExecution,
  WorkflowTemplate,
  WorkflowPhase,
  WorkflowPhaseStatus,
  GateType,
} from '../../../../shared/types/workflow.types';

interface GateAction {
  executionId: string;
  phaseId: string;
  gateType: GateType;
  response: { approved?: boolean; selection?: string; answer?: string };
}

interface PhaseWithStatus extends WorkflowPhase {
  status: WorkflowPhaseStatus;
}

@Component({
  selector: 'app-workflow-progress',
  standalone: true,
  template: `
    @if (execution(); as exec) {
      <div class="workflow-container">
        <!-- Header -->
        <div class="workflow-header">
          <div class="header-left">
            <span class="workflow-icon">🔄</span>
            <span class="workflow-name">{{ template()?.name || exec.templateId }}</span>
          </div>
          <div class="header-right">
            <span class="status-badge" [class]="'status-' + executionStatus()">
              {{ executionStatus() }}
            </span>
          </div>
        </div>

        <!-- Progress Bar -->
        <div class="progress-section">
          <div class="progress-bar">
            <div
              class="progress-fill"
              [style.width.%]="progressPercent()"
            ></div>
          </div>
          <span class="progress-text">
            Phase {{ currentPhaseIndex() + 1 }} of {{ phasesWithStatus().length }}
          </span>
        </div>

        <!-- Phases Timeline -->
        <div class="phases-timeline">
          @for (phase of phasesWithStatus(); track phase.id; let i = $index) {
            <div
              class="phase-item"
              [class.completed]="phase.status === 'completed'"
              [class.active]="phase.status === 'active' || phase.status === 'awaiting_confirmation'"
              [class.pending]="phase.status === 'pending'"
              [class.failed]="phase.status === 'failed'"
              [class.skipped]="phase.status === 'skipped'"
            >
              <div class="phase-marker">
                @if (phase.status === 'completed') {
                  <span class="marker-icon">✓</span>
                } @else if (phase.status === 'active' || phase.status === 'awaiting_confirmation') {
                  <span class="marker-icon active">●</span>
                } @else if (phase.status === 'failed') {
                  <span class="marker-icon error">✗</span>
                } @else if (phase.status === 'skipped') {
                  <span class="marker-icon">⊘</span>
                } @else {
                  <span class="marker-icon">○</span>
                }
              </div>
              <div class="phase-content">
                <span class="phase-name">{{ phase.name }}</span>
                @if (phase.description) {
                  <span class="phase-description">{{ phase.description }}</span>
                }
              </div>
            </div>
          }
        </div>

        <!-- Current Phase Details with Pending Gate -->
        @if (currentPhase(); as phase) {
          <div class="current-phase-details">
            <h4 class="section-title">Current Phase: {{ phase.name }}</h4>

            <!-- Pending Gate -->
            @if (exec.pendingGate) {
              <div class="gates-section">
                <h5 class="gates-title">Waiting for</h5>
                <div class="gate-item pending">
                  <span class="gate-icon">⏳</span>
                  <span class="gate-label">{{ getGateLabel(exec.pendingGate.gateType) }}</span>

                  <div class="gate-action">
                    @switch (exec.pendingGate.gateType) {
                      @case ('user_confirmation') {
                        @if (exec.pendingGate.gatePrompt) {
                          <span class="gate-prompt">{{ exec.pendingGate.gatePrompt }}</span>
                        }
                        <button
                          class="gate-btn primary"
                          (click)="handleGateAction(exec.pendingGate.gateType, { approved: true })"
                        >
                          Confirm
                        </button>
                        <button
                          class="gate-btn secondary"
                          (click)="handleGateAction(exec.pendingGate.gateType, { approved: false })"
                        >
                          Cancel
                        </button>
                      }
                      @case ('user_approval') {
                        @if (exec.pendingGate.gatePrompt) {
                          <span class="gate-prompt">{{ exec.pendingGate.gatePrompt }}</span>
                        }
                        <button
                          class="gate-btn primary"
                          (click)="handleGateAction(exec.pendingGate.gateType, { approved: true })"
                        >
                          Approve
                        </button>
                        <button
                          class="gate-btn secondary"
                          (click)="handleGateAction(exec.pendingGate.gateType, { approved: false })"
                        >
                          Reject
                        </button>
                      }
                      @case ('user_selection') {
                        @if (exec.pendingGate.gatePrompt) {
                          <span class="gate-prompt">{{ exec.pendingGate.gatePrompt }}</span>
                        }
                        @if (exec.pendingGate.options && exec.pendingGate.options.length > 0) {
                          <select
                            class="gate-select"
                            (change)="handleGateAction(exec.pendingGate.gateType, { selection: $any($event.target).value })"
                          >
                            <option value="" disabled selected>
                              Select an option
                            </option>
                            @for (option of exec.pendingGate.options; track option) {
                              <option [value]="option">{{ option }}</option>
                            }
                          </select>
                        }
                      }
                      @case ('completion') {
                        <span class="gate-info">Waiting for required actions to complete...</span>
                      }
                    }
                  </div>
                </div>
              </div>
            }

            <!-- Phase Data Output -->
            @if (getPhaseData(phase.id); as data) {
              @if (data.userResponse) {
                <div class="phase-output">
                  <h5 class="output-title">Response</h5>
                  <pre class="output-content">{{ data.userResponse }}</pre>
                </div>
              }
              @if (data.errors && data.errors.length > 0) {
                <div class="phase-errors">
                  <h5 class="output-title error">Errors</h5>
                  @for (error of data.errors; track error) {
                    <div class="error-message">{{ error }}</div>
                  }
                </div>
              }
            }
          </div>
        }

        <!-- Actions -->
        <div class="workflow-actions">
          @if (!exec.completedAt) {
            <button
              class="action-btn secondary"
              (click)="onCancel()"
            >
              Cancel Workflow
            </button>
          }
        </div>
      </div>
    } @else {
      <div class="empty-state">
        <span class="empty-icon">📋</span>
        <span class="empty-text">No active workflow</span>
      </div>
    }
  `,
  styles: [`
    .workflow-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    .workflow-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .workflow-icon {
      font-size: 18px;
    }

    .workflow-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .status-badge {
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;

      &.status-running {
        background: var(--primary-color);
        color: white;
      }

      &.status-awaiting {
        background: var(--warning-color);
        color: black;
      }

      &.status-completed {
        background: var(--success-color);
        color: white;
      }

      &.status-failed {
        background: var(--error-color);
        color: white;
      }

      &.status-pending {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
    }

    .progress-section {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }

    .progress-bar {
      flex: 1;
      height: 6px;
      background: var(--bg-tertiary);
      border-radius: 3px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: var(--primary-color);
      border-radius: 3px;
      transition: width 0.3s ease;
    }

    .progress-text {
      font-size: 12px;
      color: var(--text-secondary);
      white-space: nowrap;
    }

    .phases-timeline {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      padding-left: var(--spacing-sm);
    }

    .phase-item {
      display: flex;
      align-items: flex-start;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) 0;
      position: relative;

      &::before {
        content: '';
        position: absolute;
        left: 7px;
        top: 20px;
        bottom: -8px;
        width: 2px;
        background: var(--border-color);
      }

      &:last-child::before {
        display: none;
      }

      &.completed {
        .phase-marker {
          background: var(--success-color);
          border-color: var(--success-color);
        }
        &::before {
          background: var(--success-color);
        }
      }

      &.active {
        .phase-marker {
          background: var(--primary-color);
          border-color: var(--primary-color);
        }
      }

      &.failed {
        .phase-marker {
          background: var(--error-color);
          border-color: var(--error-color);
        }
      }

      &.skipped {
        opacity: 0.5;
      }
    }

    .phase-marker {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--bg-tertiary);
      border: 2px solid var(--border-color);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      z-index: 1;
    }

    .marker-icon {
      font-size: 10px;
      color: white;

      &.active {
        animation: pulse 1.5s ease-in-out infinite;
      }

      &.error {
        color: white;
      }
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .phase-content {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .phase-name {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .phase-description {
      font-size: 11px;
      color: var(--text-secondary);
    }

    .current-phase-details {
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      padding: var(--spacing-md);
    }

    .section-title {
      margin: 0 0 var(--spacing-sm) 0;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .gates-section {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .gates-title {
      margin: 0;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .gate-item {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm);
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      flex-wrap: wrap;
    }

    .gate-icon {
      font-size: 14px;
    }

    .gate-label {
      font-size: 13px;
      color: var(--text-primary);
      flex: 1;
    }

    .gate-prompt {
      width: 100%;
      font-size: 12px;
      color: var(--text-secondary);
      margin: var(--spacing-xs) 0;
    }

    .gate-info {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
    }

    .gate-action {
      display: flex;
      gap: var(--spacing-xs);
      flex-wrap: wrap;
      width: 100%;
    }

    .gate-btn {
      padding: 4px 12px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all var(--transition-fast);

      &.primary {
        background: var(--primary-color);
        color: white;

        &:hover {
          background: var(--primary-hover);
        }
      }

      &.secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
        border-color: var(--border-color);

        &:hover {
          background: var(--bg-hover);
        }
      }
    }

    .gate-select {
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 12px;
    }

    .phase-output {
      margin-top: var(--spacing-md);
    }

    .phase-errors {
      margin-top: var(--spacing-md);
    }

    .output-title {
      margin: 0 0 var(--spacing-xs) 0;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;

      &.error {
        color: var(--error-color);
      }
    }

    .output-content {
      margin: 0;
      padding: var(--spacing-sm);
      background: var(--bg-primary);
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-primary);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 150px;
      overflow-y: auto;
    }

    .error-message {
      padding: var(--spacing-xs) var(--spacing-sm);
      background: rgba(220, 38, 38, 0.1);
      border-radius: var(--radius-sm);
      font-size: 12px;
      color: var(--error-color);
      margin-bottom: var(--spacing-xs);
    }

    .workflow-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--spacing-sm);
      padding-top: var(--spacing-sm);
      border-top: 1px solid var(--border-color);
    }

    .action-btn {
      padding: 6px 16px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all var(--transition-fast);

      &.primary {
        background: var(--primary-color);
        color: white;

        &:hover {
          background: var(--primary-hover);
        }
      }

      &.secondary {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border-color);

        &:hover {
          background: var(--bg-hover);
          color: var(--text-primary);
        }
      }
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xl);
      color: var(--text-muted);
    }

    .empty-icon {
      font-size: 32px;
      opacity: 0.5;
    }

    .empty-text {
      font-size: 13px;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowProgressComponent {
  /** The workflow execution to display */
  execution = input<WorkflowExecution | null>(null);

  /** The workflow template (provides phase definitions) */
  template = input<WorkflowTemplate | null>(null);

  /** Event when a gate action is performed */
  gateAction = output<GateAction>();

  /** Event when workflow is cancelled */
  cancel = output<string>();

  /** Phases combined with their status from execution */
  phasesWithStatus = computed((): PhaseWithStatus[] => {
    const exec = this.execution();
    const tmpl = this.template();
    if (!exec || !tmpl) return [];

    return tmpl.phases.map((phase) => ({
      ...phase,
      status: exec.phaseStatuses[phase.id] || 'pending',
    }));
  });

  /** Execution status derived from phase statuses */
  executionStatus = computed(() => {
    const exec = this.execution();
    if (!exec) return 'pending';
    if (exec.completedAt) return 'completed';
    if (exec.pendingGate) return 'awaiting';

    const statuses = Object.values(exec.phaseStatuses);
    if (statuses.some((s) => s === 'failed')) return 'failed';
    if (statuses.some((s) => s === 'active')) return 'running';
    return 'pending';
  });

  /** Current phase index */
  currentPhaseIndex = computed(() => {
    const phases = this.phasesWithStatus();
    const index = phases.findIndex(
      (p) => p.status === 'active' || p.status === 'awaiting_confirmation'
    );
    return index >= 0 ? index : phases.filter((p) => p.status === 'completed').length;
  });

  /** Current phase */
  currentPhase = computed(() => {
    const phases = this.phasesWithStatus();
    return (
      phases.find(
        (p) => p.status === 'active' || p.status === 'awaiting_confirmation'
      ) || null
    );
  });

  /** Progress percentage */
  progressPercent = computed(() => {
    const phases = this.phasesWithStatus();
    if (phases.length === 0) return 0;
    const completed = phases.filter((p) => p.status === 'completed').length;
    return (completed / phases.length) * 100;
  });

  getGateLabel(type: GateType): string {
    switch (type) {
      case 'user_confirmation':
        return 'User Confirmation';
      case 'user_approval':
        return 'User Approval';
      case 'user_selection':
        return 'User Selection';
      case 'completion':
        return 'Completion';
      case 'none':
        return 'Automatic';
      default:
        return type;
    }
  }

  getPhaseData(phaseId: string) {
    const exec = this.execution();
    return exec?.phaseData[phaseId] || null;
  }

  handleGateAction(
    gateType: GateType,
    response: { approved?: boolean; selection?: string; answer?: string }
  ): void {
    const exec = this.execution();
    const phase = this.currentPhase();
    if (!exec || !phase) return;

    this.gateAction.emit({
      executionId: exec.id,
      phaseId: phase.id,
      gateType,
      response,
    });
  }

  onCancel(): void {
    const exec = this.execution();
    if (exec) {
      this.cancel.emit(exec.id);
    }
  }
}
