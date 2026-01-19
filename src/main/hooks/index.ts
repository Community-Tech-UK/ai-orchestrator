/**
 * Hooks Module
 * Event-driven automation with command and prompt-based hooks
 */

// Core hook engine
export { HookEngine, getHookEngine } from './hook-engine';
export { builtInHookRules, getBuiltInRulesByEvent, getEnabledRulesCount } from './built-in-rules';

// Phase 6: Hook management
export { HookManager, getHookManager } from './hook-manager';
export type { HookManagerConfig, ManagedHookConfig, HookMatcher } from './hook-manager';

export { HookExecutor, getHookExecutor } from './hook-executor';
export type {
  HookExecutorConfig,
  HookConfig,
  HookExecutionContext,
  HookExecutorResult,
  CommandHook,
  PromptHook,
} from './hook-executor';

// Enhanced hook executor with blocking and chaining
export { EnhancedHookExecutor } from './enhanced-hook-executor';
export type {
  EnhancedHookConfig,
  EnhancedHookHandler,
  HookCondition,
  HookExecutionResult,
  HookTiming,
  HookAction,
  BlockingResult,
} from './enhanced-hook-executor';
