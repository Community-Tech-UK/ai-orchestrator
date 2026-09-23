/**
 * Orchestration Module
 * Multi-agent coordination, supervision, and task management
 */

// Core orchestration
export { OrchestrationHandler } from './orchestration-handler';
export type { OrchestrationContext, OrchestrationEvents, ChildInfo, UserActionRequest } from './orchestration-handler';
export { OrchestrationEngine } from './orchestration-engine';
export type { OrchestrationCommand, OrchestrationCommandType } from './orchestration-commands';
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
import { ORCHESTRATION_FEATURES } from '../../shared/constants/feature-flags';

let _debateCoordinator: DebateCoordinator | null = null;
let _multiVerifyCoordinator: MultiVerifyCoordinator | null = null;
let _consensusCoordinator: ConsensusCoordinator | null = null;

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

/** Reset all lazy-loaded coordinators (for testing) */
export function resetLazyCoordinators(): void {
  _debateCoordinator = null;
  _multiVerifyCoordinator = null;
  _consensusCoordinator = null;
}
