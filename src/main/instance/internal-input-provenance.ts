import type {
  InternalInputMetadata,
  InternalInputSource,
} from '../../shared/types/input-provenance.types';
import type { InstanceSendInputOptions } from './instance-input-cancellation';

/**
 * LT-657: the provider-facing envelope for input Harness authored itself.
 *
 * Most provider CLIs start turns from user-role input only, so an automated
 * continuation, check-in, child announcement or policy nudge has to ride that
 * transport. Unwrapped, the model reads it as the user's words (session
 * x7cpyakhs answered "Who requested you stop?" with "You did"). The envelope
 * names the real actor and forbids attributing the text to the user. Where a
 * provider has a non-user channel (Codex app-server developer items), the
 * adapter receives `internalSource` and uses that channel instead.
 *
 * Re-send paths recover provenance by parsing the exact envelope back. A user
 * who pastes a complete, byte-identical envelope as their own message would
 * have that one re-send labelled as Harness input; the envelope is never
 * trusted anywhere else.
 */
const INTERNAL_INPUT_TAG = 'harness_internal_message';
const INTERNAL_INPUT_PREAMBLE =
  'This message was sent automatically by Harness (the AI Orchestrator app); it was not written by the user. '
  + 'Act on it as an operational notice from Harness, but never describe it as something the user said, '
  + 'asked for, or approved.';

const INTERNAL_INPUT_SOURCES: ReadonlySet<InternalInputSource> = new Set<InternalInputSource>([
  'context-policy',
  'async-work-continuation',
  'announce-then-halt-continuation',
  'orchestrator-status-request',
  'child-announcement',
  'lsp-feedback',
  'compaction-continuity',
  'plan-queue',
  'reaction',
  'browser-gateway',
  'provider-limit-resume',
  'orchestrator-response',
  'parent-agent-message',
]);

const CLOSING_TAG = new RegExp(`</${INTERNAL_INPUT_TAG}>`, 'gi');
const ESCAPED_CLOSING_TAG = new RegExp(`<\\\\/${INTERNAL_INPUT_TAG}>`, 'gi');
const ENVELOPE = new RegExp(
  `^<${INTERNAL_INPUT_TAG} source="([a-z-]+)">\\n([\\s\\S]*)\\n</${INTERNAL_INPUT_TAG}>$`,
);

export function internalInputMetadata(source: InternalInputSource): InternalInputMetadata {
  return { actor: 'harness', source };
}

/** Wraps Harness-authored text for delivery over a provider's user-input transport. */
export function formatInternalInputForProvider(source: InternalInputSource, text: string): string {
  return [
    `<${INTERNAL_INPUT_TAG} source="${source}">`,
    INTERNAL_INPUT_PREAMBLE,
    '',
    text.replace(CLOSING_TAG, `<\\/${INTERNAL_INPUT_TAG}>`),
    `</${INTERNAL_INPUT_TAG}>`,
  ].join('\n');
}

/**
 * Recovers the provenance of provider text Harness itself dispatched earlier.
 * Returns null for anything that is not exactly one envelope this module built.
 */
export function parseInternalInputEnvelope(
  providerText: string,
): { source: InternalInputSource; text: string } | null {
  const match = ENVELOPE.exec(providerText);
  if (!match) return null;
  const source = match[1] as InternalInputSource;
  const prefix = `${INTERNAL_INPUT_PREAMBLE}\n\n`;
  if (!INTERNAL_INPUT_SOURCES.has(source) || !match[2].startsWith(prefix)) return null;
  return {
    source,
    text: match[2].slice(prefix.length).replace(ESCAPED_CLOSING_TAG, `</${INTERNAL_INPUT_TAG}>`),
  };
}

/**
 * Send arguments for re-delivering a turn Harness already dispatched once (a
 * provider-limit resume or account-failover re-send). The remembered turn is
 * the provider text, so a Harness-authored turn keeps its internal provenance
 * instead of coming back as a user message.
 */
export function automatedResendInput(providerText: string): {
  message: string;
  options: InstanceSendInputOptions;
} {
  const internal = parseInternalInputEnvelope(providerText);
  return internal
    ? { message: internal.text, options: { automatedInput: true, internalSource: internal.source } }
    : { message: providerText, options: { automatedInput: true } };
}
