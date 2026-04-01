/**
 * Debate Coordinator
 * Multi-round debate system for complex decisions
 *
 * Building on Phase 7's multi-verification, adds multi-round debate:
 * Round 1: Independent responses - N diverse answers
 * Round 2: Cross-critique - Each agent critiques others
 * Round 3: Defense & revision - Agents defend/revise positions
 * Round 4: Synthesis - Moderator extracts best elements
 */

import { EventEmitter } from 'events';
import type {
  DebateConfig,
  DebateSessionRound,
  DebateContribution,
  DebateResult,
  ActiveDebate,
  DebateStatus,
  AgentCritique,
  ConsensusAnalysis,
  ConsensusAgreement,
  ConsensusDisagreement,
  DebateStats,
  DebateRoundType,
  CritiqueSeverity,
} from '../../shared/types/debate.types';
import { getLogger } from '../logging/logger';
import { estimateTokens } from '../rlm/token-counter';
import { getErrorRecoveryManager } from '../core/error-recovery';
import { ErrorCategory } from '../../shared/types/error-recovery.types';

const logger = getLogger('DebateCoordinator');

/** Progress event yielded by the debate stream */
export type DebateStreamEvent =
  | { type: 'started'; debateId: string; topic: string; agentCount: number }
  | { type: 'round-started'; debateId: string; round: number; roundType: string }
  | { type: 'round-complete'; debateId: string; round: number; consensusScore: number; roundType: string }
  | { type: 'early-terminated'; debateId: string; reason: string; bestRoundScore: number }
  | { type: 'synthesis-started'; debateId: string }
  | { type: 'completed'; debateId: string; status: string; finalScore: number }
  | { type: 'error'; debateId: string; error: string };

export class DebateCoordinator extends EventEmitter {
  private static instance: DebateCoordinator | null = null;

  /** Minimum improvement needed per round to continue (2%) */
  private static readonly MIN_IMPROVEMENT_THRESHOLD = 0.02;
  /** Score drop that indicates divergence (-5%) */
  private static readonly DIVERGENCE_THRESHOLD = -0.05;
  /** Minimum rounds before divergence detection kicks in */
  private static readonly MIN_ROUNDS_FOR_DIVERGENCE = 2;

  private activeDebates = new Map<string, ActiveDebate>();
  private completedDebates = new Map<string, DebateResult>();
  private pauseGates = new Map<string, { resolve: () => void }>();
  private interventions = new Map<string, string[]>();
  private stats: DebateStats;

  private defaultConfig: DebateConfig = {
    agents: 3,
    maxRounds: 4,
    convergenceThreshold: 0.8,
    synthesisModel: 'default',
    temperatureRange: [0.3, 0.9],
    timeout: 300000, // 5 minutes
  };

  static getInstance(): DebateCoordinator {
    if (!this.instance) {
      this.instance = new DebateCoordinator();
    }
    return this.instance;
  }

