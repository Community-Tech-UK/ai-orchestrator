import type { BrowserElementCandidate, BrowserGatewayResult } from '@contracts/types/browser';
import { evaluateSessionState, type SessionEvaluation } from './browser-session-sentinel';
import type {
  BrowserEscalationService,
  RaiseEscalationResult,
} from './browser-escalation-store';
import type {
  BrowserGatewayContext,
  BrowserGatewayFillCredentialRequest,
} from './browser-gateway-service-types';
import {
  loginRecipeScopeFor,
  type LoginFingerprintStore,
  type LoginRecipe,
  type LoginRecipeOutcome,
  type LoginReloginDetails,
} from './browser-login-recipe-store';
import {
  deriveBrowserTargetInspectionState,
  isOpaqueBrowserTarget,
} from './browser-target-inspection';
import { getLogger } from '../logging/logger';

/**
 * Session resilience for unattended runs: `browser.check_session` evaluates the
 * live page against a remembered login fingerprint and, when the profile has
 * been logged out mid-campaign, runs a bounded auto re-login (navigate to the
 * login URL → fill_credential from the vault → optional TOTP/email code →
 * re-verify), max 2 attempts, then parks a `relogin_failed` escalation.
 *
 * Recipes are persisted and keyed by the stable credential scope (see
 * browser-login-recipe-store.ts), so any tab on the same computer and origin
 * finds the recipe, and it survives a restart.
 *
 * Every page judgement uses a LIVE snapshot. A cached copy describes the page
 * as it was before the sign-in, and an opaque (secret-tainted) page cannot
 * show the logged-in markers, so neither is ever reported as a success.
 *
 * Safety: the re-login uses ONLY guarded/authorized service primitives —
 * navigation is grant-checked and the credential fill re-validates the LIVE
 * origin against the standing authorization + the vault's origin binding. A
 * poisoned fingerprint (wrong loginUrl) therefore cannot exfiltrate a secret:
 * the fill refuses on the wrong origin.
 */

const logger = getLogger('BrowserSessionRelogin');

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
  /** Stable scope the recipe was looked up under (managed profileId or node scope). */
  recipeScope: string;
  /** The live page the verdict is based on. Never a cached copy. */
  page?: { title: string; url: string };
  /** Set when the hard stop was parked for morning triage. */
  escalationId?: string;
  parked?: boolean;
}

type ServiceResult<T> = Promise<BrowserGatewayResult<T | null>>;

