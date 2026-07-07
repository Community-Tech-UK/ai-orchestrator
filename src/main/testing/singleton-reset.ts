/**
 * Singleton Reset Utilities for Testing
 *
 * Provides utilities to reset all singleton instances during testing.
 * Call resetAllSingletonsForTesting() in beforeEach() to ensure clean state.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('SingletonReset');

/**
 * Interface for resettable singletons
 */
export interface ResettableSingleton {
  _resetForTesting(): void | Promise<void>;
}

/**
 * Registry of all resettable singletons
 */
const resettableRegistry = new Set<ResettableSingleton>();

/**
 * Register a singleton for reset during testing
 */
export function registerResettable(singleton: ResettableSingleton): void {
  resettableRegistry.add(singleton);
}

/**
 * Unregister a singleton from reset registry
 */
export function unregisterResettable(singleton: ResettableSingleton): void {
  resettableRegistry.delete(singleton);
}

/**
 * Reset all registered singletons
 * Call this in beforeEach() in your test files
 */
export async function resetAllSingletons(): Promise<void> {
  for (const singleton of resettableRegistry) {
    try {
      await singleton._resetForTesting();
    } catch (error) {
      logger.warn('Failed to reset singleton', { error: String(error) });
    }
  }
}

/**
 * Get the count of registered resettable singletons
 */
export function getResettableCount(): number {
  return resettableRegistry.size;
}

/**
 * Clear the registry (useful for cleanup after tests)
 */
export function clearResettableRegistry(): void {
  resettableRegistry.clear();
}

// ============================================
// Direct singleton imports for resetAllSingletonsForTesting()
// ============================================

// Process
import { SupervisorTree } from '../process/supervisor-tree';
import { CircuitBreakerRegistry as ProcessCircuitBreakerRegistry } from '../process/circuit-breaker';

// Core
import { ErrorRecoveryManager } from '../core/error-recovery';
import { CircuitBreakerRegistry as CoreCircuitBreakerRegistry } from '../core/circuit-breaker';
import { ClaudeMdLoader } from '../core/config/claude-md-loader';
import { HealthChecker } from '../core/system/health-checker';

// Orchestration
import { EmbeddingService } from '../orchestration/embedding-service';
import { DebateCoordinator } from '../orchestration/debate-coordinator';
import { MultiVerifyCoordinator } from '../orchestration/multi-verify-coordinator';
import { ConsensusCoordinator } from '../orchestration/consensus-coordinator';
import { ConfidenceAnalyzer } from '../orchestration/confidence-analyzer';
import { ChildResultStorage } from '../orchestration/child-result-storage';
import { VerificationCache } from '../orchestration/verification-cache';
import { ParallelWorktreeCoordinator } from '../orchestration/parallel-worktree-coordinator';
import { CliVerificationCoordinator } from '../orchestration/cli-verification-extension';
import { ConsensusManager } from '../orchestration/consensus';
import { Supervisor } from '../orchestration/supervisor';

// Observation
import { ObservationIngestor } from '../observation/observation-ingestor';
import { ObservationStore } from '../observation/observation-store';
import { ObserverAgent } from '../observation/observer-agent';
import { PolicyAdapter } from '../observation/policy-adapter';
import { ReflectorAgent } from '../observation/reflector-agent';

// Memory
import { MemoryManagerAgent } from '../memory/r1-memory-manager';
import { UnifiedMemoryController } from '../memory/unified-controller';
import { AnswerAgent } from '../memory/answer-agent';
import { ContextEditingFallback } from '../memory/context-editing-fallback';
import { CritiqueAgent } from '../memory/critique-agent';
import { CrossProjectLearner } from '../memory/cross-project-learner';
import { EpisodicStore } from '../memory/episodic-store';
import { HybridRetrievalManager } from '../memory/hybrid-retrieval';
import { ProactiveSurfacer } from '../memory/proactive-surfacer';
import { ProceduralStore } from '../memory/procedural-store';
import { PromptCacheManager } from '../memory/prompt-cache';
import { SkillsLoader } from '../memory/skills-loader';
import { TrainingLoop } from '../memory/training-loop';

// Learning
import { ABTestingEngine } from '../learning/ab-testing';
import { GRPOTrainer } from '../learning/grpo-trainer';
import { HabitTracker } from '../learning/habit-tracker';
import { MetricsCollector } from '../learning/metrics-collector';
import { OutcomeTracker } from '../learning/outcome-tracker';
import { PreferenceStore } from '../learning/preference-store';
import { PromptEnhancer } from '../learning/prompt-enhancer';
import { StrategyLearner } from '../learning/strategy-learner';

// RLM
import { RLMContextManager } from '../rlm/context-manager';
import { EmbeddingService as RLMEmbeddingService } from '../rlm/embedding-service';
import { EpisodicRLMStore } from '../rlm/episodic-rlm-store';
import { HyDEService } from '../rlm/hyde-service';
import { LLMService } from '../rlm/llm-service';
import { SmartCompactionManager } from '../rlm/smart-compaction';
import { SummarizationWorker } from '../rlm/summarization-worker';
import { TokenCounter } from '../rlm/token-counter';
import { VectorStore } from '../rlm/vector-store';

// Hooks
import { EnhancedHookExecutor } from '../hooks/enhanced-hook-executor';
import { HookEngine } from '../hooks/hook-engine';
import { HookExecutor } from '../hooks/hook-executor';
import { HookManager } from '../hooks/hook-manager';

// Skills
import { SkillLoader } from '../skills/skill-loader';
import { SkillMatcher } from '../skills/skill-matcher';
import { SkillRegistry } from '../skills/skill-registry';
import { TriggerMatcher } from '../skills/trigger-matcher';

