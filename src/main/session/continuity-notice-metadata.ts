/**
 * The presentation facts a system notice keeps across a restore.
 *
 * The continuity projection used to keep a system message's text and nothing else,
 * so after a crash restore a folded routine notice came back as a full-size
 * attention row, a request receipt as a loud notice, and an error without its
 * plain-language details. Those facts live in `metadata`, which the continuity
 * boundary deliberately does not copy wholesale: it is arbitrary provider data and
 * can hold anything. This module is the whitelist. Each field below is read from a
 * named key, checked against a closed vocabulary or bounded, and written back under
 * the same name. Nothing else crosses, and the same checks run again on the way
 * back out, so a hand-edited or corrupt saved entry cannot put other keys onto a
 * restored message.
 *
 * Secrets: `errorPresentation.rawDetail` is provider text, so it is redacted before
 * it is saved. The headline and advice are redacted too, since the check costs
 * nothing. Redaction runs before the length cap, so a cut can never leave half a
 * credential behind.
 *
 * Stability: reading a restored message must give back exactly what was saved
 * (`hasCompleteCheckpoint` compares the two as JSON), so the key order is fixed
 * and every step here is idempotent. The same holds across the transport: a notice
 * saves identically whether it is the adapter's original or the copy that went
 * through `toProviderOutputEvent`, which is why the default audience is not saved.
 *
 * Limits: an `error` message restores as a `system` message (a continuity entry has
 * no error role). Its severity is kept as `error` so it still reads as one.
 */

import type { ErrorCategory, PresentedError } from '../../shared/present-error';
import { REQUEST_RECEIPT_KIND, type RequestReceiptOutcome } from '../../shared/utils/request-receipt-message';
import type { OutputMessage } from '../../shared/types/instance.types';
import {
  isSystemMessagePresentationKind,
  isSystemMessageSeverity,
  type SystemMessageSeverity,
} from '../../shared/utils/system-message-audience';
import { redactSecrets } from '../security/secret-detector';
import type { ContinuityNoticeMetadata } from './session-continuity.types';

const MAX_REQUEST_ID_CHARS = 200;
const MAX_RECEIPT_SUBJECT_CHARS = 200;
const RECEIPT_OUTCOMES = {
  allowed: true, denied: true, dismissed: true, answered: true, skipped: true,
  chose: true, approved: true, declined: true, saved: true, 'auto-approve': true,
  timeout: true, auto_approved: true, decided: true, cancelled: true, exited: true,
} as const satisfies Readonly<Record<RequestReceiptOutcome, true>>;
const MAX_PRESENTATION_TEXT_CHARS = 1_000;
const MAX_RAW_DETAIL_CHARS = 8_000;

/** Typed as a record so adding an `ErrorCategory` without adding it here fails to compile. */
const ERROR_CATEGORIES: Readonly<Record<ErrorCategory, true>> = {
  quota: true,
  auth: true,
  network: true,
  'provider-crash': true,
  concurrency: true,
  'tool-server': true,
  cancelled: true,
  unknown: true,
};

const ERROR_ACTIONS: Readonly<Record<NonNullable<PresentedError['action']>, true>> = {
  retry: true,
  'switch-account': true,
  'sign-in': true,
};

/**
 * Credential shapes that show up in provider error text beyond the token prefixes
 * the secret detector knows. A value has to be long and opaque to count, so a word
 * after "token:" (as in "Invalid token: expired") is left alone.
 */
const CREDENTIAL_SHAPES: readonly (readonly [RegExp, string])[] = [
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED]'],
  [/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|token)\s*[=:]\s*["']?)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED:api_key]'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMember<T extends string>(table: Readonly<Record<T, true>>, value: unknown): value is T {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(table, value);
}

/** Redact, then cap. A text at the cap is returned as it is, so applying this twice changes nothing more. */
function savedText(text: string, maxChars: number): string {
  let safe = redactSecrets(text);
  for (const [pattern, replacement] of CREDENTIAL_SHAPES) safe = safe.replace(pattern, replacement);
  return safe.length <= maxChars ? safe : `${safe.slice(0, maxChars - 1)}…`;
}

