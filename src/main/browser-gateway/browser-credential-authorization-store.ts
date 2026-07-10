/**
 * Standing, human-granted authorizations for agent credential use.
 *
 * The credential hard-stop (classifier) stays intact for arbitrary typed values
 * and for the user's personal accounts. `browser.fill_credential` is the only
 * primitive allowed to bypass it, and only when a live authorization from this
 * store covers (profileId, live origin, purpose). Authorizations are created
 * ONLY through an interactive James-approved dialog — never via an MCP tool,
 * never auto-approved.
 *
 * Scope: agent-owned managed profiles, keyed by the managed profileId. The same
 * record ALSO gates autonomous login on the user's SHARED existing Chrome tabs
 * when the operator opts in (the `browserAllowSharedTabCredentialFill` setting).
 * A shared tab's own profileId is ephemeral (`existing-tab:...:<window>:<tab>`),
 * so for that path the caller keys the check by the tab's NODE scope instead —
 * the remote nodeId, or `'local'` for the coordinator's own Chrome — exactly
 * as shared-tab GRANTS are scoped (see browser-grant-scope.ts). That keeps the
 * consent genuinely standing: one authorization per node, not per tab.
 *
 * This is the standing-consent record; runtime secret resolution + origin/
 * folder jailing live in browser-credential-vault.ts. Both must pass.
 */

export type CredentialPurpose = 'login' | 'register' | 'totp' | 'email_code';

export interface CredentialAuthorizationOrigin {
  scheme: 'https' | 'http';
  /** Host pattern, e.g. 'portal.example.gov.uk' or '*.example.gov.uk'. */
  hostPattern: string;
  includeSubdomains: boolean;
}

export interface CredentialAuthorization {
  id: string;
  profileId: string;
  allowedOrigins: CredentialAuthorizationOrigin[];
  purposes: CredentialPurpose[];
  /** Bitwarden folder this authorization is scoped to (e.g. 'AIO-Agent'). */
  vaultFolder: string;
  createdAt: number;
  /** Weeks/months out — long-lived standing consent, not a 30-min grant. */
  expiresAt: number;
  revokedAt?: number;
  note?: string;
}

export interface CredentialAuthorizationRecordStore {
  insert(auth: CredentialAuthorization): void;
  get(id: string): CredentialAuthorization | undefined;
  list(filter?: { profileId?: string; includeRevoked?: boolean }): CredentialAuthorization[];
  markRevoked(id: string, revokedAt: number): void;
}

export class InMemoryCredentialAuthorizationStore
  implements CredentialAuthorizationRecordStore
{
  private readonly map = new Map<string, CredentialAuthorization>();

  insert(auth: CredentialAuthorization): void {
    this.map.set(auth.id, auth);
  }
  get(id: string): CredentialAuthorization | undefined {
    return this.map.get(id);
  }
  list(filter?: { profileId?: string; includeRevoked?: boolean }): CredentialAuthorization[] {
    return [...this.map.values()].filter((auth) => {
      if (filter?.profileId && auth.profileId !== filter.profileId) {
        return false;
      }
      if (!filter?.includeRevoked && auth.revokedAt) {
        return false;
      }
      return true;
    });
  }
  markRevoked(id: string, revokedAt: number): void {
    const existing = this.map.get(id);
    if (existing) {
      this.map.set(id, { ...existing, revokedAt });
    }
  }
}

export interface AuthorizationCheck {
  profileId: string;
  origin: string;
  purpose: CredentialPurpose;
  now?: number;
}

export interface AuthorizationDecision {
  authorized: boolean;
  authorizationId?: string;
  reason?:
    | 'no_authorization_for_profile'
    | 'origin_not_authorized'
    | 'purpose_not_authorized'
    | 'authorization_expired'
    | 'authorization_revoked';
}

export class CredentialAuthorizationService {
  constructor(
    private readonly store: CredentialAuthorizationRecordStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  create(input: Omit<CredentialAuthorization, 'id' | 'createdAt'>, id: string): CredentialAuthorization {
    const auth: CredentialAuthorization = { ...input, id, createdAt: this.now() };
    this.store.insert(auth);
    return auth;
  }

  revoke(id: string): void {
    this.store.markRevoked(id, this.now());
  }

  list(profileId?: string): CredentialAuthorization[] {
    return this.store.list(profileId ? { profileId } : undefined);
  }

  /** Does a live, unrevoked authorization cover this profile+origin+purpose? */
  check(input: AuthorizationCheck): AuthorizationDecision {
    const now = input.now ?? this.now();
    const candidates = this.store.list({ profileId: input.profileId, includeRevoked: true });
    if (candidates.length === 0) {
      return { authorized: false, reason: 'no_authorization_for_profile' };
    }

    let sawOrigin = false;
    let sawPurpose = false;
    for (const auth of candidates) {
      if (auth.revokedAt) {
        continue;
      }
      const originOk = auth.allowedOrigins.some((o) => originMatches(o, input.origin));
      if (originOk) {
        sawOrigin = true;
      }
      const purposeOk = auth.purposes.includes(input.purpose);
      if (purposeOk) {
        sawPurpose = true;
      }
      if (!originOk || !purposeOk) {
        continue;
      }
      if (auth.expiresAt <= now) {
        continue; // an expired-but-otherwise-matching auth is reported below
      }
      return { authorized: true, authorizationId: auth.id };
    }

    // Nothing fully matched — report the most specific failure reason.
    if (!sawOrigin) {
      return { authorized: false, reason: 'origin_not_authorized' };
    }
    if (!sawPurpose) {
      return { authorized: false, reason: 'purpose_not_authorized' };
    }
    return { authorized: false, reason: 'authorization_expired' };
  }
}

function originMatches(pattern: CredentialAuthorizationOrigin, origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (scheme !== pattern.scheme) {
    return false;
  }
  const host = url.host.toLowerCase();
  const wanted = pattern.hostPattern.toLowerCase().replace(/^\*\./, '');
  if (host === wanted) {
    return true;
  }
  if (pattern.includeSubdomains || pattern.hostPattern.startsWith('*.')) {
    return host.endsWith(`.${wanted}`);
  }
  return false;
}
