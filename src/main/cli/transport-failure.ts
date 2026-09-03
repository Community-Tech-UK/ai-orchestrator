/**
 * Detecting provider *transport* failures that masquerade as model output.
 *
 * A CLI that cannot reach its backend does not always throw. `cursor-agent`
 * (and every other CLI that wraps its transport in a retry client) prints the
 * failure as assistant text and reports the turn as a normal completion:
 *
 *   `Error: RetriableError: [unavailable] getaddrinfo ENOTFOUND agentn.global.api5.cursor.sh`
 *
 * Two distinct shapes have been observed, and they need different detectors:
 *
 * 1. **The whole turn is the error.** The CLI never got a token out.
 *    {@link isTransportFailureOnlyOutput} matches this: short, opening with an
 *    error prefix, naming a transport-layer failure. The loop coordinator uses
 *    it (with a no-work requirement) to avoid counting an outage as an
 *    iteration — see `orchestration/loop-transport-failure-output.ts`.
 *
 * 2. **The error is appended to a real turn.** The stream is severed partway
 *    through, so the model's partial work is followed by the transport error as
 *    the last line. {@link findTrailingTransportFailure} matches this. Observed
 *    2026-09-03: a 36-minute cursor ACP turn full of tool calls and edits ended
 *    `\n\nError: RetriableError: [canceled] http/2 stream closed with error code
 *    CANCEL (0x8)`. The agent reported `stopReason: 'end_turn'` and the app
 *    recorded a clean `busy → idle`, so a truncated reply was indistinguishable
 *    from a finished one. Shape 1 cannot catch this: the output was 2876 chars
 *    of real work, so both the length ceiling and the error-opening test reject
 *    it.
 *
 * Sibling of `provider-notice.ts`, which covers the other masquerade:
 * usage/limit notices printed as assistant output.
 */

/**
 * Longest output still considered "nothing but a transport error". A real turn
 * that genuinely discusses a network failure carries analysis with it and runs
 * far longer than this.
 */
export const MAX_TRANSPORT_FAILURE_OUTPUT_CHARS = 600;

/**
 * Longest *final line* still considered a transport error appended to a real
 * turn. A CLI appends a bare error string; a model that ends a paragraph
 * discussing an error writes prose well past this.
 */
export const MAX_TRANSPORT_FAILURE_TAIL_CHARS = 300;

/**
 * The text must OPEN like an error report. This is what keeps a genuine turn
 * ("I fixed the ECONNREFUSED retry path") from being mistaken for an outage.
 */
const ERROR_OPENING = /^[\s\W]{0,4}(?:error|fatal|request failed|api error|stream error|connection error|failed to connect)\b/i;

/**
 * Markers that say "something failed" without saying anything about the
 * network: the name of an error class, and the bracketed gRPC status tags.
 * They are real evidence when the WHOLE turn is the error — nothing else is
 * present to go on — but they are excluded from
 * {@link TRANSPORT_EVIDENCE_PATTERNS}, so that for the trailing detector a
 * status tag can never serve as its own corroboration.
 */
const STRUCTURAL_FAILURE_MARKERS: readonly RegExp[] = [
  /\bRetriableError\b/i,
  /\[canceled\]/i,
  /\[unavailable\]/i,
];

/**
 * Transport evidence proper: errnos, syscalls and network phrases. Disjoint
 * from {@link STRUCTURAL_FAILURE_MARKERS} by construction, so "something
 * failed" and "the network is why" are two genuinely independent signals.
 *
 * All four failures observed in the wild from `cursor-agent` over a three-day
 * window (34 events across 8 instances) carry evidence from THIS list, not just
 * a status tag: `stream closed with error code` (the CANCEL variant),
 * `PING timed out`, `EHOSTUNREACH`, and `getaddrinfo` / `ENOTFOUND`.
 */
const TRANSPORT_EVIDENCE_PATTERNS: readonly RegExp[] = [
  /\bgetaddrinfo\b/i,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bEPIPE\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETUNREACH\b/,
  /\bENETDOWN\b/,
  /\bsocket hang up\b/i,
  /\bfetch failed\b/i,
  /\bnetwork (?:error|is unreachable|unreachable)\b/i,
  /\bconnection reset by peer\b/i,
  /\bconnection (?:reset|refused|closed|aborted|timed out)\b/i,
  /\bstream closed with error code\b/i,
  /\bPING timed out\b/i,
  /\bupstream connect error\b/i,
  /\bTLS handshake\b/i,
  /\b(?:bad gateway|service unavailable|gateway timeout)\b/i,
];

