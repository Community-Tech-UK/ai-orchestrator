/**
 * User Action Request Component - Displays pending orchestrator requests to the user
 */

import {
  Component,
  HostListener,
  inject,
  signal,
  computed,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  input,
  effect,
  untracked
} from '@angular/core';
import { IpcFacadeService, IpcEventBusService } from '../../core/services/ipc';
import { shouldClearInputRequiredForStatus } from '../../core/services/ipc/input-required-lifecycle';
import type { InputRequiredEvent } from '../../core/services/ipc/ipc-event-bus.service';
import { InstanceStore } from '../../core/state/instance.store';
import {
  approveLabelFor,
  decisionFor,
  permissionHintFor,
  permissionScopesFor,
  rejectLabelFor,
  scopeOptionLabel,
  canResolveInputRequiredWithYolo,
  defaultInputRequiredScope,
  type InputRequiredScope,
  shouldClearInputRequiredForYolo,
  shouldClearRequestAfterYoloEnabled
} from './user-action-request.rules';
import type { UserActionRequest } from './user-action-request.types';
import { PlanHandoffDialogComponent } from './plan-handoff-dialog.component';
import {
  toInputRequiredRequest,
  isAcpInputRequired,
  isInputRequiredNotPending,
} from './user-action-request.input-required';
import {
  clearResponseError,
  errorMessage,
  responseErrorMessage,
  setResponseError
} from './user-action-request.response-utils';
import {
  declineSecretCardDraft,
  isSecretRequest,
  SecretCardDrafts,
  submitSecretCardDraft,
} from './user-action-request.secret-card';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';

export type { UserActionRequest } from './user-action-request.types';