// Security
import { FilesystemPolicy } from '../security/filesystem-policy';
import { NetworkPolicy } from '../security/network-policy';
import { PermissionManager } from '../security/permission-manager';

// Agents
import { AgentRegistry } from '../agents/agent-registry';
import { ReviewCoordinator } from '../agents/review-coordinator';
import { SpecialistRegistryManager } from '../agents/specialists/specialist-registry';

// History
import { HistoryManager } from '../history/history-manager';

// Other
import { CliDetectionService } from '../cli/cli-detection';
import { MarkdownCommandRegistry } from '../commands/markdown-command-registry';
import { ContextCompactor } from '../context/context-compactor';
import { JITContextLoader } from '../context/jit-loader';
import { _resetMagicPromptServiceForTesting } from '../magic-prompts/magic-prompt-service';
import { OrchestratorPluginManager } from '../plugins/plugin-manager';
import { RLMDatabase } from '../persistence/rlm-database';
import { FailoverManager } from '../providers/failover-manager';
import { HotModelSwitcher } from '../routing/hot-model-switcher';
import { CheckpointManager } from '../session/checkpoint-manager';
import { BackgroundTaskManager } from '../tasks/background-task-manager';
import { ToolRegistry } from '../tools/tool-registry';
import { WorkflowManager } from '../workflows/workflow-manager';
import { WorktreeManager } from '../workspace/git/worktree-manager';

// Module-level singletons (use their exported reset functions)
import { _resetLogManagerForTesting } from '../logging/logger';

/**
 * Reset all known singletons by directly calling their _resetForTesting methods.
 * Grouped by subsystem for readability.
 */
export async function resetAllSingletonsForTesting(): Promise<void> {
  // Process
  await SupervisorTree._resetForTesting();
  ProcessCircuitBreakerRegistry._resetForTesting();

  // Core
  ErrorRecoveryManager._resetForTesting();
  CoreCircuitBreakerRegistry._resetForTesting();
  ClaudeMdLoader._resetForTesting();
  HealthChecker._resetForTesting();

  // Orchestration
  EmbeddingService._resetForTesting();
  DebateCoordinator._resetForTesting();
  MultiVerifyCoordinator._resetForTesting();
  ConsensusCoordinator._resetForTesting();
  ConfidenceAnalyzer._resetForTesting();
  ChildResultStorage._resetForTesting();
  VerificationCache._resetForTesting();
  ParallelWorktreeCoordinator._resetForTesting();
  CliVerificationCoordinator._resetForTesting();
  ConsensusManager._resetForTesting();
  Supervisor._resetForTesting();

  // Observation
  ObservationIngestor._resetForTesting();
  ObservationStore._resetForTesting();
  ObserverAgent._resetForTesting();
  PolicyAdapter._resetForTesting();
  ReflectorAgent._resetForTesting();

  // Memory
  MemoryManagerAgent._resetForTesting();
  UnifiedMemoryController._resetForTesting();
  AnswerAgent._resetForTesting();
  ContextEditingFallback._resetForTesting();
  CritiqueAgent._resetForTesting();
  CrossProjectLearner._resetForTesting();
  EpisodicStore._resetForTesting();
  HybridRetrievalManager._resetForTesting();
  ProactiveSurfacer._resetForTesting();
  ProceduralStore._resetForTesting();
  PromptCacheManager._resetForTesting();
  SkillsLoader._resetForTesting();
  TrainingLoop._resetForTesting();

  // Learning
  ABTestingEngine._resetForTesting();
  GRPOTrainer._resetForTesting();
  HabitTracker._resetForTesting();
  MetricsCollector._resetForTesting();
  OutcomeTracker._resetForTesting();
  PreferenceStore._resetForTesting();
  PromptEnhancer._resetForTesting();
  StrategyLearner._resetForTesting();

  // RLM
  RLMContextManager._resetForTesting();
  RLMEmbeddingService._resetForTesting();
  EpisodicRLMStore._resetForTesting();
  HyDEService._resetForTesting();
  LLMService._resetForTesting();
  SmartCompactionManager._resetForTesting();
  SummarizationWorker._resetForTesting();
  TokenCounter._resetForTesting();
  VectorStore._resetForTesting();

  // Hooks
  EnhancedHookExecutor._resetForTesting();
  HookEngine._resetForTesting();
  HookExecutor._resetForTesting();
  HookManager._resetForTesting();

  // Skills
  SkillLoader._resetForTesting();
  SkillMatcher._resetForTesting();
  SkillRegistry._resetForTesting();
  TriggerMatcher._resetForTesting();

  // Security
  FilesystemPolicy._resetForTesting();
  NetworkPolicy._resetForTesting();
  PermissionManager._resetForTesting();

  // Agents
  AgentRegistry._resetForTesting();
  ReviewCoordinator._resetForTesting();
  SpecialistRegistryManager._resetForTesting();

  // History
  HistoryManager._resetForTesting();

  // Other
  CliDetectionService._resetForTesting();
  MarkdownCommandRegistry._resetForTesting();
  ContextCompactor._resetForTesting();
  JITContextLoader._resetForTesting();
  _resetMagicPromptServiceForTesting();
  OrchestratorPluginManager._resetForTesting();
  RLMDatabase._resetForTesting();
  FailoverManager._resetForTesting();
  HotModelSwitcher._resetForTesting();
  CheckpointManager._resetForTesting();
  BackgroundTaskManager._resetForTesting();
  ToolRegistry._resetForTesting();
  WorkflowManager._resetForTesting();
  WorktreeManager._resetForTesting();

  // Module-level singletons
  _resetLogManagerForTesting();
}
