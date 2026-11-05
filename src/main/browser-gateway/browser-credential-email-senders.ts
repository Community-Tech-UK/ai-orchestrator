import { getDomain } from 'tldts';
import {
  EmailCodeReaderError,
  MailboxReaderError,
  type BrowserEmailCodeReader,
} from './browser-email-code-reader';
import { getLogger } from '../logging/logger';

/**
 * Email-code sender scoping and mailbox read for `fill_credential`'s
 * `email_code` fields. Split out of browser-form-fill-operations with the fill
 * targeting logic (browser-credential-fill-targeting) to keep the fill loop
 * readable.
 */

const logger = getLogger('BrowserCredentialEmailCode');

const DEFAULT_EMAIL_CODE_WINDOW_MS = 15 * 60 * 1000;

// allowPrivateDomains: platform suffixes (github.io, netlify.app, …) are
// boundaries too — two tenants of one platform are unrelated parties.
const PSL_OPTIONS = { allowPrivateDomains: true };

/**
 * Validate agent-supplied sender domains against the origin that would RECEIVE
 * the one-time code's field (the fill's receiving frame origin, which for an
 * embedded cross-origin form differs from the tab's page origin): each
 * domain must equal the origin host, be a subdomain of it, or share the same
 * REGISTRABLE domain (public-suffix aware via tldts). This keeps email_code
 * disambiguation scoped to the site being filled — an agent can never point
 * the reader at an unrelated inbox sender (e.g. a bank) to harvest someone
 * else's code, and a public suffix like 'co.uk' or 'github.io' is never
 * accepted as "related" (its registrable domain is null). Hosts without a
 * registrable domain (localhost, IPs) fail closed to exact/subdomain matches.
 * Returns null when any domain fails.
 *
 * When none are supplied the default is the origin's REGISTRABLE domain (by
 * the same rule), so a code mailed from the site's parent domain matches:
 * auth.reportmi.gca.gov.uk sends from gca.gov.uk. Hosts without a registrable
 * domain default to the host itself. Declared senders are added either way.
 */
export function resolveEmailSenderDomains(
  origin: string,
  requested: string[] | undefined,
  /**
   * Sender domains the live, human-granted authorization permits for this origin
   * even though they are unrelated to it (a shared notification platform such as
   * GOV.UK Notify). Explicit consent only — never derived from the page.
   */
  authorized?: string[],
): string[] | null {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  const authorizedNormalized = (authorized ?? [])
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);
  const registrable = getDomain(host, PSL_OPTIONS);
  if (!requested || requested.length === 0) {
    // De-duplicate: an authorization may name the default domain itself.
    return [...new Set([registrable ?? host, ...authorizedNormalized])];
  }
  const related = (domain: string): boolean => {
    if (domain === host || domain.endsWith(`.${host}`)) {
      return true;
    }
    if (authorizedNormalized.includes(domain)) {
      return true;
    }
    return registrable !== null && getDomain(domain, PSL_OPTIONS) === registrable;
  };
  const normalized = requested.map((domain) => domain.trim().toLowerCase());
  return normalized.every((domain) => domain.length > 0 && related(domain))
    ? normalized
    : null;
}

/**
 * The fixed failure codes an email_code read can report. They are listed in
 * the credential fill boundary's SAFE_CREDENTIAL_CODES, so they reach the tool
 * result and the audit row; nothing else from the mailbox ever does.
 */
export const EMAIL_CODE_FAILURE_CODES = {
  no_matching_message: 'email_code_no_matching_message',
  code_not_found: 'email_code_not_found_in_message',
  mailbox_unavailable: 'email_code_mailbox_unavailable',
  mailbox_timeout: 'email_code_mailbox_timeout',
} as const;

/**
 * Read the code, translating every known failure into one fixed code (thrown
 * as the Error message the fill boundary allowlists) and logging only its
 * category. Mail text and server messages never leave this function.
 */
export async function resolveEmailCode(
  reader: Pick<BrowserEmailCodeReader, 'fetchCode'>,
  senderDomains: string[],
  options: { sinceMs?: number; withinMs?: number } | undefined,
): Promise<string> {
  const withinMs = options?.withinMs ?? DEFAULT_EMAIL_CODE_WINDOW_MS;
  try {
    const result = await reader.fetchCode({
      expectedSenderDomains: senderDomains,
      sinceMs: options?.sinceMs ?? Date.now() - withinMs,
      withinMs,
    });
    return result.code;
  } catch (error) {
    if (error instanceof EmailCodeReaderError || error instanceof MailboxReaderError) {
      const code = EMAIL_CODE_FAILURE_CODES[error.code];
      logger.warn('Email code read failed', {
        failure: code,
        ...(error instanceof MailboxReaderError ? { detail: error.detail } : {}),
        senderDomains: senderDomains.length,
      });
      throw new Error(code);
    }
    // Unexpected: keep the generic fill failure, and log only the error type.
    logger.warn('Email code read failed unexpectedly', {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }
}
