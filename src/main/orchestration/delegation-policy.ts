/**
 * Delegation policy (claude2_todo #17 — cost-aware delegation + deterministic
 * keyword→role router).
 *
 * A pure, dependency-free module that decides, *without burning a model call*:
 *   1. **Which role** a delegated task best fits — routed deterministically over
 *      AIO's real agent roles (`build` / `plan` / `review` / `retriever`).
 *   2. **Whether delegating is even worth it** — the "skip delegation if the
 *      overhead ≥ doing it yourself" heuristic (trivial narrow tasks shouldn't
 *      spawn a child).
 *   3. **How wide to fan out** — narrow tasks get no parallelism; broad tasks
 *      are capped (default 3) to prevent over-parallelization.
 *
 * Kept pure so it is trivially unit-testable and free of orchestration deps.
 * The 37-role *prompt library* from the source projects is intentionally out of
 * scope: AIO ships 4 agent roles, so a deterministic router over those is the
 * transferable, net-new value — not a library of prompts with no target.
 */

/** AIO's built-in agent roles (see `src/shared/types/agent.types.ts`). */
export type DelegationRole = 'build' | 'plan' | 'review' | 'retriever';

export type DelegationScope = 'narrow' | 'broad';

/** Doc: "broad → cap 3 parallel". */
export const DEFAULT_BROAD_PARALLEL = 3;

/**
 * Minimum route confidence before a caller should *act* on a routed role (e.g.
 * override an otherwise-default agent). Below this the route is too ambiguous
 * to be worth changing behavior over.
 */
export const ROUTE_CONFIDENCE_THRESHOLD = 0.5;

export interface RoleRoute {
  role: DelegationRole;
  /** 0..1 — share of matched keyword weight that went to the winning role. */
  confidence: number;
  reason: string;
}

export interface DelegationDecision {
  scope: DelegationScope;
  /** Best-effort deterministic role for the child. */
  suggestedRole: DelegationRole;
  /** Confidence in `suggestedRole` (0..1). */
  routeConfidence: number;
  /**
   * Whether spawning a child is worth the overhead. False for trivial narrow
   * tasks the lead agent should just do inline.
   */
  recommendDelegation: boolean;
  /** Max children to fan out in parallel (narrow → 1, broad → capped). */
  maxParallel: number;
  reason: string;
}

export interface DelegationPolicyOptions {
  /** Hard ceiling on parallel fan-out (e.g. `maxChildrenPerParent`). 0 = use the default. */
  maxParallelCap?: number;
}

/**
 * Keyword weights per role. Higher weight = stronger signal. Matching is
 * word-boundary, case-insensitive. `build` deliberately has no table — it is
 * the default sink when nothing else scores.
 */
const ROLE_KEYWORDS: Record<Exclude<DelegationRole, 'build'>, [string, number][]> = {
  retriever: [
    ['find', 2], ['search', 2], ['locate', 2], ['grep', 2], ['ripgrep', 2],
    ['where is', 3], ['where are', 3], ['list files', 3], ['enumerate', 2],
    ['references', 2], ['reference', 1], ['usages', 2], ['usage', 1],
    ['occurrences', 2], ['look for', 2], ['which files', 3], ['files containing', 3],
    ['show me', 1], ['identify', 1],
  ],
  review: [
    ['review', 3], ['audit', 3], ['critique', 3], ['inspect', 2],
    ['security', 3], ['vulnerability', 3], ['vulnerabilities', 3],
    ['code smell', 2], ['lint', 1], ['assess', 2], ['evaluate', 2],
    ['check for bugs', 3], ['find bugs', 2], ['sanity check', 2],
  ],
  plan: [
    ['plan', 3], ['design', 2], ['architect', 3], ['architecture', 2],
    ['strategy', 2], ['approach', 1], ['break down', 3], ['break it down', 3],
    ['scope out', 3], ['roadmap', 2], ['outline', 2], ['propose', 2],
    ['how should', 2], ['decide whether', 2],
  ],
};

/** Signals that a task is broad (multi-step / wide surface) rather than narrow. */
const BROAD_SIGNALS: [RegExp, number][] = [
  [/\bacross\b/i, 2],
  [/\bentire\b/i, 2],
  [/\bevery\b/i, 1],
  [/\ball (?:the )?(?:files|modules|components|tests|callers|usages)\b/i, 3],
  [/\bthroughout\b/i, 2],
  [/\bmigrate\b/i, 2],
  [/\bmigration\b/i, 2],
  [/\brefactor\b/i, 2],
  [/\binvestigate\b/i, 2],
  [/\bresearch\b/i, 2],
  [/\baudit\b/i, 2],
  [/\bcodebase\b/i, 2],
  [/\bend[- ]to[- ]end\b/i, 2],
  [/\band then\b/i, 1],
  [/\bmultiple\b/i, 1],
  [/\beach\b/i, 1],
];

