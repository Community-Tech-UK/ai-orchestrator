/**
 * Answer Agent
 * Memory-R1 component that uses retrieved memories to generate responses
 * Based on arXiv:2508.19828 - learns what context is helpful through RL
 */

import { EventEmitter } from 'events';
import type {
  MemoryEntry,
  AnswerAgentContext,
} from '../../shared/types/memory-r1.types';

export interface AnswerConfig {
  maxContextTokens: number;
  minRelevanceScore: number;
  preferRecentMemories: boolean;
  includeReasoning: boolean;
  diversityWeight: number; // 0-1, higher = more diverse memory selection
}

export interface AnswerRequest {
  query: string;
  taskId: string;
  retrievedMemories: MemoryEntry[];
  additionalContext?: string;
}

export interface AnswerResponse {
  id: string;
  content: string;
  selectedMemories: MemoryEntry[];
  reasoning?: string;
  confidence: number;
  tokensUsed: number;
}

export interface MemorySelection {
  selected: MemoryEntry[];
  reasons: Map<string, string>;
  totalRelevance: number;
}

export interface SelectionFeedback {
  answerId: string;
  taskId: string;
  success: boolean;
  score: number;
  selectedMemoryIds: string[];
}

export class AnswerAgent extends EventEmitter {
  private static instance: AnswerAgent;
  private config: AnswerConfig;
  private selectionHistory: Map<string, SelectionFeedback[]> = new Map();

  private defaultConfig: AnswerConfig = {
    maxContextTokens: 8000,
    minRelevanceScore: 0.3,
    preferRecentMemories: true,
    includeReasoning: true,
    diversityWeight: 0.3,
  };

  static getInstance(): AnswerAgent {
    if (!this.instance) {
      this.instance = new AnswerAgent();
    }
    return this.instance;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
  }

