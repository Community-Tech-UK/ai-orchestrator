/**
 * Leaves a short, calm line in the session history when a question or approval
 * closes: what the person chose, or why it ended without them.
 *
 * The window used to keep these as three grey lines that vanished after ten
 * minutes and only existed where the card had been on screen. Main sees every
 * way a request can end (the person's reply, a timeout, an answer from another
 * screen, a stopped turn, a closed session), so it writes the line once, into
 * the history, where every screen and every later replay finds it.
 *
 * Rules this keeps:
 * - Each request gets at most one line; whichever ending reaches here first wins.
 * - The words come from what main itself applied or observed. A permission is
 *   only ever worded from the decision main acted on, never from text a window
 *   supplied, and a failed "always allow" says nothing at all.
 * - A secret is named by its label. Its value never reaches this class.
 * - The line is a system message. It is never sent to the model.
 */

import { getLogger } from '../logging/logger';
import type { SettledUserAction, UserActionEnd } from '../orchestration/user-action-lifecycle';
import type { UserActionRequest } from '../orchestration/orchestration-handler.types';
import { resolveClaudeAllowRuleTool } from '../../shared/permissions/claude-allow-rule-tools';
import {
  isApprovalRequest,
  isAutoHandledByYolo,
  requestToolName,
  type RequestShape,
} from '../../shared/utils/input-request-types';
import {
  describeRequestOutcome,
  describeUserChoice,
  outcomeReasonForStatus,
  previewAnswer,
  statusClearsOpenRequests,
  type RequestOutcomeReason,
  type RequestReceiptWords,
  type UserChoice,
} from '../../shared/utils/request-outcome';
import {
  buildRequestReceiptMetadata,
  type RequestReceiptMetadata,
  type RequestReceiptOutcome,
} from '../../shared/utils/request-receipt-message';

const logger = getLogger('InputRequestReceipts');

/** How many closed requests are remembered, so a late echo of an old ending is not written again. */
const REMEMBER_CLOSED = 200;

export interface InputRequestReceiptHost {
  /** Writes the line into the session's history as a system message. */
  writeReceipt(instanceId: string, content: string, metadata: RequestReceiptMetadata): void;
  isYoloOn(instanceId: string): boolean;
}

/** A question or approval main handed to a window. */
export interface ObservedInputRequired {
  instanceId: string;
  requestId: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

/** What main did with the person's reply to a request from a CLI. */
export interface NativeReply {
  /** The text that went to the agent. */
  response: string;
  /** The permission decision main applied, when the reply was one. */
  decision?: { action: 'allow' | 'deny' | 'modify'; scope?: 'once' | 'session' | 'always' };
  /** For "always allow" of a tool the CLI refused: whether the rule was really saved. */
  grant?: 'saved' | 'failed';
  /** The reply switched auto-approve on. */
  enabledYolo?: boolean;
  /** The person's own account of a question's answer. Used only to word a question, never an approval. */
  receipt?: { kind: 'answered' | 'skipped'; summary?: string };
}

/** A reply being applied. Exactly one of `commit` and `abort` should follow. */
export interface InFlightReply {
  commit(reply: NativeReply): boolean;
  abort(): void;
}

interface OpenRequest {
  instanceId: string;
  requestId: string;
  shape: RequestShape;
  /** A secret's label, or its name when it has none. */
  secretLabel?: string;
  shownAt: number;
  requestedAt: number;
}

const keyOf = (instanceId: string, requestId: string): string => JSON.stringify([instanceId, requestId]);

function stringField(metadata: Record<string, unknown>, name: string): string {
  const value = metadata[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** What the person chose in a CLI's request, or null when main applied nothing it could name. */
function choiceForNativeReply(request: OpenRequest, reply: NativeReply): UserChoice | null {
  if (reply.enabledYolo) return { kind: 'auto-approve' };
  const type = request.shape.permissionMetadata?.type ?? '';
  if (type === 'secret_required') return null;
  const tool = requestToolName(request.shape);
  switch (type) {
    case 'permission_denial':
      if (reply.decision?.action === 'allow' && reply.decision.scope === 'always') {
        return reply.grant === 'saved' ? { kind: 'allowed', scope: 'always', tool } : null;
      }
      // With no rule to add, the only button is "OK": that acknowledges, it does not refuse.
      return resolveClaudeAllowRuleTool(tool) ? { kind: 'denied', tool } : { kind: 'dismissed', tool };
    case 'deferred_permission':
    case 'codex_mcp_approval':
      if (!reply.decision) return null;
      return reply.decision.action === 'deny'
        ? { kind: 'denied', tool }
        : { kind: 'allowed', scope: reply.decision.scope ?? 'once', tool };
    case 'acp_permission_request':
      return reply.response === 'cancel' ? { kind: 'denied', tool } : { kind: 'answered', answer: reply.response };
    default:
      return reply.receipt?.kind === 'skipped'
        ? { kind: 'skipped' }
        : { kind: 'answered', answer: reply.receipt?.summary || reply.response };
  }
}

/** Several answers sent as `{"Question": "Answer"}` read as the answers alone. */
function answersOnly(selected: string | undefined): string {
  const text = selected ?? '';
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.values(parsed).filter((value) => typeof value === 'string' && value).join('; ');
    }
  } catch {
    // Not JSON: it was a plain answer.
  }
  return text;
}

/** What the person chose in one of the model's own cards, from what main applied. */
function choiceForUserAction(request: UserActionRequest, end: Extract<UserActionEnd, { reason: 'decided' }>): UserChoice {
  const { approved, selectedOption } = end;
  switch (request.requestType) {
    case 'secret_required': {
      const what = request.secretRequest?.label || request.secretRequest?.name || request.title;
      return approved ? { kind: 'saved', what } : { kind: 'declined', what };
    }
    case 'select_option': {
      if (isApprovalRequest(request)) {
        const id = selectedOption ?? '';
        const scope = id.endsWith('_always') ? 'always' : id.endsWith('_session') ? 'session' : 'once';
        const tool = requestToolName(request);
        return id.startsWith('allow_') ? { kind: 'allowed', scope, tool } : { kind: 'denied', tool };
      }
      const option = request.options?.find((candidate) => candidate.id === selectedOption);
      if (option) return { kind: 'chose', label: option.label };
      return selectedOption ? { kind: 'answered', answer: selectedOption } : { kind: 'skipped' };
    }
    case 'approve_action':
    case 'confirm':
    case 'switch_mode':
      return approved ? { kind: 'approved', what: request.title } : { kind: 'declined', what: request.title };
    default:
      return approved ? { kind: 'answered', answer: answersOnly(selectedOption) } : { kind: 'skipped' };
  }
}

export class InputRequestReceiptRecorder {
  private readonly open = new Map<string, OpenRequest>();
  /** Replies being applied, and whether an adapter already echoed "decided" for them. */
  private readonly inFlight = new Map<string, { decidedEchoed: boolean }>();
  private readonly closed = new Map<string, number>();