/** Signals that a task is narrow (single, contained action). */
const NARROW_SIGNALS: [RegExp, number][] = [
  [/\bwhat is\b/i, 2],
  [/\bwhere is\b/i, 2],
  [/\bthis (?:one |single )?(?:file|function|line|method|variable)\b/i, 2],
  [/\bjust\b/i, 1],
  [/\bquick(?:ly)?\b/i, 1],
  [/\ba single\b/i, 2],
  [/\bone (?:file|function|line|test)\b/i, 2],
  [/\btypo\b/i, 2],
  [/\brename\b/i, 1],
];

function countSignals(text: string, table: [RegExp, number][]): number {
  let score = 0;
  for (const [re, weight] of table) {
    if (re.test(text)) score += weight;
  }
  return score;
}

/**
 * Deterministically route a task to the best-fit AIO role. Pure keyword scoring
 * with word-boundary, case-insensitive matching; `build` is the default sink.
 */
export function routeRole(task: string): RoleRoute {
  const text = ` ${(task ?? '').toLowerCase()} `;
  const scores: Record<DelegationRole, number> = { build: 0, plan: 0, review: 0, retriever: 0 };

  for (const role of ['retriever', 'review', 'plan'] as const) {
    for (const [kw, weight] of ROLE_KEYWORDS[role]) {
      // Word-boundary-ish match: phrase surrounded by non-word chars.
      if (kw.includes(' ')) {
        if (text.includes(` ${kw} `) || text.includes(` ${kw}.`) || text.includes(` ${kw},`)) {
          scores[role] += weight;
        }
      } else {
        const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (re.test(text)) scores[role] += weight;
      }
    }
  }

  const total = scores.retriever + scores.review + scores.plan;
  if (total === 0) {
    return { role: 'build', confidence: 0, reason: 'no role keywords matched — default build role' };
  }

  // Pick the highest-scoring specialist role (stable order on ties).
  const ranked = (['retriever', 'review', 'plan'] as const)
    .map((role) => ({ role, score: scores[role] }))
    .sort((a, b) => b.score - a.score);
  const winner = ranked[0]!;
  const confidence = winner.score / total;
  return {
    role: winner.role,
    confidence,
    reason: `routed to "${winner.role}" (score ${winner.score}/${total})`,
  };
}

/** Classify a task as narrow vs broad from breadth/narrowness signals. */
export function classifyScope(task: string): DelegationScope {
  const text = ` ${(task ?? '')} `;
  const broad = countSignals(text, BROAD_SIGNALS);
  const narrow = countSignals(text, NARROW_SIGNALS);
  // Long tasks lean broad; very short ones lean narrow.
  const lengthBias = task && task.length > 240 ? 1 : task && task.length < 60 ? -1 : 0;
  return broad + lengthBias > narrow ? 'broad' : 'narrow';
}

/**
 * Full delegation decision: role + scope + whether to delegate + fan-out cap.
 *
 * `recommendDelegation` is false only for trivial narrow tasks (short, narrow
 * scope, and either a pure retrieval lookup or no specialist signal) — the
 * "don't spawn a child if the overhead ≥ doing it yourself" rule. This is
 * advisory; callers decide whether to honor it.
 */
export function decideDelegation(
  task: string,
  options: DelegationPolicyOptions = {},
): DelegationDecision {
  const route = routeRole(task);
  const scope = classifyScope(task);
  const cap = options.maxParallelCap && options.maxParallelCap > 0
    ? Math.min(options.maxParallelCap, DEFAULT_BROAD_PARALLEL)
    : DEFAULT_BROAD_PARALLEL;
  const maxParallel = scope === 'broad' ? cap : 1;

  const trimmed = (task ?? '').trim();
  const isTrivial =
    scope === 'narrow' &&
    trimmed.length > 0 &&
    trimmed.length < 40 &&
    route.confidence < ROUTE_CONFIDENCE_THRESHOLD;

  return {
    scope,
    suggestedRole: route.role,
    routeConfidence: route.confidence,
    recommendDelegation: !isTrivial,
    maxParallel,
    reason: isTrivial
      ? `trivial narrow task — likely cheaper to do inline than delegate (${route.reason})`
      : `${scope} task — ${route.reason}; fan-out cap ${maxParallel}`,
  };
}
