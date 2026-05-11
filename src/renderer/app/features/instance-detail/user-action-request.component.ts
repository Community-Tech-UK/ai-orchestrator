/**
 * User Action Request Component - Displays pending orchestrator requests to the user
 */

import {
  Component,
  HostListener,
  inject,
  signal,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  input,
  effect
} from '@angular/core';
import { ElectronIpcService } from '../../core/services/ipc';
import { InstanceStore } from '../../core/state/instance.store';
import {
  canResolveInputRequiredWithYolo,
  defaultInputRequiredScope,
  type InputRequiredScope,
  shouldClearInputRequiredForYolo,
  shouldClearRequestAfterYoloEnabled
} from './user-action-request.rules';

export interface UserActionRequest {
  id: string;
  instanceId: string;
  requestType: 'switch_mode' | 'approve_action' | 'confirm' | 'select_option' | 'input_required' | 'ask_questions';
  title: string;
  message: string;
  targetMode?: 'build' | 'plan' | 'review';
  options?: {
    id: string;
    label: string;
    description?: string;
  }[];
  /** For ask_questions: list of questions to present with text inputs */
  questions?: string[];
  context?: Record<string, unknown>;
  createdAt: number;
  /** Permission metadata for input_required requests (action, path, etc.) */
  permissionMetadata?: {
    type?: string;
    tool_use_id?: string;
    action?: string;
    /** Display-friendly (possibly truncated) path shown in prompts. */
    path?: string;
    /**
     * Untruncated resource path or Bash command. Preferred over `path` when
     * building rule strings (e.g. for `~/.claude/settings.json` allow-lists).
     */
    full_path?: string;
    originalContent?: string;
    approvalTraceId?: string;
    /**
     * Canonical Claude CLI tool name for the denied tool_use (e.g. 'Edit',
     * 'Write'). Set by the adapter for `permission_denial` prompts and by
     * the hook bridge for `deferred_permission` prompts.
     */
    tool_name?: string;
    /** Tool input for deferred permission requests (e.g., { command: '...' }) */
    tool_input?: Record<string, unknown>;
    /** Session ID for deferred permission resume */
    session_id?: string;
  };
}