  private localResolution?: (instanceId: string, requestId: string) => void;
  constructor(private readonly host: InputRequestReceiptHost) {}

  /** The binder forwards successful local replies over the existing resolution channel. */
  setLocalResolutionHandler(handler?: (instanceId: string, requestId: string) => void): void {
    this.localResolution = handler;
  }

  /** A CLI's request reached a window. Anything the window hides under YOLO is not tracked. */
  observeInputRequired(request: ObservedInputRequired): void {
    const metadata = request.metadata ?? {};
    const isSecret = metadata['type'] === 'secret_required';
    const shape: RequestShape = {
      requestType: isSecret ? 'secret_required' : 'input_required',
      permissionMetadata: metadata as RequestShape['permissionMetadata'],
    };
    if (this.host.isYoloOn(request.instanceId) && isAutoHandledByYolo(shape)) return;
    const key = keyOf(request.instanceId, request.requestId);
    // Adapters reuse request ids; one that already closed is a new request now.
    if (request.timestamp !== undefined && this.closed.get(key) === request.timestamp) return;
    const existing = this.open.get(key);
    if (existing && (request.timestamp === undefined || existing.requestedAt === request.timestamp)) return;
    this.closed.delete(key);
    const now = Date.now();
    this.open.set(key, {
      instanceId: request.instanceId,
      requestId: request.requestId,
      shape,
      secretLabel: isSecret ? stringField(metadata, 'label') || stringField(metadata, 'name') : undefined,
      shownAt: now,
      requestedAt: request.timestamp ?? now,
    });
  }

  /**
   * Call before applying the person's reply. Holding the request open here is
   * what lets an adapter's "decided" echo of that same reply be recognised
   * rather than reported as an answer from somewhere else.
   */
  beginReply(instanceId: string, requestId: string): InFlightReply {
    const key = keyOf(instanceId, requestId);
    const observed = this.open.get(key);
    if (!observed) throw Object.assign(new Error('That request has already closed, so nothing was sent.'), { code: 'INPUT_REQUIRED_NOT_PENDING' });
    if (observed.secretLabel !== undefined || observed.shape.requestType === 'secret_required') throw Object.assign(new Error('Use the secure secret card to answer this request.'), { code: 'SECRET_CARD_REQUIRES_DEDICATED_CHANNEL' });
    if (this.inFlight.has(key)) throw Object.assign(new Error('A reply to that request is already being sent.'), { code: 'INPUT_REQUIRED_REPLY_IN_FLIGHT' });
    const flight = { decidedEchoed: false };
    this.inFlight.set(key, flight);
    return {
      commit: (reply) => {
        const request = this.open.get(key);
        if (request !== observed || this.inFlight.get(key) !== flight) return false;
        const choice = choiceForNativeReply(request, reply);
        if (choice) this.finish(key, request, describeUserChoice(choice), choice.kind);
        else this.finishQuietly(key);
        if (!flight.decidedEchoed) this.localResolution?.(instanceId, requestId);
        return true;
      },
      abort: () => {
        if (this.inFlight.get(key) !== flight) return;
        this.inFlight.delete(key);
        const request = this.open.get(key);
        if (flight.decidedEchoed && request === observed) this.closeWithReason(key, request, 'decided');
      },
    };
  }

