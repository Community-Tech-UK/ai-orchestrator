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
import type { UserActionRequest } from './user-action-request.types';
import type { AskUserQuestionEntry } from '../../../../shared/types/ask-user-question.types';

export type { UserActionRequest } from './user-action-request.types';

@Component({
  selector: 'app-user-action-request',
  standalone: true,
  imports: [],
  templateUrl: './user-action-request.component.html',
  styleUrl: './user-action-request.component.scss',
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
  private pendingInputRequiredById = new Map<string, UserActionRequest>();

  /** Tracks whether the "Edit input" section is expanded per requestId */
  private modifyPanelOpen = new Map<string, boolean>();
  /** Tracks the raw textarea text for modified tool_input per requestId */
  private modifyInputTexts = new Map<string, string>();
  /** Tracks JSON parse/validation errors for modify per requestId */
  modifyInputErrors = signal<Map<string, string>>(new Map());

  /** Tracks user answers for ask_questions requests: requestId → Map<questionIndex, answer> */
  private questionAnswers = new Map<string, Map<number, string>>();

  /**
   * Tracks selected option labels for AskUserQuestion prompts:
   * requestId → questionIndex → set of selected option labels.
   */
  private askSelections = new Map<string, Map<number, Set<string>>>();
  /**
   * Tracks free-text answers for AskUserQuestion entries that have no options:
   * requestId → questionIndex → text.
   */
  private askTextAnswers = new Map<string, Map<number, string>>();

  private unsubscribeUserAction: (() => void) | null = null;
  private unsubscribeInputRequired: (() => void) | null = null;

  constructor() {
    // Reload pending requests when instanceId changes and keep the card scoped
    // to the selected session.
    effect(() => {
      const id = this.instanceId();
      if (id) {
        this.pendingRequests.update((requests) =>
          requests.filter((r) => this.isRequestForInstance(r, id))
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
          this.clearCachedInputRequiredForInstance(id, shouldClearInputRequiredForYolo);
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

    // Subscribe to user action requests (orchestrator commands) for the
    // currently selected session.
    this.unsubscribeUserAction = this.ipc.onUserActionRequest((request) => {
      const req = request as UserActionRequest;
      const currentInstanceId = this.instanceId();
      if (!currentInstanceId || !this.isRequestForInstance(req, currentInstanceId)) {
        return;
      }

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
      if (metadata?.type !== 'permission_denial') {
        const instance = this.instanceStore.getInstance(payload.instanceId);
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

      const isPermissionPrompt = metadata?.type === 'permission_denial' || metadata?.type === 'deferred_permission';
      const askQuestions =
        metadata?.type === 'ask_user_question'
          ? this.coerceAskQuestions((payload.metadata as Record<string, unknown> | undefined)?.['questions'])
          : undefined;
      const req: UserActionRequest = {
        id: payload.requestId,
        instanceId: payload.instanceId,
        requestType: 'input_required',
        title: askQuestions?.length
          ? 'Claude has a question'
          : isPermissionPrompt
            ? 'Permission Required'
            : 'Input Required',
        message: payload.prompt,
        createdAt: payload.timestamp,
        permissionMetadata: metadata, // Store permission details for retry message
        askQuestions
      };
      this.pendingInputRequiredById.set(req.id, req);
      if (!this.inputRequiredScopes.has(req.id)) {
        this.inputRequiredScopes.set(req.id, defaultInputRequiredScope(metadata));
      }

      // Only show for this instance
      if (!currentInstanceId || payload.instanceId === currentInstanceId) {
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
    if (!currentInstanceId) {
      this.pendingRequests.set([]);
      return;
    }

    try {
      const response = await this.ipc.listUserActionRequestsForInstance(currentInstanceId);
      if (this.instanceId() !== currentInstanceId) {
        return;
      }

      if (response.success && 'data' in response && response.data) {
        const serverRequests = response.data as UserActionRequest[];
        // Merge: use server list as base, but keep any locally-tracked requests
        // that the server doesn't know about yet (e.g., input_required from IPC events).
        this.pendingRequests.update((existing) => {
          const serverIds = new Set(serverRequests.map((r) => r.id));
          const cachedInputRequired = this.getCachedInputRequiredForInstance(currentInstanceId);
          const cachedIds = new Set(cachedInputRequired.map((r) => r.id));
          const localOnly = existing.filter(
            (r) =>
              !serverIds.has(r.id) &&
              !cachedIds.has(r.id) &&
              this.isRequestForInstance(r, currentInstanceId)
          );
          const filteredServer = serverRequests.filter(
            (r) => this.isRequestForInstance(r, currentInstanceId)
          );
          return [...filteredServer, ...localOnly, ...cachedInputRequired];
        });
      }
    } catch (error) {
      console.error('Failed to load pending user action requests:', error);
    }
  }

  private isRequestForInstance(request: UserActionRequest, instanceId: string): boolean {
    return request.instanceId === instanceId;
  }

  private getCachedInputRequiredForInstance(instanceId: string): UserActionRequest[] {
    return Array.from(this.pendingInputRequiredById.values()).filter(
      (request) => this.isRequestForInstance(request, instanceId)
    );
  }

  private clearCachedInputRequiredForInstance(
    instanceId: string,
    shouldClear: (request: UserActionRequest) => boolean = () => true,
  ): void {
    for (const [requestId, request] of this.pendingInputRequiredById.entries()) {
      if (this.isRequestForInstance(request, instanceId) && shouldClear(request)) {
        this.pendingInputRequiredById.delete(requestId);
      }
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

  // ── Modify-approval helpers ──────────────────────────────────────────────

  /**
   * Returns true only when the request is a deferred permission AND has
   * tool_input data to pre-fill the editor. This gates the entire modify UI.
   */
  canModifyInput(request: UserActionRequest): boolean {
    return (
      this.isDeferredPermission(request) &&
      request.permissionMetadata?.tool_input !== undefined &&
      request.permissionMetadata.tool_input !== null
    );
  }

  isModifyPanelOpen(requestId: string): boolean {
    return this.modifyPanelOpen.get(requestId) ?? false;
  }

  toggleModifyPanel(request: UserActionRequest): void {
    const open = !this.isModifyPanelOpen(request.id);
    this.modifyPanelOpen.set(request.id, open);
    // Pre-fill from tool_input the first time the panel is opened
    if (open && !this.modifyInputTexts.has(request.id)) {
      const toolInput = request.permissionMetadata?.tool_input;
      this.modifyInputTexts.set(
        request.id,
        toolInput ? JSON.stringify(toolInput, null, 2) : ''
      );
    }
  }

  getModifyInputText(requestId: string): string {
    return this.modifyInputTexts.get(requestId) ?? '';
  }

  onModifyInputTextChange(requestId: string, event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.modifyInputTexts.set(requestId, target.value);
    // Clear any stale error as user edits
    const errors = new Map(this.modifyInputErrors());
    errors.delete(requestId);
    this.modifyInputErrors.set(errors);
  }

  getModifyInputError(requestId: string): string {
    return this.modifyInputErrors().get(requestId) ?? '';
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

  /**
   * Validate and normalize the structured `questions` array shipped on
   * AskUserQuestion `input_required` metadata. Returns undefined when nothing
   * actionable is present so the card falls back to the freeform text box.
   */
  private coerceAskQuestions(value: unknown): AskUserQuestionEntry[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const entries: AskUserQuestionEntry[] = [];
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const obj = raw as Record<string, unknown>;
      const question = typeof obj['question'] === 'string' ? obj['question'] : '';
      const header = typeof obj['header'] === 'string' ? obj['header'] : undefined;
      const options = Array.isArray(obj['options'])
        ? obj['options']
            .filter(
              (opt): opt is { label: string; description?: string } =>
                !!opt && typeof opt === 'object' && typeof (opt as { label?: unknown }).label === 'string'
            )
            .map((opt) => ({
              label: opt.label,
              description: typeof opt.description === 'string' ? opt.description : undefined
            }))
        : [];
      if (!question && !header && options.length === 0) {
        continue;
      }
      entries.push({
        header,
        question: question || header || 'Please choose an option',
        multiSelect: obj['multiSelect'] === true,
        options
      });
    }
    return entries.length > 0 ? entries : undefined;
  }

  /** True when the request should render clickable AskUserQuestion options. */
  isAskUserQuestion(request: UserActionRequest): boolean {
    return !!request.askQuestions && request.askQuestions.length > 0;
  }

  isAskOptionSelected(requestId: string, questionIndex: number, label: string): boolean {
    return this.askSelections.get(requestId)?.get(questionIndex)?.has(label) ?? false;
  }

  /**
   * Toggle an option for a question. Single-select questions behave like radio
   * buttons (selecting one replaces the prior choice); multi-select toggles.
   */
  toggleAskOption(
    requestId: string,
    questionIndex: number,
    label: string,
    multiSelect: boolean
  ): void {
    let byQuestion = this.askSelections.get(requestId);
    if (!byQuestion) {
      byQuestion = new Map();
      this.askSelections.set(requestId, byQuestion);
    }
    const current = byQuestion.get(questionIndex) ?? new Set<string>();
    if (multiSelect) {
      if (current.has(label)) {
        current.delete(label);
      } else {
        current.add(label);
      }
    } else {
      const wasSelected = current.has(label);
      current.clear();
      if (!wasSelected) {
        current.add(label);
      }
    }
    byQuestion.set(questionIndex, current);
  }

  onAskTextChange(requestId: string, questionIndex: number, event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    let byQuestion = this.askTextAnswers.get(requestId);
    if (!byQuestion) {
      byQuestion = new Map();
      this.askTextAnswers.set(requestId, byQuestion);
    }
    byQuestion.set(questionIndex, target.value);
  }

  askTextValue(requestId: string, questionIndex: number): string {
    return this.askTextAnswers.get(requestId)?.get(questionIndex) ?? '';
  }

  /** Enabled only once every question has a selection or non-empty text. */
  canSubmitAskUserQuestion(request: UserActionRequest): boolean {
    const questions = request.askQuestions;
    if (!questions || questions.length === 0) {
      return false;
    }
    return questions.every((entry, index) => {
      if (entry.options.length > 0) {
        return (this.askSelections.get(request.id)?.get(index)?.size ?? 0) > 0;
      }
      return this.askTextValue(request.id, index).trim().length > 0;
    });
  }

  /**
   * Compile the chosen options/text into a readable answer and send it back to
   * the CLI through the standard input_required response path.
   */
  async onSubmitAskUserQuestion(request: UserActionRequest): Promise<void> {
    const questions = request.askQuestions;
    if (!questions || !this.canSubmitAskUserQuestion(request)) {
      return;
    }

    const lines = questions.map((entry, index) => {
      const heading = entry.header || entry.question;
      let answer: string;
      if (entry.options.length > 0) {
        const selected = [...(this.askSelections.get(request.id)?.get(index) ?? new Set<string>())];
        answer = selected.join(', ');
      } else {
        answer = this.askTextValue(request.id, index).trim();
      }
      return `${heading}: ${answer}`;
    });

    const responseText = lines.join('\n').trim();
    if (!responseText) {
      return;
    }

    await this.respond(request, true, responseText);
    this.askSelections.delete(request.id);
    this.askTextAnswers.delete(request.id);
  }

  /**
   * Dismiss an AskUserQuestion without choosing. Sends a brief note back to the
   * CLI so the turn isn't left waiting on input indefinitely.
   */
  async onSkipAskUserQuestion(request: UserActionRequest): Promise<void> {
    await this.respond(
      request,
      true,
      'No preference — please proceed with your own recommendation.'
    );
    this.askSelections.delete(request.id);
    this.askTextAnswers.delete(request.id);
  }

  async onApprove(request: UserActionRequest): Promise<void> {
    await this.respond(request, true);
  }

  async onReject(request: UserActionRequest): Promise<void> {
    await this.respond(request, false);
  }

  /**
   * "Approve with changes" path: parse the edited JSON, validate it is a
   * non-empty plain object, then call respondToInputRequired with
   * decisionAction='modify' and the parsed object as updatedInput.
   */
  async onApproveWithChanges(request: UserActionRequest): Promise<void> {
    const rawText = (this.modifyInputTexts.get(request.id) ?? '').trim();

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const errors = new Map(this.modifyInputErrors());
      errors.set(request.id, 'Invalid JSON — please fix the syntax before approving.');
      this.modifyInputErrors.set(errors);
      return;
    }

    // Validate: must be a non-empty plain object
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed as object).length === 0
    ) {
      const errors = new Map(this.modifyInputErrors());
      errors.set(request.id, 'Input must be a non-empty JSON object ({ … }).');
      this.modifyInputErrors.set(errors);
      return;
    }

    await this.respondWithModify(request, parsed as Record<string, unknown>);
  }

  async onEnableYolo(request: UserActionRequest): Promise<void> {
    this.isResponding.set(true);
    try {
      // Toggle YOLO mode for this instance
      const result = await this.ipc.toggleYoloMode(request.instanceId);
      if (result.success) {
        // Remove all pending permission requests for this instance since YOLO is now enabled
        this.clearCachedInputRequiredForInstance(
          request.instanceId,
          (cachedRequest) => shouldClearRequestAfterYoloEnabled(cachedRequest, request.instanceId)
        );
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

  /**
   * Sends a 'modify' decision: approved with an edited tool_input payload.
   * Only valid for deferred_permission requests.
   */
  private async respondWithModify(
    request: UserActionRequest,
    updatedInput: Record<string, unknown>
  ): Promise<void> {
    this.isResponding.set(true);
    try {
      const meta = request.permissionMetadata;
      const approvalTraceId =
        meta?.approvalTraceId || `approval-renderer-modify-${request.id}`;
      const permissionKey =
        meta?.action && meta?.path ? `${meta.action}:${meta.path}` : undefined;
      const decisionScope = this.getInputRequiredScope(request);
      const ipcMetadata: Record<string, unknown> = {
        type: 'deferred_permission',
        tool_use_id: meta?.tool_use_id,
      };

      console.log('[APPROVAL_TRACE][renderer:user-action] submit_modify_decision', {
        approvalTraceId,
        requestId: request.id,
        instanceId: request.instanceId,
        decisionScope,
        updatedInputKeys: Object.keys(updatedInput),
      });

      const result = await this.ipc.respondToInputRequired(
        request.instanceId,
        request.id,
        'Permission granted with modified input.',
        permissionKey,
        'modify',
        decisionScope,
        ipcMetadata,
        updatedInput
      );

      if (result.success) {
        console.log('[APPROVAL_TRACE][renderer:user-action] submit_modify_decision_success', {
          approvalTraceId,
          requestId: request.id,
          instanceId: request.instanceId,
        });
        // Clean up local state
        this.modifyInputTexts.delete(request.id);
        this.modifyPanelOpen.delete(request.id);
        const errors = new Map(this.modifyInputErrors());
        errors.delete(request.id);
        this.modifyInputErrors.set(errors);
        this.inputRequiredScopes.delete(request.id);
        this.pendingInputRequiredById.delete(request.id);
        this.pendingRequests.update((requests) =>
          requests.filter((r) => r.id !== request.id)
        );
        this.instanceStore.decrementPendingApproval(request.instanceId);
      }
    } catch (error) {
      console.error('Failed to respond with modified input:', error);
    } finally {
      this.isResponding.set(false);
    }
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
            this.pendingInputRequiredById.delete(request.id);
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
          this.pendingInputRequiredById.delete(request.id);
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