@Component({
  selector: 'app-user-action-request',
  standalone: true,
  imports: [],
  template: `
    @if (pendingRequests().length > 0) {
      <div class="user-action-requests">
        @for (request of pendingRequests(); track request.id) {
          <div class="request-card" [class]="'request-' + request.requestType">
            <div class="request-header">
              <span class="request-icon">{{
                getRequestIcon(request.requestType)
              }}</span>
              <span class="request-title">{{ request.title }}</span>
            </div>
            <p class="request-message">{{ request.message }}</p>

            @if (request.requestType === 'ask_questions' && request.questions) {
              <!-- Ask questions: render text inputs for each question -->
              <div class="questions-form">
                @for (question of request.questions; track $index) {
                  <label class="question-item">
                    <span class="question-label">{{ question }}</span>
                    <textarea
                      class="question-input"
                      rows="2"
                      [placeholder]="'Type your answer...'"
                      [disabled]="isResponding()"
                      (input)="onQuestionAnswerChange(request.id, $index, $event)"
                    ></textarea>
                  </label>
                }
                <div class="request-actions">
                  <button
                    class="btn-reject"
                    (click)="onReject(request)"
                    [disabled]="isResponding()"
                  >
                    Skip
                  </button>
                  <button
                    class="btn-approve"
                    (click)="onSubmitAnswers(request)"
                    [disabled]="isResponding()"
                  >
                    Submit Answers
                  </button>
                </div>
              </div>
            } @else if (request.requestType === 'input_required' && !isPermissionRequest(request)) {
              <!-- Generic input_required prompt: collect free-form text -->
              <div class="questions-form">
                <label class="question-item">
                  <span class="question-label">Your response</span>
                  <textarea
                    class="question-input"
                    rows="3"
                    [placeholder]="'Type your response...'"
                    [disabled]="isResponding()"
                    (input)="onInputRequiredTextChange(request.id, $event)"
                  ></textarea>
                </label>
                <div class="request-actions">
                  <button
                    class="btn-reject"
                    (click)="onReject(request)"
                    [disabled]="isResponding()"
                  >
                    Cancel
                  </button>
                  <button
                    class="btn-approve"
                    (click)="onSubmitInputRequired(request)"
                    [disabled]="isResponding() || !hasInputRequiredText(request.id)"
                  >
                    Submit
                  </button>
                </div>
              </div>
            } @else if (request.requestType === 'select_option' && request.options) {
              <div class="request-options">
                @for (option of request.options; track option.id) {
                  <button
                    class="option-btn"
                    (click)="onSelectOption(request, option.id)"
                    [disabled]="isResponding()"
                  >
                    {{ option.label }}
                    @if (option.description) {
                      <span class="option-desc">{{ option.description }}</span>
                    }
                  </button>
                }
              </div>
            } @else {
              <div class="request-actions">
                @if (request.requestType === 'input_required' && isPermissionRequest(request)) {
                  <select
                    class="scope-select"
                    [value]="getInputRequiredScope(request)"
                    (change)="onInputRequiredScopeChange(request.id, $event)"
                    [disabled]="isResponding()"
                    [title]="isPermissionDenial(request) ? 'Remember this decision (Always writes an allow rule to ~/.claude/settings.json)' : 'Remember this decision'"
                  >
                    @for (scope of scopesFor(request); track scope) {
                      <option [value]="scope">{{ scopeLabel(scope) }}</option>
                    }
                  </select>
                }
                <button
                  class="btn-reject"
                  (click)="onReject(request)"
                  [disabled]="isResponding()"
                >
                  Reject
                </button>
                @if (request.requestType === 'input_required' && isPermissionRequest(request)) {
                  @if (canResolveWithYolo(request)) {
                    <button
                      class="btn-yolo"
                      (click)="onEnableYolo(request)"
                      [disabled]="isResponding()"
                      title="Enable YOLO mode to auto-approve all permissions for this session"
                    >
                      ⚡ YOLO
                    </button>
                  }
                }
                <button
                  class="btn-approve"
                  (click)="onApprove(request)"
                  [disabled]="isResponding()"
                >
                  {{ getApproveLabel(request) }}
                </button>
              </div>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .user-action-requests {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
      }

      .request-card {
        background: var(--bg-secondary);
        border: 2px solid var(--primary-color);
        border-radius: var(--radius-lg);
        padding: var(--spacing-md);
        animation:
          slideIn 0.3s ease-out,
          pulse-border 2s ease-in-out infinite;
        box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.2);
      }

      @keyframes slideIn {
        from {
          opacity: 0;
          transform: translateY(-10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @keyframes pulse-border {
        0%,
        100% {
          border-color: var(--primary-color);
          box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.2);
        }
        50% {
          border-color: var(--primary-hover);
          box-shadow: 0 4px 24px rgba(var(--primary-rgb), 0.35);
        }
      }

      .request-switch_mode {
        border-color: #6366f1;
        box-shadow: 0 4px 16px rgba(99, 102, 241, 0.2);
      }

      .request-approve_action {
        border-color: #f59e0b;
        box-shadow: 0 4px 16px rgba(245, 158, 11, 0.2);
      }

      .request-input_required {
        border-color: #ef4444;
        box-shadow: 0 4px 16px rgba(239, 68, 68, 0.2);
      }

      .request-ask_questions {
        border-color: #8b5cf6;
        box-shadow: 0 4px 16px rgba(139, 92, 246, 0.2);
      }

      .request-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-sm);
      }

      .request-icon {
        font-size: 20px;
      }

      .request-title {
        font-family: var(--font-display);
        font-size: 16px;
        font-weight: 700;
        color: var(--text-primary);
      }

      .request-message {
        font-size: 14px;
        color: var(--text-secondary);
        margin: 0 0 var(--spacing-md) 0;
        line-height: 1.5;
      }

      .request-actions {
        display: flex;
        gap: var(--spacing-sm);
        justify-content: flex-end;
        align-items: center;
      }

      .scope-select {
        padding: 6px 8px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border-subtle);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        font-size: 12px;
      }

      .request-options {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .option-btn {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--bg-tertiary);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        color: var(--text-primary);
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover:not(:disabled) {
          background: rgba(var(--primary-rgb), 0.1);
          border-color: var(--primary-color);
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      .option-desc {
        font-size: 12px;
        color: var(--text-muted);
        font-weight: 400;
        margin-top: 2px;
      }

      .btn-reject,
      .btn-approve,
      .btn-yolo {
        padding: var(--spacing-sm) var(--spacing-lg);
        border-radius: var(--radius-md);
        font-family: var(--font-display);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all var(--transition-fast);

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      .btn-reject {
        background: var(--bg-tertiary);
        border: 1px solid var(--border-subtle);
        color: var(--text-secondary);

        &:hover:not(:disabled) {
          background: rgba(var(--error-rgb), 0.1);
          border-color: var(--error-color);
          color: var(--error-color);
        }
      }

      .btn-yolo {
        background: linear-gradient(
          135deg,
          #f59e0b 0%,
          #d97706 100%
        );
        border: none;
        color: #000;
        box-shadow: 0 2px 8px rgba(245, 158, 11, 0.3);

        &:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(245, 158, 11, 0.5);
        }
      }

      .btn-approve {
        background: linear-gradient(
          135deg,
          var(--primary-color) 0%,
          var(--primary-hover) 100%
        );
        border: none;
        color: var(--bg-primary);
        box-shadow: 0 2px 8px rgba(var(--primary-rgb), 0.3);

        &:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(var(--primary-rgb), 0.4);
        }
      }

      /* Ask questions form styles */
      .questions-form {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
      }

      .question-item {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        cursor: default;
      }

      .question-label {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
        line-height: 1.4;
      }

      .question-input {
        width: 100%;
        padding: var(--spacing-sm);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        font-size: 14px;
        font-family: inherit;
        line-height: 1.5;
        resize: vertical;
        min-height: 40px;
        box-sizing: border-box;
        transition: border-color var(--transition-fast);

        &:focus {
          outline: none;
          border-color: var(--primary-color);
          box-shadow: 0 0 0 2px rgba(var(--primary-rgb), 0.15);
        }

        &::placeholder {
          color: var(--text-muted);
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class UserActionRequestComponent implements OnInit, OnDestroy {
  private ipc = inject(ElectronIpcService);
  private instanceStore = inject(InstanceStore);

  instanceId = input<string | null>(null);

  pendingRequests = signal<UserActionRequest[]>([]);
  isResponding = signal(false);

  private inputRequiredScopes = new Map<string, InputRequiredScope>();
  private inputRequiredTexts = new Map<string, string>();

  /** Tracks user answers for ask_questions requests: requestId → Map<questionIndex, answer> */
  private questionAnswers = new Map<string, Map<number, string>>();

  private unsubscribeUserAction: (() => void) | null = null;
  private unsubscribeInputRequired: (() => void) | null = null;

  constructor() {
    // Reload pending requests when instanceId changes.
    // Only filter input_required (permission prompts) by instance — orchestrator
    // user-action requests (ask_questions, switch_mode, etc.) are shown globally
    // so questions from child instances are visible regardless of which instance
    // the user is viewing.
    effect(() => {
      const id = this.instanceId();
      if (id) {
        // Keep orchestrator requests (global) + instance-scoped input_required
        this.pendingRequests.update((requests) =>
          requests.filter(
            (r) => r.requestType !== 'input_required' || r.instanceId === id
          )
        );
        this.loadPendingRequests();
      } else {
        this.pendingRequests.set([]);
      }
    });

    // Clear permission dialogs when YOLO mode is toggled ON
    effect(() => {
      const id = this.instanceId();
      if (id) {
        const instance = this.instanceStore.getInstance(id);
        if (instance?.yoloMode) {
          // YOLO mode enabled - clear any pending permission requests
          this.pendingRequests.update((requests) =>
            requests.filter((r) => !shouldClearInputRequiredForYolo(r))
          );
        }
      }
    });
  }

  ngOnInit(): void {
    // Initial load of pending requests (for cases where instanceId is already set)
    this.loadPendingRequests();

    // Subscribe to user action requests (orchestrator commands).
    // Show ALL orchestrator requests globally so questions from child instances
    // are visible regardless of which instance the user is viewing.
    this.unsubscribeUserAction = this.ipc.onUserActionRequest((request) => {
      const req = request as UserActionRequest;

      // Deduplicate: skip if we already have this request ID
      this.pendingRequests.update((requests) => {
        if (requests.some((r) => r.id === req.id)) return requests;
        return [...requests, req];
      });
    });

    // Subscribe to input required events (CLI permission prompts)
    console.log('[APPROVAL_TRACE][renderer:user-action] onInputRequired subscription setup');
    this.unsubscribeInputRequired = this.ipc.onInputRequired((payload) => {
      const metadata = payload.metadata as UserActionRequest['permissionMetadata'] | undefined;
      const approvalTraceId = metadata?.approvalTraceId || `approval-renderer-component-${payload.requestId}`;
      console.log('[APPROVAL_TRACE][renderer:user-action] received', {
        approvalTraceId,
        instanceId: payload.instanceId,
        requestId: payload.requestId,
        metadataType: metadata?.type
      });

      const currentInstanceId = this.instanceId();

      // YOLO-mode suppression — don't short-circuit for `permission_denial`.
      // Claude CLI has an internal guard for its own settings files that
      // `--dangerously-skip-permissions` does NOT bypass, so the CLI itself
      // denies the tool_use and the user must still decide whether to add a
      // rule to ~/.claude/settings.json. Suppressing the prompt here would
      // leave the user with no visible path to fix the denial.
      if (currentInstanceId && metadata?.type !== 'permission_denial') {
        const instance = this.instanceStore.getInstance(currentInstanceId);
        if (instance?.yoloMode) {
          console.log('[APPROVAL_TRACE][renderer:user-action] skipped_yolo_enabled', {
            approvalTraceId,
            currentInstanceId,
            payloadInstanceId: payload.instanceId,
            requestId: payload.requestId
          });
          return;
        }
      }

      // Only show for this instance
      if (!currentInstanceId || payload.instanceId === currentInstanceId) {
        const isPermissionPrompt = metadata?.type === 'permission_denial' || metadata?.type === 'deferred_permission';
        const req: UserActionRequest = {
          id: payload.requestId,
          instanceId: payload.instanceId,
          requestType: 'input_required',
          title: isPermissionPrompt ? 'Permission Required' : 'Input Required',
          message: payload.prompt,
          createdAt: payload.timestamp,
          permissionMetadata: metadata // Store permission details for retry message
        };
        if (!this.inputRequiredScopes.has(req.id)) {
          this.inputRequiredScopes.set(req.id, defaultInputRequiredScope(metadata));
        }
        this.pendingRequests.update((requests) => {
          if (requests.some((r) => r.id === req.id)) {
            console.log('[APPROVAL_TRACE][renderer:user-action] duplicate_request_skipped', {
              approvalTraceId,
              requestId: req.id,
              pendingCount: requests.length
            });
            return requests;
          }
          const updated = [...requests, req];
          console.log('[APPROVAL_TRACE][renderer:user-action] request_added', {
            approvalTraceId,
            requestId: req.id,
            pendingCount: updated.length
          });
          return updated;
        });
      } else {
        console.log('[APPROVAL_TRACE][renderer:user-action] skipped_instance_mismatch', {
          approvalTraceId,
          currentInstanceId,
          payloadInstanceId: payload.instanceId,
          requestId: payload.requestId
        });
      }
    });
    console.log('[APPROVAL_TRACE][renderer:user-action] onInputRequired subscription ready');
  }

  ngOnDestroy(): void {
    if (this.unsubscribeUserAction) {
      this.unsubscribeUserAction();
    }
    if (this.unsubscribeInputRequired) {
      this.unsubscribeInputRequired();
    }
  }

  private async loadPendingRequests(): Promise<void> {
    const currentInstanceId = this.instanceId();

    try {
      // Load ALL pending orchestrator requests (shown globally) so child
      // instance questions are visible from any instance view.
      const response = await this.ipc.listUserActionRequests();

      if (response.success && 'data' in response && response.data) {
        const serverRequests = response.data as UserActionRequest[];
        // Merge: use server list as base, but keep any locally-tracked requests
        // that the server doesn't know about yet (e.g., input_required from IPC events).
        // Filter input_required to the current instance only.
        this.pendingRequests.update((existing) => {
          const serverIds = new Set(serverRequests.map((r) => r.id));
          const localOnly = existing.filter(
            (r) => !serverIds.has(r.id) && (r.requestType !== 'input_required' || r.instanceId === currentInstanceId)
          );
          const filteredServer = serverRequests.filter(
            (r) => r.requestType !== 'input_required' || r.instanceId === currentInstanceId
          );
          return [...filteredServer, ...localOnly];
        });
      }
    } catch (error) {
      console.error('Failed to load pending user action requests:', error);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key < '1' || event.key > '9') return;
    const selectRequest = this.pendingRequests().find((r) => r.requestType === 'select_option');
    if (!selectRequest?.options) return;
    const index = parseInt(event.key, 10) - 1;
    const option = selectRequest.options[index];
    if (!option || this.isResponding()) return;
    void this.onSelectOption(selectRequest, option.id);
  }

  getRequestIcon(requestType: string): string {
    switch (requestType) {
      case 'switch_mode':
        return '🔄';
      case 'approve_action':
        return '✋';
      case 'confirm':
        return '❓';
      case 'select_option':
        return '📋';
      case 'input_required':
        return '🔐';
      case 'ask_questions':
        return '💬';
      default:
        return '📢';
    }
  }

  getApproveLabel(request: UserActionRequest): string {
    switch (request.requestType) {
      case 'switch_mode':
        return request.targetMode
          ? `Switch to ${request.targetMode.charAt(0).toUpperCase() + request.targetMode.slice(1)} Mode`
          : 'Approve';
      case 'approve_action':
        return 'Approve';
      case 'confirm':
        return 'Confirm';
      case 'input_required':
        return 'Allow';
      default:
        return 'Yes';
    }
  }

  getInputRequiredScope(request: UserActionRequest | string): InputRequiredScope {
    const requestId = typeof request === 'string' ? request : request.id;
    const metadata = typeof request === 'string' ? undefined : request.permissionMetadata;
    return this.inputRequiredScopes.get(requestId) || defaultInputRequiredScope(metadata);
  }

  onInputRequiredScopeChange(requestId: string, event: Event): void {
    const target = event.target as HTMLSelectElement;
    const val = (target.value as InputRequiredScope) || 'once';
    this.inputRequiredScopes.set(requestId, val);
  }

  isPermissionRequest(request: UserActionRequest): boolean {
    return request.requestType === 'input_required' &&
      (request.permissionMetadata?.type === 'permission_denial' ||
       request.permissionMetadata?.type === 'deferred_permission');
  }

  /** Returns true if this is a deferred permission request (defer-based flow). */
  isDeferredPermission(request: UserActionRequest): boolean {
    return request.permissionMetadata?.type === 'deferred_permission';
  }

  /**
   * Returns true if this is a post-denial permission prompt surfaced because
   * Claude CLI denied a tool use (e.g. self-editing `~/.claude/settings.json`
   * under `--dangerously-skip-permissions`). When scope='always' is chosen for
   * these prompts, the main process writes a rule to ~/.claude/settings.json
   * and respawns the session so the CLI picks up the new allow-list entry.
   */
  isPermissionDenial(request: UserActionRequest): boolean {
    return request.permissionMetadata?.type === 'permission_denial';
  }

  canResolveWithYolo(request: UserActionRequest): boolean {
    return canResolveInputRequiredWithYolo(request);
  }

  /**
   * Returns the scope choices to show in the scope selector for a given
   * request. `permission_denial` intentionally drops 'session' because
   * remembering the grant only for the duration of the current Claude CLI
   * session would require re-deriving an in-memory allow-list that the CLI
   * doesn't expose; the meaningful options are 'once' (one-shot retry) and
   * 'always' (persist to `~/.claude/settings.json`). Deferred permission
   * prompts keep all three choices so users can opt into a session-scoped
   * grant via the hook bridge's in-memory resume flow.
   */
  scopesFor(request: UserActionRequest): InputRequiredScope[] {
    return this.isPermissionDenial(request)
      ? ['once', 'always']
      : ['once', 'session', 'always'];
  }

  /**
   * Human-readable label for a scope choice. Kept inline so the template can
   * render the options without a pipe or nested switch.
   */
  scopeLabel(scope: InputRequiredScope): string {
    switch (scope) {
      case 'once':
        return 'Once';
      case 'session':
        return 'Session';
      case 'always':
        return 'Always';
    }
  }

  onInputRequiredTextChange(requestId: string, event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.inputRequiredTexts.set(requestId, target.value);
  }

  hasInputRequiredText(requestId: string): boolean {
    const text = this.inputRequiredTexts.get(requestId) || '';
    return text.trim().length > 0;
  }

  /**
   * Track answer changes for ask_questions requests
   */
  onQuestionAnswerChange(requestId: string, questionIndex: number, event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    let answers = this.questionAnswers.get(requestId);
    if (!answers) {
      answers = new Map();
      this.questionAnswers.set(requestId, answers);
    }
    answers.set(questionIndex, target.value);
  }

  /**
   * Submit answers for an ask_questions request
   */
  async onSubmitAnswers(request: UserActionRequest): Promise<void> {
    const answers = this.questionAnswers.get(request.id);
    const questions = request.questions || [];

    // Build answers object: { "Question text": "Answer text" }
    const answersObj: Record<string, string> = {};
    questions.forEach((q, i) => {
      answersObj[q] = answers?.get(i) || '';
    });

    const answersJson = JSON.stringify(answersObj);
    await this.respond(request, true, answersJson);

    // Clean up answer tracking
    this.questionAnswers.delete(request.id);
  }

  async onApprove(request: UserActionRequest): Promise<void> {
    await this.respond(request, true);
  }

  async onReject(request: UserActionRequest): Promise<void> {
    await this.respond(request, false);
  }

  async onEnableYolo(request: UserActionRequest): Promise<void> {
    this.isResponding.set(true);
    try {
      // Toggle YOLO mode for this instance
      const result = await this.ipc.toggleYoloMode(request.instanceId);
      if (result.success) {
        // Remove all pending permission requests for this instance since YOLO is now enabled
        this.pendingRequests.update((requests) =>
          requests.filter((r) => !shouldClearRequestAfterYoloEnabled(r, request.instanceId))
        );
        this.instanceStore.clearPendingApprovals(request.instanceId);
      }
    } catch (error) {
      console.error('Failed to enable YOLO mode:', error);
    } finally {
      this.isResponding.set(false);
    }
  }

  async onSelectOption(
    request: UserActionRequest,
    optionId: string
  ): Promise<void> {
    await this.respond(request, true, optionId);
  }

  async onSubmitInputRequired(request: UserActionRequest): Promise<void> {
    const responseText = (this.inputRequiredTexts.get(request.id) || '').trim();
    if (!responseText) return;

    await this.respond(request, true, responseText);
    this.inputRequiredTexts.delete(request.id);
  }

  private async respond(
    request: UserActionRequest,
    approved: boolean,
    selectedOption?: string
  ): Promise<void> {
    this.isResponding.set(true);

    try {
      // Handle input_required differently - send retry message or denial to CLI
      if (request.requestType === 'input_required') {
        if (!this.isPermissionRequest(request)) {
          const inputText = (selectedOption || '').trim();
          if (!inputText) {
            return;
          }
          const approvalTraceId =
            request.permissionMetadata?.approvalTraceId || `approval-renderer-generic-${request.id}`;
          console.log('[APPROVAL_TRACE][renderer:user-action] submit_generic_input_required', {
            approvalTraceId,
            requestId: request.id,
            instanceId: request.instanceId
          });

          const result = await this.ipc.respondToInputRequired(
            request.instanceId,
            request.id,
            inputText
          );

          if (result.success) {
            console.log('[APPROVAL_TRACE][renderer:user-action] submit_generic_input_required_success', {
              approvalTraceId,
              requestId: request.id,
              instanceId: request.instanceId
            });
            this.inputRequiredTexts.delete(request.id);
            this.pendingRequests.update((requests) =>
              requests.filter((r) => r.id !== request.id)
            );
            this.instanceStore.decrementPendingApproval(request.instanceId);
          }
          return;
        }

        let response: string;
        const meta = request.permissionMetadata;
        const approvalTraceId = meta?.approvalTraceId || `approval-renderer-permission-${request.id}`;
        // Create permission key to clear pending permission tracking
        const permissionKey = meta?.action && meta?.path ? `${meta.action}:${meta.path}` : undefined;
        const decisionScope = this.getInputRequiredScope(request);
        const decisionAction = approved ? 'allow' : 'deny';

        if (approved) {
          // Construct a helpful retry message based on the permission metadata
          if (meta?.action && meta?.path) {
            // Tell Claude to retry the specific action
            response = `Permission granted. Please proceed to ${meta.action} ${meta.path}.`;
          } else {
            // Generic approval message
            response = `Permission granted. Please proceed with the operation.`;
          }
          console.log('[APPROVAL_TRACE][renderer:user-action] submit_permission_decision', {
            approvalTraceId,
            requestId: request.id,
            instanceId: request.instanceId,
            decisionAction,
            decisionScope,
            permissionKey: permissionKey || null
          });
        } else {
          response = 'Permission denied. Please do not perform that operation.';
          console.log('[APPROVAL_TRACE][renderer:user-action] submit_permission_decision', {
            approvalTraceId,
            requestId: request.id,
            instanceId: request.instanceId,
            decisionAction,
            decisionScope,
            permissionKey: permissionKey || null
          });
        }

        // Pass metadata so the IPC handler can route to the correct flow:
        //   - `deferred_permission` → resume the CLI via the hook bridge
        //   - `permission_denial` + scope='always' → write a rule to
        //     ~/.claude/settings.json via SelfPermissionGranter and respawn
        //     the session so the CLI picks up the new allow entry
        // The full_path (untruncated) is preferred when building the rule
        // pattern; `path` is the display-friendly version that may have been
        // truncated for the user-visible prompt message.
        const ipcMetadata = this.isDeferredPermission(request)
          ? { type: 'deferred_permission', tool_use_id: meta?.tool_use_id }
          : this.isPermissionDenial(request)
            ? {
                type: 'permission_denial',
                tool_name: meta?.tool_name,
                full_path: meta?.full_path,
                path: meta?.path,
                action: meta?.action,
              }
            : undefined;

        const result = await this.ipc.respondToInputRequired(
          request.instanceId,
          request.id,
          response,
          permissionKey,
          decisionAction,
          decisionScope,
          ipcMetadata
        );

        if (result.success) {
          console.log('[APPROVAL_TRACE][renderer:user-action] submit_permission_decision_success', {
            approvalTraceId,
            requestId: request.id,
            instanceId: request.instanceId,
            decisionAction,
            decisionScope,
            isDeferred: this.isDeferredPermission(request),
          });
          this.inputRequiredScopes.delete(request.id);
          this.pendingRequests.update((requests) =>
            requests.filter((r) => r.id !== request.id)
          );
          this.instanceStore.decrementPendingApproval(request.instanceId);
        }
        return;
      }

      // Handle orchestrator user action requests
      const response = await this.ipc.respondToUserAction(
        request.id,
        approved,
        selectedOption
      );

      if (response.success) {
        if (
          approved &&
          request.requestType === 'switch_mode' &&
          request.targetMode
        ) {
          await this.instanceStore.changeAgentMode(
            request.instanceId,
            request.targetMode
          );
        }
        // Remove the request from the list
        this.pendingRequests.update((requests) =>
          requests.filter((r) => r.id !== request.id)
        );
      }
    } catch (error) {
      console.error('Failed to respond to user action request:', error);
    } finally {
      this.isResponding.set(false);
    }
  }
}