/** An id is kept whole or not at all: a shortened id would point at the wrong request. */
function savedId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id && id.length <= MAX_REQUEST_ID_CHARS && savedText(id, MAX_REQUEST_ID_CHARS) === id ? id : undefined;
}

function savedErrorPresentation(value: unknown): PresentedError | undefined {
  if (!isRecord(value)) return undefined;
  const { category, headline, whatToDo, action, rawDetail } = value;
  if (!isMember(ERROR_CATEGORIES, category) || typeof headline !== 'string' || typeof whatToDo !== 'string') return undefined;
  return {
    category,
    headline: savedText(headline, MAX_PRESENTATION_TEXT_CHARS),
    whatToDo: savedText(whatToDo, MAX_PRESENTATION_TEXT_CHARS),
    ...(isMember(ERROR_ACTIONS, action) ? { action } : {}),
    rawDetail: savedText(typeof rawDetail === 'string' ? rawDetail : '', MAX_RAW_DETAIL_CHARS),
  };
}

/**
 * Keep only the whitelisted fields of `source`, which is message metadata or a saved
 * notice. `forcedSeverity` overrides whatever the source declares.
 */
function savedNotice(source: object | undefined, forcedSeverity?: SystemMessageSeverity): ContinuityNoticeMetadata | undefined {
  const fields = (source ?? {}) as Record<string, unknown>;
  const { audience, severity, presentationKind } = fields;
  const requestId = savedId(fields['requestId']);
  const receipt = presentationKind === REQUEST_RECEIPT_KIND;
  const outcome = fields['outcome'];
  const subject = fields['subject'];
  const requestedAt = fields['requestedAt'];
  const errorPresentation = savedErrorPresentation(fields['errorPresentation']);
  const keptSeverity = forcedSeverity ?? (isSystemMessageSeverity(severity) ? severity : undefined);
  const notice: ContinuityNoticeMetadata = {
    // Outside receipts, only `routine` is saved. `attention` is what a message with no audience already
    // reads as, and the transport writes it onto the event copy of a system message
    // while the live buffer keeps the original, so saving it would make the saved
    // transcript differ from the live one for every ordinary notice.
    ...(audience === 'routine' ? { audience } : receipt ? { audience: 'attention' as const } : {}),
    ...(keptSeverity ? { severity: keptSeverity } : {}),
    ...(isSystemMessagePresentationKind(presentationKind) ? { presentationKind } : {}),
    ...(requestId ? { requestId } : {}),
    ...(receipt && isMember(RECEIPT_OUTCOMES, outcome) ? { outcome } : {}),
    ...(receipt && typeof subject === 'string' && subject.trim()
      ? { subject: savedText(subject.trim(), MAX_RECEIPT_SUBJECT_CHARS) } : {}),
    ...(receipt && typeof requestedAt === 'number' && Number.isSafeInteger(requestedAt) && requestedAt >= 0 && requestedAt <= 8.64e15
      ? { requestedAt } : {}),
    ...(fields['resumeFailed'] === true ? { resumeFailed: true as const } : {}),
    ...(errorPresentation ? { errorPresentation } : {}),
  };
  return Object.keys(notice).length > 0 ? notice : undefined;
}

/**
 * The facts to save for a message that is stored with the system role (a `system`
 * or an `error` message). Undefined when it carries none, which is every notice
 * written before these were kept.
 *
 * An `error` message always reads as severity `error` (see
 * `resolveSystemMessageSeverity`), whatever it declares, so that is what is saved:
 * the restored `system` message then resolves to the same severity as the original.
 */
export function readNoticeMetadata(message: Pick<OutputMessage, 'type' | 'metadata'>): ContinuityNoticeMetadata | undefined {
  return savedNotice(message.metadata, message.type === 'error' ? 'error' : undefined);
}

/** The metadata keys a restored message gets back for a saved notice. Empty for none. */
export function noticeToMetadata(notice: ContinuityNoticeMetadata | undefined): Record<string, unknown> {
  return { ...savedNotice(notice) };
}
