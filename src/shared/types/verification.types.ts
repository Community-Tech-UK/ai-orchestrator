/**
 * Verification Types - Multi-agent verification with diverse perspectives
 * Based on validated research: arXiv:2502.20379 (MAV), DelphiAgent, Byzantine FT
 */

import type { DebateSessionRound } from './debate.types';

export type SynthesisStrategy =
  | 'consensus' // Use points N-1 agents agree on
  | 'best-of' // Rank and select highest quality
  | 'merge' // Synthesize best elements from all
  | 'majority-vote' // Democratic voting on key points
  | 'debate' // Multi-round debate with final synthesis
  | 'hierarchical'; // Fast filter then deep analysis

export type PersonalityType =
  | 'methodical-analyst'
  | 'creative-solver'
  | 'pragmatic-engineer'
  | 'security-focused'
  | 'user-advocate'
  | 'devils-advocate'
  | 'domain-expert'
  | 'generalist';

export interface AgentHealthConfig {
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
  minSuccessfulAgents: number;
}

export interface VerificationConfig {
  agentCount: number; // Minimum 3 for meaningful verification
  models?: string[]; // Different models for diversity
  personalities?: PersonalityType[]; // Personality prompts for perspective diversity
  timeout: number; // Max time per agent (ms)
  synthesisStrategy: SynthesisStrategy;
  minAgreement?: number; // Minimum agents that must agree (for consensus)
  confidenceThreshold?: number; // Minimum confidence to include in synthesis
  maxDebateRounds?: number; // For debate strategy
  healthConfig?: AgentHealthConfig; // Agent health and retry configuration
  useSemanticClustering?: boolean; // Use embedding-based clustering (default: true)
}

export interface VerificationRequest {
  id: string;
  instanceId: string;
  prompt: string; // Original user prompt
  config: VerificationConfig;
  context?: string; // Additional context to include
  taskType?: string; // Task classification for strategy selection
  attachments?: { name: string; mimeType: string; data: string }[]; // Base64 encoded files
}

export interface AgentResponse {
  agentId: string;
  agentIndex: number;
  model: string;
  personality?: PersonalityType;

  // Response
  response: string;
  keyPoints: ExtractedKeyPoint[]; // Structured key points
  confidence: number; // Self-reported confidence (0-1)
  reasoning?: string; // Reasoning trace

  // Metrics
  duration: number;
  tokens: number;
  cost: number;

  // Status
  error?: string;
  timedOut?: boolean;
}

export interface ExtractedKeyPoint {
  id: string;
  content: string;
  category: 'conclusion' | 'recommendation' | 'warning' | 'fact' | 'opinion';
  confidence: number;
  supportingEvidence?: string;
}

export interface VerificationAnalysis {
  // Agreement analysis (validated from research)
  agreements: AgreementPoint[]; // Points all/most agents agree on
  disagreements: DisagreementPoint[]; // Points with varying opinions
  uniqueInsights: UniqueInsight[]; // Points only one agent raised

  // Quality assessment
  responseRankings: ResponseRanking[];
  overallConfidence: number; // Combined confidence (0-1)

  // Byzantine detection (N >= 3f+1)
  outlierAgents: string[]; // Agents with significantly different responses
  consensusStrength: number; // 0-1, how strong is the consensus
}

export interface AgreementPoint {
  point: string;
  category: ExtractedKeyPoint['category'];
  agentIds: string[];
  strength: number; // 0-1 based on how many agreed
  combinedConfidence: number; // Average confidence of agreeing agents
}

export interface DisagreementPoint {
  topic: string;
  positions: {
    agentId: string;
    position: string;
    confidence: number;
    reasoning?: string;
  }[];
  resolution?: string; // Synthesized resolution if available
  requiresHumanReview: boolean; // Flag for human escalation
}

export interface UniqueInsight {
  point: string;
  category: ExtractedKeyPoint['category'];
  agentId: string;
  confidence: number;
  value: 'high' | 'medium' | 'low'; // Assessed value of the insight
  reasoning: string;
}

export interface ResponseRanking {
  agentId: string;
  rank: number;
  score: number;
  criteria: {
    completeness: number;
    accuracy: number;
    clarity: number;
    reasoning: number;
  };
}

export interface VerificationResult {
  id: string;
  request: VerificationRequest;

  // Individual responses
  responses: AgentResponse[];

  // Analysis
  analysis: VerificationAnalysis;

  // Synthesized output
  synthesizedResponse: string;
  synthesisMethod: SynthesisStrategy;
  synthesisConfidence: number;

  // Metadata
  totalDuration: number;
  totalTokens: number;
  totalCost: number;
  completedAt: number;

  // Audit trail
  debateRounds?: DebateSessionRound[];
}

/**
 * @deprecated Use DebateSessionRound from debate.types.ts instead
 */
export interface DebateRound {
  round: number;
  exchanges: {
    agentId: string;
    argument: string;
    rebuttal?: string;
    positionChange?: boolean;
  }[];
  convergenceScore: number; // How much agents converged this round
}

// Progress tracking
export interface VerificationProgress {
  phase: 'spawning' | 'collecting' | 'analyzing' | 'synthesizing' | 'complete';
  completedAgents: number;
  totalAgents: number;
  currentActivity: string;
  partialResults?: Partial<VerificationResult>;
  timestamp: number;
}

// Events
export type VerificationEventType =
  | 'verification:started'
  | 'verification:agents-launching'
  | 'verification:agent-completed'
  | 'verification:invoke-agent'
  | 'verification:progress'
  | 'verification:synthesize'
  | 'verification:completed'
  | 'verification:error';

export interface VerificationEvent {
  type: VerificationEventType;
  request?: VerificationRequest;
  result?: VerificationResult;
  agentId?: string;
  error?: string;
}

// Helper functions
export function createDefaultVerificationConfig(): VerificationConfig {
  return {
    agentCount: 3,
    timeout: 60000,
    synthesisStrategy: 'merge',
    confidenceThreshold: 0.6,
    maxDebateRounds: 3,
  };
}

export function calculateByzantineTolerance(agentCount: number): number {
  // N >= 3f + 1, so f = (N - 1) / 3
  return Math.floor((agentCount - 1) / 3);
}

export function isVerificationComplete(result: VerificationResult): boolean {
  return result.completedAt !== undefined;
}

export function getConsensusThreshold(agentCount: number): number {
  // 66% agreement required for consensus
  return Math.ceil(agentCount * 0.66);
}

export function getMajorityThreshold(agentCount: number): number {
  // 50% + 1 for majority
  return Math.ceil(agentCount / 2);
}