  /** An adapter said a request ended without a reply from this window. */
  inputResolved(event: { instanceId: string; requestId: string; reason: RequestOutcomeReason }): void {
    const key = keyOf(event.instanceId, event.requestId);
    const request = this.open.get(key);
    if (!request) return;
    const flight = this.inFlight.get(key);
    if (flight && event.reason === 'decided') {
      flight.decidedEchoed = true;
      return;
    }
    this.closeWithReason(key, request, event.reason);
  }

  /** An orchestrator card ended. Everything needed to word it is in the event. */
  userActionSettled({ request, waitedMs, end }: SettledUserAction): void {
    const key = keyOf(request.instanceId, request.id);
    if (this.closed.get(key) === request.createdAt) return;
    const subject = request.secretRequest?.label || requestToolName(request) || request.title;
    let words: RequestReceiptWords;
    let outcome: RequestReceiptOutcome;
    if (end.reason === 'decided' && end.via !== 'elsewhere') {
      const choice = choiceForUserAction(request, end);
      words = describeUserChoice(choice);
      outcome = choice.kind;
    } else {
      words = describeRequestOutcome(end.reason, {
        permission: isApprovalRequest(request),
        waitedMs,
        tool: previewAnswer(subject ?? '') || undefined,
      });
      outcome = end.reason;
    }
    this.remember(key, request.createdAt);
    this.write(request.instanceId, request.id, words, outcome, request.createdAt);
  }

  /** A secret card from a CLI was saved or declined. Only its label is ever said. */
  secretHandled(event: { instanceId: string; requestId: string; outcome: 'saved' | 'declined' }): void {
    const key = keyOf(event.instanceId, event.requestId);
    const request = this.open.get(key);
    if (!request) return;
    const what = request.secretLabel || 'a secret';
    this.finish(key, request, describeUserChoice({ kind: event.outcome, what }), event.outcome);
    this.localResolution?.(event.instanceId, event.requestId);
  }

  /** The session's status changed; some statuses mean an open request can no longer be answered. */
  statusChanged(instanceId: string, status: string): void {
    if (!statusClearsOpenRequests(status)) return;
    const reason = outcomeReasonForStatus(status);
    for (const [key, request] of this.open) {
      if (request.instanceId === instanceId && !this.inFlight.has(key)) this.closeWithReason(key, request, reason);
    }
  }

  /** Auto-approve was switched on: the window clears approvals it would now allow by itself. */
  yoloEnabled(instanceId: string): void {
    for (const [key, request] of this.open) {
      if (request.instanceId !== instanceId || this.inFlight.has(key) || !isAutoHandledByYolo(request.shape)) continue;
      if (isApprovalRequest(request.shape)) this.closeWithReason(key, request, 'auto_approved');
      else this.finishQuietly(key);
    }
  }

  forgetInstance(instanceId: string): void {
    for (const [key, request] of this.open) {
      if (request.instanceId === instanceId) {
        this.open.delete(key);
        this.inFlight.delete(key);
      }
    }
  }

  private closeWithReason(key: string, request: OpenRequest, reason: RequestOutcomeReason): void {
    const words = describeRequestOutcome(reason, {
      permission: isApprovalRequest(request.shape),
      waitedMs: Date.now() - request.shownAt,
      tool: previewAnswer(requestToolName(request.shape) ?? '') || undefined,
    });
    this.finish(key, request, words, reason);
  }

  private finish(key: string, request: OpenRequest, words: RequestReceiptWords, outcome: RequestReceiptOutcome): void {
    this.finishQuietly(key);
    this.write(request.instanceId, request.requestId, words, outcome, request.requestedAt);
  }

  private finishQuietly(key: string): void {
    const requestedAt = this.open.get(key)?.requestedAt ?? Date.now();
    this.open.delete(key);
    this.inFlight.delete(key);
    this.remember(key, requestedAt);
  }

  private remember(key: string, requestedAt: number): void {
    this.closed.set(key, requestedAt);
    if (this.closed.size > REMEMBER_CLOSED) this.closed.delete(this.closed.keys().next().value as string);
  }

  private write(
    instanceId: string,
    requestId: string,
    words: RequestReceiptWords,
    outcome: RequestReceiptOutcome,
    requestedAt: number,
  ): void {
    try {
      this.host.writeReceipt(
        instanceId,
        words.text,
        buildRequestReceiptMetadata({ requestId, outcome, subject: words.subject, requestedAt }),
      );
    } catch (error) {
      // A receipt is a courtesy; failing to write one must never break answering a request.
      logger.warn('Could not write a request receipt', {
        instanceId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