  configure(config: Partial<AnswerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============ Answer Generation ============

  async generateAnswer(request: AnswerRequest): Promise<AnswerResponse> {
    const startTime = Date.now();

    this.emit('answer:started', { query: request.query, taskId: request.taskId });

    // 1. Select relevant memories
    const selection = this.selectMemories(request.retrievedMemories, request.query);

    // 2. Build context
    const context = this.buildContext(selection.selected, request.additionalContext);

    // 3. Generate response (placeholder - actual impl calls LLM)
    const content = await this.callLLM(request.query, context);

    // 4. Calculate confidence based on selection quality
    const confidence = this.calculateConfidence(selection);

    const response: AnswerResponse = {
      id: `answer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      content,
      selectedMemories: selection.selected,
      reasoning: this.config.includeReasoning ? this.generateReasoning(selection) : undefined,
      confidence,
      tokensUsed: this.estimateTokens(context) + this.estimateTokens(content),
    };

    // Update access counts
    for (const memory of selection.selected) {
      memory.accessCount++;
      memory.lastAccessedAt = Date.now();
    }

    this.emit('answer:completed', {
      answerId: response.id,
      taskId: request.taskId,
      memoryCount: selection.selected.length,
      confidence,
    });

    return response;
  }

  // ============ Memory Selection ============

  private selectMemories(memories: MemoryEntry[], query: string): MemorySelection {
    const selected: MemoryEntry[] = [];
    const reasons = new Map<string, string>();
    let usedTokens = 0;

    // Score and sort memories
    const scored = memories
      .filter(m => m.relevanceScore >= this.config.minRelevanceScore)
      .map(memory => ({
        memory,
        score: this.calculateMemoryScore(memory, query),
      }))
      .sort((a, b) => b.score - a.score);

    // Select top memories within token budget
    const selectedTopics = new Set<string>();

    for (const { memory, score } of scored) {
      const tokens = this.estimateTokens(memory.content);

      if (usedTokens + tokens > this.config.maxContextTokens) {
        continue;
      }

      // Diversity check - avoid redundant information
      const topic = this.extractTopic(memory);
      if (selectedTopics.has(topic) && Math.random() > this.config.diversityWeight) {
        continue;
      }

      selected.push(memory);
      selectedTopics.add(topic);
      usedTokens += tokens;
      reasons.set(memory.id, this.generateSelectionReason(memory, score));
    }

    const totalRelevance = selected.reduce((sum, m) => sum + m.relevanceScore, 0) / Math.max(selected.length, 1);

    return { selected, reasons, totalRelevance };
  }

  private calculateMemoryScore(memory: MemoryEntry, query: string): number {
    let score = memory.relevanceScore * 0.4;

    // Confidence contribution
    score += memory.confidenceScore * 0.2;

    // Recency contribution
    if (this.config.preferRecentMemories) {
      const age = Date.now() - memory.updatedAt;
      const recencyScore = Math.max(0, 1 - age / (30 * 24 * 60 * 60 * 1000)); // Decay over 30 days
      score += recencyScore * 0.2;
    }

    // Query similarity contribution
    const similarity = this.calculateSimilarity(memory.content, query);
    score += similarity * 0.2;

    return Math.min(1, score);
  }

  private calculateSimilarity(content: string, query: string): number {
    const contentWords = new Set(content.toLowerCase().split(/\s+/));
    const queryWords = query.toLowerCase().split(/\s+/);
    const matches = queryWords.filter(w => contentWords.has(w)).length;
    return queryWords.length > 0 ? matches / queryWords.length : 0;
  }

  private extractTopic(memory: MemoryEntry): string {
    // Simple topic extraction based on tags or first few words
    if (memory.tags.length > 0) {
      return memory.tags[0];
    }
    return memory.content.split(/\s+/).slice(0, 5).join(' ').toLowerCase();
  }

  private generateSelectionReason(memory: MemoryEntry, score: number): string {
    const reasons: string[] = [];

    if (memory.relevanceScore > 0.7) {
      reasons.push('high relevance');
    }
    if (memory.confidenceScore > 0.7) {
      reasons.push('high confidence');
    }
    if (memory.accessCount > 5) {
      reasons.push('frequently accessed');
    }

    return reasons.length > 0
      ? `Selected (score: ${score.toFixed(2)}): ${reasons.join(', ')}`
      : `Selected with score: ${score.toFixed(2)}`;
  }

  // ============ Context Building ============

  private buildContext(memories: MemoryEntry[], additionalContext?: string): string {
    const parts: string[] = [];

    if (additionalContext) {
      parts.push(`## Additional Context\n${additionalContext}`);
    }

    if (memories.length > 0) {
      parts.push('## Retrieved Memories');
      for (const memory of memories) {
        parts.push(`### Memory (relevance: ${memory.relevanceScore.toFixed(2)})`);
        parts.push(memory.content);
        if (memory.tags.length > 0) {
          parts.push(`Tags: ${memory.tags.join(', ')}`);
        }
      }
    }

    return parts.join('\n\n');
  }

  // ============ Reasoning ============

  private calculateConfidence(selection: MemorySelection): number {
    if (selection.selected.length === 0) {
      return 0.3; // Low confidence without memories
    }

    // Base confidence from relevance
    let confidence = selection.totalRelevance * 0.6;

    // Bonus for having multiple supporting memories
    const memoryCountBonus = Math.min(0.2, selection.selected.length * 0.05);
    confidence += memoryCountBonus;

    // Bonus for high-confidence memories
    const highConfCount = selection.selected.filter(m => m.confidenceScore > 0.7).length;
    confidence += (highConfCount / selection.selected.length) * 0.2;

    return Math.min(0.95, confidence);
  }

  private generateReasoning(selection: MemorySelection): string {
    const parts: string[] = [];

    parts.push(`Selected ${selection.selected.length} memories for context.`);
    parts.push(`Average relevance: ${selection.totalRelevance.toFixed(2)}`);

    if (selection.selected.length > 0) {
      parts.push('Key reasons:');
      for (const [id, reason] of Array.from(selection.reasons.entries()).slice(0, 3)) {
        parts.push(`- ${id}: ${reason}`);
      }
    }

    return parts.join('\n');
  }

  // ============ Feedback Processing ============

  recordFeedback(feedback: SelectionFeedback): void {
    const history = this.selectionHistory.get(feedback.taskId) || [];
    history.push(feedback);
    this.selectionHistory.set(feedback.taskId, history);

    this.emit('feedback:recorded', feedback);
  }

  getSelectionStats(taskId?: string): {
    totalSelections: number;
    avgMemoriesSelected: number;
    successRate: number;
    avgScore: number;
  } {
    const feedbacks = taskId
      ? this.selectionHistory.get(taskId) || []
      : Array.from(this.selectionHistory.values()).flat();

    if (feedbacks.length === 0) {
      return {
        totalSelections: 0,
        avgMemoriesSelected: 0,
        successRate: 0,
        avgScore: 0,
      };
    }

    const totalSelections = feedbacks.length;
    const avgMemoriesSelected =
      feedbacks.reduce((sum, f) => sum + f.selectedMemoryIds.length, 0) / totalSelections;
    const successRate = feedbacks.filter(f => f.success).length / totalSelections;
    const avgScore = feedbacks.reduce((sum, f) => sum + f.score, 0) / totalSelections;

    return { totalSelections, avgMemoriesSelected, successRate, avgScore };
  }

  // ============ LLM Integration ============

  private async callLLM(query: string, context: string): Promise<string> {
    // Placeholder - actual implementation calls the LLM API
    return `Response to "${query.slice(0, 50)}..." generated with ${this.estimateTokens(context)} tokens of context.`;
  }

  // ============ Utilities ============

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  // ============ Context for Training ============

  createTrainingContext(
    query: string,
    response: AnswerResponse
  ): AnswerAgentContext {
    return {
      query,
      retrievedMemories: response.selectedMemories,
      selectedMemories: response.selectedMemories,
      response: response.content,
      tokensUsed: response.tokensUsed,
    };
  }
}

// Export singleton getter
export function getAnswerAgent(): AnswerAgent {
  return AnswerAgent.getInstance();
}
