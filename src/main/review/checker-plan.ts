/**
 * Who checks the work, and on which model.
 *
 * Two rules, both hardcoded on purpose (a switch that re-enables self-review has
 * no good use):
 *
 * 1. FAMILY DIVERSITY — a checker must run a model from a different vendor than
 *    the implementer's. Provider is the wrong axis: one Copilot seat fronts
 *    Anthropic, OpenAI, Google and xAI models, so "Copilot checked Copilot" can
 *    be a real second opinion while "the Claude CLI checked
 *    Copilot-running-claude-opus-5" is self-review wearing a different badge.
 *
 * 2. LICENCE CONTAINMENT — work inside a *protected enterprise* Copilot scope is
 *    checked on that same seat. Employer code does not go to the Claude CLI, the
 *    Codex CLI, Cursor, or a personal Copilot seat. The cross-check comes from
 *    switching model family within the seat instead.
 *
 * Nothing is ever barred. A checker whose model would collide with the
 * implementer's family is RE-MODELLED, not dropped — losing a checker is a worse
 * outcome than a same-family one, so re-modelling is tried first and the checker
 * runs unchanged if no diverse model is available for it.
 *
 * The one exception is fail-closed licence scope: when a workspace might be in a
 * protected scope but we cannot tell which, the plan is empty. A check that
 * cannot establish where the code may go does not run.
 */

import { getLogger } from '../logging/logger';
import { modelFamily, sameFamily, type ModelFamily } from '../../shared/models/model-family';
import {
  CLAUDE_PINNED_MODELS,
  COPILOT_MODELS,
  PROVIDER_MODEL_LIST,
} from '../../shared/types/provider.types';
import {
  getCopilotAccountRoutingService,
  type WorkspaceCopilotScope,
} from '../providers/copilot/copilot-account-routing-service';
import { isModelKnownUnavailable } from './copilot-model-entitlements';
import { resolveReviewerModelOverride } from './reviewer-model-override';

const logger = getLogger('CheckerPlan');

/**
 * Copilot checker models per family, strongest first.
 *
 * Hardcoded rather than read from `PROVIDER_MODEL_LIST` because the app's static
 * Copilot catalog does NOT match what a seat serves. `copilot help config`
 * returns an identical roster for every account (see
 * `copilot-model-entitlements.ts`), and measured against the EBRD enterprise
 * seat it advertises models that seat rejects while omitting ones it serves.
 * These ids were verified against that seat's own API response.
 *
 * `-mini`, `-nano` and `-fast` tiers are deliberately absent: a weak checker
 * that agrees with everything is worse than no cross-check, because it looks
 * like corroboration.
 */
const COPILOT_CHECKER_MODELS: Readonly<Partial<Record<ModelFamily, readonly string[]>>> = {
  openai: ['gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex'],
  // Constants, not literals: `model-token-guard.spec.ts` forbids hardcoded
  // Claude model ids in app code so a model rename cannot silently rot them.
  // Copilot uses the DOTTED 4.x form, which is why these come from
  // COPILOT_MODELS rather than CLAUDE_PINNED_MODELS' hyphenated ids.
  anthropic: [
    COPILOT_MODELS.CLAUDE_OPUS_5,
    CLAUDE_PINNED_MODELS.SONNET_5,
    COPILOT_MODELS.CLAUDE_OPUS_48,
  ],
  xai: ['grok-4.6', 'grok-4.5'],
  // Only flash tiers reach this seat, so Google sits last: usable as a third
  // opinion, not as the first choice.
  google: ['gemini-3.7-flash', 'gemini-3.6-flash'],
};

/** Family preference order for a licence-pinned checker. */
export const FAMILY_PREFERENCE: readonly ModelFamily[] = ['openai', 'anthropic', 'xai', 'google'];

export interface CheckerContext {
  /** Provider that produced the work. Undefined = unknown; constrains nothing. */
  implementerProvider?: string;
  /** Model that produced the work. Undefined = unknown; constrains nothing. */
  implementerModel?: string;
  /** Workspace the work lives in. Drives licence containment. */
  workingDirectory?: string;
  /** Call-site name, for logs. */
  context: string;
  /**
   * Fewest checkers to produce in the licence-pinned branch when `requested` is
   * empty. Default 0.
   *
   * An empty `requested` list is ambiguous on its own: it can mean "the normal
   * selection pool came up empty, please still find me someone" (pass 1) or "the
   * caller explicitly asked for ZERO remote reviewers" (`aio review --reviewers
   * none`, and the loop's local-only advisory pass, which runs every ping-pong
   * round). Inferring intent from array length made the second case spawn a real,
   * billed Copilot review that no caller asked for — and whose spend the loop's
   * cost cap never saw, because the local-advisory result type has no cost fields.
   */
  minCheckers?: number;
}

export type CheckerRationale =
  | 'licence-pinned'
  | 'family-diverse'
  | 'unchanged';

