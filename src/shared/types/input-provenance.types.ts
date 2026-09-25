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
  | 'context-policy'
  | 'async-work-continuation'
  | 'announce-then-halt-continuation'
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
