import type { BrowserElementCandidate, BrowserGatewayResult } from '@contracts/types/browser';
import { SessionSentinel, type SessionEvaluation } from './browser-session-sentinel';
import type {
  BrowserEscalationService,
  RaiseEscalationResult,
} from './browser-escalation-store';
import type {
  BrowserGatewayContext,
  BrowserGatewayFillCredentialRequest,
} from './browser-gateway-service-types';
import { getLogger } from '../logging/logger';

/**
 * Session resilience for unattended runs: `browser.check_session` evaluates the
 * live page against a remembered login fingerprint and, when the profile has
 * been logged out mid-campaign, runs a bounded auto re-login (navigate to the
 * login URL → fill_credential from the vault → optional TOTP/email code →
 * re-verify), max 2 attempts, then parks a `relogin_failed` escalation.
 *
 * Safety: the re-login uses ONLY guarded/authorized service primitives —
 * navigation is grant-checked and the credential fill re-validates the LIVE
 * origin against the standing authorization + the vault's origin binding. A
 * poisoned fingerprint (wrong loginUrl) therefore cannot exfiltrate a secret:
 * the fill refuses on the wrong origin.
 */

const logger = getLogger('BrowserSessionRelogin');

export interface LoginReloginDetails {
  /** Vault item to re-login with (a reference, never a secret). */
  vaultItemRef: string;
  usernameSelector?: string;
  passwordSelector: string;
  submitSelector?: string;
  /** Second-factor input, filled on a second pass when configured. */
  codeSelector?: string;
  codeKind?: 'totp' | 'email_code';
}

export interface RememberLoginFingerprintInput {
  profileId: string;
  origin: string;
  loginUrl: string;
  loggedInMarkers: string[];
  relogin?: LoginReloginDetails;
}

/**
 * In-memory fingerprint + re-login recipe store (per app run — an overnight
 * campaign keeps the app alive; fingerprints are re-recorded on first login
 * after a restart).
 */
export class LoginFingerprintStore {
  private readonly sentinel = new SessionSentinel();
  private readonly relogin = new Map<string, LoginReloginDetails>();

  private key(profileId: string, origin: string): string {
    return `${profileId}::${origin}`;
  }

  remember(input: RememberLoginFingerprintInput): void {
    this.sentinel.remember(input.profileId, input.origin, {
      loggedInMarkers: input.loggedInMarkers,
      loginUrl: input.loginUrl,
    });
    if (input.relogin) {
      this.relogin.set(this.key(input.profileId, input.origin), input.relogin);
    }
  }

  getSentinel(): SessionSentinel {
    return this.sentinel;
  }

  getReloginDetails(profileId: string, origin: string): LoginReloginDetails | undefined {
    return this.relogin.get(this.key(profileId, origin));
  }
}

let fingerprintStore: LoginFingerprintStore | null = null;

export function getLoginFingerprintStore(): LoginFingerprintStore {
  if (!fingerprintStore) {
    fingerprintStore = new LoginFingerprintStore();
  }
  return fingerprintStore;
}

// ── check_session operation ────────────────────────────────────────────────

export interface CheckSessionRequest extends BrowserGatewayContext {
  profileId: string;
  targetId: string;
  /** Attempt the auto re-login when logged out (default true). */
  autoRelogin?: boolean;
  /** Campaign to attribute a parked escalation to. */
  campaignId?: string;
}

export interface CheckSessionOutcome {
  state: SessionEvaluation['state'];
  reason: string;
  reloggedIn: boolean;
  attempts: number;
  /** Set when the hard stop was parked for morning triage. */
  escalationId?: string;
  parked?: boolean;
}

type ServiceResult<T> = Promise<BrowserGatewayResult<T | null>>;

export interface CheckSessionDeps {
  fingerprints: LoginFingerprintStore;
  escalations: Pick<BrowserEscalationService, 'raise'>;
  snapshot: (req: { profileId: string; targetId: string } & BrowserGatewayContext) =>
    ServiceResult<{ title: string; url: string; text: string }>;
  queryElements: (req: {
    profileId: string;
    targetId: string;
    limit?: number;
  } & BrowserGatewayContext) => ServiceResult<BrowserElementCandidate[]>;
  navigate: (req: {
    profileId: string;
    targetId: string;
    url: string;
  } & BrowserGatewayContext) => ServiceResult<unknown>;
  fillCredential: (req: BrowserGatewayFillCredentialRequest) =>
    ServiceResult<{ filled: number }>;
  click: (req: {
    profileId: string;
    targetId: string;
    selector: string;
  } & BrowserGatewayContext) => ServiceResult<unknown>;
}

const MAX_RELOGIN_ATTEMPTS = 2;

