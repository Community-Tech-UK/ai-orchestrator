/**
 * Browser Email Code Reader — reads a one-time verification/2FA code from the
 * agent's shared mailbox (james@communitytech.co.uk) during an unattended
 * signup/login flow.
 *
 * CRITICAL CONSTRAINT: there is no plus-addressing on the shared inbox — every
 * message arrives at the same address — so a message cannot be disambiguated
 * by a per-site recipient tag. Instead we disambiguate by:
 *  - sender domain (an allowlist derived from the campaign's origin set), and
 *  - a recency window anchored to when the signup/login flow was started.
 *
 * Fully injectable (`MailboxReader`) so this unit-tests against an in-memory
 * fake with no real IMAP connection and no real mailbox. A production adapter
 * over the existing imap MCP or a node imap client is wired in later, out of
 * scope for this module.
 *
 * Never logs message bodies or extracted codes — both are one-time secrets.
 */

export interface MailboxMessage {
  id: string;
  /** Sender email address (or a `Name <email>` header value). */
  from: string;
  subject: string;
  textBody: string;
  receivedAt: number;
}

export interface MailboxSearchCriteria {
  sinceMs: number;
  limit?: number;
}

/** Reads mailbox messages. Injected so tests supply an in-memory fake. */
export interface MailboxReader {
  /** Returns matching messages, newest-first. */
  search(criteria: MailboxSearchCriteria): Promise<MailboxMessage[]>;
}

export interface EmailCodeRequest {
  /** Allowlist of sender domains for this campaign's origin set (suffix-matched). */
  expectedSenderDomains: string[];
  /** Only consider messages received at or after this time. */
  sinceMs: number;
  /** Recency window: the message must have arrived within this many ms of `now`. */
  withinMs: number;
  /** Override "now" for deterministic tests. Default: `Date.now()`. */
  now?: number;
}

export interface EmailCodeResult {
  code: string;
  messageId: string;
  matchedSender: string;
}

export class EmailCodeReaderError extends Error {
  constructor(
    message: string,
    readonly code: 'no_matching_message' | 'code_not_found',
  ) {
    super(message);
    this.name = 'EmailCodeReaderError';
  }
}

export interface BrowserEmailCodeReaderOptions {
  reader: MailboxReader;
  now?: () => number;
}

export class BrowserEmailCodeReader {
  private readonly reader: MailboxReader;
  private readonly now: () => number;

  constructor(options: BrowserEmailCodeReaderOptions) {
    this.reader = options.reader;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Find the newest recent message from an expected sender domain and pull a
   * verification code out of it.
   */
  async fetchCode(request: EmailCodeRequest): Promise<EmailCodeResult> {
    const now = request.now ?? this.now();
    const windowStart = Math.max(request.sinceMs, now - request.withinMs);
    const allowedDomains = request.expectedSenderDomains.map((domain) => domain.toLowerCase());

    const messages = await this.reader.search({ sinceMs: request.sinceMs });
    const candidates = messages.filter(
      (message) =>
        message.receivedAt >= windowStart &&
        message.receivedAt <= now &&
        matchesAllowedDomain(message.from, allowedDomains),
    );

    if (candidates.length === 0) {
      throw new EmailCodeReaderError(
        'No message from an expected sender domain arrived within the recency window',
        'no_matching_message',
      );
    }

    const newest = candidates.reduce((latest, candidate) =>
      candidate.receivedAt > latest.receivedAt ? candidate : latest,
    );

    const code = extractVerificationCode(newest.subject, newest.textBody);
    if (!code) {
      throw new EmailCodeReaderError(
        `Matched message ${newest.id} but could not extract a verification code from it`,
        'code_not_found',
      );
    }

    return { code, messageId: newest.id, matchedSender: newest.from };
  }
}

function matchesAllowedDomain(from: string, allowedDomains: string[]): boolean {
  const domain = domainOf(from);
  if (!domain) {
    return false;
  }
  return allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

function domainOf(from: string): string | null {
  const angleMatch = from.match(/<([^>]+)>/);
  const address = (angleMatch ? angleMatch[1] : from).trim();
  const at = address.lastIndexOf('@');
  if (at === -1 || at === address.length - 1) {
    return null;
  }
  return address.slice(at + 1).toLowerCase();
}

// --- Code extraction -------------------------------------------------------
//
// Priority ladder, applied to the subject first and then the body:
//   1. A 4-8 digit run adjacent to a keyword ('code', 'otp', 'verification',
//      'one-time', 'pin', 'security', 'confirmation', 'passcode').
//   2. A 6-8 char alphanumeric token (mixed letters + digits) adjacent to a
//      keyword.
//   3. A 4-8 digit run standing alone on its own line (no keyword needed).
//   4. A 6-8 char mixed alphanumeric token standing alone on its own line.
//
// "Adjacent" is deliberately narrow (a short run of whitespace/punctuation and
// at most one linking verb) so that an unrelated year or other number
// mentioned in the same sentence as a keyword — but separated by ordinary
// prose — is not swept up as a code. Digit runs are always word-boundary
// bounded, so a code embedded inside a longer contiguous phone number never
// matches part of that number.

const CODE_KEYWORDS = '(?:one-time|verification|security|confirmation|passcode|otp|pin|code)s?';
/** Narrow "glue" between a keyword and a code: punctuation/whitespace plus at most one linking verb. */
const GAP = '[\\s:]{0,3}(?:is|was|are)?[\\s:=-]{0,3}';

const KEYWORD_THEN_DIGITS = new RegExp(`\\b${CODE_KEYWORDS}\\b${GAP}(\\d{4,8})\\b`, 'i');
const DIGITS_THEN_KEYWORD = new RegExp(`\\b(\\d{4,8})\\b${GAP}${CODE_KEYWORDS}\\b`, 'i');
const KEYWORD_THEN_ALNUM = new RegExp(`\\b${CODE_KEYWORDS}\\b${GAP}([A-Za-z0-9]{6,8})\\b`, 'i');
const ALNUM_THEN_KEYWORD = new RegExp(`\\b([A-Za-z0-9]{6,8})\\b${GAP}${CODE_KEYWORDS}\\b`, 'i');

/** Pure helper: extract a verification code from a subject/body pair, or null. */
export function extractVerificationCode(subject: string, body: string): string | null {
  for (const text of [subject, body]) {
    const found = extractFromText(text);
    if (found) {
      return found;
    }
  }
  return null;
}

function extractFromText(text: string): string | null {
  if (!text) {
    return null;
  }
  return (
    KEYWORD_THEN_DIGITS.exec(text)?.[1] ??
    DIGITS_THEN_KEYWORD.exec(text)?.[1] ??
    findMixedAlnum(KEYWORD_THEN_ALNUM.exec(text)) ??
    findMixedAlnum(ALNUM_THEN_KEYWORD.exec(text)) ??
    findStandaloneLine(text, /^\d{4,8}$/) ??
    findStandaloneMixedAlnumLine(text) ??
    null
  );
}

function findMixedAlnum(match: RegExpExecArray | null): string | null {
  const candidate = match?.[1];
  return candidate && isMixedAlnum(candidate) ? candidate : null;
}

function isMixedAlnum(value: string): boolean {
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

function findStandaloneLine(text: string, pattern: RegExp): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (pattern.test(line)) {
      return line;
    }
  }
  return null;
}

function findStandaloneMixedAlnumLine(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^[A-Za-z0-9]{6,8}$/.test(line) && isMixedAlnum(line)) {
      return line;
    }
  }
  return null;
}
