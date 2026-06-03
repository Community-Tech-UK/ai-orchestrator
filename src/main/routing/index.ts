/**
 * Model Routing Module
 *
 * Provides intelligent model selection based on task complexity to optimize
 * costs while maintaining quality. Can achieve 40-85% cost savings by routing
 * simple tasks to faster, cheaper models.
 */

export {
  ModelRouter,
  getModelRouter,
  routeTask,
  DEFAULT_ROUTING_CONFIG,
  type ModelRoutingConfig,
  type RoutingDecision,
  type TaskComplexity,
  type ModelTier,
} from './model-router';

export {
  applyProviderResolution,
  resolveRoutedModel,
  type ResolveRoutedModelOptions,
} from './route-task';

export {
  HotModelSwitcher,
  getHotModelSwitcher,
  DEFAULT_HOT_SWITCHER_CONFIG,
  type HotSwitcherConfig,
  type ConversationState,
  type ConversationMessage,
  type SwitchRequest,
  type SwitchResult,
  type ProviderTransformer,
} from './hot-model-switcher';
