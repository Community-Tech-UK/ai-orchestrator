import type { CredentialAuthorization } from './browser-credential-authorization-store';

/**
 * Agent-visible copy for a standing-authorization miss.
 *
 * `browser.fill_credential` returns only `reason` to the model (the audit
 * summary never leaves the recorder). A bare
 * `credential_not_authorized:origin_not_authorized` therefore looks like a
 * Gateway hard-stop, even though the real door is a visible approval request
 * (`browser.request_credential_access`). Never point at `aio-mcp
 * browser-credentials authorize`: session RPC refuses it, and outside a
 * session it has no connection (22 Nov 2026, UptimeRobot sign-up).
 */

export function formatAuthorizedOriginHosts(
  authorizations: Pick<CredentialAuthorization, 'allowedOrigins'>[],
  limit = 8,
): string[] {
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const auth of authorizations) {
    for (const origin of auth.allowedOrigins) {
      const host =
        origin.includeSubdomains || origin.hostPattern.startsWith('*.')
          ? `*.${origin.hostPattern.replace(/^\*\./, '')}`
          : origin.hostPattern;
      const rendered = `${origin.scheme}://${host}`;
      if (seen.has(rendered)) {
        continue;
      }
      seen.add(rendered);
      hosts.push(rendered);
      if (hosts.length >= limit) {
        return hosts;
      }
    }
  }
  return hosts;
}

export function formatCredentialAuthorizationDenial(input: {
  toolName: string;
  origin: string;
  purpose: string;
  reason: string;
  /** Shown in parentheses when it is more specific than `purpose` (secret type). */
  detail?: string;
  authorizedOrigins?: string[];
}): { reason: string; summary: string } {
  const codePrefix = input.toolName === 'browser.fill_secret'
    ? `secret_not_authorized:${input.reason}`
    : `credential_not_authorized:${input.reason}`;
  const label = input.detail ?? input.purpose;
  const parts = [
    `${input.toolName} is not authorized for ${input.origin} (${label}).`,
    'A session grant from browser.request_grant does not cover credential fill.',
  ];
  if (input.authorizedOrigins && input.authorizedOrigins.length > 0) {
    parts.push(`This scope already covers: ${input.authorizedOrigins.join(', ')}.`);
  }
  parts.push(nextStep(input.origin, input.purpose));
  const message = parts.join(' ');
  return {
    reason: `${codePrefix}: ${message}`,
    summary: message,
  };
}

export function buildCredentialAuthorizationDenial(
  list: ((profileId?: string) => Pick<CredentialAuthorization, 'allowedOrigins'>[]) | undefined,
  input: {
    toolName: string;
    origin: string;
    purpose: string;
    reason: string;
    scope: string;
    detail?: string;
  },
): { reason: string; summary: string } {
  const authorizedOrigins = list ? formatAuthorizedOriginHosts(list(input.scope)) : [];
  return formatCredentialAuthorizationDenial({
    ...input,
    ...(authorizedOrigins.length > 0 ? { authorizedOrigins } : {}),
  });
}

function nextStep(origin: string, purpose: string): string {
  if (purpose === 'login' || purpose === 'totp') {
    return 'Call browser.request_credential_access with this profileId, targetId, exact saved login name and reason. '
      + 'Wait for its approved status, then retry secure fill. It works without the shell CLI connection.';
  }
  if (purpose === 'email_code') {
    return 'Call browser.request_credential_access with this profileId, targetId, exact saved login name, reason and '
      + 'purposes including email_code; add senderDomains when the code email comes from another domain. '
      + 'Wait for its approved status, then retry secure fill.';
  }
  if (purpose === 'register') {
    return `Call browser.request_credential_access with this profileId, targetId, purposes ["register"], `
      + `origin ${origin} and a reason (no item). Wait for its approved status, then retry `
      + 'browser.create_agent_credential. It works without the shell CLI connection.';
  }
  return 'Only James can allow this: ask him to create a secret_fill permission for this website in '
    + 'Browser Gateway > Permissions. Agents cannot request secret_fill.';
}