export async function checkSessionOperation(
  deps: CheckSessionDeps,
  request: CheckSessionRequest,
): Promise<CheckSessionOutcome> {
  const evaluation = await evaluateLiveSession(deps, request);
  if (evaluation.state !== 'logged_out') {
    return { state: evaluation.state, reason: evaluation.reason, reloggedIn: false, attempts: 0 };
  }

  const origin = evaluation.origin;
  const fingerprint = origin
    ? deps.fingerprints.getSentinel().getFingerprint(request.profileId, origin)
    : undefined;
  const relogin = origin
    ? deps.fingerprints.getReloginDetails(request.profileId, origin)
    : undefined;

  if (request.autoRelogin === false) {
    return { state: 'logged_out', reason: evaluation.reason, reloggedIn: false, attempts: 0 };
  }
  if (!fingerprint || !relogin) {
    const parked = park(deps, request, 'No login fingerprint/re-login recipe recorded for this origin', evaluation.url);
    return {
      state: 'logged_out',
      reason: 'no_fingerprint',
      reloggedIn: false,
      attempts: 0,
      escalationId: parked.escalationId,
      parked: true,
    };
  }

  for (let attempt = 1; attempt <= MAX_RELOGIN_ATTEMPTS; attempt++) {
    try {
      const ok = await attemptRelogin(deps, request, fingerprint.loginUrl, relogin);
      if (ok) {
        const recheck = await evaluateLiveSession(deps, request);
        if (recheck.state === 'logged_in' || recheck.state === 'unknown') {
          logger.info('Auto re-login succeeded', { profileId: request.profileId, attempt });
          return {
            state: recheck.state,
            reason: recheck.reason,
            reloggedIn: true,
            attempts: attempt,
          };
        }
      }
    } catch (error) {
      logger.warn('Auto re-login attempt failed', {
        profileId: request.profileId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const parked = park(
    deps,
    request,
    `Auto re-login failed after ${MAX_RELOGIN_ATTEMPTS} attempts`,
    evaluation.url,
  );
  return {
    state: 'logged_out',
    reason: 'relogin_failed',
    reloggedIn: false,
    attempts: MAX_RELOGIN_ATTEMPTS,
    escalationId: parked.escalationId,
    parked: true,
  };
}

interface LiveSessionEvaluation extends SessionEvaluation {
  url: string;
  origin: string | null;
}

async function evaluateLiveSession(
  deps: CheckSessionDeps,
  request: CheckSessionRequest,
): Promise<LiveSessionEvaluation> {
  const base = contextOf(request);
  const snap = await deps.snapshot({ ...base, profileId: request.profileId, targetId: request.targetId });
  if (snap.decision !== 'allowed' || !snap.data) {
    return { state: 'unknown', reason: snap.reason ?? 'snapshot_unavailable', url: '', origin: null };
  }
  const elements = await deps.queryElements({
    ...base,
    profileId: request.profileId,
    targetId: request.targetId,
    limit: 100,
  });
  const hasPasswordField = (elements.data ?? []).some(
    (candidate) => candidate.inputType === 'password',
  );
  const url = snap.data.url;
  const evaluation = getOrigin(url)
    ? deps.fingerprints
        .getSentinel()
        .evaluate(request.profileId, getOrigin(url)!, {
          url,
          hasPasswordField,
          presentTexts: [snap.data.text, snap.data.title],
        })
    : ({ state: 'unknown', reason: 'origin_unknown' } as SessionEvaluation);
  return { ...evaluation, url, origin: getOrigin(url) };
}

async function attemptRelogin(
  deps: CheckSessionDeps,
  request: CheckSessionRequest,
  loginUrl: string,
  relogin: LoginReloginDetails,
): Promise<boolean> {
  const base = { ...contextOf(request), profileId: request.profileId, targetId: request.targetId };

  const nav = await deps.navigate({ ...base, url: loginUrl });
  if (nav.decision !== 'allowed') {
    throw new Error(`relogin navigate refused: ${nav.reason ?? nav.decision}`);
  }

  const fields: BrowserGatewayFillCredentialRequest['fields'] = [
    ...(relogin.usernameSelector
      ? [{ selector: relogin.usernameSelector, kind: 'username' as const }]
      : []),
    { selector: relogin.passwordSelector, kind: 'password' as const },
  ];
  const fill = await deps.fillCredential({
    ...base,
    vaultItemRef: relogin.vaultItemRef,
    fields,
  });
  if (fill.decision !== 'allowed' || fill.outcome !== 'succeeded') {
    throw new Error(`relogin credential fill refused: ${fill.reason ?? fill.decision}`);
  }
  if (relogin.submitSelector) {
    await deps.click({ ...base, selector: relogin.submitSelector });
  }

  // Optional second factor: fill the code input on a second pass (the code
  // mail/TOTP only exists after the password submit).
  if (relogin.codeSelector && relogin.codeKind) {
    const codeFill = await deps.fillCredential({
      ...base,
      vaultItemRef: relogin.vaultItemRef,
      fields: [{ selector: relogin.codeSelector, kind: relogin.codeKind }],
    });
    if (codeFill.decision !== 'allowed' || codeFill.outcome !== 'succeeded') {
      throw new Error(`relogin 2FA fill refused: ${codeFill.reason ?? codeFill.decision}`);
    }
    if (relogin.submitSelector) {
      await deps.click({ ...base, selector: relogin.submitSelector });
    }
  }
  return true;
}

function park(
  deps: CheckSessionDeps,
  request: CheckSessionRequest,
  reason: string,
  url: string,
): RaiseEscalationResult {
  return deps.escalations.raise({
    ...(request.campaignId ? { campaignId: request.campaignId } : {}),
    profileId: request.profileId,
    targetId: request.targetId,
    kind: 'relogin_failed',
    reason,
    ...(url ? { url } : {}),
  });
}

function getOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function contextOf(request: BrowserGatewayContext): BrowserGatewayContext {
  return {
    ...(request.instanceId ? { instanceId: request.instanceId } : {}),
    ...(request.provider ? { provider: request.provider } : {}),
  };
}