export interface CheckSessionDeps {
  fingerprints: LoginFingerprintStore;
  escalations: Pick<BrowserEscalationService, 'raise'>;
  snapshot: (req: { profileId: string; targetId: string; requireLive: true } & BrowserGatewayContext) =>
    ServiceResult<{ title: string; url: string; text: string; textUnavailableReason?: string }>;
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
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RELOGIN_ATTEMPTS = 2;
/** A submitted login form redirects; poll the live page before judging it. */
const SETTLE_POLLS = 6;
const SETTLE_INTERVAL_MS = 1_500;
const OBSERVATION_BLOCKED = 'observation_blocked';

export async function checkSessionOperation(
  deps: CheckSessionDeps,
  request: CheckSessionRequest,
): Promise<CheckSessionOutcome> {
  const recipeScope = loginRecipeScopeFor(request.profileId).scope;
  const evaluation = await evaluateLiveSession(deps, request);
  const base = { recipeScope, ...pageOf(evaluation) };
  if (evaluation.state !== 'logged_out') {
    if (evaluation.recipe) {
      record(deps, request, evaluation.recipe.origin, outcomeForEvaluation(evaluation), evaluation.reason);
    }
    return {
      state: evaluation.state,
      reason: evaluation.reason,
      reloggedIn: false,
      attempts: 0,
      ...base,
    };
  }

  if (request.autoRelogin === false) {
    return { state: 'logged_out', reason: evaluation.reason, reloggedIn: false, attempts: 0, ...base };
  }
  const recipe = evaluation.recipe;
  const relogin = recipe?.relogin;
  if (!recipe || !relogin) {
    if (recipe) {
      record(deps, request, recipe.origin, 'no_relogin_recipe', evaluation.reason);
    }
    const parked = park(
      deps,
      request,
      recipe
        ? `A login fingerprint exists for ${recipe.origin} under scope ${recipeScope}, but it has no re-login recipe`
        : `No login fingerprint/re-login recipe recorded for ${evaluation.origin ?? 'this origin'} under scope ${recipeScope}`,
      evaluation.url,
    );
    return {
      state: 'logged_out',
      reason: recipe ? 'no_relogin_recipe' : 'no_fingerprint',
      reloggedIn: false,
      attempts: 0,
      ...base,
      escalationId: parked.escalationId,
      parked: true,
    };
  }

  let lastReason = evaluation.reason;
  let lastPage = base.page;
  for (let attempt = 1; attempt <= MAX_RELOGIN_ATTEMPTS; attempt++) {
    try {
      await attemptRelogin(deps, request, recipe.loginUrl, relogin);
      const settled = await waitForSettledSession(deps, request);
      lastReason = settled.reason;
      lastPage = pageOf(settled).page ?? lastPage;
      if (settled.state === 'logged_in') {
        logger.info('Auto re-login succeeded', { profileId: request.profileId, attempt });
        record(deps, request, recipe.origin, 'relogged_in', settled.reason);
        return {
          state: 'logged_in',
          reason: settled.reason,
          reloggedIn: true,
          attempts: attempt,
          recipeScope,
          ...pageOf(settled),
        };
      }
      if (settled.reason === OBSERVATION_BLOCKED) {
        // The form was submitted but the page cannot be read, so the sign-in
        // cannot be confirmed. Retrying would refill the credential into a page
        // we still cannot see; hand it to a human with the cause instead.
        record(deps, request, recipe.origin, 'observation_blocked', settled.reason);
        const parked = park(
          deps,
          request,
          'Sign-in was submitted but the page cannot be read afterwards (secret observation '
            + 'protection is blocking this origin). Check browser.health secretObservation.',
          settled.url || evaluation.url,
        );
        return {
          state: 'unknown',
          reason: 'observation_blocked_after_relogin',
          reloggedIn: false,
          attempts: attempt,
          recipeScope,
          ...pageOf(settled),
          escalationId: parked.escalationId,
          parked: true,
        };
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
      logger.warn('Auto re-login attempt failed', {
        profileId: request.profileId,
        attempt,
        error: lastReason,
      });
    }
  }

  record(deps, request, recipe.origin, 'relogin_failed', lastReason);
  const parked = park(
    deps,
    request,
    `Auto re-login failed after ${MAX_RELOGIN_ATTEMPTS} attempts (last: ${lastReason})`,
    evaluation.url,
  );
  return {
    state: 'logged_out',
    reason: 'relogin_failed',
    reloggedIn: false,
    attempts: MAX_RELOGIN_ATTEMPTS,
    recipeScope,
    ...(lastPage ? { page: lastPage } : {}),
    escalationId: parked.escalationId,
    parked: true,
  };
}

interface LiveSessionEvaluation extends SessionEvaluation {
  url: string;
  title: string;
  origin: string | null;
  recipe?: LoginRecipe;
}

async function evaluateLiveSession(
  deps: CheckSessionDeps,
  request: CheckSessionRequest,
): Promise<LiveSessionEvaluation> {
  const base = contextOf(request);
  const snap = await deps.snapshot({
    ...base,
    profileId: request.profileId,
    targetId: request.targetId,
    requireLive: true,
  });
  if (snap.decision !== 'allowed' || snap.outcome !== 'succeeded' || !snap.data) {
    return {
      state: 'unknown',
      reason: snap.reason ?? 'snapshot_unavailable',
      url: '',
      title: '',
      origin: null,
    };
  }
  const { url, title, text } = snap.data;
  const origin = getOrigin(url);
  const recipe = origin ? deps.fingerprints.find(request.profileId, origin) : undefined;
  const inspection = deriveBrowserTargetInspectionState({
    title,
    url,
    ...(snap.data.textUnavailableReason
      ? { textUnavailableReason: snap.data.textUnavailableReason }
      : {}),
  });
  if (isOpaqueBrowserTarget(inspection)) {
    return { state: 'unknown', reason: OBSERVATION_BLOCKED, url, title, origin, ...(recipe ? { recipe } : {}) };
  }
  if (!origin) {
    return { state: 'unknown', reason: 'origin_unknown', url, title, origin };
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
  const evaluation = evaluateSessionState(
    { url, hasPasswordField, presentTexts: [text, title] },
    recipe ? deps.fingerprints.fingerprintOf(recipe) : undefined,
  );
  return { ...evaluation, url, title, origin, ...(recipe ? { recipe } : {}) };
}

async function waitForSettledSession(
  deps: CheckSessionDeps,
  request: CheckSessionRequest,
): Promise<LiveSessionEvaluation> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let latest = await evaluateLiveSession(deps, request);
  for (let poll = 1; poll < SETTLE_POLLS; poll++) {
    if (latest.state === 'logged_in' || latest.reason === OBSERVATION_BLOCKED) {
      return latest;
    }
    await sleep(SETTLE_INTERVAL_MS);
    latest = await evaluateLiveSession(deps, request);
  }
  return latest;
}

function outcomeForEvaluation(evaluation: LiveSessionEvaluation): LoginRecipeOutcome {
  if (evaluation.state === 'logged_in') {
    return 'logged_in';
  }
  return evaluation.reason === OBSERVATION_BLOCKED ? 'observation_blocked' : 'unknown';
}

function record(
  deps: CheckSessionDeps,
  request: CheckSessionRequest,
  origin: string,
  outcome: LoginRecipeOutcome,
  reason: string,
): void {
  try {
    deps.fingerprints.recordOutcome(request.profileId, origin, outcome, reason.slice(0, 500));
  } catch (error) {
    // Diagnostics only; a failed write must not change the session verdict.
    logger.warn('Could not record login recipe outcome', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function pageOf(evaluation: LiveSessionEvaluation): { page?: { title: string; url: string } } {
  return evaluation.url ? { page: { title: evaluation.title, url: evaluation.url } } : {};
}

async function attemptRelogin(
  deps: CheckSessionDeps,
  request: CheckSessionRequest,
  loginUrl: string,
  relogin: LoginReloginDetails,
): Promise<void> {
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
    await submit(deps, base, relogin.submitSelector);
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
      await submit(deps, base, relogin.submitSelector);
    }
  }
}

/**
 * A refused submit (no grant, approval pending) must fail the attempt with its
 * reason. Ignoring it left the settle loop polling an untouched login form and
 * reported only a generic relogin_failed. An allowed click whose command then
 * failed is tolerated: a login submit navigates the page away mid-command, and
 * the settle loop judges the result from the live page.
 */
async function submit(
  deps: CheckSessionDeps,
  base: BrowserGatewayContext & { profileId: string; targetId: string },
  selector: string,
): Promise<void> {
  const clicked = await deps.click({ ...base, selector });
  if (clicked.decision !== 'allowed') {
    throw new Error(`relogin submit refused: ${clicked.reason ?? clicked.decision}`);
  }
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
