/**
 * What a Copilot SEAT will actually serve, as opposed to what the CLI advertises.
 *
 * Why this exists
 * ---------------
 * `CopilotCliAdapter.listAvailableModels()` discovers models by running
 * `copilot help config` and parsing the output. Its cache is correctly scoped
 * per account profile — but the DATA is not. Running that command against the
 * personal profile home and against an enterprise profile home returns the
 * identical 28-model list, so it is a static build-time roster, not the seat's
 * entitlements.
 *
 * The two genuinely disagree in both directions. Measured 2026-09-02 against
 * the EBRD enterprise seat: `help config` advertises `claude-sonnet-4.6`,
 * `claude-opus-4.6` and `gemini-3.1-pro-preview`, none of which that seat
 * serves; the seat serves `grok-4.6`, which `help config` does not list.
 *
 * That matters here because the checking policy picks a specific model on a
 * specific seat. Picking one the seat rejects turns a review into an
 * infrastructure error. The only authoritative source is the API's own refusal:
 *
 *   The requested model is not available for integrator "copilot-developer-cli".
 *   Available models: [gpt-4.1 claude-fable-5 claude-opus-4.7 ...]
 *
 * So we learn from the refusal and cache it against the profile. The refused
 * review itself still fails — there is no in-call retry — but every LATER plan
 * for that seat skips the model, so the failure does not repeat. Nothing here
 * mutates the adapter's own cache: this is a separate, additive source of truth
 * that is empty until a seat tells us otherwise.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('CopilotModelEntitlements');

/** Cache key for a request with no resolved profile (probes, tests). */
const UNSCOPED_KEY = '__unscoped__';

/**
 * How long a learned roster is trusted.
 *
 * A refusal only ever teaches us that the seat serves FEWER models than the
 * static catalog claims. If the seat later gains a model, nothing refuses
 * anything, so without an expiry the smaller set would keep rejecting it until
 * the process restarts. Expiring returns us to "unknown", which constrains
 * nothing, and the next refusal re-learns immediately.
 */
const ENTITLEMENT_TTL_MS = 6 * 60 * 60 * 1000;

export interface CopilotUnavailableModelError {
  /** The integrator the seat named, e.g. `copilot-developer-cli`. */
  integrator: string;
  /** Model ids the seat says it WILL serve, in the order it listed them. */
  availableModels: string[];
}

/**
 * Recognise the seat's "model not available" refusal and pull the roster out of
 * it. Returns null for any other text, including other 400s — a false positive
 * here would poison the cache with a partial list and start rejecting models the
 * seat actually serves.
 *
 * The message is matched inside arbitrary surrounding text because it reaches us
 * wrapped in CLI output and JSON escaping, not as a bare string.
 */
export function parseCopilotUnavailableModelError(
  message: string | undefined | null,
): CopilotUnavailableModelError | null {
  if (typeof message !== 'string' || message.length === 0) return null;

  // Tolerate escaped quotes (\" and \\") from JSON-wrapped CLI output.
  const integratorMatch = /requested model is not available for integrator\s*\\*"([^"\\]+)\\*"/i
    .exec(message);
  if (!integratorMatch) return null;

  const listMatch = /available models:\s*\[([^\]]*)\]/i.exec(message);
  if (!listMatch) return null;

  const availableModels = (listMatch[1] ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (availableModels.length === 0) return null;

  return { integrator: integratorMatch[1] ?? '', availableModels };
}

/**
 * The CLI's own client-side refusal, which carries no roster:
 *   Error: Model "grok-4.6" from --model flag is not available.
 *
 * MEASURED 2026-09-02 against the EBRD enterprise seat: this — not the API's
 * "not available for integrator" form — is what you actually get for a model the
 * seat is not entitled to. `copilot` validates `--model` against the account's
 * real entitlements before sending anything, so the API-side message only
 * appears when a model passes that check and is refused later. Recognising ONLY
 * the API form meant the common case never taught the cache anything, and the
 * same dead model was re-picked on every future plan, forever.
 */
export function parseCopilotUnavailableModelFlag(
  message: string | undefined | null,
): string | null {
  if (typeof message !== 'string' || message.length === 0) return null;
  const match = /model\s*\\*"([^"\\]+)\\*"\s*from\s*--model\s*flag\s*is\s*not\s*available/i
    .exec(message);
  return match?.[1] ?? null;
}

