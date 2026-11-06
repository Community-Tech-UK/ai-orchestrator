/**
 * The line a question or approval leaves in the session history when it closes.
 *
 * Main writes it as an ordinary system message (so it is saved, replayed and
 * shown on every screen) and marks it with the metadata below. The screen that
 * draws the transcript reads the same metadata to give it a row of its own,
 * instead of folding it in with routine notices. The text is already the final
 * words; nothing here is ever sent to the model.
 */

import type { RequestOutcomeReason, UserChoice } from './request-outcome';

export const REQUEST_RECEIPT_KIND = 'request-receipt' as const;

/** What happened: the person's own choice, or why the request closed without them. */
export type RequestReceiptOutcome = UserChoice['kind'] | RequestOutcomeReason;

export interface RequestReceiptMetadata {
  /** Always `attention`, so a receipt is never folded away with routine notices. */
  audience: 'attention';
  presentationKind: typeof REQUEST_RECEIPT_KIND;
  /** Identifies the request this closes. One receipt per request. */
  requestId: string;
  outcome: RequestReceiptOutcome;
  /** The tool the request was about, when there was one. */
  subject?: string;
  /** When the request arrived (epoch ms). Separates two requests that reuse an id. */
  requestedAt?: number;
}

export function buildRequestReceiptMetadata(input: {
  requestId: string;
  outcome: RequestReceiptOutcome;
  subject?: string;
  requestedAt?: number;
}): RequestReceiptMetadata {
  const subject = input.subject?.trim();
  return {
    audience: 'attention',
    presentationKind: REQUEST_RECEIPT_KIND,
    requestId: input.requestId,
    outcome: input.outcome,
    ...(subject ? { subject } : {}),
    ...(input.requestedAt === undefined ? {} : { requestedAt: input.requestedAt }),
  };
}

export interface RequestReceiptView {
  requestId: string;
  text: string;
  outcome?: RequestReceiptOutcome;
  subject?: string;
  requestedAt?: number;
}

/** The two fields read from a message, so main and renderer `OutputMessage` types both fit. */
export interface ReceiptCarrier {
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/** The receipt a message carries, or null when it is anything else. */
export function readRequestReceipt(message: ReceiptCarrier): RequestReceiptView | null {
  if (message.type !== 'system') return null;
  const metadata = message.metadata;
  if (metadata?.['presentationKind'] !== REQUEST_RECEIPT_KIND) return null;
  const requestId = metadata['requestId'];
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  const outcome = metadata['outcome'];
  const subject = metadata['subject'];
  const requestedAt = metadata['requestedAt'];
  return {
    requestId,
    text: message.content,
    ...(typeof outcome === 'string' ? { outcome: outcome as RequestReceiptOutcome } : {}),
    ...(typeof subject === 'string' && subject ? { subject } : {}),
    ...(typeof requestedAt === 'number' ? { requestedAt } : {}),
  };
}
