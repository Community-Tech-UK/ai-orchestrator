/**
 * Orchestration Module
 * Multi-agent coordination, supervision, and task management
 */

// Core orchestration
export { OrchestrationHandler } from './orchestration-handler';
export type { OrchestrationContext, OrchestrationEvents, ChildInfo } from './orchestration-handler';
export { TaskManager, getTaskManager } from './task-manager';
export { Supervisor, getSupervisor } from './supervisor';

// Orchestration protocol
export {
  generateOrchestrationPrompt,
  generateChildPrompt,
  parseOrchestratorCommands,
  formatCommandResponse,
  ORCHESTRATION_MARKER_START,
  ORCHESTRATION_MARKER_END,
} from './orchestration-protocol';
export type { OrchestratorAction, OrchestratorCommand } from './orchestration-protocol';

// Agent personalities
export {
  PERSONALITY_PROMPTS,
  selectPersonalities,
  getPersonalityPrompt,
  getPersonalityDescription,
  getAllPersonalities,
  isValidPersonality,
  getRecommendedPersonalities,
} from './personalities';

// Phase 7: Parallel coordination
export { ParallelWorktreeCoordinator, getParallelWorktreeCoordinator } from './parallel-worktree-coordinator';
export type {
  ParallelTask,
  ParallelExecution,
  CoordinatorConfig,
} from './parallel-worktree-coordinator';

export { SynthesisAgent, getSynthesisAgent } from './synthesis-agent';
export type {
  AgentResponse,
  SynthesisResult,
  AgreementPoint,
  DisagreementPoint,
  SynthesisStrategy,
  SynthesisConfig,
} from './synthesis-agent';

export { RestartPolicy, getRestartPolicy } from './restart-policy';
export type {
  RestartDecision,
  FailureRecord,
  WorkerState,
  RestartPolicyConfig,
} from './restart-policy';

// Multi-verification
export { MultiVerifyCoordinator, getMultiVerifyCoordinator } from './multi-verify-coordinator';
