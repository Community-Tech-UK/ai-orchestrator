/**
 * Debate Types
 * Multi-round debate for complex decisions
 *
 * Building on Phase 7's multi-verification, adds multi-round debate:
 * Round 1: Independent responses - N diverse answers
 * Round 2: Cross-critique - Each agent critiques others
 * Round 3: Defense & revision - Agents defend/revise positions
 * Round 4: Synthesis - Moderator extracts best elements
 */

// ============ Configuration ============

export interface DebateConfig {
  agents: number; // Number of debating agents
  maxRounds: number; // Maximum debate rounds
  convergenceThreshold: number; // Agreement level to stop early (0-1)
  synthesisModel: string; // Model for final synthesis
  temperatureRange: [number, number]; // Diversity via temperature
  timeout: number; // Max time in ms
}

// ============ Round Types ============

export type DebateRoundType = 'initial' | 'critique' | 'defense' | 'synthesis';

export interface DebateSessionRound {
  roundNumber: number;
  type: DebateRoundType;
  contributions: DebateContribution[];
  consensusScore: number; // 0-1, how much agents agree
  timestamp: number;
  durationMs: number;
}

// ============ Contributions ============

export interface DebateContribution {
  agentId: string;
  content: string;
  critiques?: AgentCritique[];
  defenses?: string[];
  confidence: number;
  reasoning: string;
}

export type CritiqueSeverity = 'major' | 'minor' | 'suggestion';

export interface AgentCritique {
  targetAgentId: string;
  issue: string;
  severity: CritiqueSeverity;
  counterpoint?: string;
}

// ============ Debate Result ============

export interface DebateResult {
  id: string;
  query: string;
  rounds: DebateSessionRound[];
  synthesis: string;
  consensusReached: boolean;
  finalConsensusScore: number;
  keyAgreements: string[];
  unresolvedDisagreements: string[];
  tokensUsed: number;
  duration: number;
  status: DebateStatus;
}

export type DebateStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'paused' | 'early_terminated';

// ============ Active Debate State ============

export interface ActiveDebate {
  id: string;
  config: DebateConfig;
  query: string;
  context?: string;
  /** Originating instance ID for provider routing */
  instanceId?: string;
  /** Explicit provider override for LLM invocation */
  provider?: string;
  currentRound: number;
  rounds: DebateSessionRound[];
  startTime: number;
  status: DebateStatus;
}

// ============ Agent Configuration ============

export interface DebateAgentConfig {
  id: string;
  model: string;
  temperature: number;
  systemPrompt?: string;
  personality?: string; // e.g., "skeptical", "optimistic", "analytical"
}

// ============ Consensus Calculation ============

export interface ConsensusAnalysis {
  overallScore: number; // 0-1
  agreements: ConsensusAgreement[];
  disagreements: ConsensusDisagreement[];
  undecided: string[];
}

export interface ConsensusAgreement {
  topic: string;
  confidence: number;
  supportingAgents: string[];
}

export interface ConsensusDisagreement {
  topic: string;
  positions: Map<string, string>; // agentId -> position
  severity: CritiqueSeverity;
}

// ============ Synthesis Request ============

export interface SynthesisRequest {
  debateId: string;
  rounds: DebateSessionRound[];
  consensusAnalysis: ConsensusAnalysis;
  preferredApproach?: 'conservative' | 'balanced' | 'comprehensive';
}

// ============ Statistics ============

export interface DebateStats {
  totalDebates: number;
  avgRounds: number;
  avgConsensusScore: number;
  consensusRate: number; // % that reached convergence threshold
  avgDurationMs: number;
  avgTokensUsed: number;
}
