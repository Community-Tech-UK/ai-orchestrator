/**
 * The grey one-line receipts left when a question or approval card closes.
 * Before this a closed card was deleted with no trace, so "did that go through?"
 * had no answer. App-wide rather than per card, so a receipt survives the card
 * being rebuilt and is the same wherever the session is shown.
 */

import { Injectable, OnDestroy, signal } from '@angular/core';
import {
  describeRequestOutcome,
  describeUserChoice,
  previewAnswer,
  type RequestOutcomeReason,
  type UserChoice,
} from '../../../../shared/utils/request-outcome';
import { readRequestReceipt, type ReceiptCarrier } from '../../../../shared/utils/request-receipt-message';
import type { UserActionRequest } from './user-action-request.types';
import { isApproval, toolNameOf } from './user-input-request.kinds';

export interface RequestReceipt {
  /** Unique per receipt, so a reused request id still gets its own line. */
  id: string;
  requestId: string;
  instanceId: string;
  text: string;
  subject?: string;
  expiresAt: number;
  requestedAt?: number;
}

export const RECEIPT_LIFETIME_MS = 10 * 60_000;
const KEEP_PER_SESSION = 3;
const REMEMBER_REQUESTS = 200;
const keyOf = (instanceId: string, requestId: string): string => JSON.stringify([instanceId, requestId]);
const generationOf = (instanceId: string, requestId: string, requestedAt: number): string => JSON.stringify([instanceId, requestId, requestedAt]);

interface KnownRequest {
  request: UserActionRequest;
  shownAt: number;
}

export interface CardDecision {
  approved: boolean;
  /** What went to the agent: typed text, or the id of the option picked. */
  reply?: string;
  scope?: 'once' | 'session' | 'always';
  /** The only button was an acknowledgement ("OK"), not a yes or a no. */
  acknowledgedOnly?: boolean;
}

/** What the person did with a card, in the terms a receipt speaks. */
export function choiceFor(request: UserActionRequest, decision: CardDecision): UserChoice {
  const { approved, reply = '' } = decision;
  const tool = toolNameOf(request);
  if (request.requestType === 'select_option') {
    if (isApproval(request)) {
      const scope = reply.endsWith('_always') ? 'always' : reply.endsWith('_session') ? 'session' : 'once';
      return reply.startsWith('allow_') ? { kind: 'allowed', scope, tool } : { kind: 'denied', tool };
    }
    const option = request.options?.find((candidate) => candidate.id === reply);
    return option ? { kind: 'chose', label: option.label } : { kind: 'answered', answer: reply };
  }
  if (request.requestType === 'approve_action' || request.requestType === 'confirm' || request.requestType === 'switch_mode') {
    return approved ? { kind: 'approved', what: request.title } : { kind: 'declined', what: request.title };
  }
  if (!isApproval(request)) return approved ? { kind: 'answered', answer: reply } : { kind: 'skipped' };
  if (!approved) return decision.acknowledgedOnly ? { kind: 'dismissed', tool } : { kind: 'denied', tool };
  // A typed reply in an ACP permission box is quoted rather than interpreted.
  if (request.permissionMetadata?.type === 'acp_permission_request') return { kind: 'answered', answer: reply };
  return { kind: 'allowed', scope: decision.scope ?? 'once', tool };
}

@Injectable({ providedIn: 'root' })
export class RequestReceiptStore implements OnDestroy {
  /** Newest first. */
  private readonly receipts = signal<readonly RequestReceipt[]>([]);
  private readonly known = new Map<string, KnownRequest>();
  private readonly settled = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private sequence = 0;

  forSession(instanceId: string | null | undefined): RequestReceipt[] {
    return instanceId ? this.receipts().filter((receipt) => receipt.instanceId === instanceId) : [];
  }

  /** Replays of the same request must not reopen its feedback or reset its clock. */
  shown(request: UserActionRequest): void {
    const key = keyOf(request.instanceId, request.id);
    if (this.known.get(key)?.request.createdAt === request.createdAt) return;
    this.known.set(key, { request, shownAt: Date.now() });
    if (this.known.size > REMEMBER_REQUESTS) this.known.delete(this.known.keys().next().value as string);
  }

  chose(requestId: string, choice: UserChoice, instanceId: string): void {
    this.settle(instanceId, requestId, () => describeUserChoice(choice));
  }

  closed(requestId: string, reason: RequestOutcomeReason, instanceId: string): void {
    this.settle(instanceId, requestId, ({ request, shownAt }) => describeRequestOutcome(reason, {
      permission: isApproval(request),
      waitedMs: Date.now() - shownAt,
      tool: previewAnswer(toolNameOf(request) ?? '') || undefined,
    }));
  }

  /** Main's history row supersedes local feedback, even if it arrives before the reply acknowledgement. */
  observeHistory(instanceId: string, messages: readonly ReceiptCarrier[]): void {
    for (const message of messages) {
      const receipt = readRequestReceipt(message);
      if (!receipt) continue;
      const requestedAt = receipt.requestedAt ?? this.known.get(keyOf(instanceId, receipt.requestId))?.request.createdAt;
      if (requestedAt === undefined) continue;
      this.remember(generationOf(instanceId, receipt.requestId, requestedAt));
      for (const local of this.receipts()) {
        if (local.instanceId === instanceId && local.requestId === receipt.requestId && local.requestedAt === requestedAt) this.dismiss(local.id);
      }
    }
  }

  dismiss(receiptId: string): void {
    clearTimeout(this.timers.get(receiptId));
    this.timers.delete(receiptId);
    this.receipts.update((list) => list.filter((receipt) => receipt.id !== receiptId));
  }

  ngOnDestroy(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }

  private settle(instanceId: string, requestId: string, words: (entry: KnownRequest) => { text: string; subject?: string }): void {
    const entry = this.known.get(keyOf(instanceId, requestId));
    if (!entry) return;
    const generation = generationOf(instanceId, requestId, entry.request.createdAt);
    if (this.settled.has(generation)) return;
    this.remember(generation);
    const receipt: RequestReceipt = {
      id: `${generation}#${++this.sequence}`,
      requestId,
      requestedAt: entry.request.createdAt,
      instanceId: entry.request.instanceId,
      ...words(entry),
      expiresAt: Date.now() + RECEIPT_LIFETIME_MS,
    };
    this.receipts.update((list) => this.trimmed([receipt, ...list]));
    this.timers.set(receipt.id, setTimeout(() => this.dismiss(receipt.id), RECEIPT_LIFETIME_MS));
  }

  private remember(generation: string): void {
    this.settled.add(generation);
    if (this.settled.size > REMEMBER_REQUESTS) this.settled.delete(this.settled.values().next().value as string);
  }

  private trimmed(list: RequestReceipt[]): RequestReceipt[] {
    const perSession = new Map<string, number>();
    return list.filter((receipt) => {
      const count = (perSession.get(receipt.instanceId) ?? 0) + 1;
      perSession.set(receipt.instanceId, count);
      if (count <= KEEP_PER_SESSION) return true;
      clearTimeout(this.timers.get(receipt.id));
      this.timers.delete(receipt.id);
      return false;
    });
  }
}
