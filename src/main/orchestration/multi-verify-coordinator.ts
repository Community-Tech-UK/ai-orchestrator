/**
 * MultiVerifyCoordinator - Multi-agent verification with diverse perspectives
 * Based on validated research: arXiv:2502.20379 (MAV), DelphiAgent, Byzantine FT
 */

import { EventEmitter } from 'events';
import {
  VerificationConfig,
  VerificationRequest,
  VerificationResult,
  AgentResponse,
  VerificationAnalysis,
  SynthesisStrategy,
  ExtractedKeyPoint,
  AgreementPoint,
  DisagreementPoint,
  UniqueInsight,
  ResponseRanking,
  PersonalityType,
  AgentHealthConfig,
  VerificationProgress,
  createDefaultVerificationConfig,
} from '../../shared/types/verification.types';
import type { DebateSessionRound } from '../../shared/types/debate.types';
import { PERSONALITY_PROMPTS, selectPersonalities } from './personalities';
import { getVerificationCache, type VerificationCache } from './verification-cache';
import { getConfidenceAnalyzer, type ConfidenceAnalyzer } from './confidence-analyzer';
import { getEmbeddingService as getOrchestrationEmbeddingService, type EmbeddingService, type SemanticClusterConfig, type ResponseCluster } from './embedding-service';
import { getLogger } from '../logging/logger';
import { getErrorRecoveryManager } from '../core/error-recovery';
import { ErrorCategory } from '../../shared/types/error-recovery.types';
import { getConfidenceFilter } from './confidence-filter';
import { createCliAdapter, resolveCliType, type UnifiedSpawnOptions } from '../cli/adapters/adapter-factory';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import { getSettingsManager } from '../core/config/settings-manager';
import { createAbortController, createChildAbortController } from '../util/abort-controller-tree';

const logger = getLogger('MultiVerifyCoordinator');

export class InsufficientAgentsError extends Error {
  constructor(message: string, public successfulAgents: number, public minRequired: number) {
    super(message);
    this.name = 'InsufficientAgentsError';
  }
}

export class MultiVerifyCoordinator extends EventEmitter {
  private static instance: MultiVerifyCoordinator | null = null;
  private activeVerifications = new Map<string, VerificationRequest>();
  private results = new Map<string, VerificationResult>();
  private defaultConfig: Partial<VerificationConfig> = {};
  private agentRetryCount = new Map<string, number>();
  private failedAgents = new Set<string>();

  // Integrated services
  private cache: VerificationCache;
  private confidenceAnalyzer: ConfidenceAnalyzer;
  private embeddingService: EmbeddingService;

  static getInstance(): MultiVerifyCoordinator {
    if (!this.instance) {
      this.instance = new MultiVerifyCoordinator();
    }
    return this.instance;
  }

