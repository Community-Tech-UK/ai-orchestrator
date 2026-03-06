/**
 * Workflow Page
 * Container that wires workflow UI to orchestration IPC APIs.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import type {
  GateType,
  WorkflowExecution,
  WorkflowTemplate,
} from '../../../../shared/types/workflow.types';
import { WorkflowProgressComponent } from './workflow-progress.component';
import { OrchestrationIpcService } from '../../core/services/ipc/orchestration-ipc.service';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { TaskIpcService } from '../../core/services/ipc/task-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import type { TaskPreflightReport } from '../../../../shared/types/task-preflight.types';
import { TaskPreflightCardComponent } from '../../shared/components/task-preflight-card.component';

interface InstanceOption {
  id: string;
  displayName: string;
  status: string;
  workingDirectory?: string;
}

interface GateAction {
  executionId: string;
  phaseId: string;
  gateType: GateType;
  response: { approved?: boolean; selection?: string; answer?: string };
}

@Component({
  selector: 'app-workflow-page',
  standalone: true,
  imports: [CommonModule, WorkflowProgressComponent, TaskPreflightCardComponent],
  template: `
    <div class="workflow-page">
      <div class="page-header">
        <button class="header-btn" type="button" (click)="goBack()">← Back</button>
        <div class="header-title">
          <span class="title">Workflows</span>
          <span class="subtitle">Template-driven multi-phase orchestration</span>
        </div>
      </div>

      <div class="toolbar">
        <label class="field">
          <span class="label">Instance</span>
          <select
            class="select"
            [value]="selectedInstanceId()"
            (change)="onInstanceChange($event)"
          >
            <option value="">Select an instance</option>
            @for (instance of instances(); track instance.id) {
              <option [value]="instance.id">
                {{ instance.displayName }} ({{ instance.status }})
              </option>
            }
          </select>
        </label>

        <label class="field">
          <span class="label">Template</span>
          <select
            class="select"
            [value]="selectedTemplateId()"
            (change)="onTemplateChange($event)"
          >
            <option value="">Select a template</option>
            @for (template of templates(); track template.id) {
              <option [value]="template.id">{{ template.name }}</option>
            }
          </select>
        </label>

        <div class="toolbar-actions">
          <button
            class="btn primary"
            type="button"
            [disabled]="!canStartWorkflow() || working()"
            (click)="startWorkflow()"
          >
            {{ working() ? 'Starting...' : 'Start Workflow' }}
          </button>
          <button
            class="btn"
            type="button"
            [disabled]="working()"
            (click)="refreshAll()"
          >
            Refresh
          </button>
        </div>
      </div>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      <div class="content">
        <div class="main-panel">
          <app-workflow-progress
            [execution]="execution()"
            [template]="selectedTemplate()"
            (gateAction)="onGateAction($event)"
            (abortRequested)="cancelWorkflow($event)"
          />
        </div>

        <div class="side-panel">
          <div class="panel-card">
            <div class="panel-title">Launch Preflight</div>
            <app-task-preflight-card
              [report]="preflight()"
              [loading]="preflightLoading()"
              title="Workflow Preflight"
              subtitle="Instructions, permissions, and network/tool readiness for the selected instance."
              emptyMessage="Select an instance to inspect workflow readiness."
            />
          </div>

          <div class="panel-card">
            <div class="panel-title">Manual Actions</div>
            @if (execution(); as exec) {
              <textarea
                class="textarea"
                placeholder='Optional phaseData JSON, e.g. {"answer":"done"}'
                [value]="phaseDataJson()"
                (input)="onPhaseDataInput($event)"
              ></textarea>

              <div class="button-row">
                <button class="btn primary" type="button" [disabled]="working()" (click)="completeCurrentPhase()">
                  Complete Phase
                </button>
                <button class="btn" type="button" [disabled]="working()" (click)="skipCurrentPhase()">
                  Skip Phase
                </button>
              </div>

              <div class="button-row">
                <button class="btn" type="button" [disabled]="working()" (click)="refreshExecution()">
                  Refresh Execution
                </button>
                <button class="btn danger" type="button" [disabled]="working()" (click)="cancelWorkflow(exec.id)">
                  Cancel Workflow
                </button>
              </div>
            } @else {
              <div class="hint">Start or select a workflow execution to access actions.</div>
            }
          </div>

          <div class="panel-card">
            <div class="panel-title">Prompt Addition</div>
            @if (promptAddition()) {
              <pre class="prompt-preview">{{ promptAddition() }}</pre>
            } @else {
              <div class="hint">No prompt addition for the current phase.</div>
            }
          </div>
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

    .workflow-page {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      gap: var(--spacing-md);
      padding: var(--spacing-lg);
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    .page-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }

    .header-btn {
      padding: var(--spacing-xs) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
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

    .toolbar {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: var(--spacing-md);
      align-items: end;
      padding: var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      min-width: 0;
    }

    .label {
      font-size: 12px;
      color: var(--text-muted);
    }

    .select {
      width: 100%;
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    .toolbar-actions {
      display: flex;
      gap: var(--spacing-sm);
      justify-content: flex-end;
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
      color: #fff;
    }

    .btn.danger {
      background: var(--error-color);
      border-color: var(--error-color);
      color: #fff;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .error-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
      font-size: 12px;
    }

    .content {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
      gap: var(--spacing-md);
    }

    .main-panel {
      min-height: 0;
    }

    .side-panel {
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    .panel-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .panel-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .textarea {
      width: 100%;
      min-height: 92px;
      resize: vertical;
      padding: var(--spacing-sm);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-family: var(--font-family-mono);
      font-size: 12px;
    }

    .button-row {
      display: flex;
      gap: var(--spacing-sm);
      flex-wrap: wrap;
    }

    .prompt-preview {
      margin: 0;
      max-height: 280px;
      overflow: auto;
      padding: var(--spacing-sm);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      white-space: pre-wrap;
      font-size: 12px;
      line-height: 1.5;
    }

    .hint {
      font-size: 12px;
      color: var(--text-muted);
    }

    @media (max-width: 1100px) {
      .toolbar {
        grid-template-columns: 1fr;
      }

      .toolbar-actions {
        justify-content: flex-start;
      }

      .content {
        grid-template-columns: 1fr;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowPageComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly workflowIpc = inject(OrchestrationIpcService);
  private readonly instanceIpc = inject(InstanceIpcService);
  private readonly taskIpc = inject(TaskIpcService);

  readonly templates = signal<WorkflowTemplate[]>([]);
  readonly instances = signal<InstanceOption[]>([]);
  readonly selectedTemplateId = signal('');
  readonly selectedInstanceId = signal('');
  readonly execution = signal<WorkflowExecution | null>(null);
  readonly promptAddition = signal('');
  readonly preflight = signal<TaskPreflightReport | null>(null);
  readonly preflightLoading = signal(false);
  readonly phaseDataJson = signal('');
  readonly errorMessage = signal<string | null>(null);
  readonly working = signal(false);

  readonly selectedTemplate = computed(() => {
    const templateId = this.selectedTemplateId();
    return this.templates().find((template) => template.id === templateId) || null;
  });
  readonly selectedInstance = computed(() =>
    this.instances().find((instance) => instance.id === this.selectedInstanceId()) || null
  );

  readonly canStartWorkflow = computed(() =>
    this.selectedTemplateId().length > 0 &&
    this.selectedInstanceId().length > 0 &&
    !this.preflightLoading() &&
    (this.preflight()?.blockers.length || 0) === 0
  );

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight = false;

  async ngOnInit(): Promise<void> {
    await this.refreshAll();
    this.startPolling();
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  goBack(): void {
    this.router.navigate(['/']);
  }

  async refreshAll(): Promise<void> {
    this.errorMessage.set(null);
    await Promise.all([this.loadTemplates(), this.loadInstances()]);
    await this.refreshExecution();
  }

  async startWorkflow(): Promise<void> {
    if (!this.canStartWorkflow() || this.working()) {
      return;
    }

    this.errorMessage.set(null);
    this.working.set(true);
    try {
      const response = await this.workflowIpc.workflowStart({
        instanceId: this.selectedInstanceId(),
        templateId: this.selectedTemplateId(),
      });

      const execution = this.extractData<WorkflowExecution>(response);
      if (!execution) {
        this.setErrorFromResponse(response, 'Failed to start workflow.');
        return;
      }

      this.execution.set(execution);
      this.selectedTemplateId.set(execution.templateId);
      await this.refreshPromptAddition();
      this.queueFollowUpRefresh();
    } finally {
      this.working.set(false);
    }
  }

  async completeCurrentPhase(): Promise<void> {
    const execution = this.execution();
    if (!execution || this.working()) {
      return;
    }

    const phaseData = this.parsePhaseData();
    if (phaseData === null) {
      return;
    }

    this.errorMessage.set(null);
    this.working.set(true);
    try {
      const response = await this.workflowIpc.workflowCompletePhase(
        execution.id,
        phaseData ?? undefined
      );

      const updated = this.extractData<WorkflowExecution>(response);
      if (!updated) {
        this.setErrorFromResponse(response, 'Failed to complete workflow phase.');
        return;
      }

      this.execution.set(updated);
      await this.refreshPromptAddition();
      this.queueFollowUpRefresh();
    } finally {
      this.working.set(false);
    }
  }

  async onGateAction(action: GateAction): Promise<void> {
    if (this.working()) {
      return;
    }

    if (action.gateType === 'user_confirmation') {
      if (action.response.approved === false) {
        await this.cancelWorkflow(action.executionId);
        return;
      }
      const response = { answer: action.response.answer || 'confirmed' };
      await this.submitGateResponse(action.executionId, response);
      return;
    }

    if (action.gateType === 'user_approval') {
      if (action.response.approved === false) {
        await this.cancelWorkflow(action.executionId);
        return;
      }
      await this.submitGateResponse(action.executionId, { approved: true });
      return;
    }

    await this.submitGateResponse(action.executionId, action.response);
  }

  async skipCurrentPhase(): Promise<void> {
    const execution = this.execution();
    if (!execution || this.working()) {
      return;
    }

    this.errorMessage.set(null);
    this.working.set(true);
    try {
      const response = await this.workflowIpc.workflowSkipPhase(execution.id);
      const updated = this.extractData<WorkflowExecution>(response);
      if (!updated) {
        this.setErrorFromResponse(response, 'Failed to skip workflow phase.');
        return;
      }

      this.execution.set(updated);
      await this.refreshPromptAddition();
      this.queueFollowUpRefresh();
    } finally {
      this.working.set(false);
    }
  }

  async cancelWorkflow(executionId?: string): Promise<void> {
    const id = executionId || this.execution()?.id;
    if (!id || this.working()) {
      return;
    }

    this.errorMessage.set(null);
    this.working.set(true);
    try {
      const response = await this.workflowIpc.workflowCancel(id);
      if (!response.success) {
        this.setErrorFromResponse(response, 'Failed to cancel workflow.');
        return;
      }
      await this.refreshExecution();
    } finally {
      this.working.set(false);
    }
  }

  async refreshExecution(): Promise<void> {
    if (this.refreshInFlight) {
      return;
    }

    const selectedInstanceId = this.selectedInstanceId();
    if (!selectedInstanceId) {
      this.execution.set(null);
      this.promptAddition.set('');
      return;
    }

    this.refreshInFlight = true;
    try {
      const response = await this.workflowIpc.workflowGetByInstance(selectedInstanceId);
      if (!response.success) {
        this.setErrorFromResponse(response, 'Failed to load workflow execution.');
        return;
      }

      const execution = this.extractData<WorkflowExecution | null>(response);
      this.execution.set(execution || null);
      if (execution) {
        this.selectedTemplateId.set(execution.templateId);
        await this.refreshPreflight();
        await this.refreshPromptAddition();
      } else {
        this.promptAddition.set('');
        await this.refreshPreflight();
      }
    } finally {
      this.refreshInFlight = false;
    }
  }

  onTemplateChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.selectedTemplateId.set(target.value);
    void this.refreshPreflight();
  }

  async onInstanceChange(event: Event): Promise<void> {
    const target = event.target as HTMLSelectElement;
    this.selectedInstanceId.set(target.value);
    await this.refreshPreflight();
    await this.refreshExecution();
  }

  onPhaseDataInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.phaseDataJson.set(target.value);
  }

  private async submitGateResponse(
    executionId: string,
    response: { approved?: boolean; selection?: string; answer?: string }
  ): Promise<void> {
    this.errorMessage.set(null);
    this.working.set(true);
    try {
      const result = await this.workflowIpc.workflowSatisfyGate(executionId, response);
      if (!result.success) {
        this.setErrorFromResponse(result, 'Failed to submit gate response.');
        return;
      }

      await this.refreshExecution();
      this.queueFollowUpRefresh();
    } finally {
      this.working.set(false);
    }
  }

  private parsePhaseData(): Record<string, unknown> | null | undefined {
    const raw = this.phaseDataJson().trim();
    if (!raw) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      this.errorMessage.set('Phase data JSON must be an object.');
      return null;
    } catch {
      this.errorMessage.set('Invalid phase data JSON.');
      return null;
    }
  }

  private async loadTemplates(): Promise<void> {
    const response = await this.workflowIpc.workflowListTemplates();
    if (!response.success) {
      this.setErrorFromResponse(response, 'Failed to load workflow templates.');
      return;
    }

    const templates = this.extractData<WorkflowTemplate[]>(response) || [];
    this.templates.set(templates);

    if (!this.selectedTemplateId() && templates.length > 0) {
      this.selectedTemplateId.set(templates[0].id);
    }
  }

  private async loadInstances(): Promise<void> {
    const response = await this.instanceIpc.listInstances();
    if (!response.success) {
      this.setErrorFromResponse(response, 'Failed to load instances.');
      return;
    }

    const rawInstances = this.extractData<unknown[]>(response) || [];
    const mapped = rawInstances
      .map((instance) => this.mapInstanceOption(instance))
      .filter((instance): instance is InstanceOption => instance !== null);

    this.instances.set(mapped);

    if (!this.selectedInstanceId() && mapped.length > 0) {
      this.selectedInstanceId.set(mapped[0].id);
    }

    await this.refreshPreflight();
  }

  private mapInstanceOption(value: unknown): InstanceOption | null {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const candidate = value as Record<string, unknown>;
    if (typeof candidate['id'] !== 'string' || typeof candidate['displayName'] !== 'string') {
      return null;
    }
    return {
      id: candidate['id'],
      displayName: candidate['displayName'],
      status: typeof candidate['status'] === 'string' ? candidate['status'] : 'unknown',
      workingDirectory:
        typeof candidate['workingDirectory'] === 'string' ? candidate['workingDirectory'] : undefined,
    };
  }

  private async refreshPreflight(): Promise<void> {
    const workingDirectory = this.selectedInstance()?.workingDirectory?.trim();
    if (!workingDirectory) {
      this.preflight.set(null);
      this.preflightLoading.set(false);
      return;
    }

    this.preflightLoading.set(true);
    try {
      const response = await this.taskIpc.taskGetPreflight({
        workingDirectory,
        surface: 'workflow',
        taskType: this.selectedTemplateId() || 'workflow',
        requiresWrite: true,
        requiresNetwork: true,
      });

      if (response.success && response.data) {
        this.preflight.set(response.data);
        return;
      }

      this.preflight.set(null);
    } finally {
      this.preflightLoading.set(false);
    }
  }

  private async refreshPromptAddition(): Promise<void> {
    const execution = this.execution();
    if (!execution) {
      this.promptAddition.set('');
      return;
    }

    const response = await this.workflowIpc.workflowGetPromptAddition(execution.id);
    if (!response.success) {
      this.promptAddition.set('');
      return;
    }

    const promptAddition = this.extractData<string>(response);
    this.promptAddition.set(typeof promptAddition === 'string' ? promptAddition : '');
  }

  private setErrorFromResponse(response: IpcResponse, fallback: string): void {
    this.errorMessage.set(response.error?.message || fallback);
  }

  private extractData<T>(response: IpcResponse): T | null {
    return response.success ? (response.data as T) : null;
  }

  private queueFollowUpRefresh(): void {
    setTimeout(() => {
      void this.refreshExecution();
    }, 350);
  }

  private startPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(() => {
      if (!this.execution()) {
        return;
      }
      void this.refreshExecution();
    }, 2000);
  }
}
