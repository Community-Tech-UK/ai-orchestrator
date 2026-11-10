/**
 * Provenance for input that Harness itself authored and delivered to an agent
 * (LT-657). Such input rides the provider's user-input transport because most
 * CLIs have no other way to start a turn, but it is never the end user's
 * message: it is stored as `type: 'system'` with `metadata.internalInput`, is
 * excluded from prompt history, and is wrapped for the provider so the model
 * cannot attribute it to the user.
 *
 * Input that the user wrote and Harness merely delivers later (scheduled
 * automation prompts, provider-limit re-sends of the user's own prompt) is not
 * internal and must not use this.
 */
export type InternalInputSource =
  | 'global-pause-note'
  | 'global-pause-resume'
  | 'context-policy'
  | 'async-work-continuation'
  | 'announce-then-halt-continuation'
  | 'waiting-check-in'
  | 'crash-turn-continuation'
  | 'reasoning-collapse-continuation'
  | 'content-filter-continuation'
  | 'orchestrator-status-request'
  | 'child-announcement'
  | 'lsp-feedback'
  | 'compaction-continuity'
  | 'plan-queue'
  | 'reaction'
  | 'browser-gateway'
  | 'provider-limit-resume'
  | 'orchestrator-response'
  | 'parent-agent-message';

export interface InternalInputMetadata {
  actor: 'harness';
  source: InternalInputSource;
}

/**
 * Marks words a person typed or spoke themselves, in Harness or on the phone.
 * It is separate from `automatedInput` (which only says a send was not a fresh
 * submission, for example a queued message being drained) and from
 * `InternalInputMetadata` (text Harness wrote). Text built by the app from an
 * agent's words (a review or diff packet, a question-card answer) never carries
 * it, even when the person clicks to send it, and neither does steering a
 * running turn. A stored message without it, including every older one, counts
 * as not typed by a person. It is the only thing that lets an `@session` chip
 * in a message grant read access to that session, and it is used to decide
 * whether a session may land Plan Queue work without a passing check
 * (docs/plans/2026-11-04-pq-b1-land-anyway_plan.md).
 */
export interface PersonInputOrigin {
  kind: 'person';
  /** When the person typed it, in epoch ms; for a message that waited in a queue this is before it was sent. */
  typedAt: number;
}