@Component({
  selector: 'app-user-action-request',
  standalone: true,
  imports: [AioTooltipDirective, PlanHandoffDialogComponent],
  templateUrl: './user-action-request.component.html',
  styleUrl: './user-action-request.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserActionRequestComponent implements OnInit, OnDestroy {
  protected readonly copy = copyFor;
  private ipc = inject(IpcFacadeService);
  private instanceStore = inject(InstanceStore);
  private eventBus = inject(IpcEventBusService);

  instanceId = input<string | null>(null);
  private readonly yoloModeEnabled = computed(() => {
    const id = this.instanceId();
    return id ? this.instanceStore.getInstance(id)?.yoloMode === true : false;
  });

  pendingRequests = signal<UserActionRequest[]>([]);
  protected readonly planHandoff = signal<{ id: string; instanceId: string } | null>(null);
  openPlanHandoff(request: UserActionRequest): void { this.planHandoff.set({ id: request.id, instanceId: request.instanceId }); }
  onPlanHandoffStarted(requestId: string): void { this.pendingRequests.update(requests => requests.filter(request => request.id !== requestId)); }
  isResponding = signal(false);
  responseErrors = signal<Map<string, string>>(new Map());

  private inputRequiredScopes = new Map<string, InputRequiredScope>();
  private inputRequiredTexts = new Map<string, string>();
  private readonly secretCardDrafts = new SecretCardDrafts();

  private modifyPanelOpen = new Map<string, boolean>();
  private modifyInputTexts = new Map<string, string>();
  modifyInputErrors = signal<Map<string, string>>(new Map());

  /** Answers keyed by instance/request identity, then question index. */
  private questionAnswers = new Map<string, Map<number, string>>();

  /**
   * Tracks selected option labels for AskUserQuestion prompts:
   * Instance/request identity → questionIndex → selected option labels.
   */
  private askSelections = new Map<string, Map<number, Set<string>>>();
  /**
   * Tracks free-text answers for AskUserQuestion entries that have no options:
   * Instance/request identity → questionIndex → text.
   */
  private askTextAnswers = new Map<string, Map<number, string>>();

  private visibleInputRequired: readonly InputRequiredEvent[] = [];
  private retainedInputRequired: readonly InputRequiredEvent[] = [];
  private unsubscribeUserAction: (() => void) | null = null;

  constructor() {
    // Reload pending requests when instanceId changes and keep the card scoped
    // to the selected session.
    effect(() => {
      const id = this.instanceId();
      untracked(() => {
        for (const request of this.pendingRequests()) {
          if (request.instanceId !== id) this.secretCardDrafts.clear(request.id);
        }
      });
      if (this.planHandoff() && this.planHandoff()!.instanceId !== id) this.planHandoff.set(null);
      if (id) {
        this.pendingRequests.update((requests) =>
          requests.filter((r) => this.isRequestForInstance(r, id))
        );
        this.loadPendingRequests();
      } else {
        this.pendingRequests.set([]);
      }
    });

    effect(() => {
      const id = this.instanceId();
      const status = id ? this.instanceStore.getInstance(id)?.status : undefined;
      if (id && shouldClearInputRequiredForStatus(status)) {
        this.clearCachedInputRequiredForInstance(id);
        this.pendingRequests.update((requests) =>
          requests.filter((r) => r.requestType !== 'input_required' || !this.isRequestForInstance(r, id))
        );
        this.instanceStore.clearPendingApprovals(id);
      }
    });

    // Mirror the runtime-owned requests, including events received while this
    // component did not exist. Only the selected runtime can contribute cards.
    effect(() => {
      const id = this.instanceId();
      const pending = this.eventBus.pendingInputRequired();
      const yoloMode = this.yoloModeEnabled();
      const visible = pending.filter((request) => request.instanceId === id);
      const currentPayloads = new Set(pending);
      // secret_required also arrives through the orchestrator list/events.
      // Replace only cards owned by this runtime stream, preserving those.
      const runtimeRequestIds = new Set([...this.visibleInputRequired, ...visible]
        .filter((request) => request.instanceId === id).map((request) => request.requestId));
      untracked(() => {
        for (const previous of this.retainedInputRequired) {
          if (!currentPayloads.has(previous)) {
            const key = this.draftKey(previous.instanceId, previous.requestId);
            for (const drafts of [this.inputRequiredTexts, this.inputRequiredScopes, this.modifyPanelOpen,
              this.modifyInputTexts, this.questionAnswers, this.askSelections, this.askTextAnswers]) {
              drafts.delete(key);
            }
            clearResponseError(this.responseErrors, key);
            this.modifyInputErrors.update((errors) => {
              const next = new Map(errors);
              next.delete(key);
              return next;
            });
          }
        }
        for (const previous of this.visibleInputRequired) {
          if (!visible.includes(previous)) this.secretCardDrafts.clear(previous.requestId);
        }
      });
      this.retainedInputRequired = pending;
      this.visibleInputRequired = visible;
      const cards = visible.map(toInputRequiredRequest)
        .filter((request) => !yoloMode || !shouldClearInputRequiredForYolo(request));
      this.pendingRequests.update((requests) => [
        ...requests.filter((request) => request.instanceId === id && !runtimeRequestIds.has(request.id)),
        ...cards,
      ]);
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
  }

  private dropInputRequiredCard(instanceId: string, requestId: string): void {
    this.inputRequiredTexts.delete(this.draftKey(instanceId, requestId));
    this.eventBus.dismissInputRequired(instanceId, requestId);
    clearResponseError(this.responseErrors, this.draftKey(instanceId, requestId));
    this.pendingRequests.update((requests) => requests.filter((r) => r.instanceId !== instanceId || r.id !== requestId));
  }

  ngOnDestroy(): void {
    if (this.unsubscribeUserAction) {
      this.unsubscribeUserAction();
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
            (r) => this.isRequestForInstance(r, currentInstanceId) && !cachedIds.has(r.id)
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
    return this.eventBus.pendingInputRequired()
      .filter((request) => request.instanceId === instanceId)
      .map(toInputRequiredRequest)
      .filter((request) => !this.instanceStore.getInstance(instanceId)?.yoloMode || !shouldClearInputRequiredForYolo(request));
  }

  private clearCachedInputRequiredForInstance(
    instanceId: string,
    shouldClear: (request: UserActionRequest) => boolean = () => true,
  ): void {
    this.eventBus.clearInputRequired(instanceId, (request) => shouldClear(toInputRequiredRequest(request)));
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

  getApproveLabel(request: UserActionRequest): string | undefined {
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
        return approveLabelFor(request.permissionMetadata, this.getInputRequiredScope(request));
      default:
        return 'Yes';
    }
  }

  getInputRequiredScope(request: UserActionRequest | string): InputRequiredScope {
    const requestId = typeof request === 'string' ? request : request.id;
    const metadata = typeof request === 'string' ? undefined : request.permissionMetadata;
    const instanceId = typeof request === 'string' ? this.instanceId() : request.instanceId;
    return this.inputRequiredScopes.get(this.draftKey(instanceId, requestId)) || defaultInputRequiredScope(metadata);
  }

  onInputRequiredScopeChange(requestId: string, event: Event): void {
    const target = event.target as HTMLSelectElement;
    const val = (target.value as InputRequiredScope) || 'once';
    this.inputRequiredScopes.set(this.draftKey(this.instanceId(), requestId), val);
    clearResponseError(this.responseErrors, this.draftKey(this.instanceId(), requestId));
  }

  getResponseError(requestId: string): string {
    return this.responseErrors().get(this.draftKey(this.instanceId(), requestId)) ?? '';
  }

  isPermissionRequest(request: UserActionRequest): boolean {
    return request.requestType === 'input_required' &&
      (request.permissionMetadata?.type === 'permission_denial' ||
       request.permissionMetadata?.type === 'deferred_permission' ||
       request.permissionMetadata?.type === 'codex_mcp_approval');
  }

  getRejectLabel(request: UserActionRequest): string {
    return this.isPermissionRequest(request)
      ? rejectLabelFor(request.permissionMetadata, this.getInputRequiredScope(request)) : 'Reject';
  }

  getPermissionHint(request: UserActionRequest): string {
    return this.isPermissionRequest(request)
      ? permissionHintFor(request.permissionMetadata, this.getInputRequiredScope(request)) : '';
  }

  isDeferredPermission(request: UserActionRequest): boolean {
    return request.permissionMetadata?.type === 'deferred_permission';
  }

  isPermissionDenial(request: UserActionRequest): boolean {
    return request.permissionMetadata?.type === 'permission_denial';
  }

  canResolveWithYolo(request: UserActionRequest): boolean {
    return canResolveInputRequiredWithYolo(request);
  }

  scopesFor(request: UserActionRequest): InputRequiredScope[] {
    return permissionScopesFor(request.permissionMetadata);
  }

  readonly scopeLabel = scopeOptionLabel;

  onInputRequiredTextChange(requestId: string, event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.inputRequiredTexts.set(this.draftKey(this.instanceId(), requestId), target.value);
  }

  protected draftKey(instanceId: string | null, requestId: string): string {
    return JSON.stringify([instanceId, requestId]);
  }

  getInputRequiredText(requestId: string): string {
    return this.inputRequiredTexts.get(this.draftKey(this.instanceId(), requestId)) ?? '';
  }

  hasInputRequiredText(requestId: string): boolean {
    return this.getInputRequiredText(requestId).trim().length > 0;
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
    return this.modifyPanelOpen.get(this.draftKey(this.instanceId(), requestId)) ?? false;
  }

  toggleModifyPanel(request: UserActionRequest): void {
    const open = !this.isModifyPanelOpen(request.id);
    this.modifyPanelOpen.set(this.draftKey(request.instanceId, request.id), open);
    // Pre-fill from tool_input the first time the panel is opened
    if (open && !this.modifyInputTexts.has(this.draftKey(request.instanceId, request.id))) {
      const toolInput = request.permissionMetadata?.tool_input;
      this.modifyInputTexts.set(
        this.draftKey(request.instanceId, request.id),
        toolInput ? JSON.stringify(toolInput, null, 2) : ''
      );
    }
  }

  getModifyInputText(requestId: string): string {
    return this.modifyInputTexts.get(this.draftKey(this.instanceId(), requestId)) ?? '';
  }

  onModifyInputTextChange(requestId: string, event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.modifyInputTexts.set(this.draftKey(this.instanceId(), requestId), target.value);
    // Clear any stale error as user edits
    const errors = new Map(this.modifyInputErrors());
    errors.delete(this.draftKey(this.instanceId(), requestId));
    this.modifyInputErrors.set(errors);
  }

  getModifyInputError(requestId: string): string {
    return this.modifyInputErrors().get(this.draftKey(this.instanceId(), requestId)) ?? '';
  }

  /**
   * Track answer changes for ask_questions requests
   */
  onQuestionAnswerChange(requestId: string, questionIndex: number, event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    let answers = this.questionAnswers.get(this.draftKey(this.instanceId(), requestId));
    if (!answers) {
      answers = new Map();
      this.questionAnswers.set(this.draftKey(this.instanceId(), requestId), answers);
    }
    answers.set(questionIndex, target.value);
  }

  questionAnswerValue(requestId: string, questionIndex: number): string {
    return this.questionAnswers.get(this.draftKey(this.instanceId(), requestId))?.get(questionIndex) ?? '';
  }

  async onSubmitAnswers(request: UserActionRequest): Promise<void> {
    const answers = this.questionAnswers.get(this.draftKey(request.instanceId, request.id));
    const questions = request.questions || [];

    // Build answers object: { "Question text": "Answer text" }
    const answersObj: Record<string, string> = {};
    questions.forEach((q, i) => {
      answersObj[q] = answers?.get(i) || '';
    });

    const answersJson = JSON.stringify(answersObj);
    await this.respond(request, true, answersJson);

  }

  isAskOptionSelected(requestId: string, questionIndex: number, label: string): boolean {
    return this.askSelections.get(this.draftKey(this.instanceId(), requestId))?.get(questionIndex)?.has(label) ?? false;
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
    let byQuestion = this.askSelections.get(this.draftKey(this.instanceId(), requestId));
    if (!byQuestion) {
      byQuestion = new Map();
      this.askSelections.set(this.draftKey(this.instanceId(), requestId), byQuestion);
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
    let byQuestion = this.askTextAnswers.get(this.draftKey(this.instanceId(), requestId));
    if (!byQuestion) {
      byQuestion = new Map();
      this.askTextAnswers.set(this.draftKey(this.instanceId(), requestId), byQuestion);
    }
    byQuestion.set(questionIndex, target.value);
  }

  askTextValue(requestId: string, questionIndex: number): string {
    return this.askTextAnswers.get(this.draftKey(this.instanceId(), requestId))?.get(questionIndex) ?? '';
  }

  /** Enabled only once every question has a selection or non-empty text. */
  canSubmitAskUserQuestion(request: UserActionRequest): boolean {
    const questions = request.askQuestions;
    if (!questions || questions.length === 0) {
      return false;
    }
    return questions.every((entry, index) => {
      if (entry.options.length > 0) {
        return (this.askSelections.get(this.draftKey(request.instanceId, request.id))?.get(index)?.size ?? 0) > 0;
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
        const selected = [...(this.askSelections.get(this.draftKey(request.instanceId, request.id))?.get(index) ?? new Set<string>())];
        answer = selected.join(', ');
      } else {
        answer = this.askTextValue(request.id, index).trim();
      }
      return `${heading}: ${answer}`;
    });

    const responseText = isAcpInputRequired(request) ? JSON.stringify(Object.fromEntries(questions.map((entry, index) => [entry.header || entry.question,
      entry.options.length ? (entry.multiSelect ? [...(this.askSelections.get(this.draftKey(request.instanceId, request.id))?.get(index) ?? [])] : [...(this.askSelections.get(this.draftKey(request.instanceId, request.id))?.get(index) ?? [])][0]) : this.askTextValue(request.id, index).trim()]))) : lines.join('\n').trim();
    if (!responseText) {
      return;
    }

    await this.respond(request, true, responseText);
  }

  /**
   * Dismiss an AskUserQuestion without choosing. Sends a brief note back to the
   * CLI so the turn isn't left waiting on input indefinitely.
   */
  async onSkipAskUserQuestion(request: UserActionRequest): Promise<void> {
    await this.respond(
      request,
      true,
      isAcpInputRequired(request) ? 'cancel' : 'No preference — please proceed with your own recommendation.'
    );
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
    const rawText = (this.modifyInputTexts.get(this.draftKey(request.instanceId, request.id)) ?? '').trim();

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const errors = new Map(this.modifyInputErrors());
      errors.set(this.draftKey(request.instanceId, request.id), 'Invalid JSON — please fix the syntax before approving.');
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
      errors.set(this.draftKey(request.instanceId, request.id), 'Input must be a non-empty JSON object ({ … }).');
      this.modifyInputErrors.set(errors);
      return;
    }

    await this.respondWithModify(request, parsed as Record<string, unknown>);
  }

  async onEnableYolo(request: UserActionRequest): Promise<void> {
    if (this.isDeferredPermission(request)) {
      await this.respond(request, true, undefined, { enableYolo: true });
      return;
    }

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
      } else {
        setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), responseErrorMessage(result, 'Failed to enable YOLO mode.'));
      }
    } catch (error) {
      console.error('Failed to enable YOLO mode:', error);
      setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), errorMessage(error, 'Failed to enable YOLO mode.'));
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
    const responseText = (this.inputRequiredTexts.get(this.draftKey(request.instanceId, request.id)) || '').trim();
    if (!responseText) return;

    await this.respond(request, true, responseText);
  }

  readonly isSecretRequest = isSecretRequest;

  onSecretValueChange(requestId: string, event: Event): void {
    this.secretCardDrafts.set(requestId, (event.target as HTMLInputElement).value);
  }

  hasSecretValue(requestId: string): boolean {
    return this.secretCardDrafts.has(requestId);
  }

  secretCardValue(requestId: string): string {
    return this.secretCardDrafts.value(requestId);
  }

  secretCardWarning(request: UserActionRequest): string | null {
    return this.secretCardDrafts.warning(request);
  }

  async onSubmitSecretCard(request: UserActionRequest): Promise<void> {
    const value = this.secretCardDrafts.take(request.id);
    if (!value.trim()) return;
    await this.finishSecretCard(request, () => submitSecretCardDraft(this.ipc, request, value), 'The secret could not be saved.');
  }

  async onDeclineSecretCard(request: UserActionRequest): Promise<void> {
    this.secretCardDrafts.clear(request.id);
    await this.finishSecretCard(request, () => declineSecretCardDraft(this.ipc, request), 'The decline could not be recorded.');
  }

  private async finishSecretCard(
    request: UserActionRequest,
    submit: () => Promise<{ success: boolean; error?: { message: string } }>,
    fallback: string,
  ): Promise<void> {
    this.isResponding.set(true);
    clearResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id));
    try {
      const result = await submit();
      if (result.success) {
        this.eventBus.dismissInputRequired(request.instanceId, request.id);
        this.pendingRequests.update((requests) => requests.filter((r) => r.instanceId !== request.instanceId || r.id !== request.id));
      } else {
        setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), responseErrorMessage(result, fallback));
      }
    } catch (error) {
      setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), errorMessage(error, fallback));
    } finally {
      this.isResponding.set(false);
    }
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
        this.modifyInputTexts.delete(this.draftKey(request.instanceId, request.id));
        this.modifyPanelOpen.delete(this.draftKey(request.instanceId, request.id));
        const errors = new Map(this.modifyInputErrors());
        errors.delete(this.draftKey(request.instanceId, request.id));
        this.modifyInputErrors.set(errors);
        this.inputRequiredScopes.delete(this.draftKey(request.instanceId, request.id));
        this.eventBus.dismissInputRequired(request.instanceId, request.id);
        this.pendingRequests.update((requests) =>
          requests.filter((r) => r.instanceId !== request.instanceId || r.id !== request.id)
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
    selectedOption?: string,
    metadataExtras?: Record<string, unknown>,
  ): Promise<void> {
    this.isResponding.set(true);
    clearResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id));

    try {
      // Handle input_required differently - send retry message or denial to CLI
      if (request.requestType === 'input_required') {
        if (!this.isPermissionRequest(request)) {
          const acp = isAcpInputRequired(request);
          // Cancel on an ACP card is a real answer (outcome `cancelled`); on
          // other generic cards the reply is plain input, so nothing is sent.
          const inputText = (selectedOption || (!approved && acp ? 'cancel' : '')).trim();
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
            inputText,
            // ACP resolves the reply by key, so a stale sibling card cannot absorb it.
            acp ? request.id : undefined,
          );

          if (!result.success && isInputRequiredNotPending(result)) {
            // Already settled elsewhere (timeout, auto-approve); the resolved
            // event handles the pending count.
            this.dropInputRequiredCard(request.instanceId, request.id);
            return;
          }
          if (result.success) {
            console.log('[APPROVAL_TRACE][renderer:user-action] submit_generic_input_required_success', {
              approvalTraceId,
              requestId: request.id,
              instanceId: request.instanceId
            });
            this.inputRequiredTexts.delete(this.draftKey(request.instanceId, request.id));
            this.eventBus.dismissInputRequired(request.instanceId, request.id);
            this.pendingRequests.update((requests) =>
              requests.filter((r) => r.instanceId !== request.instanceId || r.id !== request.id)
            );
            this.instanceStore.decrementPendingApproval(request.instanceId);
          } else {
            setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), responseErrorMessage(result, 'Failed to submit your response.'));
          }
          return;
        }

        let response: string;
        const meta = request.permissionMetadata;
        const approvalTraceId = meta?.approvalTraceId || `approval-renderer-permission-${request.id}`;
        // Create permission key to clear pending permission tracking
        const permissionKey = meta?.action && meta?.path ? `${meta.action}:${meta.path}` : undefined;
        const decision = decisionFor(meta, approved, this.getInputRequiredScope(request));
        const decisionScope = decision?.scope;
        const decisionAction = decision?.action;

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
          ? { type: 'deferred_permission', tool_use_id: meta?.tool_use_id, ...metadataExtras }
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
          const resultData = result.data as { yoloMode?: boolean } | undefined;
          console.log('[APPROVAL_TRACE][renderer:user-action] submit_permission_decision_success', {
            approvalTraceId,
            requestId: request.id,
            instanceId: request.instanceId,
            decisionAction,
            decisionScope,
            isDeferred: this.isDeferredPermission(request),
          });
          this.inputRequiredScopes.delete(this.draftKey(request.instanceId, request.id));
          if (resultData?.yoloMode === true) {
            this.instanceStore.setLocalYoloMode(request.instanceId, true);
            this.clearCachedInputRequiredForInstance(
              request.instanceId,
              (cachedRequest) => shouldClearRequestAfterYoloEnabled(cachedRequest, request.instanceId)
            );
            this.pendingRequests.update((requests) =>
              requests.filter((r) => !shouldClearRequestAfterYoloEnabled(r, request.instanceId))
            );
            this.instanceStore.clearPendingApprovals(request.instanceId);
          } else {
            this.eventBus.dismissInputRequired(request.instanceId, request.id);
            this.pendingRequests.update((requests) =>
              requests.filter((r) => r.instanceId !== request.instanceId || r.id !== request.id)
            );
            this.instanceStore.decrementPendingApproval(request.instanceId);
          }
        } else {
          setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), responseErrorMessage(result, 'Failed to submit your decision.'));
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
        this.questionAnswers.delete(this.draftKey(request.instanceId, request.id));
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
          requests.filter((r) => r.instanceId !== request.instanceId || r.id !== request.id)
        );
      } else {
        setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), responseErrorMessage(response, 'Failed to submit your decision.'));
      }
    } catch (error) {
      console.error('Failed to respond to user action request:', error);
      setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), errorMessage(error, 'Failed to submit your decision.'));
    } finally {
      this.isResponding.set(false);
    }
  }
}
