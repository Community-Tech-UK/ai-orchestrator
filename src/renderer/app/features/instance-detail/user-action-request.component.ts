/**
 * User Action Request Component - Displays pending orchestrator requests to the user
 */

import {
  Component,
  HostListener,
  inject,
  signal,
  computed,
  untracked,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  input,
  effect
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
  respondToQuestion,
} from './user-action-request.input-required';
import { outcomeReasonForStatus, type RequestOutcomeReason, type UserChoice } from '../../../../shared/utils/request-outcome';
import { AskAnswerDrafts, normaliseChoice } from './user-input-request.ask-drafts';
import { isAgentQuestion, isApproval, questionSlots } from './user-input-request.kinds';
import { UserInputRequestRegistry, type QuestionCardHandle, type QuestionOfferResult } from './user-input-request.registry';
import { choiceFor, RequestReceiptStore } from './user-input-request.receipts';
import { RequestReceiptsComponent } from './request-receipts.component';
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

/** Whether a reply reached the agent, found its request already closed, or failed. */
type ReplyOutcome = 'sent' | 'stale' | 'failed';
const requestGeneration = (request: UserActionRequest): string => JSON.stringify([request.instanceId, request.id, request.createdAt]);

@Component({
  selector: 'app-user-action-request',
  standalone: true,
  imports: [AioTooltipDirective, RequestReceiptsComponent, PlanHandoffDialogComponent],
  templateUrl: './user-action-request.component.html',
  styleUrl: './user-action-request.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserActionRequestComponent implements OnInit, OnDestroy {
  protected readonly copy = copyFor;
  private ipc = inject(IpcFacadeService);
  private instanceStore = inject(InstanceStore);
  private eventBus = inject(IpcEventBusService);
  private readonly registry = inject(UserInputRequestRegistry);
  private readonly receiptStore = inject(RequestReceiptStore);

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

  /** What has been chosen or typed for each question; shared by the buttons and the message box. */
  private readonly drafts = new Map<string, AskAnswerDrafts>();
  protected get asks(): AskAnswerDrafts { return this.draftsFor(this.instanceId() ?? ''); }
  private draftsFor(instanceId: string): AskAnswerDrafts {
    let drafts = this.drafts.get(instanceId);
    if (!drafts) { drafts = new AskAnswerDrafts(); this.drafts.set(instanceId, drafts); }
    return drafts;
  }
  protected readonly isQuestion = isAgentQuestion;
  protected readonly receipts = computed(() => this.receiptStore.forSession(this.instanceId()));
  /** Replies from this card still on their way, so a worker's "decided" for one is not "answered elsewhere". */
  private readonly answering = new Set<string>();
  private readonly resolutions = new Map<string, RequestOutcomeReason>();
  private readonly closedGenerations = new Set<string>();

  private visibleInputRequired: readonly InputRequiredEvent[] = [];
  private retainedInputRequired: readonly InputRequiredEvent[] = [];
  private unsubscribeUserAction: (() => void) | null = null;
  private unsubscribeInputRequiredResolved: (() => void) | null = null;

  constructor() {
    // Reload pending requests when instanceId changes and keep the card scoped
    // to the selected session.
    effect(() => {
      const id = this.instanceId();
      untracked(() => {
        for (const request of this.pendingRequests()) {
          if (request.instanceId !== id) this.secretCardDrafts.clear(this.draftKey(request.instanceId, request.id));
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
        this.clearCachedInputRequiredForInstance(id, undefined, outcomeReasonForStatus(status));
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
      const cards = visible.map(toInputRequiredRequest)
        .filter((request) => !yoloMode || !shouldClearInputRequiredForYolo(request))
        .filter((request) => !this.closedGenerations.has(requestGeneration(request)));
      untracked(() => {
        for (const previous of this.retainedInputRequired) {
          if (!currentPayloads.has(previous)) {
            const key = this.draftKey(previous.instanceId, previous.requestId);
            for (const drafts of [this.inputRequiredTexts, this.inputRequiredScopes, this.modifyPanelOpen,
              this.modifyInputTexts]) {
              drafts.delete(key);
            }
            this.draftsFor(previous.instanceId).clear(previous.requestId);
            clearResponseError(this.responseErrors, key);
            this.modifyInputErrors.update((errors) => {
              const next = new Map(errors);
              next.delete(key);
              return next;
            });
          }
        }
        for (const previous of this.visibleInputRequired) {
          if (!visible.includes(previous)) this.secretCardDrafts.clear(this.draftKey(previous.instanceId, previous.requestId));
        }
        // A request seen for the first time, in any session, starts its receipt; one shown again is no longer resolved.
        for (const event of pending) {
          if (this.retainedInputRequired.some((previous) => previous.requestId === event.requestId && previous.instanceId === event.instanceId)) continue;
          const request = toInputRequiredRequest(event);
          if (this.closedGenerations.has(requestGeneration(request))) continue;
          if (this.instanceStore.getInstance(event.instanceId)?.yoloMode === true && shouldClearInputRequiredForYolo(request)) continue;
          this.resolutions.delete(this.draftKey(request.instanceId, request.id));
          this.receiptStore.shown(request);
        }
      });
      this.retainedInputRequired = pending;
      this.visibleInputRequired = visible;
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
          this.clearCachedInputRequiredForInstance(id, shouldClearInputRequiredForYolo, 'auto_approved');
          this.pendingRequests.update((requests) =>
            requests.filter((r) => !shouldClearInputRequiredForYolo(r))
          );
        }
      }
    });

    effect(() => {
      const id = this.instanceId();
      const messages = id ? this.instanceStore.getInstance(id)?.outputBuffer ?? [] : [];
      if (id) untracked(() => this.receiptStore.observeHistory(id, messages));
    });

    // The message box asks the registry before it sends; keep it in step with the question cards on screen.
    effect(() => {
      const handles = this.pendingRequests().filter(isAgentQuestion).map((request) => this.questionHandle(request));
      untracked(() => this.registry.replace(this, handles));
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
      if (this.closedGenerations.has(requestGeneration(req))) return;
      this.resolutions.delete(this.draftKey(req.instanceId, req.id));
      this.receiptStore.shown(req);

      // Deduplicate: skip if we already have this request ID
      this.pendingRequests.update((requests) => {
        if (requests.some((r) => r.id === req.id)) return requests;
        return [...requests, req];
      });
    });

    // Requests settled without the user (timeout, auto-approve, cancelled turn,
    // CLI exit) would otherwise leave a card that answers nothing.
    this.unsubscribeInputRequiredResolved = this.ipc.onInputRequiredResolved((payload) => {
      const key = this.draftKey(payload.instanceId, payload.requestId);
      const event = this.retainedInputRequired.find(r => r.requestId === payload.requestId && r.instanceId === payload.instanceId);
      const request = event ? toInputRequiredRequest(event) : this.pendingRequests().find(r => r.id === payload.requestId && r.instanceId === payload.instanceId);
      if (request) this.closedGenerations.add(requestGeneration(request));
      if (this.closedGenerations.size > 200) this.closedGenerations.delete(this.closedGenerations.values().next().value!);
      this.resolutions.set(key, payload.reason);
      if (this.resolutions.size > 200) this.resolutions.delete(this.resolutions.keys().next().value!);
      this.dropInputRequiredCard(payload.requestId, payload.reason, payload.instanceId);
    });
  }

  /** Drop only this session's card; a local decided echo waits for its acknowledgement. */
  private dropInputRequiredCard(requestId: string, reason?: RequestOutcomeReason, instanceId = this.instanceId() ?? ''): void {
    const key = this.draftKey(instanceId, requestId);
    if (reason && (reason !== 'decided' || !this.answering.has(key))) this.receiptStore.closed(requestId, reason, instanceId);
    this.inputRequiredTexts.delete(key);
    this.inputRequiredScopes.delete(key);
    this.modifyPanelOpen.delete(key);
    this.modifyInputTexts.delete(key);
    this.secretCardDrafts.clear(key);
    this.eventBus.dismissInputRequired(instanceId, requestId);
    this.drafts.get(instanceId)?.clear(requestId);
    clearResponseError(this.responseErrors, key);
    this.pendingRequests.update(requests => requests.filter(r => r.id !== requestId || r.instanceId !== instanceId));
  }

  private requestClosed(request: UserActionRequest): boolean {
    const reason = this.resolutions.get(this.draftKey(request.instanceId, request.id));
    return reason !== undefined && reason !== 'decided';
  }

  dismissReceipt(receiptId: string): void {
    this.receiptStore.dismiss(receiptId);
  }

  ngOnDestroy(): void {
    this.registry.replace(this, []);
    this.unsubscribeInputRequiredResolved?.();
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
        const serverRequests = (response.data as UserActionRequest[]).filter(request => !this.closedGenerations.has(requestGeneration(request)));
        serverRequests.forEach((request) => this.receiptStore.shown(request));
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
      .filter((request) => !this.instanceStore.getInstance(instanceId)?.yoloMode || !shouldClearInputRequiredForYolo(request))
      .filter((request) => !this.closedGenerations.has(requestGeneration(request)));
  }

  /** Forgets cached requests; `closedBecause` also leaves each a receipt (YOLO only for approvals). */
  private clearCachedInputRequiredForInstance(
    instanceId: string,
    shouldClear: (request: UserActionRequest) => boolean = () => true,
    closedBecause?: RequestOutcomeReason,
  ): void {
    // The bus may already have dropped these (a status change clears it first), so the cards last mirrored count too.
    const known = new Map<string, InputRequiredEvent>();
    for (const event of [...this.retainedInputRequired, ...this.eventBus.pendingInputRequired()]) {
      if (event.instanceId === instanceId) known.set(event.requestId, event);
    }
    for (const event of known.values()) {
      const request = toInputRequiredRequest(event);
      if (!shouldClear(request)) continue;
      if (closedBecause && !this.answering.has(this.draftKey(instanceId, request.id)) && (closedBecause !== 'auto_approved' || isApproval(request))) this.receiptStore.closed(request.id, closedBecause, request.instanceId);
      this.draftsFor(instanceId).clear(request.id);
    }
    this.eventBus.clearInputRequired(instanceId, (request) => shouldClear(toInputRequiredRequest(request)));
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key < '1' || event.key > '9' || event.metaKey || event.ctrlKey || event.altKey) return;
    // A digit typed into the message box (or any field) is text, not a choice.
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
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
    return this.inputRequiredScopes.get(this.draftKey(typeof request === 'string' ? this.instanceId() : request.instanceId, requestId)) || defaultInputRequiredScope(metadata);
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
    return JSON.stringify([instanceId ?? '', requestId]);
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

  /** Submit answers for an ask_questions request: { "Question text": "Answer text" }. */
  async onSubmitAnswers(request: UserActionRequest): Promise<ReplyOutcome> {
    if (!this.draftsFor(request.instanceId).canSubmit(request)) return 'failed';
    const answers: Record<string, string> = {};
    (request.questions || []).forEach((question, index) => {
      answers[question] = this.draftsFor(request.instanceId).text(request.id, index);
    });
    return this.sendAnswers(request, JSON.stringify(answers));
  }

  /**
   * Compile the chosen options/text into a readable answer and send it back to
   * the CLI through the standard input_required response path.
   */
  async onSubmitAskUserQuestion(request: UserActionRequest): Promise<ReplyOutcome> {
    const reply = this.draftsFor(request.instanceId).canSubmit(request) ? this.draftsFor(request.instanceId).responseText(request) : '';
    return reply ? this.sendAnswers(request, reply) : 'failed';
  }

  /** Sends the compiled answers; the drafts are kept if it fails, so nothing typed is lost. */
  private async sendAnswers(request: UserActionRequest, reply: string): Promise<ReplyOutcome> {
    const outcome = await this.respond(request, true, reply, undefined, { kind: 'answered', answer: this.draftsFor(request.instanceId).summary(request) });
    if (outcome === 'sent') this.draftsFor(request.instanceId).clear(request.id);
    return outcome;
  }

  /**
   * Dismiss an AskUserQuestion without choosing. Sends a brief note back to the
   * CLI so the turn isn't left waiting on input indefinitely.
   */
  async onSkipAskUserQuestion(request: UserActionRequest): Promise<void> {
    const skipReply = isAcpInputRequired(request) ? 'cancel' : 'No preference — please proceed with your own recommendation.';
    if (await this.respond(request, true, skipReply, undefined, { kind: 'skipped' }) === 'sent') this.draftsFor(request.instanceId).clear(request.id);
  }

  protected readonly questionHint = 'You can also type your answer in the message box below.';

  /** Registers one waiting question with the message box, which answers the oldest first. */
  private questionHandle(request: UserActionRequest): QuestionCardHandle {
    return {
      requestId: request.id,
      instanceId: request.instanceId,
      createdAt: request.createdAt,
      answer: (text) => this.answerFromMessageBox(request, text),
    };
  }

  private async answerFromMessageBox(request: UserActionRequest, text: string): Promise<QuestionOfferResult> {
    if (this.answering.has(this.draftKey(request.instanceId, request.id))) return 'busy'; // a button on the card is already sending a reply
    let outcome: ReplyOutcome;
    if (questionSlots(request)) {
      const applied = this.draftsFor(request.instanceId).apply(request, text);
      if (!applied) return 'not-applicable';
      if (!applied.complete) return 'partial';
      outcome = await (request.requestType === 'ask_questions' ? this.onSubmitAnswers(request) : this.onSubmitAskUserQuestion(request));
    } else {
      // A choice card takes the id of the option the text names, else the text itself.
      const wanted = normaliseChoice(text);
      const option = request.options?.find((candidate) => [candidate.label, candidate.id].some((name) => normaliseChoice(name) === wanted));
      outcome = await this.respond(request, true, option?.id ?? text);
    }
    return outcome === 'sent' ? 'answered' : outcome === 'stale' ? 'not-applicable' : 'failed';
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
        this.receiptStore.chose(request.id, { kind: 'auto-approve' }, request.instanceId);
        this.clearCachedInputRequiredForInstance(
          request.instanceId,
          (cachedRequest) => shouldClearRequestAfterYoloEnabled(cachedRequest, request.instanceId),
          'auto_approved',
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

    // Keep the typed text if the reply fails, so a retry still has something to send.
    if (await this.respond(request, true, responseText) === 'sent') this.inputRequiredTexts.delete(this.draftKey(request.instanceId, request.id));
  }

  readonly isSecretRequest = isSecretRequest;

  onSecretValueChange(requestId: string, event: Event): void {
    this.secretCardDrafts.set(this.draftKey(this.instanceId(), requestId), (event.target as HTMLInputElement).value);
  }

  hasSecretValue(requestId: string): boolean {
    return this.secretCardDrafts.has(this.draftKey(this.instanceId(), requestId));
  }

  secretCardValue(requestId: string): string {
    return this.secretCardDrafts.value(this.draftKey(this.instanceId(), requestId));
  }

  secretCardWarning(request: UserActionRequest): string | null {
    return this.secretCardDrafts.warning({ ...request, id: this.draftKey(request.instanceId, request.id) });
  }

  async onSubmitSecretCard(request: UserActionRequest): Promise<void> {
    const value = this.secretCardDrafts.take(this.draftKey(request.instanceId, request.id));
    if (!value.trim()) return;
    await this.finishSecretCard(request, () => submitSecretCardDraft(this.ipc, request, value), 'The secret could not be saved.', 'saved');
  }

  async onDeclineSecretCard(request: UserActionRequest): Promise<void> {
    this.secretCardDrafts.clear(this.draftKey(request.instanceId, request.id));
    await this.finishSecretCard(request, () => declineSecretCardDraft(this.ipc, request), 'The decline could not be recorded.', 'declined');
  }

  private async finishSecretCard(
    request: UserActionRequest,
    submit: () => Promise<{ success: boolean; error?: { message: string } }>,
    fallback: string,
    kind: 'saved' | 'declined',
  ): Promise<void> {
    this.isResponding.set(true);
    this.answering.add(this.draftKey(request.instanceId, request.id));
    clearResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id));
    try {
      const result = await submit();
      if (result.success) {
        this.receiptStore.chose(request.id, { kind, what: request.secretRequest?.label || request.title }, request.instanceId);
        this.eventBus.dismissInputRequired(request.instanceId, request.id);
        this.pendingRequests.update((requests) => requests.filter((r) => r.id !== request.id || r.instanceId !== request.instanceId));
      } else {
        setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), responseErrorMessage(result, fallback));
      }
    } catch (error) {
      setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), errorMessage(error, fallback));
    } finally {
      this.answering.delete(this.draftKey(request.instanceId, request.id));
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
    this.answering.add(this.draftKey(request.instanceId, request.id));
    clearResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id));
    try {
      const meta = request.permissionMetadata;
      const permissionKey =
        meta?.action && meta?.path ? `${meta.action}:${meta.path}` : undefined;
      const decisionScope = this.getInputRequiredScope(request);
      const ipcMetadata: Record<string, unknown> = {
        type: 'deferred_permission',
        tool_use_id: meta?.tool_use_id,
      };

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

      if (this.requestClosed(request)) return;
      if (!result.success && isInputRequiredNotPending(result)) {
        this.dropInputRequiredCard(request.id, undefined, request.instanceId);
        return;
      }
      if (result.success) {
        // Clean up local state
        this.receiptStore.chose(request.id, choiceFor(request, { approved: true, scope: decisionScope }), request.instanceId);
        this.modifyInputTexts.delete(this.draftKey(request.instanceId, request.id));
        this.modifyPanelOpen.delete(this.draftKey(request.instanceId, request.id));
        const errors = new Map(this.modifyInputErrors());
        errors.delete(this.draftKey(request.instanceId, request.id));
        this.modifyInputErrors.set(errors);
        this.inputRequiredScopes.delete(this.draftKey(request.instanceId, request.id));
        this.eventBus.dismissInputRequired(request.instanceId, request.id);
        this.pendingRequests.update((requests) =>
          requests.filter((r) => r.id !== request.id || r.instanceId !== request.instanceId)
        );
        if (!this.resolutions.has(this.draftKey(request.instanceId, request.id))) this.instanceStore.decrementPendingApproval(request.instanceId);
      } else setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), responseErrorMessage(result, 'Failed to submit your decision.'));
    } catch (error) {
      setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), errorMessage(error, 'Failed to submit your decision.'));
    } finally {
      this.answering.delete(this.draftKey(request.instanceId, request.id));
      this.isResponding.set(false);
    }
  }

  /** `receipt` overrides the line left behind when the reply succeeds (otherwise it is worked out from the card). */
  private async respond(
    request: UserActionRequest,
    approved: boolean,
    selectedOption?: string,
    metadataExtras?: Record<string, unknown>,
    receipt?: UserChoice,
  ): Promise<ReplyOutcome> {
    this.isResponding.set(true);
    this.answering.add(this.draftKey(request.instanceId, request.id));
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
            return 'failed';
          }

          const result = await respondToQuestion(this.ipc, request, inputText, receipt);
          if (this.requestClosed(request)) return 'stale';

          if (!result.success && isInputRequiredNotPending(result)) {
            // Already settled elsewhere (timeout, auto-approve); the resolved
            // event handles the pending count.
            this.dropInputRequiredCard(request.id, undefined, request.instanceId);
            return 'stale';
          }
          if (result.success) {
            this.receiptStore.chose(request.id, receipt ?? choiceFor(request, { approved, reply: inputText }), request.instanceId);
            this.inputRequiredTexts.delete(this.draftKey(request.instanceId, request.id));
            this.eventBus.dismissInputRequired(request.instanceId, request.id);
            this.pendingRequests.update((requests) =>
              requests.filter((r) => r.id !== request.id || r.instanceId !== request.instanceId)
            );
            if (!this.resolutions.has(this.draftKey(request.instanceId, request.id))) this.instanceStore.decrementPendingApproval(request.instanceId);
            return 'sent';
          }
          if (this.resolutions.get(this.draftKey(request.instanceId, request.id)) === 'decided') this.receiptStore.closed(request.id, 'decided', request.instanceId);
          setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), responseErrorMessage(result, 'Failed to submit your response.'));
          return 'failed';
        }

        let response: string;
        const meta = request.permissionMetadata;
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
        } else {
          response = 'Permission denied. Please do not perform that operation.';
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

        if (this.requestClosed(request)) return 'stale';
        if (!result.success && isInputRequiredNotPending(result)) {
          this.dropInputRequiredCard(request.id, undefined, request.instanceId);
          return 'stale';
        }
        if (result.success) {
          const resultData = result.data as { yoloMode?: boolean; granted?: boolean } | undefined;
          this.inputRequiredScopes.delete(this.draftKey(request.instanceId, request.id));
          const acknowledgedOnly = rejectLabelFor(meta, this.getInputRequiredScope(request)) === 'OK';
          if (resultData?.granted !== false) this.receiptStore.chose(request.id, resultData?.yoloMode === true ? { kind: 'auto-approve' }
            : receipt ?? choiceFor(request, { approved, scope: decisionScope, acknowledgedOnly }), request.instanceId);
          if (resultData?.yoloMode === true) {
            this.instanceStore.setLocalYoloMode(request.instanceId, true);
            this.clearCachedInputRequiredForInstance(
              request.instanceId,
              (cachedRequest) => shouldClearRequestAfterYoloEnabled(cachedRequest, request.instanceId),
              'auto_approved',
            );
            this.pendingRequests.update((requests) =>
              requests.filter((r) => !shouldClearRequestAfterYoloEnabled(r, request.instanceId))
            );
            this.instanceStore.clearPendingApprovals(request.instanceId);
          } else {
            this.eventBus.dismissInputRequired(request.instanceId, request.id);
            this.pendingRequests.update((requests) =>
              requests.filter((r) => r.id !== request.id || r.instanceId !== request.instanceId)
            );
            if (!this.resolutions.has(this.draftKey(request.instanceId, request.id))) this.instanceStore.decrementPendingApproval(request.instanceId);
          }
          return 'sent';
        }
        setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), responseErrorMessage(result, 'Failed to submit your decision.'));
        return 'failed';
      }

      // Handle orchestrator user action requests
      const response = await this.ipc.respondToUserAction(
        request.id,
        approved,
        selectedOption
      );

      if (this.requestClosed(request)) return 'stale';
      if (!response.success && isInputRequiredNotPending(response)) {
        this.dropInputRequiredCard(request.id, undefined, request.instanceId);
        return 'stale';
      }
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
        this.receiptStore.chose(request.id, receipt ?? choiceFor(request, { approved, reply: selectedOption }), request.instanceId);
        this.pendingRequests.update((requests) =>
          requests.filter((r) => r.id !== request.id || r.instanceId !== request.instanceId)
        );
        return 'sent';
      }
      setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), responseErrorMessage(response, 'Failed to submit your decision.'));
      return 'failed';
    } catch (error) {
      console.error('Failed to respond to user action request:', error);
      setResponseError(this.responseErrors, this.draftKey(request.instanceId, request.id), errorMessage(error, 'Failed to submit your decision.'));
      return 'failed';
    } finally {
      this.answering.delete(this.draftKey(request.instanceId, request.id));
      this.isResponding.set(false);
    }
  }
}