  /**
   * Reset the singleton instance for testing.
   * Clears all active debates, results, and resets stats.
   */
  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.activeDebates.clear();
      this.instance.completedDebates.clear();
      this.instance.removeAllListeners();
      this.instance = null;
    }
  }

  private constructor() {
    super();
    this.stats = {
      totalDebates: 0,
      avgRounds: 0,
      avgConsensusScore: 0,
      consensusRate: 0,
      avgDurationMs: 0,
      avgTokensUsed: 0,
    };
  }

  /**
   * Check if a handler is registered for an extensibility event.
   * Logs a warning if no handler is found.
   */
  private checkExtensibilityHandler(eventName: string): void {
    const count = this.listenerCount(eventName);
    if (count === 0) {
      logger.warn(`No handlers registered for "${eventName}" event`, {
        hint: 'This is an extensibility point requiring an external handler. Register debate:* listeners in main-process integration.'
      });
      throw new Error(
        `No handler registered for ${eventName}. ` +
        'Connect an LLM invocation handler to use the debate system.'
      );
    }
  }

  // ============ Debate Lifecycle ============

  async startDebate(
    query: string,
    context?: string,
    config?: Partial<DebateConfig>,
    options?: { instanceId?: string; provider?: string }
  ): Promise<string> {
    const debateId = `debate-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const mergedConfig = { ...this.defaultConfig, ...config };

    const debate: ActiveDebate = {
      id: debateId,
      config: mergedConfig,
      query,
      context,
      instanceId: options?.instanceId,
      provider: options?.provider,
      currentRound: 0,
      rounds: [],
      startTime: Date.now(),
      status: 'in_progress',
    };

    this.activeDebates.set(debateId, debate);
    this.emit('debate:started', { debateId, query });

    // Start the debate process
    this.runDebate(debate).catch(err => {
      this.emit('debate:error', { debateId, error: err.message });
    });

    return debateId;
  }

  private async runDebate(debate: ActiveDebate): Promise<void> {
    try {
      // Round 1: Initial responses
      await this.runInitialRound(debate);

      // Rounds 2-N: Critique and defense
      while (debate.currentRound < debate.config.maxRounds - 1) {
        // Wait if paused
        await this.waitIfPaused(debate.id);

        // Check for cancellation after pause
        if (debate.status === 'cancelled') break;

        // Check for early convergence
        const lastRound = debate.rounds[debate.rounds.length - 1];
        if (lastRound.consensusScore >= debate.config.convergenceThreshold) {
          break;
        }

        // Check for divergence: if consensus is consistently dropping, stop early
        if (debate.rounds.length >= DebateCoordinator.MIN_ROUNDS_FOR_DIVERGENCE) {
          const previousRound = debate.rounds[debate.rounds.length - 2];
          const currentRound = debate.rounds[debate.rounds.length - 1];
          const scoreTrend = currentRound.consensusScore - previousRound.consensusScore;

          if (scoreTrend < DebateCoordinator.DIVERGENCE_THRESHOLD) {
            logger.info('Debate early termination: agents diverging', {
              debateId: debate.id,
              round: debate.currentRound,
              scoreTrend,
              currentScore: currentRound.consensusScore,
              previousScore: previousRound.consensusScore,
            });
            debate.status = 'early_terminated';
            break;
          }
        }

        // Check timeout
        if (Date.now() - debate.startTime > debate.config.timeout) {
          debate.status = 'timeout';
          break;
        }

        // Inject any pending interventions as additional context
        const pendingInterventions = this.interventions.get(debate.id);
        if (pendingInterventions && pendingInterventions.length > 0) {
          const interventionContext = pendingInterventions.join('\n\n');
          debate.context = debate.context
            ? `${debate.context}\n\n[User Intervention]:\n${interventionContext}`
            : `[User Intervention]:\n${interventionContext}`;
          this.interventions.set(debate.id, []);
          this.emit('debate:intervention-applied', { debateId: debate.id });
        }

        // Alternate between critique and defense rounds
        if (debate.currentRound % 2 === 1) {
          await this.runCritiqueRound(debate);
        } else {
          await this.runDefenseRound(debate);
        }
      }

      // Final synthesis round (or early-termination fallback)
      if (debate.status === 'early_terminated') {
        // Use the round with the highest consensus score instead of synthesizing
        const bestRound = debate.rounds.reduce((best, round) =>
          round.consensusScore > best.consensusScore ? round : best
        );

        logger.info('Using best round as debate result', {
          debateId: debate.id,
          bestRoundNumber: bestRound.roundNumber ?? debate.rounds.indexOf(bestRound),
          bestScore: bestRound.consensusScore,
        });

        this.emit('debate:early-terminated', {
          debateId: debate.id,
          reason: 'divergence',
          bestRoundScore: bestRound.consensusScore,
          roundsCompleted: debate.rounds.length,
        });
      } else if (debate.status === 'in_progress') {
        await this.runSynthesisRound(debate);
        debate.status = 'completed';
      }

      // Finalize the debate
      this.finalizeDebate(debate);
    } catch (error) {
      const classified = getErrorRecoveryManager().classifyError(error as Error, 'DebateCoordinator');
      logger.warn('Debate failed', {
        debateId: debate.id,
        category: classified.category,
        severity: classified.severity,
        recoverable: classified.recoverable,
        message: classified.technicalDetails,
      });

      // Always emit debate:error — runDebate has no retry loop, so suppressing
      // transient errors would silently swallow failures with no recovery path.
      debate.status = 'cancelled';
      this.emit('debate:error', { debateId: debate.id, error: (error as Error).message });
    }
  }

  // ============ Round Implementations ============

  private async runInitialRound(debate: ActiveDebate): Promise<void> {
    const roundStart = Date.now();
    const contributions: DebateContribution[] = [];

    // Generate diverse responses from each agent in parallel
    const results = await Promise.all(
      Array.from({ length: debate.config.agents }, (_, i) => {
        const temperature = this.getAgentTemperature(i, debate.config);
        return this.generateInitialResponse(debate, i, temperature);
      })
    );
    contributions.push(...results);

    const round: DebateSessionRound = {
      roundNumber: 1,
      type: 'initial',
      contributions,
      consensusScore: this.calculateConsensus(contributions),
      timestamp: Date.now(),
      durationMs: Date.now() - roundStart,
    };

    debate.rounds.push(round);
    debate.currentRound = 1;

    this.emit('debate:round-complete', { debateId: debate.id, round });
  }

  private async runCritiqueRound(debate: ActiveDebate): Promise<void> {
    const roundStart = Date.now();
    const previousRound = debate.rounds[debate.rounds.length - 1];
    const contributions: DebateContribution[] = [];

    // Each agent critiques the others in parallel
    const critiqueResults = await Promise.all(
      Array.from({ length: debate.config.agents }, async (_, i) => {
        const critiques = await this.generateCritiques(debate, i, previousRound.contributions);
        return {
          agentId: `agent-${i}`,
          content: previousRound.contributions[i].content,
          critiques,
          confidence: previousRound.contributions[i].confidence,
          reasoning: 'Cross-critique of other positions',
        } as DebateContribution;
      })
    );
    contributions.push(...critiqueResults);

    const round: DebateSessionRound = {
      roundNumber: debate.currentRound + 1,
      type: 'critique',
      contributions,
      consensusScore: this.calculateConsensus(contributions),
      timestamp: Date.now(),
      durationMs: Date.now() - roundStart,
    };

    debate.rounds.push(round);
    debate.currentRound++;

    this.emit('debate:round-complete', { debateId: debate.id, round });
  }

  private async runDefenseRound(debate: ActiveDebate): Promise<void> {
    const roundStart = Date.now();
    const critiqueRound = debate.rounds[debate.rounds.length - 1];
    const contributions: DebateContribution[] = [];

    // Each agent defends their position and potentially revises in parallel
    const defenseResults = await Promise.all(
      Array.from({ length: debate.config.agents }, (_, i) => {
        const critiquesReceived = critiqueRound.contributions
          .flatMap(c => c.critiques || [])
          .filter(crit => crit.targetAgentId === `agent-${i}`);
        return this.generateDefense(debate, i, critiquesReceived);
      })
    );
    contributions.push(...defenseResults);

    const round: DebateSessionRound = {
      roundNumber: debate.currentRound + 1,
      type: 'defense',
      contributions,
      consensusScore: this.calculateConsensus(contributions),
      timestamp: Date.now(),
      durationMs: Date.now() - roundStart,
    };

    debate.rounds.push(round);
    debate.currentRound++;

    this.emit('debate:round-complete', { debateId: debate.id, round });
  }

  private async runSynthesisRound(debate: ActiveDebate): Promise<void> {
    const roundStart = Date.now();

    // Analyze consensus across all rounds
    const consensusAnalysis = this.analyzeConsensus(debate);

    // Generate final synthesis
    const synthesis = await this.generateSynthesis(debate, consensusAnalysis);

    const contribution: DebateContribution = {
      agentId: 'moderator',
      content: synthesis,
      confidence: consensusAnalysis.overallScore,
      reasoning: 'Final synthesis of debate positions',
    };

    const round: DebateSessionRound = {
      roundNumber: debate.currentRound + 1,
      type: 'synthesis',
      contributions: [contribution],
      consensusScore: consensusAnalysis.overallScore,
      timestamp: Date.now(),
      durationMs: Date.now() - roundStart,
    };

    debate.rounds.push(round);
    debate.currentRound++;

    this.emit('debate:round-complete', { debateId: debate.id, round });
  }

  // ============ Response Generation (Real LLM Integration) ============

  private async generateInitialResponse(
    debate: ActiveDebate,
    agentIndex: number,
    temperature: number
  ): Promise<DebateContribution> {
    const agentId = `agent-${agentIndex}`;

    // Build prompt for initial response
    const prompt = this.buildInitialResponsePrompt(debate, agentIndex);

    // Check for registered handler before emitting
    this.checkExtensibilityHandler('debate:generate-response');

    // Emit event to request LLM generation
    const result = await new Promise<{ response: string; tokens: number }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Initial response generation timed out'));
      }, debate.config.timeout);

      this.emit('debate:generate-response', {
        debateId: debate.id,
        instanceId: debate.instanceId,
        provider: debate.provider,
        agentId,
        agentIndex,
        temperature,
        prompt,
        context: debate.context,
        callback: (response: string, tokens: number) => {
          clearTimeout(timeout);
          resolve({ response, tokens });
        },
      });
    });

    // Extract confidence and reasoning from response
    const confidence = this.extractConfidenceFromResponse(result.response);
    const reasoning = this.extractReasoningFromResponse(result.response);

    return {
      agentId,
      content: result.response,
      confidence,
      reasoning,
    };
  }

  private buildInitialResponsePrompt(debate: ActiveDebate, agentIndex: number): string {
    const context = debate.context ? `\n\n## Context\n${debate.context}` : '';

    return `You are Agent ${agentIndex} participating in a multi-agent debate to address the following query.

## Query
${debate.query}${context}

## Your Task
Provide your independent response to this query. You will be participating in a debate with other agents, so:
1. Be thorough and clear in your reasoning
2. Explicitly state your confidence level (0-100%)
3. Highlight key assumptions or uncertainties
4. Consider multiple perspectives

## Response Format
Provide your response, then end with:

## Confidence
State your overall confidence in this response (0-100%): X%

## Reasoning Summary
Brief summary of your reasoning approach and key considerations.`;
  }

  private async generateCritiques(
    debate: ActiveDebate,
    agentIndex: number,
    contributions: DebateContribution[]
  ): Promise<AgentCritique[]> {
    const agentId = `agent-${agentIndex}`;

    // Build prompt for critique generation
    const prompt = this.buildCritiquePrompt(debate, agentIndex, contributions);

    // Check for registered handler before emitting
    this.checkExtensibilityHandler('debate:generate-critiques');

    // Emit event to request LLM generation
    const result = await new Promise<{ response: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Critique generation timed out'));
      }, debate.config.timeout);

      this.emit('debate:generate-critiques', {
        debateId: debate.id,
        instanceId: debate.instanceId,
        provider: debate.provider,
        agentId,
        agentIndex,
        prompt,
        context: debate.context,
        callback: (response: string) => {
          clearTimeout(timeout);
          resolve({ response });
        },
      });
    });

    // Parse critiques from response
    return this.parseCritiquesFromResponse(result.response, contributions);
  }

  private buildCritiquePrompt(
    debate: ActiveDebate,
    agentIndex: number,
    contributions: DebateContribution[]
  ): string {
    const otherContributions = contributions
      .filter((_, i) => i !== agentIndex)
      .map(
        (c, i) => `### ${c.agentId}'s Response
${c.content}
(Confidence: ${(c.confidence * 100).toFixed(0)}%)`
      )
      .join('\n\n');

    return `You are Agent ${agentIndex} in a debate. Your task is to critically analyze the other agents' responses.

## Original Query
${debate.query}

## Other Agents' Responses
${otherContributions}

## Your Task
Provide constructive critiques of each response. For each agent, identify:
1. Potential issues or weaknesses in their reasoning
2. Alternative perspectives they may have missed
3. The severity of any concerns (major/minor/suggestion)

## Response Format
For each agent you're critiquing, use this format:

### Critique of [agentId]
**Issue**: [Brief description of the issue]
**Severity**: [major/minor/suggestion]
**Counterpoint**: [Alternative perspective or approach]

---

Provide your critiques:`;
  }

  private parseCritiquesFromResponse(response: string, contributions: DebateContribution[]): AgentCritique[] {
    const critiques: AgentCritique[] = [];

    // Look for critique sections
    const critiqueMatches = response.matchAll(/### Critique of (agent-\d+)\s+\*\*Issue\*\*:\s*(.+?)\s+\*\*Severity\*\*:\s*(major|minor|suggestion)\s+\*\*Counterpoint\*\*:\s*(.+?)(?=###|$)/gis);

    for (const match of critiqueMatches) {
      const targetAgentId = match[1];
      const issue = match[2].trim();
      const severity = match[3].toLowerCase() as CritiqueSeverity;
      const counterpoint = match[4].trim();

      critiques.push({
        targetAgentId,
        issue,
        severity,
        counterpoint,
      });
    }

    // Fallback: if no structured critiques found, create generic ones for other agents
    if (critiques.length === 0) {
      for (const contribution of contributions) {
        critiques.push({
          targetAgentId: contribution.agentId,
          issue: 'Analysis needed',
          severity: 'minor',
          counterpoint: 'Further consideration suggested',
        });
      }
    }

    return critiques;
  }

  private async generateDefense(
    debate: ActiveDebate,
    agentIndex: number,
    critiquesReceived: AgentCritique[]
  ): Promise<DebateContribution> {
    const agentId = `agent-${agentIndex}`;

    // Get original response
    const initialRound = debate.rounds.find(r => r.type === 'initial');
    const originalContribution = initialRound?.contributions[agentIndex];

    // Build prompt for defense generation
    const prompt = this.buildDefensePrompt(debate, agentIndex, originalContribution, critiquesReceived);

    // Check for registered handler before emitting
    this.checkExtensibilityHandler('debate:generate-defense');

    // Emit event to request LLM generation
    const result = await new Promise<{ response: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Defense generation timed out'));
      }, debate.config.timeout);

      this.emit('debate:generate-defense', {
        debateId: debate.id,
        instanceId: debate.instanceId,
        provider: debate.provider,
        agentId,
        agentIndex,
        prompt,
        context: debate.context,
        callback: (response: string) => {
          clearTimeout(timeout);
          resolve({ response });
        },
      });
    });

    // Extract defense points, confidence, and reasoning
    const defenses = this.extractDefensesFromResponse(result.response);
    const confidence = this.extractConfidenceFromResponse(result.response);
    const reasoning = this.extractReasoningFromResponse(result.response);

    return {
      agentId,
      content: result.response,
      defenses,
      confidence,
      reasoning,
    };
  }

  private buildDefensePrompt(
    debate: ActiveDebate,
    agentIndex: number,
    originalContribution: DebateContribution | undefined,
    critiquesReceived: AgentCritique[]
  ): string {
    const critiquesList = critiquesReceived
      .map(
        (c) => `- **From ${c.targetAgentId}**: ${c.issue} (Severity: ${c.severity})
  Counterpoint: ${c.counterpoint}`
      )
      .join('\n');

    const originalResponse = originalContribution ? `\n\n## Your Original Response\n${originalContribution.content}` : '';

    return `You are Agent ${agentIndex} in a debate. Other agents have critiqued your position.

## Original Query
${debate.query}${originalResponse}

## Critiques You Received
${critiquesList}

## Your Task
1. Address each critique thoughtfully
2. Defend your position where it remains valid
3. Acknowledge valid concerns and revise your position if needed
4. Provide your updated/refined response

## Response Format
Provide your defense and revised position, then end with:

## Defense Points
- [List each specific defense against the critiques]

## Confidence
State your confidence in your revised position (0-100%): X%

## Reasoning Summary
Brief summary of how you addressed the critiques.`;
  }

  private extractDefensesFromResponse(response: string): string[] {
    const defenses: string[] = [];

    // Look for defense points section
    const defenseMatch = response.match(/## Defense Points\s+([\s\S]*?)(?=\n##|$)/i);
    if (defenseMatch) {
      const lines = defenseMatch[1].split('\n').filter((l) => l.trim().startsWith('-'));
      for (const line of lines) {
        defenses.push(line.replace(/^-\s*/, '').trim());
      }
    }

    return defenses;
  }

  private async generateSynthesis(debate: ActiveDebate, consensusAnalysis: ConsensusAnalysis): Promise<string> {
    // Build prompt for synthesis generation
    const prompt = this.buildSynthesisPrompt(debate, consensusAnalysis);

    // Check for registered handler before emitting
    this.checkExtensibilityHandler('debate:generate-synthesis');

    // Emit event to request LLM generation
    const result = await new Promise<{ response: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Synthesis generation timed out'));
      }, debate.config.timeout);

      this.emit('debate:generate-synthesis', {
        debateId: debate.id,
        instanceId: debate.instanceId,
        provider: debate.provider,
        agentId: 'moderator',
        prompt,
        context: debate.context,
        callback: (response: string) => {
          clearTimeout(timeout);
          resolve({ response });
        },
      });
    });

    return result.response;
  }

  private buildSynthesisPrompt(debate: ActiveDebate, consensusAnalysis: ConsensusAnalysis): string {
    // Summarize all rounds
    const roundsSummary = debate.rounds
      .map(
        (r) => `### Round ${r.roundNumber}: ${r.type}
Consensus Score: ${(r.consensusScore * 100).toFixed(0)}%
Contributions: ${r.contributions.length}
Duration: ${r.durationMs}ms`
      )
      .join('\n\n');

    // Format agreements
    const agreementsList = consensusAnalysis.agreements
      .map((a) => `- ${a.topic} (Confidence: ${(a.confidence * 100).toFixed(0)}%, Supported by: ${a.supportingAgents.join(', ')})`)
      .join('\n');

    // Format disagreements
    const disagreementsList = consensusAnalysis.disagreements
      .map((d) => {
        const positions = Array.from(d.positions.entries())
          .map(([agentId, position]) => `  - ${agentId}: ${position}`)
          .join('\n');
        return `- ${d.topic} (Severity: ${d.severity})\n${positions}`;
      })
      .join('\n\n');

    return `You are the moderator synthesizing a multi-agent debate.

## Original Query
${debate.query}

## Debate Summary
${roundsSummary}

## Consensus Analysis
Overall Score: ${(consensusAnalysis.overallScore * 100).toFixed(0)}%

### Areas of Agreement
${agreementsList || 'None identified'}

### Areas of Disagreement
${disagreementsList || 'None identified'}

### Undecided Topics
${consensusAnalysis.undecided.join(', ') || 'None'}

## Your Task
Create a comprehensive synthesis that:
1. Integrates the strongest points from all agents
2. Acknowledges areas of consensus
3. Addresses unresolved disagreements with balanced perspective
4. Provides a clear, actionable answer to the original query
5. Notes any important caveats or limitations

Provide your synthesis:`;
  }

  // ============ Consensus Analysis ============

  private calculateConsensus(contributions: DebateContribution[]): number {
    if (contributions.length <= 1) return 1.0;

    // Simple text similarity-based consensus
    let totalSimilarity = 0;
    let comparisons = 0;

    for (let i = 0; i < contributions.length; i++) {
      for (let j = i + 1; j < contributions.length; j++) {
        totalSimilarity += this.textSimilarity(contributions[i].content, contributions[j].content);
        comparisons++;
      }
    }

    return comparisons > 0 ? totalSimilarity / comparisons : 0;
  }

  private analyzeConsensus(debate: ActiveDebate): ConsensusAnalysis {
    const lastRound = debate.rounds[debate.rounds.length - 1];
    const allContributions = debate.rounds.flatMap(r => r.contributions);

    // Extract topics (simplified)
    const topics = this.extractTopics(allContributions);
    const agreements: ConsensusAgreement[] = [];
    const disagreements: ConsensusDisagreement[] = [];

    for (const topic of topics) {
      const positions = new Map<string, string>();
      for (const contribution of lastRound.contributions) {
        if (contribution.content.toLowerCase().includes(topic.toLowerCase())) {
          positions.set(contribution.agentId, contribution.content);
        }
      }

      if (positions.size >= debate.config.agents * 0.7) {
        agreements.push({
          topic,
          confidence: 0.8,
          supportingAgents: Array.from(positions.keys()),
        });
      } else if (positions.size > 0) {
        disagreements.push({
          topic,
          positions,
          severity: 'minor',
        });
      }
    }

    return {
      overallScore: lastRound.consensusScore,
      agreements,
      disagreements,
      undecided: [],
    };
  }

  private extractTopics(contributions: DebateContribution[]): string[] {
    // Simplified topic extraction - actual implementation uses NLP
    const words = contributions
      .flatMap(c => c.content.toLowerCase().split(/\s+/))
      .filter(w => w.length > 5);

    const wordCounts = new Map<string, number>();
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }

    return Array.from(wordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  private textSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  // ============ Helper Methods ============

  private extractConfidenceFromResponse(response: string): number {
    const confidenceMatch = response.match(/Confidence[:\s]*(\d+)%?/i);
    if (confidenceMatch) {
      return parseInt(confidenceMatch[1]) / 100;
    }
    return 0.7; // Default confidence
  }

  private extractReasoningFromResponse(response: string): string {
    const reasoningMatch = response.match(/## Reasoning Summary\s+([\s\S]*?)(?=\n##|$)/i);
    if (reasoningMatch) {
      return reasoningMatch[1].trim();
    }
    return 'Based on analysis of the query and context';
  }

  private getAgentTemperature(agentIndex: number, config: DebateConfig): number {
    const [min, max] = config.temperatureRange;
    const step = (max - min) / Math.max(1, config.agents - 1);
    return min + step * agentIndex;
  }

  private finalizeDebate(debate: ActiveDebate): void {
    const lastRound = debate.rounds[debate.rounds.length - 1];
    const consensusAnalysis = this.analyzeConsensus(debate);

    const result: DebateResult = {
      id: debate.id,
      query: debate.query,
      rounds: debate.rounds,
      synthesis: lastRound.type === 'synthesis' ? lastRound.contributions[0].content : '',
      consensusReached: lastRound.consensusScore >= debate.config.convergenceThreshold,
      finalConsensusScore: lastRound.consensusScore,
      keyAgreements: consensusAnalysis.agreements.map(a => a.topic),
      unresolvedDisagreements: consensusAnalysis.disagreements.map(d => d.topic),
      tokensUsed: this.estimateTokensUsed(debate),
      duration: Date.now() - debate.startTime,
      status: debate.status,
    };

    this.completedDebates.set(debate.id, result);
    this.activeDebates.delete(debate.id);

    // Update stats
    this.updateStats(result);

    this.emit('debate:completed', result);
  }

  private estimateTokensUsed(debate: ActiveDebate): number {
    let tokens = 0;
    for (const round of debate.rounds) {
      for (const contribution of round.contributions) {
        tokens += estimateTokens(contribution.content);
      }
    }
    return tokens;
  }

  private updateStats(result: DebateResult): void {
    const n = this.stats.totalDebates;
    this.stats.totalDebates++;
    this.stats.avgRounds = (this.stats.avgRounds * n + result.rounds.length) / (n + 1);
    this.stats.avgConsensusScore = (this.stats.avgConsensusScore * n + result.finalConsensusScore) / (n + 1);
    this.stats.consensusRate =
      (this.stats.consensusRate * n + (result.consensusReached ? 1 : 0)) / (n + 1);
    this.stats.avgDurationMs = (this.stats.avgDurationMs * n + result.duration) / (n + 1);
    this.stats.avgTokensUsed = (this.stats.avgTokensUsed * n + result.tokensUsed) / (n + 1);
  }

  // ============ Pause/Resume Support ============

  private async waitIfPaused(debateId: string): Promise<void> {
    const debate = this.activeDebates.get(debateId);
    if (!debate || debate.status !== 'paused') return;

    await new Promise<void>((resolve) => {
      this.pauseGates.set(debateId, { resolve });
    });
  }

  // ============ Public API ============

  getDebate(debateId: string): ActiveDebate | DebateResult | undefined {
    return this.activeDebates.get(debateId) || this.completedDebates.get(debateId);
  }

  getResult(debateId: string): DebateResult | undefined {
    return this.completedDebates.get(debateId);
  }

  async cancelDebate(debateId: string): Promise<boolean> {
    const debate = this.activeDebates.get(debateId);
    if (!debate) return false;

    debate.status = 'cancelled';
    // Unblock any paused wait
    const gate = this.pauseGates.get(debateId);
    if (gate) {
      gate.resolve();
      this.pauseGates.delete(debateId);
    }
    this.interventions.delete(debateId);
    this.finalizeDebate(debate);
    return true;
  }

  pauseDebate(debateId: string): boolean {
    const debate = this.activeDebates.get(debateId);
    if (!debate || debate.status !== 'in_progress') return false;

    debate.status = 'paused';
    this.emit('debate:paused', { debateId });
    logger.info('Debate paused', { debateId });
    return true;
  }

  resumeDebate(debateId: string): boolean {
    const debate = this.activeDebates.get(debateId);
    if (!debate || debate.status !== 'paused') return false;

    debate.status = 'in_progress';
    const gate = this.pauseGates.get(debateId);
    if (gate) {
      gate.resolve();
      this.pauseGates.delete(debateId);
    }
    this.emit('debate:resumed', { debateId });
    logger.info('Debate resumed', { debateId });
    return true;
  }

  intervene(debateId: string, message: string): boolean {
    const debate = this.activeDebates.get(debateId);
    if (!debate) return false;
    if (debate.status !== 'in_progress' && debate.status !== 'paused') return false;

    const existing = this.interventions.get(debateId) || [];
    existing.push(message);
    this.interventions.set(debateId, existing);
    this.emit('debate:intervention-queued', { debateId, message });
    logger.info('Intervention queued for debate', { debateId });
    return true;
  }

  getActiveDebates(): ActiveDebate[] {
    return Array.from(this.activeDebates.values());
  }

  getStats(): DebateStats {
    return { ...this.stats };
  }

  /**
   * Stream debate progress as an async generator.
   * Provides natural backpressure and cancellation via iterator return.
   * This is a parallel interface to the EventEmitter events — both work simultaneously.
   */
  async *streamDebate(debateId: string): AsyncGenerator<DebateStreamEvent> {
    const debate = this.activeDebates.get(debateId);
    if (!debate) {
      yield { type: 'error', debateId, error: `Debate ${debateId} not found` };
      return;
    }

    const queue: DebateStreamEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const push = (event: DebateStreamEvent) => {
      queue.push(event);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    const onRoundComplete = (data: { debateId: string; round: DebateSessionRound }) => {
      if (data.debateId === debateId) {
        push({
          type: 'round-complete',
          debateId,
          round: data.round?.roundNumber ?? 0,
          consensusScore: data.round?.consensusScore ?? 0,
          roundType: data.round?.type ?? 'unknown',
        });
      }
    };

    const onCompleted = (data: DebateResult) => {
      if (data.id === debateId) {
        push({
          type: 'completed',
          debateId,
          status: data.status ?? 'completed',
          finalScore: data.finalConsensusScore ?? 0,
        });
        done = true;
        if (resolve) {
          resolve();
          resolve = null;
        }
      }
    };

    const onEarlyTerminated = (data: { debateId: string; reason: string; bestRoundScore: number; roundsCompleted: number }) => {
      if (data.debateId === debateId) {
        push({
          type: 'early-terminated',
          debateId,
          reason: data.reason ?? 'divergence',
          bestRoundScore: data.bestRoundScore ?? 0,
        });
      }
    };

    const onError = (data: { debateId: string; error: string }) => {
      if (data.debateId === debateId) {
        push({ type: 'error', debateId, error: data.error ?? 'Unknown error' });
        done = true;
        if (resolve) {
          resolve();
          resolve = null;
        }
      }
    };

    this.on('debate:round-complete', onRoundComplete);
    this.on('debate:completed', onCompleted);
    this.on('debate:early-terminated', onEarlyTerminated);
    this.on('debate:error', onError);

    yield {
      type: 'started',
      debateId,
      topic: debate.query,
      agentCount: debate.config.agents,
    };

    try {
      while (!done) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise<void>(r => { resolve = r; });
        }
      }

      while (queue.length > 0) {
        yield queue.shift()!;
      }
    } finally {
      this.off('debate:round-complete', onRoundComplete);
      this.off('debate:completed', onCompleted);
      this.off('debate:early-terminated', onEarlyTerminated);
      this.off('debate:error', onError);
    }
  }
}

// Export singleton getter
export function getDebateCoordinator(): DebateCoordinator {
  return DebateCoordinator.getInstance();
}
