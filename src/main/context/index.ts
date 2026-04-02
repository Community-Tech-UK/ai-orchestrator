/**
 * Context Management Module
 *
 * Intelligent context compaction and management
 */

export * from './context-compactor';
export * from './jit-loader';
export { ErrorWithholder, RecoveryOutcome, type RecoveryResult, type RecoveryStrategy } from './error-withholder';
export { OutputTokenEscalator, type EscalatorConfig, type EscalationResult } from './output-token-escalator';
export { ContinuationInjector, type ConversationMessage } from './continuation-injector';
export { Microcompact, type MicrocompactConfig, type MicrocompactTurn, type MicrocompactResult } from './microcompact';
export { TokenBudgetTracker, BudgetAction, type BudgetCheckResult, type TokenBudgetConfig } from './token-budget-tracker';
export { CompactionEpochTracker, type CompactionEpoch, type CompactionRecord } from './compaction-epoch';
export { ContextCollapse, type ContextCollapseConfig, type CollapsibleTurn } from './context-collapse';
