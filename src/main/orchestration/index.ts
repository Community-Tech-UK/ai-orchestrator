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

// === Lazy Loading Getters ===
// Use these instead of direct imports for optional coordinators.
// The coordinator module is only loaded when first called.

import type { DebateCoordinator } from './debate-coordinator';
import type { MultiVerifyCoordinator } from './multi-verify-coordinator';
import type { ConsensusCoordinator } from './consensus-coordinator';
import type { ParallelWorktreeCoordinator } from './parallel-worktree-coordinator';
import { ORCHESTRATION_FEATURES } from '../../shared/constants/feature-flags';

let _debateCoordinator: DebateCoordinator | null = null;
let _multiVerifyCoordinator: MultiVerifyCoordinator | null = null;
let _consensusCoordinator: ConsensusCoordinator | null = null;
let _parallelWorktreeCoordinator: ParallelWorktreeCoordinator | null = null;

export async function getLazyDebateCoordinator(): Promise<DebateCoordinator | null> {
  if (!ORCHESTRATION_FEATURES.DEBATE_SYSTEM) return null;
  if (!_debateCoordinator) {
    const { DebateCoordinator } = await import('./debate-coordinator');
    _debateCoordinator = DebateCoordinator.getInstance();
  }
  return _debateCoordinator;
}

export async function getLazyMultiVerifyCoordinator(): Promise<MultiVerifyCoordinator | null> {
  if (!ORCHESTRATION_FEATURES.VERIFICATION_SYSTEM) return null;
  if (!_multiVerifyCoordinator) {
    const { MultiVerifyCoordinator } = await import('./multi-verify-coordinator');
    _multiVerifyCoordinator = MultiVerifyCoordinator.getInstance();
  }
  return _multiVerifyCoordinator;
}

export async function getLazyConsensusCoordinator(): Promise<ConsensusCoordinator | null> {
  if (!ORCHESTRATION_FEATURES.CONSENSUS_SYSTEM) return null;
  if (!_consensusCoordinator) {
    const { ConsensusCoordinator } = await import('./consensus-coordinator');
    _consensusCoordinator = ConsensusCoordinator.getInstance();
  }
  return _consensusCoordinator;
}

export async function getLazyParallelWorktreeCoordinator(): Promise<ParallelWorktreeCoordinator | null> {
  if (!ORCHESTRATION_FEATURES.PARALLEL_WORKTREE) return null;
  if (!_parallelWorktreeCoordinator) {
    const { ParallelWorktreeCoordinator } = await import('./parallel-worktree-coordinator');
    _parallelWorktreeCoordinator = ParallelWorktreeCoordinator.getInstance();
  }
  return _parallelWorktreeCoordinator;
}

/** Reset all lazy-loaded coordinators (for testing) */
export function resetLazyCoordinators(): void {
  _debateCoordinator = null;
  _multiVerifyCoordinator = null;
  _consensusCoordinator = null;
  _parallelWorktreeCoordinator = null;
}
