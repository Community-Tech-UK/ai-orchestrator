/**
 * Local types for the instance module
 */

import type { ContextSection } from '../../shared/types/rlm.types';

/**
 * RLM context retrieval result
 */
export type RlmContextInfo = {
  context: string;
  tokens: number;
  sectionsAccessed: string[];
  durationMs: number;
  source: 'semantic' | 'lexical' | 'hybrid';
};

/**
 * Context budget allocation for RLM and unified memory
 */
export type ContextBudget = {
  totalTokens: number;
  rlmMaxTokens: number;
  unifiedMaxTokens: number;
  rlmTopK: number;
};

/**
 * Ranked RLM section with hybrid scoring
 */
export type RankedSection = {
  section: ContextSection;
  score: number;
  semanticScore: number;
  lexicalScore: number;
};

/**
 * Unified memory context retrieval result
 */
export type UnifiedMemoryContextInfo = {
  context: string;
  tokens: number;
  longTermCount: number;
  proceduralCount: number;
  durationMs: number;
};

/**
 * Fast-path search result for simple retrieval tasks
 */
export type FastPathResult = {
  mode: 'grep' | 'files' | 'indexed-codebase';
  command: string;
  args: string[];
  totalMatches: number;
  lines: string[];
  rawOutput: string;
  cwd: string;
};