export interface CheckerCandidate {
  provider: string;
  /** Undefined means "let the CLI choose". */
  model?: string;
  rationale: CheckerRationale;
  /** Set when the candidate is pinned to a specific Copilot account. */
  copilotProfileId?: string;
}

export interface CheckerPlan {
  candidates: CheckerCandidate[];
  /** Populated when `candidates` is empty and that was a policy decision. */
  blockedReason?: string;
  scopeKind: WorkspaceCopilotScope['kind'];
}

export interface CheckerPlanDeps {
  classifyScope?: (cwd: string | undefined) => WorkspaceCopilotScope;
  resolveProviderModel?: (provider: string) => string | undefined;
  isModelUnavailable?: (profileId: string | undefined, model: string) => boolean;
}

function classify(cwd: string | undefined, deps: CheckerPlanDeps): WorkspaceCopilotScope {
  if (deps.classifyScope) return deps.classifyScope(cwd);
  return getCopilotAccountRoutingService().classifyWorkspaceScope(cwd);
}

/**
 * Ordered licence-pinned models: every family except the implementer's, best
 * first, skipping anything the seat has already told us it will not serve.
 *
 * Round-robin across families rather than one-model-per-family. The first pass
 * spans as many distinct vendors as possible (the point of the exercise); later
 * passes deepen within each family so a caller asking for more checkers than
 * there are families still gets one distinct model each. Taking only the first
 * model per family capped every licence-pinned plan at four candidates, which
 * silently dropped participants from a five-provider consensus panel.
 */
function licencePinnedModels(
  implementerFamily: ModelFamily,
  profileId: string,
  isUnavailable: (profileId: string | undefined, model: string) => boolean,
  wanted = 1,
): string[] {
  const eligibleFamilies = FAMILY_PREFERENCE.filter(
    // An UNKNOWN implementer family excludes nothing — we never guess our way
    // into dropping a perfectly good checker.
    (family) => implementerFamily === 'unknown' || family !== implementerFamily,
  );
  const perFamily = eligibleFamilies.map((family) =>
    (COPILOT_CHECKER_MODELS[family] ?? []).filter((model) => !isUnavailable(profileId, model)),
  );
  const deepest = Math.max(0, ...perFamily.map((models) => models.length));

  const picked: string[] = [];
  for (let round = 0; round < deepest && picked.length < wanted; round += 1) {
    for (const models of perFamily) {
      if (picked.length >= wanted) break;
      const model = models[round];
      if (model) picked.push(model);
    }
  }
  return picked;
}

/**
 * A different-family model this provider can actually run, or undefined.
 *
 * Copilot uses the seat-verified table above. Every OTHER provider is resolved
 * from the app's own curated catalog, so an id we hand back is always one the
 * picker itself offers and the list tracks catalog regeneration instead of
 * rotting. This matters for Cursor in particular: it is genuinely multi-vendor
 * (Claude, Codex/GPT and Composer models from one CLI), so treating it as
 * single-family would let a Cursor checker silently run the implementer's own
 * family.
 *
 * Single-family providers (the Claude CLI, the Codex CLI, Gemini) simply have no
 * candidate in another family and return undefined, which keeps them running
 * unchanged rather than being dropped.
 */
function diverseModelFor(
  provider: string,
  implementerModel: string | undefined,
  isUnavailable: (profileId: string | undefined, model: string) => boolean,
): string | undefined {
  const implementerFamily = modelFamily(implementerModel);
  if (implementerFamily === 'unknown') return undefined;
  for (const family of FAMILY_PREFERENCE) {
    if (family === implementerFamily) continue;
    const model = providerModelForFamily(provider, family, isUnavailable);
    if (model) return model;
  }
  return undefined;
}

/**
 * A model this provider can run from a specific vendor, or undefined.
 *
 * Copilot uses the seat-verified table; every other provider is resolved from
 * the app's own curated catalog, so an id handed back is always one the picker
 * itself offers and the list tracks catalog regeneration instead of rotting.
 *
 * Exported for the verification panel, whose diversity problem is
 * panel-INTERNAL (agents must differ from each other, not from an implementer),
 * so it cannot use `resolveCheckerPlan` and needs this primitive directly.
 */
export function providerModelForFamily(
  provider: string,
  family: ModelFamily,
  isUnavailable: (profileId: string | undefined, model: string) => boolean = isModelKnownUnavailable,
): string | undefined {
  if (provider === 'copilot') {
    return (COPILOT_CHECKER_MODELS[family] ?? []).find((model) => !isUnavailable('', model));
  }
  const catalog = PROVIDER_MODEL_LIST[provider] ?? [];
  return catalog.find((entry) => modelFamily(entry.id) === family)?.id;
}

/**
 * Turn the providers a caller was going to use into a concrete checker plan.
 *
 * `requested` is the provider list the existing selection logic produced. Outside
 * the licence-pinned branch it never adds or removes a provider — each one comes
 * back, re-modelled or unchanged. The licence-pinned branch REPLACES the list
 * with checkers on the employer's seat, keeping the same count wherever the seat
 * has enough distinct models to do so.
 */
