import type { AuxiliaryLlmRoutingMode } from './auxiliary-llm.types';
import type { LocalAiFallbackPolicy } from './local-ai-guard.types';

/** Auxiliary model routing and operator-owned fallback controls. */
export interface AuxiliarySettings {
  // Auxiliary LLM (local/cheap model routing for helper calls)
  auxiliaryLlmEnabled: boolean;
  auxiliaryLlmRoutingMode: AuxiliaryLlmRoutingMode;
  auxiliaryLlmAllowRemoteWorkerModels: boolean;
  /**
   * Whether to use this (coordinator) machine's own localhost Ollama for
   * auxiliary routing. Turn off to keep offload on remote worker nodes (e.g. a
   * dedicated GPU box) without stopping the local Ollama, which other features
   * such as embeddings still use.
   */
  auxiliaryLlmUseLocalhostOllama: boolean;
  /** Optional hard daily USD ceiling for metered auxiliary cloud calls. */
  auxiliaryLlmDailySpendCapUsd: number | null;
  auxiliaryLlmEndpointsJson: string;
  auxiliaryLlmSlotsJson: string;
  /**
   * Model ids used by the per-slot quality tiers. Slots tagged `tier: 'quick'`
   * resolve to `auxiliaryLlmQuickModel` (small/fast — scoring, routing, titles)
   * and `tier: 'quality'` to `auxiliaryLlmQualityModel` (larger — compression,
   * distillation), unless a slot pins an explicit model. Empty = auto-pick.
   */
  auxiliaryLlmQuickModel: string;
  auxiliaryLlmQualityModel: string;
  /**
   * Let the auxiliary `routingClassification` slot influence Loop Mode
   * model selection. When on, each routed loop spawn asks the aux model whether
   * the task is cheap-model eligible and, if so, prefers the fast tier — at the
   * cost of one extra aux call per spawn. Default on so simple loop work can
   * downshift away from the balanced tier without a Claude call.
   */
  auxiliaryLlmRoutingClassificationEnabled: boolean;

  // Local AI Guard paid-fallback controls. These are operator-owned because
  // changing them alters consent and hard spend boundaries.
  localAiGuardDefaultFallbackPolicy: LocalAiFallbackPolicy;
  localAiGuardDailyFallbackBudgetUsd: number | null;
  localAiGuardConfirmAboveInputTokens: number | null;

  /**
   * Operator-controlled model tier per orchestration gate, as JSON.
   *
   * Before this existed, the tier for each gate was hardcoded in
   * `resolveModelForInvocation`: loop/verify/review/debate/debateSynthesis were
   * pinned to `balanced` and workflow used keyword-complexity routing. That is
   * still the default here, so behaviour is unchanged until you override a key.
   *
   * `auto` means "fall back to the router's keyword-complexity heuristic".
   * Any other value pins that gate to a fixed tier.
   *
   * This is the cheapest lever on orchestration spend: reviews and verifies are
   * bounded, read-only, diff-shaped tasks, so `{"review":"fast","verify":"fast"}`
   * moves them off the expensive tier without touching any code. Conversely a
   * gate that is producing weak output can be raised in isolation.
   *
   * @see DEFAULT_ORCHESTRATION_ROUTING_POLICY
   */
  orchestrationRoutingPolicyJson: string;

}
