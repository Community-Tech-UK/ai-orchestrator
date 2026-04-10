/**
 * Wake-Up Context Types
 * Compact initialization context for cold-starting AI agents.
 * Inspired by mempalace's L0/L1 layer system.
 *
 * L0 (Identity, ~100 tokens): Fixed persona/project description
 * L1 (Essential Story, ~500-800 tokens): Auto-generated from top-importance memories
 *
 * Total wake-up cost: ~600-900 tokens, leaving 95%+ context for conversation.
 */

export type ContextLayerLevel = 'L0' | 'L1';

export interface ContextLayer {
  level: ContextLayerLevel;
  content: string;
  tokenEstimate: number;
  generatedAt: number;
}

export interface WakeHint {
  id: string;
  content: string;
  importance: number;
  room: string;
  sourceReflectionId?: string;
  sourceSessionId?: string;
  createdAt: number;
  lastUsed: number;
  usageCount: number;
}

export interface WakeContext {
  identity: ContextLayer;
  essentialStory: ContextLayer;
  totalTokens: number;
  wing?: string;
  generatedAt: number;
}

export interface WakeContextConfig {
  l0MaxTokens: number;
  l1MaxTokens: number;
  l1MaxHints: number;
  l1SnippetMaxChars: number;
  regenerateIntervalMs: number;
}

export const DEFAULT_WAKE_CONTEXT_CONFIG: WakeContextConfig = {
  l0MaxTokens: 100,
  l1MaxTokens: 800,
  l1MaxHints: 15,
  l1SnippetMaxChars: 200,
  regenerateIntervalMs: 5 * 60 * 1000,
};
