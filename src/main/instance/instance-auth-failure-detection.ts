/**
 * Classifies a failed turn as "the provider signed us out" rather than a
 * generic error, so the session can offer a repair instead of dying.
 *
 * Deliberately narrow. A false positive attaches a misleading "signed out"
 * banner to an unrelated failure, so this only matches phrasing that providers
 * actually use for credential problems, and callers confirm with a live auth
 * probe wherever one exists (see provider-auth-status.ts).
 */

export interface AuthFailureSignal {
  /** Short human reason, already truncated for logs/telemetry. */
  reason: string;
}

/**
 * Credential-failure phrasing observed across the provider CLIs:
 * - Claude: "Failed to authenticate: OAuth session expired and could not be refreshed"
 * - Codex: "Not logged in. Run `codex login`"
 * - API-key setups: "invalid api key", "authentication_error", HTTP 401
 */
const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /\boauth\b[^.]{0,40}\bexpired\b/i,
  /\bfailed to authenticate\b/i,
  /\bauthentication[ _-]?error\b/i,
  /\bnot (?:logged in|authenticated)\b/i,
  /\bplease (?:re-?)?(?:run|sign|log)[ -]?in\b/i,
  /\brun `?(?:claude auth login|codex login|copilot login|cursor-agent login)`?/i,
  /\b(?:invalid|expired|revoked|missing)\b[^.]{0,30}\b(?:api key|credentials?|token|session)\b/i,
  /\b401\b[^.]{0,20}\bunauthoriz/i,
  /\bunauthorized\b[^.]{0,20}\b401\b/i,
  /\bcredentials? (?:have )?expired\b/i,
];

/**
 * Phrasing that looks auth-ish but is not the *provider* signing us out —
 * usually a tool, MCP server, or the agent narrating someone else's auth
 * problem. Checked first; a hit vetoes the match.
 */
const NOT_PROVIDER_AUTH_PATTERNS: RegExp[] = [
  /\bmcp\b/i,
  /\bgithub\b/i,
  /\bnpm\b/i,
  /\bdocker\b/i,
  /\bgit\b(?!hub)/i,
  /\bssh\b/i,
  /\bregistry\b/i,
  /\bdatabase\b/i,
];

/**
 * Returns a signal when the message reads as a provider credential failure,
 * or null when the turn should be handled as an ordinary error.
 */
export function detectAuthFailureSignal(errorMessage: string): AuthFailureSignal | null {
  if (!errorMessage.trim()) return null;
  if (NOT_PROVIDER_AUTH_PATTERNS.some((pattern) => pattern.test(errorMessage))) {
    return null;
  }
  if (!AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(errorMessage))) {
    return null;
  }

  return { reason: `provider auth failure on turn: ${errorMessage.slice(0, 160)}` };
}
