/**
 * Orchestration Module
 * Multi-agent coordination, supervision, and task management
 */

// Core orchestration
export { OrchestrationHandler } from './orchestration-handler';
export type { OrchestrationContext, OrchestrationEvents, ChildInfo, UserActionRequest } from './orchestration-handler';
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

// CLI verification extension
export {
  CliVerificationCoordinator,
  getCliVerificationCoordinator,
  CliVerificationConfig,
  AgentConfig,
} from './cli-verification-extension';

// Debate coordination
export { DebateCoordinator, getDebateCoordinator } from './debate-coordinator';

// Voting system
export { VotingSystem, getVotingSystem } from './voting';
export type {
  VotingStrategy,
  VotingSystemConfig,
  Ballot,
  BallotOption,
  Vote,
  VoteTally,
  VotingResult,
  VotingHistory,
  CreateBallotOptions,
  VotingStats,
} from './voting';

// Consensus mechanisms
export { ConsensusManager, getConsensusManager } from './consensus';
export type {
  ConsensusConfig,
  ConsensusAlgorithm,
  ConsensusProposal,
  ConsensusOption,
  ConsensusVote,
  ConsensusResult,
  LeaderElectionResult,
  ConsensusStats,
} from './consensus';

// Cross-Model Review
export { CrossModelReviewService, getCrossModelReviewService } from './cross-model-review-service';
