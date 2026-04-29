/**
 * Verification Store Type Definitions
 */

import type { CliInfo, CliType } from '../../../../../shared/types/unified-cli-response';
import type {
  VerificationResult,
  PersonalityType,
  SynthesisStrategy,
} from '../../../../../shared/types/verification.types';

// ============================================
// Core Types
// ============================================

export type VerificationStatus = 'idle' | 'configuring' | 'running' | 'complete' | 'error' | 'cancelled';

export interface AgentProgress {
  agentId: string;
  name: string;
  type: 'cli' | 'api';
  personality?: PersonalityType;
  status: 'pending' | 'running' | 'complete' | 'error';
  progress: number;
  tokens: number;
  cost: number;
  currentActivity?: string;
  streamedContent?: string;
}

export interface VerificationUIConfig {
  agentCount: number;
  cliAgents: CliType[];
  synthesisStrategy: SynthesisStrategy;
  personalities: PersonalityType[];
  confidenceThreshold: number;
  minAgreement: number;
  timeout: number;
  maxDebateRounds: number;
  fallbackToApi: boolean;
  mixedMode: boolean;
}

export interface VerificationSession {
  id: string;
  prompt: string;
  context?: string;
  workingDirectory?: string;
  config: VerificationUIConfig;
  status: VerificationStatus;
  startedAt: number;
  completedAt?: number;
  currentRound?: number;
  totalRounds?: number;
  consensusScore?: number;
  agentProgress: Map<string, AgentProgress>;
  result?: VerificationResult;
  error?: string;
}

export interface CliDetectionResult {
  timestamp: number;
  detected: CliInfo[];
  available: CliInfo[];
  unavailable: CliInfo[];
}

// ============================================
// Store State
// ============================================

export interface VerificationStoreState {
  // CLI Detection
  cliDetection: CliDetectionResult | null;
  isScanning: boolean;
  scanError: string | null;

  // Current Session
  currentSession: VerificationSession | null;

  // Session History
  sessions: VerificationSession[];

  // Default Configuration
  defaultConfig: VerificationUIConfig;

  // UI State
  selectedAgents: CliType[];
  configPanelOpen: boolean;
  selectedTab: 'dashboard' | 'monitor' | 'results';
}

// ============================================
// Default Configuration
// ============================================

export const DEFAULT_VERIFICATION_CONFIG: VerificationUIConfig = {
  agentCount: 3,
  cliAgents: ['claude', 'codex', 'gemini'],
  synthesisStrategy: 'debate',
  personalities: ['methodical-analyst', 'creative-solver', 'devils-advocate'],
  confidenceThreshold: 0.7,
  minAgreement: 0.6,
  timeout: 300000,
  maxDebateRounds: 4,
  fallbackToApi: true,
  mixedMode: false,
};

// Re-export shared types for convenience
export type { CliInfo, CliType } from '../../../../../shared/types/unified-cli-response';
export type {
  VerificationResult,
  PersonalityType,
  SynthesisStrategy,
  AgentResponse,
  VerificationVerdict,
  VerificationVerdictReadyPayload,
} from '../../../../../shared/types/verification.types';