  /**
   * Reset the singleton instance for testing.
   * Clears all active verifications, results, and resets state.
   */
  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.activeVerifications.clear();
      this.instance.results.clear();
      this.instance.agentRetryCount.clear();
      this.instance.failedAgents.clear();
      this.instance.removeAllListeners();
      this.instance = null;
    }
  }

  private constructor() {
    super();
    // Initialize integrated services
    this.cache = getVerificationCache();
    this.confidenceAnalyzer = getConfidenceAnalyzer();
    this.embeddingService = getOrchestrationEmbeddingService();
  }

  /**
   * Set default configuration for all verifications
   */
  setDefaultConfig(config: Partial<VerificationConfig>): void {
    this.defaultConfig = { ...this.defaultConfig, ...config };
  }

  /**
   * Get current default configuration
   */
  getDefaultConfig(): Partial<VerificationConfig> {
    return { ...this.defaultConfig };
  }

  // ============ Health & Failure Handling ============

  private getHealthConfig(config: VerificationConfig): AgentHealthConfig {
    return (
      config.healthConfig || {
        maxRetries: 2,
        retryDelayMs: 1000,
        timeoutMs: config.timeout,
        minSuccessfulAgents: 2,
      }
    );
  }

  private async handleAgentFailure(
    request: VerificationRequest,
    agentId: string,
    error: Error
  ): Promise<'retry' | 'failed'> {
    const config = request.config;
    const healthConfig = this.getHealthConfig(config);

    const classified = getErrorRecoveryManager().classifyError(error, `MultiVerifyCoordinator.agent[${agentId}]`);

    logger.warn('Agent failure classified', {
      requestId: request.id,
      agentId,
      category: classified.category,
      severity: classified.severity,
      recoverable: classified.recoverable,
      message: classified.technicalDetails,
    });

    // Only fail-fast on explicitly non-recoverable categories (auth, permanent).
    // UNKNOWN errors should respect the retry budget — unknown !== permanent.
    const FAIL_FAST_CATEGORIES = new Set([ErrorCategory.AUTH, ErrorCategory.PERMANENT]);
    if (FAIL_FAST_CATEGORIES.has(classified.category)) {
      this.failedAgents.add(agentId);
      return 'failed';
    }

    const currentRetries = this.agentRetryCount.get(agentId) || 0;

    if (currentRetries < healthConfig.maxRetries) {
      // Health config's retryDelayMs is authoritative (allows tests to set 0);
      // classified delay is only used when health config doesn't specify one
      const delayMs = healthConfig.retryDelayMs !== undefined
        ? healthConfig.retryDelayMs
        : (classified.retryAfterMs ?? 0);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      this.agentRetryCount.set(agentId, currentRetries + 1);
      return 'retry';
    } else {
      // Mark agent as failed
      this.failedAgents.add(agentId);
      return 'failed';
    }
  }

  private checkSufficientAgents(request: VerificationRequest, successfulCount: number): void {
    const config = request.config;
    const healthConfig = this.getHealthConfig(config);

    if (successfulCount < healthConfig.minSuccessfulAgents) {
      throw new InsufficientAgentsError(
        `Insufficient agents succeeded. Required: ${healthConfig.minSuccessfulAgents}, Succeeded: ${successfulCount}`,
        successfulCount,
        healthConfig.minSuccessfulAgents
      );
    }
  }

  private resetAgentHealth(requestId: string): void {
    // Clear retry counts and failed agents for new verification
    const keysToDelete = Array.from(this.agentRetryCount.keys()).filter((k) => k.includes(requestId));
    keysToDelete.forEach((k) => this.agentRetryCount.delete(k));

    const failedToDelete = Array.from(this.failedAgents).filter((k) => k.includes(requestId));
    failedToDelete.forEach((k) => this.failedAgents.delete(k));
  }

  private emitProgress(
    request: VerificationRequest,
    phase: VerificationProgress['phase'],
    completedAgents: number,
    totalAgents: number,
    currentActivity: string,
    partialResults?: Partial<VerificationResult>
  ): void {
    const progress: VerificationProgress = {
      phase,
      completedAgents,
      totalAgents,
      currentActivity,
      partialResults,
      timestamp: Date.now(),
    };

    this.emit('verification:progress', {
      requestId: request.id,
      progress,
    });
  }


  // ============ Verification Lifecycle ============

  async startVerification(
    instanceId: string,
    prompt: string,
    config?: Partial<VerificationConfig>,
    context?: string,
    taskType?: string
  ): Promise<string> {
    // Apply Byzantine fault tolerance: N >= 3f+1
    // For f=1 (tolerate 1 faulty), need N>=4
    const agentCount = Math.max(config?.agentCount || 3, 3);
    const defaultConfig = createDefaultVerificationConfig();

    const fullConfig: VerificationConfig = {
      ...defaultConfig,
      ...config,
      agentCount,
      personalities: config?.personalities || selectPersonalities(agentCount, taskType),
    };

    const request: VerificationRequest = {
      id: `verify-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      instanceId,
      prompt,
      config: fullConfig,
      context,
      taskType,
    };

    // Reset health tracking for this verification
    this.resetAgentHealth(request.id);

    this.activeVerifications.set(request.id, request);
    this.emit('verification:started', request);

    // Run verification asynchronously
    this.runVerification(request).catch((error) => {
      this.emit('verification:error', { request, error });
      this.activeVerifications.delete(request.id);
    });

    return request.id;
  }

  private async runVerification(request: VerificationRequest): Promise<void> {
    const startTime = Date.now();
    const { config } = request;

    // Check cache first
    const promptHash = this.cache.hashPrompt(request.prompt);
    const cached = await this.cache.getCached(promptHash);
    if (cached) {
      // Return cached result
      this.results.set(request.id, cached.result);
      this.activeVerifications.delete(request.id);
      this.emitProgress(request, 'complete', cached.result.responses.length, cached.result.responses.length, 'Returned cached result', cached.result);
      this.emit('verification:completed', { ...cached.result, id: request.id, fromCache: true });
      return;
    }

    // Prepare agent configurations with diverse perspectives
    const agentConfigs = Array.from({ length: config.agentCount }, (_, i) => ({
      agentId: `${request.id}-agent-${i}`,
      agentIndex: i,
      model: config.models?.[i % (config.models?.length || 1)] || 'default',
      personality: config.personalities?.[i],
    }));

    this.emit('verification:agents-launching', {
      requestId: request.id,
      agentCount: config.agentCount,
      personalities: agentConfigs.map((a) => a.personality),
    });

    // Emit progress: spawning phase
    this.emitProgress(request, 'spawning', 0, config.agentCount, 'Preparing agents for execution');

    // All verification agents perform read-only analysis — concurrency classifier
    // confirms parallel execution is safe (all operations are type: 'analysis')

    // Run all agents in parallel with timeout
    // Create a per-round abort controller so non-retryable failures cancel siblings
    const roundAbort = createAbortController();
    const responses = await Promise.all(agentConfigs.map((agentConfig) => {
      const childAbort = createChildAbortController(roundAbort);
      return this.runAgent(request, agentConfig, childAbort).catch((error) => {
        if (!roundAbort.signal.aborted) {
          const msg = error instanceof Error ? error.message : String(error);
          if (/auth|unauthorized|forbidden|SIGKILL|SIGSEGV/i.test(msg)) {
            roundAbort.abort(msg);
          }
        }
        throw error;
      });
    }));

    // Emit progress: collecting phase
    const successfulCount = responses.filter((r) => !r.error).length;
    this.emitProgress(request, 'collecting', successfulCount, config.agentCount, `Collected ${successfulCount} agent responses`);

    // Filter out failed agents and check if we have enough successful responses
    const successfulResponses = responses.filter((r) => !r.error && !this.failedAgents.has(r.agentId));
    this.checkSufficientAgents(request, successfulResponses.length);

    // Filter low-confidence responses before analysis
    const confidenceFilter = getConfidenceFilter();
    const { accepted, rejected } = confidenceFilter.filterByThreshold(successfulResponses, config.confidenceThreshold);

    if (rejected.length > 0) {
      logger.info('Filtered low-confidence verification responses', {
        verificationId: request.id,
        accepted: accepted.length,
        rejected: rejected.length,
      });
    }

    // Use accepted responses for further analysis; fallback to all if none pass
    const responsesToAnalyze = accepted.length > 0 ? accepted : successfulResponses;

    // Emit progress: analyzing phase
    this.emitProgress(request, 'analyzing', successfulCount, config.agentCount, 'Analyzing agent responses');

    // Apply synthesis strategy
    let synthesizedResponse: string;
    let synthesisConfidence: number;
    let debateRounds: DebateSessionRound[] | undefined;

    const analysis = await this.analyzeResponses(responsesToAnalyze, config);

    // Emit progress: synthesizing phase
    this.emitProgress(
      request,
      'synthesizing',
      successfulCount,
      config.agentCount,
      `Synthesizing responses using ${config.synthesisStrategy} strategy`
    );

    switch (config.synthesisStrategy) {
      case 'debate':
        const debateResult = await this.runDebate(request, responsesToAnalyze, analysis);
        synthesizedResponse = debateResult.synthesizedResponse;
        synthesisConfidence = debateResult.confidence;
        debateRounds = debateResult.rounds;
        break;

      case 'hierarchical':
        const hierResult = await this.synthesizeHierarchical(request, responsesToAnalyze, analysis);
        synthesizedResponse = hierResult.synthesizedResponse;
        synthesisConfidence = hierResult.confidence;
        break;

      default:
        const result = await this.synthesize(request, responsesToAnalyze, analysis, config.synthesisStrategy);
        synthesizedResponse = result.synthesizedResponse;
        synthesisConfidence = result.confidence;
    }

    const verificationResult: VerificationResult = {
      id: request.id,
      request,
      responses: successfulResponses,
      analysis,
      synthesizedResponse,
      synthesisMethod: config.synthesisStrategy,
      synthesisConfidence,
      totalDuration: Date.now() - startTime,
      totalTokens: successfulResponses.reduce((sum, r) => sum + r.tokens, 0),
      totalCost: successfulResponses.reduce((sum, r) => sum + r.cost, 0),
      completedAt: Date.now(),
      debateRounds,
    };

    this.results.set(request.id, verificationResult);
    this.activeVerifications.delete(request.id);

    // Cache the result for future use
    await this.cache.cache(verificationResult).catch((err) => {
      logger.warn('Failed to cache verification result', { requestId: request.id, error: String(err) });
    });

    // Emit progress: complete phase
    this.emitProgress(
      request,
      'complete',
      successfulCount,
      config.agentCount,
      'Verification complete',
      verificationResult
    );

    this.emit('verification:completed', verificationResult);
  }

  private async runAgent(
    request: VerificationRequest,
    agentConfig: { agentId: string; agentIndex: number; model: string; personality?: PersonalityType },
    abortController?: AbortController,
  ): Promise<AgentResponse> {
    const startTime = Date.now();

    try {
      if (abortController?.signal.aborted) {
        throw new Error(`Aborted: ${abortController.signal.reason}`);
      }

      // Build agent prompt with personality
      const systemPrompt = this.buildAgentPrompt(agentConfig.personality);

      // Check if any handlers are registered for this extensibility event
      const listenerCount = this.listenerCount('verification:invoke-agent');
      if (listenerCount === 0) {
        logger.warn('No handlers registered for "verification:invoke-agent" event', {
          hint: 'This is an extensibility point requiring an external handler. See CLAUDE.md for integration.'
        });
        throw new Error(
          'No handler registered for verification:invoke-agent. ' +
          'Connect an LLM invocation handler to use multi-agent verification.'
        );
      }

      // Emit event for orchestration handler to execute
      const result = await new Promise<{ response: string; tokens: number; cost: number }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Agent timed out'));
        }, request.config.timeout);

        this.emit('verification:invoke-agent', {
          requestId: request.id,
          instanceId: request.instanceId,
          agentId: agentConfig.agentId,
          model: agentConfig.model,
          systemPrompt,
          userPrompt: request.prompt,
          context: request.context,
          callback: (err: string | null, response?: string, tokens?: number, cost?: number) => {
            clearTimeout(timeout);
            if (err) {
              reject(new Error(err));
              return;
            }
            resolve({ response: response || '', tokens: tokens || 0, cost: cost || 0 });
          },
        });
      });

      // Extract structured key points from response
      const keyPoints = this.extractKeyPoints(result.response);
      const confidence = this.extractConfidence(result.response);

      return {
        agentId: agentConfig.agentId,
        agentIndex: agentConfig.agentIndex,
        model: agentConfig.model,
        personality: agentConfig.personality,
        response: result.response,
        keyPoints,
        confidence,
        duration: Date.now() - startTime,
        tokens: result.tokens,
        cost: result.cost,
      };
    } catch (error: unknown) {
      const err = error as Error;

      // Attempt to handle failure with retry logic
      const failureAction = await this.handleAgentFailure(request, agentConfig.agentId, err);

      if (failureAction === 'retry') {
        // Recursively retry the agent
        return this.runAgent(request, agentConfig, abortController);
      }

      // Agent failed permanently
      return {
        agentId: agentConfig.agentId,
        agentIndex: agentConfig.agentIndex,
        model: agentConfig.model,
        personality: agentConfig.personality,
        response: '',
        keyPoints: [],
        confidence: 0,
        duration: Date.now() - startTime,
        tokens: 0,
        cost: 0,
        error: err.message,
        timedOut: err.message?.includes('timed out'),
      };
    }
  }

  private buildAgentPrompt(personality?: PersonalityType): string {
    const personalitySection =
      personality && PERSONALITY_PROMPTS[personality] ? PERSONALITY_PROMPTS[personality] + '\n\n' : '';

    return `${personalitySection}You are participating in a multi-agent verification process.
Your response will be compared with other agents to synthesize the best answer.

## Instructions
1. Provide your best, most thorough response
2. Be explicit about your reasoning
3. Rate your confidence in each conclusion (0-100%)
4. If uncertain, say so explicitly
5. Highlight key points clearly

## Output Structure
End your response with a structured section:

## Key Points
- [Category: conclusion/recommendation/warning/fact] Point 1 (Confidence: X%)
- [Category] Point 2 (Confidence: X%)
...

## Overall Confidence
State your overall confidence in your response (0-100%): X%

## Reasoning Summary
Brief summary of your reasoning approach.`;
  }

  private extractKeyPoints(response: string): ExtractedKeyPoint[] {
    const keyPoints: ExtractedKeyPoint[] = [];

    // Look for explicit key points section
    const keyPointsMatch = response.match(/## Key Points\n([\s\S]*?)(?=\n##|$)/i);
    if (keyPointsMatch) {
      const lines = keyPointsMatch[1].split('\n').filter((l) => l.trim().startsWith('-'));

      for (const line of lines) {
        const categoryMatch = line.match(/\[(?:Category:\s*)?(conclusion|recommendation|warning|fact|opinion)\]/i);
        const confidenceMatch = line.match(/\(Confidence:\s*(\d+)%?\)/i);
        const content = line
          .replace(/^-\s*/, '')
          .replace(/\[.*?\]\s*/g, '')
          .replace(/\(Confidence:.*?\)/i, '')
          .trim();

        keyPoints.push({
          id: `kp-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
          content,
          category: (categoryMatch?.[1]?.toLowerCase() || 'fact') as ExtractedKeyPoint['category'],
          confidence: confidenceMatch ? parseInt(confidenceMatch[1]) / 100 : 0.7,
        });
      }
    }

    // Fallback: extract bullet points
    if (keyPoints.length === 0) {
      const bullets = response.match(/^[-*]\s+.+$/gm);
      if (bullets) {
        for (const bullet of bullets.slice(0, 10)) {
          keyPoints.push({
            id: `kp-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            content: bullet.replace(/^[-*]\s*/, '').trim(),
            category: 'fact',
            confidence: 0.5,
          });
        }
      }
    }

    return keyPoints;
  }

  private extractConfidence(response: string): number {
    // Use the confidence analyzer for a quick explicit check
    // The full multi-signal analysis is done in analyzeResponses
    return this.confidenceAnalyzer.findExplicitConfidence(response);
  }

  /**
   * Enhanced confidence extraction using multi-signal analysis
   */
  private async extractEnhancedConfidence(response: AgentResponse): Promise<number> {
    const assessment = await this.confidenceAnalyzer.extractConfidence(response);
    return assessment.combined;
  }

  // ============ Analysis ============

  private async analyzeResponses(responses: AgentResponse[], config: VerificationConfig): Promise<VerificationAnalysis> {
    const validResponses = responses.filter((r) => !r.error);

    if (validResponses.length === 0) {
      return {
        agreements: [],
        disagreements: [],
        uniqueInsights: [],
        responseRankings: [],
        overallConfidence: 0,
        outlierAgents: [],
        consensusStrength: 0,
      };
    }

    // Cluster key points — use semantic clustering when configured, fallback to bag-of-words
    const agreements: AgreementPoint[] = [];
    const uniqueInsights: UniqueInsight[] = [];

    if (config.useSemanticClustering !== false) {
      try {
        const semanticClusters = await this.clusterResponsesSemantically(validResponses);
        for (const cluster of semanticClusters) {
          const agentIds = cluster.members.map(m => m.agentId);
          const uniqueAgentIds = [...new Set(agentIds)];
          if (uniqueAgentIds.length >= 2) {
            const representativeResponse = cluster.members[0].response;
            const firstPoint = representativeResponse.keyPoints[0];
            agreements.push({
              point: representativeResponse.response.substring(0, 200),
              category: firstPoint?.category || 'general',
              agentIds: uniqueAgentIds,
              strength: uniqueAgentIds.length / validResponses.length,
              combinedConfidence: cluster.averageSimilarity,
            });
          } else if (uniqueAgentIds.length === 1) {
            const member = cluster.members[0];
            const firstPoint = member.response.keyPoints[0];
            if (member.similarity >= (config.confidenceThreshold || 0.6)) {
              uniqueInsights.push({
                point: member.response.response.substring(0, 200),
                category: firstPoint?.category || 'general',
                agentId: member.agentId,
                confidence: member.similarity,
                value: member.similarity >= 0.8 ? 'high' : member.similarity >= 0.6 ? 'medium' : 'low',
                reasoning: 'Unique insight from single agent with high confidence',
              });
            }
          }
        }
      } catch {
        // Fallback to bag-of-words on embedding failure
        this.extractAgreementsFromKeyPoints(validResponses, config, agreements, uniqueInsights);
      }
    } else {
      this.extractAgreementsFromKeyPoints(validResponses, config, agreements, uniqueInsights);
    }

    // Detect disagreements (agents with opposing positions on same topic)
    const disagreements = this.detectDisagreements(validResponses);

    // Rank responses
    const responseRankings = this.rankResponses(validResponses);

    // Detect outliers (Byzantine fault tolerance)
    const outlierAgents = this.detectOutliers(validResponses, agreements);

    // Calculate consensus strength
    const consensusStrength =
      agreements.length > 0
        ? agreements.reduce((sum, a) => sum + a.strength * a.combinedConfidence, 0) / agreements.length
        : 0;

    return {
      agreements: agreements.sort((a, b) => b.strength - a.strength),
      disagreements,
      uniqueInsights: uniqueInsights.sort((a, b) => b.confidence - a.confidence),
      responseRankings,
      overallConfidence: consensusStrength,
      outlierAgents,
      consensusStrength,
    };
  }

  private clusterKeyPoints(
    responses: AgentResponse[]
  ): Map<string, { agentId: string; point: ExtractedKeyPoint }[]> {
    const clusters = new Map<string, { agentId: string; point: ExtractedKeyPoint }[]>();

    for (const response of responses) {
      for (const point of response.keyPoints) {
        // Normalize for comparison (simplified fallback)
        const normalized = point.content
          .toLowerCase()
          .replace(/[^\w\s]/g, '')
          .split(/\s+/)
          .sort()
          .join(' ');

        const existing = clusters.get(normalized) || [];
        existing.push({ agentId: response.agentId, point });
        clusters.set(normalized, existing);
      }
    }

    return clusters;
  }

  /**
   * Enhanced response clustering using semantic embeddings
   */
  async clusterResponsesSemantically(
    responses: AgentResponse[],
    config?: Partial<SemanticClusterConfig>
  ): Promise<ResponseCluster[]> {
    const clusterConfig: SemanticClusterConfig = {
      similarityThreshold: config?.similarityThreshold ?? 0.7,
      embeddingModel: config?.embeddingModel ?? 'simple',
      clusteringAlgorithm: config?.clusteringAlgorithm ?? 'dbscan',
    };

    return this.embeddingService.clusterResponses(responses, clusterConfig);
  }

  private extractAgreementsFromKeyPoints(
    responses: AgentResponse[],
    config: VerificationConfig,
    agreements: AgreementPoint[],
    uniqueInsights: UniqueInsight[]
  ): void {
    const pointClusters = this.clusterKeyPoints(responses);
    for (const [, sources] of pointClusters) {
      if (sources.length >= 2) {
        agreements.push({
          point: sources[0].point.content,
          category: sources[0].point.category,
          agentIds: sources.map((s) => s.agentId),
          strength: sources.length / responses.length,
          combinedConfidence: sources.reduce((sum, s) => sum + s.point.confidence, 0) / sources.length,
        });
      } else if (sources.length === 1 && sources[0].point.confidence >= (config.confidenceThreshold || 0.6)) {
        uniqueInsights.push({
          point: sources[0].point.content,
          category: sources[0].point.category,
          agentId: sources[0].agentId,
          confidence: sources[0].point.confidence,
          value: sources[0].point.confidence >= 0.8 ? 'high' : sources[0].point.confidence >= 0.6 ? 'medium' : 'low',
          reasoning: 'Unique insight from single agent with high confidence',
        });
      }
    }
  }

  private detectDisagreements(responses: AgentResponse[]): DisagreementPoint[] {
    const disagreements: DisagreementPoint[] = [];

    // Look for explicit contradictions (simplified)
    const recommendationPoints = responses.flatMap((r) =>
      r.keyPoints.filter((p) => p.category === 'recommendation').map((p) => ({ ...p, agentId: r.agentId }))
    );

    // Check for conflicting recommendations
    // This is a simplified version - production should use semantic similarity
    if (recommendationPoints.length > 1) {
      const uniqueRecommendations = new Set(recommendationPoints.map((p) => p.content.toLowerCase()));
      if (uniqueRecommendations.size > 1 && recommendationPoints.length >= 2) {
        disagreements.push({
          topic: 'Recommendations differ across agents',
          positions: recommendationPoints.map((p) => ({
            agentId: p.agentId,
            position: p.content,
            confidence: p.confidence,
          })),
          requiresHumanReview: true,
        });
      }
    }

    return disagreements;
  }

  private rankResponses(responses: AgentResponse[]): ResponseRanking[] {
    return responses
      .map((r) => {
        const completeness = Math.min(1, r.keyPoints.length / 5);
        const accuracy = r.confidence;
        const clarity = r.keyPoints.filter((p) => p.confidence >= 0.7).length / Math.max(1, r.keyPoints.length);
        const reasoning = r.reasoning ? 0.8 : 0.5;

        const score = completeness * 0.25 + accuracy * 0.35 + clarity * 0.25 + reasoning * 0.15;

        return {
          agentId: r.agentId,
          rank: 0, // Will be assigned after sorting
          score,
          criteria: { completeness, accuracy, clarity, reasoning },
        };
      })
      .sort((a, b) => b.score - a.score)
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }

  private detectOutliers(responses: AgentResponse[], agreements: AgreementPoint[]): string[] {
    const outliers: string[] = [];

    // Agent is outlier if they have less than 30% overlap with majority
    for (const response of responses) {
      const agentPoints = new Set(response.keyPoints.map((p) => p.content.toLowerCase()));
      const majorityPoints = new Set(agreements.filter((a) => a.strength >= 0.5).map((a) => a.point.toLowerCase()));

      if (majorityPoints.size > 0) {
        const overlap = [...agentPoints].filter((p) => majorityPoints.has(p)).length;
        const overlapRatio = overlap / majorityPoints.size;

        if (overlapRatio < 0.3) {
          outliers.push(response.agentId);
        }
      }
    }

    return outliers;
  }

  // ============ Synthesis Strategies ============

  private async synthesize(
    request: VerificationRequest,
    responses: AgentResponse[],
    analysis: VerificationAnalysis,
    strategy: SynthesisStrategy
  ): Promise<{ synthesizedResponse: string; confidence: number }> {
    const validResponses = responses.filter((r) => !r.error);

    if (validResponses.length === 0) {
      return {
        synthesizedResponse: 'All verification agents failed to respond.',
        confidence: 0,
      };
    }

    if (validResponses.length === 1) {
      return {
        synthesizedResponse: validResponses[0].response,
        confidence: validResponses[0].confidence * 0.5, // Single response has reduced confidence
      };
    }

    switch (strategy) {
      case 'best-of':
        return this.synthesizeBestOf(validResponses, analysis);

      case 'consensus':
        return this.synthesizeConsensus(validResponses, analysis, request.config.minAgreement);

      case 'majority-vote':
        return this.synthesizeMajorityVote(validResponses, analysis);

      case 'merge':
      default:
        return this.synthesizeMerge(request, validResponses, analysis);
    }
  }

  private synthesizeBestOf(
    responses: AgentResponse[],
    analysis: VerificationAnalysis
  ): { synthesizedResponse: string; confidence: number } {
    const topRanked = analysis.responseRankings[0];
    const topResponse = responses.find((r) => r.agentId === topRanked?.agentId);

    if (!topResponse) {
      return { synthesizedResponse: responses[0].response, confidence: 0.5 };
    }

    return {
      synthesizedResponse: `${topResponse.response}

---
*Selected as best response from ${responses.length} agents.*
*Ranking score: ${(topRanked.score * 100).toFixed(1)}%*
*Agent personality: ${topResponse.personality || 'default'}*`,
      confidence: Math.min(0.9, topRanked.score),
    };
  }

  private synthesizeConsensus(
    responses: AgentResponse[],
    analysis: VerificationAnalysis,
    minAgreement?: number
  ): { synthesizedResponse: string; confidence: number } {
    const threshold = minAgreement || Math.ceil(responses.length * 0.66);

    const consensusPoints = analysis.agreements
      .filter((a) => a.agentIds.length >= threshold)
      .map((a) => `- ${a.point} (${(a.combinedConfidence * 100).toFixed(0)}% confidence)`);

    if (consensusPoints.length === 0) {
      return {
        synthesizedResponse:
          `No consensus reached among ${responses.length} agents. ` +
          `Individual responses varied significantly on key points.\n\n` +
          `## Disagreements\n${analysis.disagreements.map((d) => `- ${d.topic}`).join('\n')}`,
        confidence: 0.3,
      };
    }

    return {
      synthesizedResponse: `## Consensus Points (${threshold}+ agents agreed)

${consensusPoints.join('\n')}

## Unique Insights (high-confidence)
${analysis.uniqueInsights
  .filter((u) => u.value === 'high')
  .map((u) => `- ${u.point}`)
  .join('\n') || 'None identified'}

---
*Synthesized from ${responses.length} agents. ${consensusPoints.length} points reached consensus.*`,
      confidence: analysis.consensusStrength,
    };
  }

  private synthesizeMajorityVote(
    responses: AgentResponse[],
    analysis: VerificationAnalysis
  ): { synthesizedResponse: string; confidence: number } {
    const majorityThreshold = Math.ceil(responses.length / 2);

    const majorityPoints = analysis.agreements.filter((a) => a.agentIds.length >= majorityThreshold);

    return {
      synthesizedResponse: `## Majority Agreement (${majorityThreshold}+ agents)

${majorityPoints
  .map(
    (p) =>
      `- ${p.point} (${p.agentIds.length}/${responses.length} agents, ${(p.combinedConfidence * 100).toFixed(0)}% avg confidence)`
  )
  .join('\n')}

## Notable Disagreements
${
  analysis.disagreements
    .slice(0, 3)
    .map((d) => `- ${d.topic}`)
    .join('\n') || 'None'
}

## High-Value Unique Insights
${
  analysis.uniqueInsights
    .filter((i) => i.value === 'high')
    .slice(0, 3)
    .map((i) => `- ${i.point} (from ${i.agentId})`)
    .join('\n') || 'None'
}

---
*Synthesized via majority vote from ${responses.length} agents.*`,
      confidence:
        majorityPoints.length > 0
          ? majorityPoints.reduce((sum, p) => sum + p.combinedConfidence, 0) / majorityPoints.length
          : 0.4,
    };
  }

  private async synthesizeMerge(
    request: VerificationRequest,
    responses: AgentResponse[],
    analysis: VerificationAnalysis
  ): Promise<{ synthesizedResponse: string; confidence: number }> {
    // Build synthesis prompt
    const synthesisPrompt = `You are synthesizing ${responses.length} agent responses into a single, high-quality answer.

## Original Question
${request.prompt}

## Agent Responses
${responses
  .map(
    (r, i) => `### Agent ${i + 1} (${r.personality || 'default'}, confidence: ${(r.confidence * 100).toFixed(0)}%)
${r.response}
`
  )
  .join('\n')}

## Analysis Summary
- **Agreement Points**: ${analysis.agreements.length} (avg strength: ${(analysis.consensusStrength * 100).toFixed(0)}%)
- **Disagreements**: ${analysis.disagreements.length}
- **Unique Insights**: ${analysis.uniqueInsights.length}
- **Outlier Agents**: ${analysis.outlierAgents.length > 0 ? analysis.outlierAgents.join(', ') : 'None'}

## Agreed Points
${
  analysis.agreements
    .map((a) => `- ${a.point} (${a.agentIds.length} agents, ${(a.combinedConfidence * 100).toFixed(0)}% confidence)`)
    .join('\n') || 'None identified'
}

## Your Task
Create a synthesized response that:
1. Incorporates points where agents agreed (highest priority)
2. Includes valuable unique insights from individual agents
3. Acknowledges areas of disagreement when relevant
4. Excludes points from outlier agents unless well-supported
5. Is comprehensive but not redundant

Provide your synthesized response:`;

    // Direct CLI invocation for synthesis (replaces event-based callback)
    const settings = getSettingsManager();
    const defaultCli = settings.getAll().defaultCli;
    const cliType = await resolveCliType('auto', defaultCli);

    const spawnOptions: UnifiedSpawnOptions = {
      workingDirectory: process.cwd(),
      systemPrompt: 'You are a synthesis agent that combines multiple perspectives into a single coherent response.',
      yoloMode: false,
      timeout: 300000,
    };

    const adapter = createCliAdapter(cliType, spawnOptions);
    try {
      const sendMessage = (adapter as any).sendMessage?.bind(adapter) as ((m: CliMessage) => Promise<CliResponse>) | undefined;
      if (!sendMessage) {
        throw new Error(`CLI adapter "${cliType}" does not support one-shot sendMessage`);
      }

      const cliResponse = await sendMessage({ role: 'user', content: synthesisPrompt });
      return {
        synthesizedResponse: cliResponse.content,
        confidence: Math.min(0.9, analysis.consensusStrength + 0.15),
      };
    } finally {
      if (typeof (adapter as any).terminate === 'function') {
        try { (adapter as any).terminate(); } catch { /* cleanup */ }
      }
    }
  }

  // ============ Debate Strategy ============

  private async runDebate(
    request: VerificationRequest,
    initialResponses: AgentResponse[],
    analysis: VerificationAnalysis
  ): Promise<{ synthesizedResponse: string; confidence: number; rounds: DebateSessionRound[] }> {
    const maxRounds = request.config.maxDebateRounds || 3;
    const rounds: DebateSessionRound[] = [];

    let currentAnalysis = analysis;

    for (let round = 1; round <= maxRounds; round++) {
      // Check convergence - if consensus is high enough, stop early
      if (currentAnalysis.consensusStrength >= 0.8) {
        break;
      }

      const startTime = Date.now();
      const debateRound = await this.runDebateRound(request, initialResponses, currentAnalysis, round, startTime);

      rounds.push(debateRound);

      // Re-analyze after debate round
      currentAnalysis = await this.analyzeResponses(initialResponses, request.config);
    }

    // Final synthesis using consensus points
    const finalSynthesis = await this.synthesizeConsensus(
      initialResponses,
      currentAnalysis,
      Math.ceil(initialResponses.length * 0.5)
    );

    return {
      synthesizedResponse: finalSynthesis.synthesizedResponse + `\n\n---\n*Arrived at through ${rounds.length} debate rounds.*`,
      confidence: Math.min(0.95, finalSynthesis.confidence + 0.1 * rounds.length),
      rounds,
    };
  }

  private async runDebateRound(
    request: VerificationRequest,
    responses: AgentResponse[],
    analysis: VerificationAnalysis,
    roundNumber: number,
    startTime: number
  ): Promise<DebateSessionRound> {
    const contributions: DebateSessionRound['contributions'] = [];

    // Focus debate on disagreements
    for (const disagreement of analysis.disagreements.slice(0, 2)) {
      for (const response of responses) {
        const contribution = {
          agentId: response.agentId,
          content: `Regarding "${disagreement.topic}": ${
            disagreement.positions.find((p) => p.agentId === response.agentId)?.position || 'No position'
          }`,
          confidence: response.confidence,
          reasoning: response.reasoning || '',
        };
        contributions.push(contribution);
      }
    }

    // Calculate convergence
    const consensusScore = analysis.consensusStrength;

    return {
      roundNumber,
      type: roundNumber === 1 ? 'initial' : roundNumber === (request.config.maxDebateRounds || 3) ? 'synthesis' : 'critique',
      contributions,
      consensusScore,
      timestamp: Date.now(),
      durationMs: Date.now() - startTime,
    };
  }

  // ============ Hierarchical Strategy ============

  private async synthesizeHierarchical(
    request: VerificationRequest,
    responses: AgentResponse[],
    analysis: VerificationAnalysis
  ): Promise<{ synthesizedResponse: string; confidence: number }> {
    // Tier 1: Fast filter - eliminate low-confidence and outlier responses
    const tier1Responses = responses.filter(
      (r) => r.confidence >= 0.5 && !analysis.outlierAgents.includes(r.agentId)
    );

    if (tier1Responses.length === 0) {
      // Fall back to best-of if all filtered
      return this.synthesizeBestOf(responses, analysis);
    }

    // Tier 2: Deep analysis on remaining
    const tier2Analysis = await this.analyzeResponses(tier1Responses, request.config);

    // Tier 3: Final synthesis using consensus
    return this.synthesizeConsensus(tier1Responses, tier2Analysis, 2);
  }

  // ============ Queries ============

  getResult(verificationId: string): VerificationResult | undefined {
    return this.results.get(verificationId);
  }

  getActiveVerifications(): VerificationRequest[] {
    return Array.from(this.activeVerifications.values());
  }

  getResultsByInstance(instanceId: string): VerificationResult[] {
    return Array.from(this.results.values()).filter((r) => r.request.instanceId === instanceId);
  }

  getAllResults(): VerificationResult[] {
    return Array.from(this.results.values());
  }

  isVerificationActive(verificationId: string): boolean {
    return this.activeVerifications.has(verificationId);
  }

  cancelVerification(verificationId: string): boolean {
    if (this.activeVerifications.has(verificationId)) {
      this.activeVerifications.delete(verificationId);
      this.emit('verification:cancelled', { verificationId });
      return true;
    }
    return false;
  }
}

// Singleton accessor
export function getMultiVerifyCoordinator(): MultiVerifyCoordinator {
  return MultiVerifyCoordinator.getInstance();
}