/**
 * Every transport/network-layer failure marker. Used by
 * {@link isTransportFailureOnlyOutput}, whose caller has already established
 * that the turn did no work at all — with that much context a status tag alone
 * is enough, so the structural markers are in scope there.
 */
export const TRANSPORT_FAILURE_PATTERNS: readonly RegExp[] = [
  ...STRUCTURAL_FAILURE_MARKERS,
  ...TRANSPORT_EVIDENCE_PATTERNS,
];

/**
 * A gRPC-style status tag: `[canceled]`, `[unavailable]`, `[internal]`.
 *
 * Requiring one is what makes {@link findTrailingTransportFailure} tractable.
 * Five review rounds were spent trying to tell a serialized error from prose
 * *about* a serialized error using looser structure — an error-shaped opening,
 * then an error-class label, then a label with a trailing colon. Each was
 * defeated, finally by an ordinary two-clause sentence
 * (`Error: RetriableError: fixed the connection reset detection bug.`), because
 * an error class in label position is exactly how a developer writes about an
 * error class. A bracketed lowercase status tag is not: it is emitted by a
 * transport serializer and is not a thing prose contains.
 *
 * Every failure observed in the wild carries one, so this costs no real
 * coverage — see {@link TRANSPORT_EVIDENCE_PATTERNS}.
 */
const STATUS_TAG = /\[[a-z_]{3,}\]/g;

/**
 * Words that appear when a human is narrating and never when a transport
 * serializer is reporting. Purely a veto: it can only ever suppress a
 * detection, so its failure mode is the silence we already have, never a wrong
 * banner on a finished turn.
 *
 * None of the four observed failures contains any of these — a serialized
 * status detail is a noun phrase (`read EHOSTUNREACH`, `PING timed out`), with
 * no articles, pronouns or past-tense verbs.
 */
const NARRATIVE_MARKER =
  /\b(?:the|an?|this|that|these|those|it|its|we|our|you|your|i|my|now|already|still|instead|because|but|when|while|was|were|is|are|be|been|being|fixed|fix|adds?|added|removes?|removed|renamed?|changed?|updates?|updated|landed|resolved|reverted|refactored|caused|replaced|suppressed|introduced|handling|should|would|could)\b/i;

/**
 * How many plain lowercase words may trail the transport evidence.
 *
 * A serialized error stops at its evidence, carrying only codes and hostnames
 * afterwards (`CANCEL (0x8)`, `agentn.global.api5.cursor.sh`) or a single
 * qualifier (`TLS handshake failure`). Prose keeps going in English
 * (`socket hang up noted post-deploy`, `ECONNRESET during nightly restart`).
 *
 * Fixed idioms that trail their own evidence — `connection reset by peer` — are
 * matched whole by {@link TRANSPORT_EVIDENCE_PATTERNS} instead of being bought
 * with a looser bound here, which is what lets this stay at one.
 */
const MAX_TRAILING_PROSE_WORDS = 1;

/** End index of the last transport-evidence match in `detail`, or -1. */
function lastEvidenceEnd(detail: string): number {
  let end = -1;
  for (const pattern of TRANSPORT_EVIDENCE_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (let m = global.exec(detail); m !== null; m = global.exec(detail)) {
      end = Math.max(end, m.index + m[0].length);
      if (m[0].length === 0) break;
    }
  }
  return end;
}

/**
 * True when descriptive English continues past the evidence — the shape of a
 * model writing ABOUT errnos rather than a serializer reporting one. Codes,
 * numbers, and dotted tokens (hostnames, paths, ratios) are not prose.
 */
function trailsIntoProse(detail: string, evidenceEnd: number): boolean {
  let words = 0;
  for (const token of detail.slice(evidenceEnd).split(/\s+/)) {
    // Sentence-final punctuation must go BEFORE the dotted-token test, or the
    // full stop ending an ordinary sentence reads as a hostname and buys the
    // sentence a free word (`ECONNRESET during nightly restart.`).
    // Normalise unicode dashes to ASCII FIRST. The strip below is ASCII-only,
    // so an en/em dash would be deleted rather than treated as a boundary,
    // silently merging two words into one token.
    const normalised = token.replace(/[\u2010-\u2015\u2212]/g, '-');
    const cleaned = normalised.replace(/[^A-Za-z0-9./:_-]/g, '').replace(/[.:_-]+$/, '');
    if (!cleaned) continue;
    // Dotted/colon-bearing tokens are hostnames, paths, ports or ratios. Tested
    // before the hyphen split so `my-host.example.com` stays one exempt token.
    if (/[./:]/.test(cleaned)) continue;
    // Hyphens and underscores join words. Without splitting them,
    // `logged-during-rollout` is three words of prose counted as one and rides
    // under the budget — with no bound at all on how many words a single
    // joined token can smuggle past.
    for (const part of cleaned.split(/[-_]/)) {
      if (!part) continue;
      if (/\d/.test(part)) continue;
      if (part === part.toUpperCase()) continue;
      if (++words > MAX_TRAILING_PROSE_WORDS) return true;
    }
  }
  return false;
}

