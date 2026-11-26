import type { RemoteReviewerProvider } from './reviewer-provider.types';
import type { CanonicalCliType } from './settings-primitives.types';
import type { CopilotAccountProfile, CopilotAccountRoutingRule } from './copilot-account.types';
import type { ProviderAccountPools, ProviderAccountProfile } from './provider-account.types';

/** Review models and the account routing boundaries they share. */
export interface ReviewSettings {
  // Cross-Model Review
  crossModelReviewEnabled: boolean;
  crossModelReviewDailyLimit: number;
  crossModelReviewDepth: 'structured' | 'tiered';
  crossModelReviewMaxReviewers: number;
  crossModelReviewProviders: RemoteReviewerProvider[];
  crossModelReviewTimeout: number;
  crossModelReviewTypes: string[];
  /**
   * Optional per-reviewer-CLI model override for cross-model review.
   * Keys are reviewer CLI names (e.g. 'copilot', 'antigravity', 'codex', 'cursor').
   * A missing entry, an empty string, or 'auto' means "let that provider's CLI
   * decide" — we pass no model and the CLI uses its own default/auto routing
   * (e.g. Copilot auto-routes to a GPT model). A concrete model id is forwarded
   * to the reviewer adapter as its model. This does NOT fall back to
   * getPrimaryModelForProvider, so the default behaviour is true CLI routing.
   */
  crossModelReviewModelByProvider: Record<string, string>;
  /**
   * Per-provider model for NON-INTERACTIVE automation (loop iterations and the
   * orchestration invokers). Keys are CLI names ('claude', 'codex', …).
   *
   * This exists because loops do NOT go through the interactive new-session
   * path: they resolve their model from `getDefaultModelForCli()`, so they
   * silently inherit whatever the interactive default happens to be. On
   * 2026-07-10 the codex interactive default moved to `gpt-5.6-sol` and every
   * loop iteration moved with it — flagship rates on the highest-volume path,
   * with no user-facing control and no way to see it had happened.
   *
   * A missing entry or an empty string means "fall back to the provider's
   * interactive default", which is the pre-existing behaviour. Interactive
   * sessions are unaffected by this setting.
   */
  loopModelByProvider: Record<string, string>;
  crossModelReviewLocalEnabled: boolean;
  crossModelReviewLocalSelectorId: string;
  crossModelReviewLocalTimeout: number;
  crossModelReviewLocalMaxToolRounds: number;
  /**
   * Providers barred from AUTOMATIC selection, by CLI id ('copilot', 'codex', …).
   *
   * A provider listed here is skipped by every path that picks a provider on the
   * user's behalf — cross-model and ping-pong review, consensus fan-out,
   * verification panels, scaffolding/workflow routing, magic prompts, and the
   * generic `auto` spawn fallback. It stays fully available when the user
   * explicitly chooses it for a session, or sets it as `defaultCli`.
   *
   * Exists for seats whose licence is scoped to a specific context — e.g. a
   * work Copilot subscription usable only on that employer's repositories,
   * where an automatic cross-review call would be a licence breach. Empty
   * (the default) means no restriction.
   */
  providersExcludedFromAutomation: string[];

  // GitHub Copilot account routing (2026-08-25-copilot-account-routing spec)
  /**
   * Copilot account profiles. Each one is an isolated Copilot CLI state
   * directory bound to exactly one GitHub identity, so a personal and an
   * enterprise seat can serve different repositories without a global switch.
   *
   * Contains no token, keychain reference, or filesystem path — the home
   * directory is derived on the execution node from the validated profile ID.
   * Operator-only: an agent that could add a profile or move the default could
   * route enterprise code through a personal seat.
   */
  copilotAccountProfiles: CopilotAccountProfile[];
  /**
   * Rules mapping a GitHub repository, owner, or canonical path prefix to a
   * Copilot account profile. Exact repository beats owner, owner beats the
   * longest matching path prefix, and a protected scope that cannot be resolved
   * blocks Copilot rather than falling back to the default account.
   */
  copilotAccountRoutingRules: CopilotAccountRoutingRule[];

  // Provider account pools (2026-09-13 spec). Operator-only; no tokens or paths.
  providerAccountProfiles: ProviderAccountProfile[];
  providerAccountPools: ProviderAccountPools;

  // Conversational ping-pong review (bigchange_pingpong_review)
  /**
   * Default reviewer provider for ping-pong mode. `'auto'` pairs Claude ⇄ Codex:
   * the reviewer is always the *other* member of that pair from the builder
   * (Claude builds → Codex reviews, and vice versa) before widening to another
   * installed non-builder provider if the pair is unavailable. To prefer
   * Antigravity/Copilot/etc., set an explicit provider here. A per-run override
   * exists in the loop control.
   */
  pingPongReviewerProvider: CanonicalCliType;
  /** Default hard cap on ping-pong rounds (clamped 1..20). */
  pingPongMaxRounds: number;

}