interface EntitlementRecord {
  models: ReadonlySet<string>;
  learnedAt: number;
}

const entitlementsByProfile = new Map<string, EntitlementRecord>();
/**
 * Individually-refused models per profile, each with the time it was learned.
 * Separate from the roster: a flag-refusal tells us one model is unusable but
 * nothing about the rest, so it must not be mistaken for "the seat serves only
 * this".
 *
 * Expires on the SAME TTL as the roster, and for the same reason: a refusal only
 * ever teaches us the seat serves fewer models, and nothing ever refuses a model
 * that has just been granted. Without expiry a seat that later gains a model
 * would keep excluding it until the process restarts. This path is the common
 * one on a real seat, so leaving it un-expiring would have reopened exactly the
 * failure the roster's TTL exists to prevent.
 */
const refusedByProfile = new Map<string, Map<string, number>>();

function keyFor(profileId: string | undefined): string {
  return profileId?.trim() || UNSCOPED_KEY;
}

/** Remember that a seat refused ONE specific model. */
export function recordCopilotModelRefusal(
  profileId: string | undefined,
  model: string,
): void {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return;
  const key = keyFor(profileId);
  const existing = refusedByProfile.get(key) ?? new Map<string, number>();
  existing.set(normalized, Date.now());
  refusedByProfile.set(key, existing);
  logger.info('Recorded a Copilot model refusal for this seat', {
    profileId: profileId ?? null,
    model: normalized,
  });
}

/** Remember what a seat told us it serves. */
export function recordCopilotEntitlements(
  profileId: string | undefined,
  models: readonly string[],
): void {
  const normalized = models
    .map((model) => model.trim().toLowerCase())
    .filter((model) => model.length > 0);
  if (normalized.length === 0) return;

  entitlementsByProfile.set(keyFor(profileId), {
    models: new Set(normalized),
    learnedAt: Date.now(),
  });
  logger.info('Learned Copilot seat entitlements from a model refusal', {
    profileId: profileId ?? null,
    modelCount: normalized.length,
  });
}

/**
 * The learned roster for a profile, or null when this seat has never refused a
 * model. Null means "we do not know", NOT "nothing is allowed" — callers must
 * treat it as no constraint.
 */
export function getCopilotEntitlements(
  profileId: string | undefined,
): ReadonlySet<string> | null {
  const key = keyFor(profileId);
  const record = entitlementsByProfile.get(key);
  if (!record) return null;
  if (Date.now() - record.learnedAt >= ENTITLEMENT_TTL_MS) {
    entitlementsByProfile.delete(key);
    return null;
  }
  return record.models;
}

/**
 * Is this model known to be unusable on this seat? Only ever true once the seat
 * has told us its roster; an unlearned seat never rejects a candidate here.
 */
export function isModelKnownUnavailable(
  profileId: string | undefined,
  modelId: string,
): boolean {
  const normalized = modelId.trim().toLowerCase();
  const refusedAt = refusedByProfile.get(keyFor(profileId))?.get(normalized);
  if (refusedAt !== undefined) {
    if (Date.now() - refusedAt < ENTITLEMENT_TTL_MS) return true;
    refusedByProfile.get(keyFor(profileId))?.delete(normalized);
  }
  const entitlements = getCopilotEntitlements(profileId);
  if (!entitlements) return false;
  return !entitlements.has(normalized);
}

/**
 * Learn from a failure message if it is a seat refusal. No-op otherwise.
 *
 * Every checking surface that can spawn a licence-pinned Copilot checker must
 * call this on failure. Without it a refused model is retried identically on
 * every future dispatch for that seat, because nothing else ever discovers what
 * the seat actually serves — see this module's header.
 */
export function learnFromCheckerFailure(
  profileId: string | undefined,
  message: string,
): void {
  const refusal = parseCopilotUnavailableModelError(message);
  if (refusal) {
    recordCopilotEntitlements(profileId, refusal.availableModels);
    return;
  }
  // The client-side form carries no roster, only the one rejected id. Measured
  // live, this is the form a non-entitled model actually produces.
  const refusedModel = parseCopilotUnavailableModelFlag(message);
  if (refusedModel) {
    recordCopilotModelRefusal(profileId, refusedModel);
  }
}

export function _resetCopilotEntitlementsForTesting(): void {
  entitlementsByProfile.clear();
  refusedByProfile.clear();
}
