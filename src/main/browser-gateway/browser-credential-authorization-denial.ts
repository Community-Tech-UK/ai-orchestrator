import type { CredentialAuthorization } from './browser-credential-authorization-store';

/**
 * Agent-visible copy for a standing-authorization miss.
 *
 * `browser.fill_credential` returns only `reason` to the model (the audit
 * summary never leaves the recorder). A bare
 * `credential_not_authorized:origin_not_authorized` therefore looks like a
 * Gateway hard-stop, even though the operator already approved a session grant
 * and the real door is `$AIO_MCP browser-credentials authorize`.
 */

const NODE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLI_PURPOSES = new Set(['login', 'register', 'totp', 'email_code']);

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

export function formatAuthorizeCommand(scope: string, origin: string, purpose: string): string {
  const rest =
    `--origin ${origin} --purpose ${purpose} --vault-folder AIO-Agent --expires-in 90d`;
  if (scope === 'local') {
    return `$AIO_MCP browser-credentials authorize --local ${rest}`;
  }
  if (NODE_ID_RE.test(scope)) {
    return `$AIO_MCP browser-credentials authorize --node ${scope} ${rest}`;
  }
  return `$AIO_MCP browser-credentials authorize --profile ${scope} ${rest}`;
}

export function formatCredentialAuthorizationDenial(input: {
  toolName: string;
  origin: string;
  purpose: string;
  reason: string;
  scope: string;
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
  parts.push(nextStep(input.scope, input.origin, input.purpose));
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

function nextStep(scope: string, origin: string, purpose: string): string {
  if (!CLI_PURPOSES.has(purpose)) {
    return (
      'Create a secret_fill authorization for this origin in Browser → Credential authorizations; '
      + 'the CLI cannot mint secret_fill.'
    );
  }
  return `Create one with: ${formatAuthorizeCommand(scope, origin, purpose)}`;
}
