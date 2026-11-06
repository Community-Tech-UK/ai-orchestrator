/**
 * Who a system message is for, and how serious it is.
 *
 * The transcript used to hide two interrupt notices by matching their exact
 * wording. A notice hidden that way cannot be inspected later, and rewording it
 * made it reappear. Instead the code that emits a notice says once whether it is
 * routine (`metadata.audience`), and everything that displays the transcript
 * reads that flag. A message with no flag is `attention`, so nothing is hidden or
 * folded by accident: a notice only goes quiet when its emit site asked for it.
 *
 * `severity` is the other half of the contract: a folded row shows the most
 * serious severity among its events, so a "resume failed" inside a fold is still
 * visible from the collapsed row.
 *
 * Only system messages carry an audience. Every other message type is always
 * `attention`, so a stray flag on an assistant reply or a tool result is inert.
 */

export type SystemMessageAudience = 'routine' | 'attention';
export type SystemMessageSeverity = 'info' | 'warning' | 'error';

/**
 * A system message the transcript shows in a purpose-built shape instead of as a
 * notice. `request-receipt` is the quiet one-line record left after the user
 * answers a request (`metadata.presentationKind`, with `metadata.requestId`).
 */
export type SystemMessagePresentationKind = 'request-receipt';

/** Spread into a system message's `metadata` at the emit site of a routine notice. */
export const ROUTINE_AUDIENCE_METADATA = { audience: 'routine' } as const satisfies {
  audience: SystemMessageAudience;
};

export function isSystemMessageAudience(value: unknown): value is SystemMessageAudience {
  return value === 'routine' || value === 'attention';
}

export function isSystemMessageSeverity(value: unknown): value is SystemMessageSeverity {
  return value === 'info' || value === 'warning' || value === 'error';
}

export function isSystemMessagePresentationKind(value: unknown): value is SystemMessagePresentationKind {
  return value === 'request-receipt';
}

/**
 * The metadata a system message should travel with: its own when it already names
 * an audience, otherwise an explicit `attention`. Writing the default down means a
 * reader that sees no flag at all knows the message predates the flag (an old
 * archive or an older worker) rather than that nobody decided. The readers below
 * still treat a missing flag as `attention`, so old transcripts display as before.
 * Other message types and an existing audience are returned untouched.
 */
export function withExplicitAudience(
  messageType: string | undefined,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (messageType !== 'system' || isSystemMessageAudience(metadata?.['audience'])) return metadata;
  return { ...metadata, audience: 'attention' satisfies SystemMessageAudience };
}

/** The two fields this module reads, so main and renderer `OutputMessage` types both fit. */
export interface AudienceCarrier {
  type: string;
  metadata?: Record<string, unknown>;
}

const SEVERITY_RANK: Readonly<Record<SystemMessageSeverity, number>> = {
  info: 0,
  warning: 1,
  error: 2,
};

/** `routine` only for a system message carrying exactly `audience: 'routine'`; otherwise `attention`. */
export function resolveSystemMessageAudience(message: AudienceCarrier): SystemMessageAudience {
  if (message.type !== 'system') return 'attention';
  return message.metadata?.['audience'] === 'routine' ? 'routine' : 'attention';
}

/** The declared severity, `error` for an error message, otherwise `info`. */
export function resolveSystemMessageSeverity(message: AudienceCarrier): SystemMessageSeverity {
  if (message.type === 'error') return 'error';
  const declared = message.metadata?.['severity'];
  return isSystemMessageSeverity(declared) ? declared : 'info';
}

/** The most serious severity in a list (`info` for an empty list). */
export function worstSystemMessageSeverity(messages: readonly AudienceCarrier[]): SystemMessageSeverity {
  let worst: SystemMessageSeverity = 'info';
  for (const message of messages) {
    const severity = resolveSystemMessageSeverity(message);
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[worst]) worst = severity;
  }
  return worst;
}