/**
 * Index just past the LAST status tag in `text`, or -1 when there is none.
 * Splitting on the last tag means the returned detail can never contain a tag,
 * so a tag can never serve as its own transport evidence.
 */
function lastStatusTagEnd(text: string): number {
  let end = -1;
  STATUS_TAG.lastIndex = 0;
  for (let m = STATUS_TAG.exec(text); m !== null; m = STATUS_TAG.exec(text)) {
    end = m.index + m[0].length;
  }
  STATUS_TAG.lastIndex = 0;
  return end;
}

/** True when `text` reads like a transport-layer error report. */
function isTransportFailureText(text: string): boolean {
  if (!ERROR_OPENING.test(text)) return false;
  return TRANSPORT_FAILURE_PATTERNS.some((re) => re.test(text));
}

/**
 * True when an iteration's whole output is a provider transport failure rather
 * than a model turn. Callers must additionally require that the turn changed no
 * files and made no tool calls before treating it as degraded.
 */
export function isTransportFailureOnlyOutput(output: string | null | undefined): boolean {
  if (!output) return false;
  const text = output.trim();
  if (!text || text.length > MAX_TRANSPORT_FAILURE_OUTPUT_CHARS) return false;
  return isTransportFailureText(text);
}

/**
 * The transport error a turn *ended* on, or null when it ended normally.
 *
 * Only the final non-empty line is considered, and it must be a serialized
 * status chain — `Error: <Class>: [status] <detail>` — with the transport
 * evidence in the detail after the last {@link STATUS_TAG}, and no
 * {@link NARRATIVE_MARKER} anywhere in that detail. Unlike
 * {@link isTransportFailureOnlyOutput} this says nothing about the rest of the
 * turn: the preceding work is real and should be kept. It means only that the
 * reply is *truncated*.
 *
 * Biased hard toward precision, because a miss costs only the silence we have
 * today. It is NOT a guarantee: this is text classification, and six review
 * rounds each produced a new false-positive shape (overlapping evidence, an
 * error class in label position, two-clause prose, a deny-list gap). The
 * residual risk is a closing line carrying a status tag, real transport
 * evidence, no narrative word, and at most one word after the evidence, e.g.
 *
 *   `Error: [internal] ECONNRESET yesterday`
 *
 * The consequence is deliberately sized for that: the caller emits an
 * informational note, not an error, and does not assert that the turn was
 * truncated — see `adapters/acp-transport-failure.ts`. Do not add a
 * higher-consequence action here without a stronger signal than text.
 *
 * Known shapes it will miss:
 *
 * - any error without a bracketed status tag (`Error: socket hang up`,
 *   `Error: TransportError: connection reset by peer`);
 * - an error whose only transport signal IS the status tag
 *   (`Error: RetriableError: [unavailable] something we have not seen`);
 * - an error appended with no line break (`…the files.Error: RetriableError: …`);
 * - an error wrapped across two lines by the CLI;
 * - a detail that happens to contain a narrative word, including inside a
 *   hostname (`my-host.internal` reads as narration because of `my`);
 * - a detail with more than {@link MAX_TRAILING_PROSE_WORDS} plain words after
 *   the evidence, counting words joined by a hyphen, underscore or unicode
 *   dash separately — so an undotted joined token like `read-timeout` reads as
 *   two words and is missed.
 *
 * Widen only against a real captured instance, never on speculation — five
 * review rounds of speculative widening produced five false-positive classes.
 */
export function findTrailingTransportFailure(output: string | null | undefined): string | null {
  if (!output) return null;
  const text = output.trimEnd();
  if (!text) return null;

  const lastBreak = text.lastIndexOf('\n');
  const tail = (lastBreak === -1 ? text : text.slice(lastBreak + 1)).trim();
  if (!tail || tail.length > MAX_TRANSPORT_FAILURE_TAIL_CHARS) return null;
  if (!ERROR_OPENING.test(tail)) return null;

  const detailStart = lastStatusTagEnd(tail);
  if (detailStart === -1) return null;

  const detail = tail.slice(detailStart);
  if (NARRATIVE_MARKER.test(detail)) return null;

  const evidenceEnd = lastEvidenceEnd(detail);
  if (evidenceEnd === -1) return null;
  if (trailsIntoProse(detail, evidenceEnd)) return null;

  return tail;
}