export function resolveCheckerPlan(
  requested: readonly string[],
  ctx: CheckerContext,
  deps: CheckerPlanDeps = {},
): CheckerPlan {
  const resolveProviderModel = deps.resolveProviderModel ?? resolveReviewerModelOverride;
  const isUnavailable = deps.isModelUnavailable ?? isModelKnownUnavailable;
  const scope = classify(ctx.workingDirectory, deps);

  if (scope.kind === 'ambiguous' || scope.kind === 'indeterminate') {
    const blockedReason =
      scope.kind === 'ambiguous'
        ? `workspace is claimed by more than one protected Copilot scope (${scope.profileIds.join(', ')}), so the licence boundary is unclear`
        : `Copilot account scope could not be determined (${scope.reason}), so the licence boundary is unclear`;
    logger.warn('Checker plan blocked — licence scope unresolved', {
      context: ctx.context,
      scope: scope.kind,
      blockedReason,
    });
    return { candidates: [], blockedReason, scopeKind: scope.kind };
  }

  if (scope.kind === 'protected' && scope.accountKind === 'enterprise') {
    // Checking is machine-initiated, so a seat the operator marked `manual-only`
    // (or `disabled`) must not service it. This is enforced HERE, not left to
    // the router: the ping-pong reviewer spawns through
    // `InstanceManager.createInstance`, which tags every route request
    // `'interactive'`, and `checkAutomationPolicy`'s `manual-only` branch only
    // fires for an automatic origin. Blocking is the right outcome — the seat
    // is off limits and the code may not leave it, so there is no checker.
    if (scope.automationPolicy !== 'allow-routed') {
      const blockedReason =
        `Copilot account "${scope.profileLabel}" is ${scope.automationPolicy}, so it cannot be ` +
        'used for automatic checking, and employer code may not be checked off that seat';
      logger.warn('Checker plan blocked — enterprise seat forbids automatic use', {
        context: ctx.context,
        profileId: scope.profileId,
        automationPolicy: scope.automationPolicy,
      });
      return { candidates: [], blockedReason, scopeKind: scope.kind };
    }

    const implementerFamily = modelFamily(ctx.implementerModel);
    const wanted = Math.max(ctx.minCheckers ?? 0, requested.length);
    if (wanted === 0) {
      // The caller explicitly wanted no remote checkers. Not a policy block, so
      // no `blockedReason` — there is nothing to warn about.
      return { candidates: [], scopeKind: scope.kind };
    }
    const models = licencePinnedModels(implementerFamily, scope.profileId, isUnavailable, wanted);
    const candidates: CheckerCandidate[] = models.slice(0, wanted).map((model) => ({
      provider: 'copilot',
      model,
      rationale: 'licence-pinned' as const,
      copilotProfileId: scope.profileId,
    }));

    if (candidates.length === 0) {
      const blockedReason =
        `no model on the "${scope.profileLabel}" Copilot seat is from a different family than the implementer's ` +
        `(${ctx.implementerModel ?? 'unknown'}), and employer code may not be checked off that seat`;
      logger.warn('Checker plan blocked — no diverse model on the enterprise seat', {
        context: ctx.context,
        profileId: scope.profileId,
        implementerModel: ctx.implementerModel ?? null,
      });
      return { candidates: [], blockedReason, scopeKind: scope.kind };
    }

    logger.info('Checker plan pinned to the enterprise Copilot seat', {
      context: ctx.context,
      profileId: scope.profileId,
      implementerFamily,
      models: candidates.map((candidate) => candidate.model),
    });
    return { candidates, scopeKind: scope.kind };
  }

  const candidates = requested.map((provider): CheckerCandidate => {
    const configured = resolveProviderModel(provider);
    if (!sameFamily(configured, ctx.implementerModel)) {
      return { provider, ...(configured ? { model: configured } : {}), rationale: 'unchanged' };
    }
    const diverse = diverseModelFor(provider, ctx.implementerModel, isUnavailable);
    if (diverse) {
      logger.debug('Re-modelled a checker to avoid the implementer family', {
        context: ctx.context,
        provider,
        from: configured,
        to: diverse,
      });
      return { provider, model: diverse, rationale: 'family-diverse' };
    }
    // No diverse model for this provider. Keep it rather than lose a checker.
    return { provider, ...(configured ? { model: configured } : {}), rationale: 'unchanged' };
  });

  return { candidates, scopeKind: scope.kind };
}

/**
 * Spawn options fragment for one checker.
 *
 * `modelOverride` is present ONLY when the policy actually changed the model.
 * The execution host treats the key's presence as the decision (`Object.hasOwn`),
 * so passing it unconditionally would bypass paths that resolve their own model
 * — notably Antigravity's quota-aware multi-model fallback plan. An unchanged
 * checker must therefore carry no key at all.
 */
export function modelOverrideOptionFor(
  candidate: CheckerCandidate,
): { modelOverride: string } | Record<string, never> {
  if (candidate.rationale === 'unchanged' || !candidate.model) return {};
  return { modelOverride: candidate.model };
}
