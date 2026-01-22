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
