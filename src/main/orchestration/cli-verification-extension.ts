/**
 * CLI Verification Extension - Extends MultiVerifyCoordinator for CLI agents
 * Enables heterogeneous multi-agent verification across different CLI tools
 */

import { EventEmitter } from 'events';
import { Subscription } from 'rxjs';
import { getLogger } from '../logging/logger';
import {
  VerificationConfig,
  VerificationRequest,
  VerificationResult,
  AgentResponse,
  PersonalityType,
  createDefaultVerificationConfig,
} from '../../shared/types/verification.types';
import { ProviderType } from '../../shared/types/provider.types';
import { CliDetectionService, CliInfo, CliType } from '../cli/cli-detection';
import { getProviderInstanceManager } from '../providers/provider-instance-manager';
import { BaseProvider } from '../providers/provider-interface';
import { selectPersonalities, PERSONALITY_PROMPTS } from './personalities';
import { generateId } from '../../shared/utils/id-generator';
import { estimateTokens } from '../rlm/token-counter';

/**
 * Configuration for CLI-based verification
 */
export interface CliVerificationConfig extends VerificationConfig {
  /** Specific CLIs to use: ['claude', 'codex', 'gemini'] */
  cliAgents?: CliType[];
  /** Prefer CLI over API when both available */
  preferCli?: boolean;
  /** Use API if CLI not available */
  fallbackToApi?: boolean;
  /** Allow mixing CLI and API agents */
  mixedMode?: boolean;
}

/**
 * Agent configuration for verification
 */
export interface AgentConfig {
  type: 'cli' | 'api';
  name: string;
  command?: string;
  provider: BaseProvider;
  personality?: PersonalityType;
}

/**
 * CLI to Provider type mapping
 */
const CLI_TO_PROVIDER: Record<string, ProviderType> = {
  'claude': 'claude-cli',
  'codex': 'openai',
  'gemini': 'google',
  'ollama': 'ollama',
};

/**
 * API fallback mapping for CLIs
 */
const API_FALLBACKS: Record<string, ProviderType> = {
  'claude': 'anthropic-api',
  'codex': 'openai',
  'gemini': 'google',
};

/**
 * CLI Verification Coordinator - Manages multi-CLI verification workflows
 */
/**
 * Tracks active agent providers for a verification session
 */
interface ActiveSession {
  request: VerificationRequest;
  providers: Map<string, BaseProvider>;
  cancelled: boolean;
}

const logger = getLogger('CliVerification');

export class CliVerificationCoordinator extends EventEmitter {
  private static instance: CliVerificationCoordinator | null = null;
  private cliDetection = CliDetectionService.getInstance();
  private registry = getProviderInstanceManager();
  private activeVerifications: Map<string, VerificationRequest> = new Map();
  private activeSessions: Map<string, ActiveSession> = new Map();
  private results: Map<string, VerificationResult> = new Map();

  private constructor() {
    super();
  }

  static getInstance(): CliVerificationCoordinator {
    if (!this.instance) {
      this.instance = new CliVerificationCoordinator();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Start verification with CLI agents
   */
  async startVerificationWithCli(
    request: { prompt: string; context?: string; id?: string; attachments?: { name: string; mimeType: string; data: string }[] },
    config: CliVerificationConfig
  ): Promise<VerificationResult> {
    const startTime = Date.now();

    // Detect available CLIs
    const detection = await this.cliDetection.detectAll();

    // Select agents based on config
    const agents = await this.selectAgents(config, detection.available);

    if (agents.length < 3) {
      this.emit('warning', {
        message: `Only ${agents.length} agents available. Byzantine tolerance requires 3+.`,
        available: agents.map(a => a.name),
      });
    }

    // Use provided ID or generate a new one
    const verificationId = request.id || `cli-verify-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const verificationRequest: VerificationRequest = {
      id: verificationId,
      instanceId: 'cli-verification',
      prompt: request.prompt,
      config: {
        ...createDefaultVerificationConfig(),
        ...config,
        agentCount: agents.length,
      },
      context: request.context,
      attachments: request.attachments,
    };

    this.activeVerifications.set(verificationId, verificationRequest);

    // Create active session to track providers for cancellation
    const activeSession: ActiveSession = {
      request: verificationRequest,
      providers: new Map(),
      cancelled: false,
    };
    this.activeSessions.set(verificationId, activeSession);

    this.emit('verification:started', { requestId: verificationId, agents: agents.map(a => a.name) });

    try {
      // Run verification
      const result = await this.runCliVerification(verificationRequest, agents, activeSession);
      result.totalDuration = Date.now() - startTime;

      this.results.set(verificationId, result);
      this.activeVerifications.delete(verificationId);
      this.activeSessions.delete(verificationId);

      this.emit('verification:completed', result);
      return result;
    } catch (error) {
      this.activeVerifications.delete(verificationId);
      this.activeSessions.delete(verificationId);

      // Check if this was due to cancellation
      if (activeSession.cancelled) {
        this.emit('verification:cancelled', {
          verificationId,
          reason: 'User requested cancellation'
        });
        throw new Error('Verification cancelled');
      }

      this.emit('verification:error', { requestId: verificationId, error });
      throw error;
    }
  }

  /**
   * Select agents based on configuration and available CLIs
   */
  private async selectAgents(
    config: CliVerificationConfig,
    availableClis: CliInfo[]
  ): Promise<AgentConfig[]> {
    const agents: AgentConfig[] = [];
    const personalities = selectPersonalities(config.agentCount || 3);
    let personalityIndex = 0;

    // If specific CLIs requested
    if (config.cliAgents && config.cliAgents.length > 0) {
      for (const cliName of config.cliAgents) {
        const cli = availableClis.find(c => c.name === cliName);

        if (cli?.installed) {
          try {
            const provider = this.registry.createCliProvider(cliName);
            agents.push({
              type: 'cli',
              name: cli.displayName,
              command: cli.command,
              provider,
              personality: personalities[personalityIndex++ % personalities.length],
            });
          } catch (error) {
            this.emit('warning', { message: `Failed to create CLI provider for ${cliName}`, error });
          }
        } else if (config.fallbackToApi) {
          // Try API fallback
          const apiType = API_FALLBACKS[cliName];
          if (apiType && this.registry.isSupported(apiType)) {
            try {
              const provider = this.registry.createProvider(apiType);
              agents.push({
                type: 'api',
                name: `${cliName}-api`,
                provider,
                personality: personalities[personalityIndex++ % personalities.length],
              });
            } catch (error) {
              this.emit('warning', { message: `Failed to create API fallback for ${cliName}`, error });
            }
          }
        }
      }
    } else {
      // Auto-select available CLIs
      for (const cli of availableClis) {
        if (agents.length >= (config.agentCount || 5)) break;

        try {
          const provider = this.registry.createCliProvider(cli.name);
          agents.push({
            type: 'cli',
            name: cli.displayName,
            command: cli.command,
            provider,
            personality: personalities[personalityIndex++ % personalities.length],
          });
        } catch (error) {
          this.emit('warning', { message: `Failed to create CLI provider for ${cli.name}`, error });
        }
      }

      // Add API agents if in mixed mode and need more agents
      if (config.mixedMode && agents.length < (config.agentCount || 3)) {
        const apiProviders = this.registry.getEnabledProviders();
        for (const apiConfig of apiProviders) {
          if (agents.length >= (config.agentCount || 5)) break;
          if (apiConfig.type.includes('cli')) continue; // Skip CLI-based providers

          try {
            const provider = this.registry.createProvider(apiConfig.type);
            agents.push({
              type: 'api',
              name: apiConfig.name,
              provider,
              personality: personalities[personalityIndex++ % personalities.length],
            });
          } catch (error) {
            this.emit('warning', { message: `Failed to create API provider for ${apiConfig.type}`, error });
          }
        }
      }
    }

    // Ensure minimum agent count by duplicating with different personalities
    // Note: When not enough unique CLIs are available, we duplicate agents with different
    // personalities to get diverse perspectives. This is intentional for Byzantine fault tolerance.
    while (agents.length < (config.agentCount || 3) && agents.length > 0) {
      // Cycle through available agents to distribute load
      const baseAgentIndex = agents.length % Math.min(agents.length, config.agentCount || 3);
      const baseAgent = agents[baseAgentIndex];
      const newPersonality = personalities[agents.length % personalities.length];
      const personalityLabel = this.getPersonalityShortLabel(newPersonality);
      agents.push({
        ...baseAgent,
        // Create a provider clone (new instance, not shared reference)
        provider: this.registry.createCliProvider(baseAgent.command?.split(' ')[0] as CliType),
        name: `${baseAgent.name} (${personalityLabel})`,
        personality: newPersonality,
      });
    }

    return agents.slice(0, config.agentCount || 5);
  }

  /**
   * Run verification with selected agents
   */
  private async runCliVerification(
    request: VerificationRequest,
    agents: AgentConfig[],
    session: ActiveSession
  ): Promise<VerificationResult> {
    const startTime = Date.now();

    this.emit('verification:agents-launching', {
      requestId: request.id,
      agentCount: agents.length,
      agents: agents.map(a => ({ name: a.name, type: a.type, personality: a.personality })),
    });

    // Run all agents in parallel
    const responsePromises = agents.map((agent, index) =>
      this.runAgent(request, agent, index, session)
    );

    const responses = await Promise.all(responsePromises);

    // Analyze responses
    const analysis = this.analyzeResponses(responses, request.config);

    // Synthesize final response
    const { synthesizedResponse, confidence } = this.synthesize(
      responses,
      analysis,
      request.config.synthesisStrategy
    );

    return {
      id: request.id,
      request,
      responses,
      analysis,
      synthesizedResponse,
      synthesisMethod: request.config.synthesisStrategy,
      synthesisConfidence: confidence,
      totalDuration: Date.now() - startTime,
      totalTokens: responses.reduce((sum, r) => sum + r.tokens, 0),
      totalCost: responses.reduce((sum, r) => sum + r.cost, 0),
      completedAt: Date.now(),
    };
  }

  /**
   * Run a single agent
   */
  private async runAgent(
    request: VerificationRequest,
    agent: AgentConfig,
    index: number,
    session: ActiveSession
  ): Promise<AgentResponse> {
    const startTime = Date.now();
    const agentId = `${request.id}-${agent.name.toLowerCase().replace(/\s+/g, '-')}-${index}`;

    // Check if cancelled before starting
    if (session.cancelled) {
      return {
        agentId,
        agentIndex: index,
        model: `${agent.type}:${agent.name}`,
        personality: agent.personality,
        response: '',
        keyPoints: [],
        confidence: 0,
        duration: 0,
        tokens: 0,
        cost: 0,
        error: 'Verification cancelled',
      };
    }

    let sub: Subscription | undefined;

    try {
      // Build prompt with personality
      const systemPrompt = this.buildAgentPrompt(agent.personality);
      const fullPrompt = request.context
        ? `${request.context}\n\n${request.prompt}`
        : request.prompt;

      // Initialize provider
      await agent.provider.initialize({
        workingDirectory: process.cwd(),
        systemPrompt,
        yoloMode: true, // Auto-approve for verification
      });

      // Register provider in session for cancellation tracking
      session.providers.set(agentId, agent.provider);

      // Check if cancelled during initialization
      if (session.cancelled) {
        await agent.provider.terminate();
        session.providers.delete(agentId);
        return {
          agentId,
          agentIndex: index,
          model: `${agent.type}:${agent.name}`,
          personality: agent.personality,
          response: '',
          keyPoints: [],
          confidence: 0,
          duration: Date.now() - startTime,
          tokens: 0,
          cost: 0,
          error: 'Verification cancelled',
        };
      }

      // Collect response
      let responseContent = '';
      let tokens = 0;
      let responseComplete = false;

      // Subscribe to typed events$ stream before sending message
      sub = agent.provider.events$.subscribe(env => {
        switch (env.event.kind) {
          case 'output': {
            const content = env.event.content;
            if (content) {
              responseContent += content;
              this.emit('verification:agent-stream', {
                requestId: request.id,
                agentId,
                agentName: agent.name,
                content,
                totalContent: responseContent,
              });
            }
            break;
          }
          case 'context':
            tokens = env.event.used || 0;
            break;
          case 'status':
            if (env.event.status === 'idle') {
              responseComplete = true;
            }
            break;
        }
      });

      // Convert attachments to provider format
      const providerAttachments = request.attachments?.map(att => ({
        type: att.mimeType.startsWith('image/') ? 'image' as const : 'file' as const,
        name: att.name,
        mimeType: att.mimeType,
        data: att.data,
      }));

      // Send message with attachments
      await agent.provider.sendMessage(fullPrompt, providerAttachments);

      // Wait for response to complete (with timeout)
      const maxWaitTime = request.config.timeout || 120000;
      const pollInterval = 500;
      let waitedTime = 0;

      while (!responseComplete && waitedTime < maxWaitTime && !session.cancelled) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        waitedTime += pollInterval;
      }

      // Additional grace period for any final events
      await new Promise(resolve => setTimeout(resolve, 500));

      // Terminate provider and remove from session tracking
      await agent.provider.terminate();
      sub?.unsubscribe();
      session.providers.delete(agentId);

      // If no token count from context event, estimate from content length.
      // Pass the CLI command (or agent name) so the counter uses
      // family-specific char/token ratios (e.g. Claude ~3.8 vs the default 4.0).
      if (tokens === 0 && responseContent.length > 0) {
        const modelHint = agent.command ?? agent.name;
        const promptTokens = estimateTokens(fullPrompt, modelHint);
        const responseTokens = estimateTokens(responseContent, modelHint);
        tokens = promptTokens + responseTokens;
      }

      // Emit agent complete event
      this.emit('verification:agent-complete', {
        requestId: request.id,
        agentId,
        agentName: agent.name,
        success: true,
        responseLength: responseContent.length,
        tokens,
      });

      const keyPoints = this.extractKeyPoints(responseContent);
      const confidence = this.extractConfidence(responseContent);

      return {
        agentId,
        agentIndex: index,
        model: `${agent.type}:${agent.name}`,
        personality: agent.personality,
        response: responseContent,
        keyPoints,
        confidence,
        duration: Date.now() - startTime,
        tokens,
        cost: this.estimateCost(tokens, agent.type),
      };
    } catch (error) {
      // Clean up provider from session tracking
      try {
        if (session.providers.has(agentId)) {
          await agent.provider.terminate();
          session.providers.delete(agentId);
        }
      } catch {
        /* intentionally ignored: provider cleanup errors should not block error reporting */
      }
      sub?.unsubscribe();

      // Emit agent complete event with error
      this.emit('verification:agent-complete', {
        requestId: request.id,
        agentId,
        agentName: agent.name,
        success: false,
        error: (error as Error).message,
      });

      return {
        agentId,
        agentIndex: index,
        model: `${agent.type}:${agent.name}`,
        personality: agent.personality,
        response: '',
        keyPoints: [],
        confidence: 0,
        duration: Date.now() - startTime,
        tokens: 0,
        cost: 0,
        error: (error as Error).message,
        timedOut: (error as Error).message.includes('timeout'),
      };
    }
  }

  /**
   * Get short label for personality (for display names)
   */
  private getPersonalityShortLabel(personality?: PersonalityType): string {
    const labels: Record<PersonalityType, string> = {
      'methodical-analyst': 'Analyst',
      'creative-solver': 'Creative',
      'pragmatic-engineer': 'Pragmatic',
      'security-focused': 'Security',
      'user-advocate': 'User Advocate',
      'devils-advocate': "Devil's Advocate",
      'domain-expert': 'Expert',
      'generalist': 'Generalist',
    };
    return personality ? labels[personality] || personality : 'Alt';
  }

  /**
   * Build agent prompt with personality
   */
  private buildAgentPrompt(personality?: PersonalityType): string {
    const personalitySection = personality && PERSONALITY_PROMPTS[personality]
      ? PERSONALITY_PROMPTS[personality] + '\n\n'
      : '';

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

## Overall Confidence
State your overall confidence in your response (0-100%): X%`;
  }

  /**
   * Extract key points from response
   */
  private extractKeyPoints(response: string): any[] {
    const keyPoints: any[] = [];
    const match = response.match(/## Key Points\n([\s\S]*?)(?=\n##|$)/i);

    if (match) {
      const lines = match[1].split('\n').filter(l => l.trim().startsWith('-'));
      for (const line of lines) {
        const categoryMatch = line.match(/\[(?:Category:\s*)?([\w-]+)\]/i);
        const confidenceMatch = line.match(/\(Confidence:\s*(\d+)%?\)/i);
        const content = line
          .replace(/^-\s*/, '')
          .replace(/\[.*?\]\s*/g, '')
          .replace(/\(Confidence:.*?\)/i, '')
          .trim();

        keyPoints.push({
          id: generateId(),
          content,
          category: categoryMatch?.[1]?.toLowerCase() || 'fact',
          confidence: confidenceMatch ? parseInt(confidenceMatch[1]) / 100 : 0.7,
        });
      }
    }

    return keyPoints;
  }

  /**
   * Extract confidence from response
   */
  private extractConfidence(response: string): number {
    const match = response.match(/Overall Confidence[:\s]*(\d+)%?/i);
    return match ? parseInt(match[1]) / 100 : 0.5;
  }

  /**
   * Analyze responses from all agents
   */
  private analyzeResponses(responses: AgentResponse[], config: VerificationConfig): any {
    const validResponses = responses.filter(r => !r.error);

    // Find agreements
    const agreements = this.findAgreements(validResponses);

    // Find disagreements
    const disagreements = this.findDisagreements(validResponses);

    // Rank responses
    const rankings = this.rankResponses(validResponses);

    // Detect outliers
    const outliers = this.detectOutliers(validResponses, agreements);

    // Calculate consensus strength
    const consensusStrength = agreements.length > 0
      ? agreements.reduce((sum, a) => sum + a.strength, 0) / agreements.length
      : 0;

    return {
      agreements,
      disagreements,
      uniqueInsights: [],
      responseRankings: rankings,
      overallConfidence: consensusStrength,
      outlierAgents: outliers,
      consensusStrength,
    };
  }

  /**
   * Find agreement points across responses
   */
  private findAgreements(responses: AgentResponse[]): any[] {
    const pointCounts = new Map<string, { point: any; agents: string[] }>();

    for (const response of responses) {
      for (const point of response.keyPoints) {
        const normalized = point.content.toLowerCase().trim();
        const existing = pointCounts.get(normalized) || { point, agents: [] };
        existing.agents.push(response.agentId);
        pointCounts.set(normalized, existing);
      }
    }

    return Array.from(pointCounts.values())
      .filter(p => p.agents.length >= 2)
      .map(p => ({
        point: p.point.content,
        category: p.point.category,
        agentIds: p.agents,
        strength: p.agents.length / responses.length,
        combinedConfidence: p.point.confidence,
      }));
  }

  /**
   * Find disagreement points
   */
  private findDisagreements(responses: AgentResponse[]): any[] {
    const recommendations = responses.flatMap(r =>
      r.keyPoints
        .filter(p => p.category === 'recommendation')
        .map(p => ({ ...p, agentId: r.agentId }))
    );

    if (recommendations.length <= 1) return [];

    const unique = new Set(recommendations.map(r => r.content.toLowerCase()));
    if (unique.size > 1) {
      return [{
        topic: 'Recommendations differ across agents',
        positions: recommendations.map(r => ({
          agentId: r.agentId,
          position: r.content,
          confidence: r.confidence,
        })),
        requiresHumanReview: true,
      }];
    }

    return [];
  }

  /**
   * Rank responses by quality
   */
  private rankResponses(responses: AgentResponse[]): any[] {
    return responses
      .map(r => {
        const completeness = Math.min(1, r.keyPoints.length / 5);
        const accuracy = r.confidence;
        const score = completeness * 0.3 + accuracy * 0.7;

        return {
          agentId: r.agentId,
          rank: 0,
          score,
          criteria: { completeness, accuracy },
        };
      })
      .sort((a, b) => b.score - a.score)
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }

  /**
   * Detect outlier agents
   */
  private detectOutliers(responses: AgentResponse[], agreements: any[]): string[] {
    const outliers: string[] = [];
    const majorityPoints = new Set(
      agreements.filter(a => a.strength >= 0.5).map(a => a.point.toLowerCase())
    );

    for (const response of responses) {
      const agentPoints = new Set(response.keyPoints.map(p => p.content.toLowerCase()));
      const overlap = [...agentPoints].filter(p => majorityPoints.has(p)).length;

      if (majorityPoints.size > 0 && overlap / majorityPoints.size < 0.3) {
        outliers.push(response.agentId);
      }
    }

    return outliers;
  }

  /**
   * Synthesize final response
   */
  private synthesize(
    responses: AgentResponse[],
    analysis: any,
    strategy: string
  ): { synthesizedResponse: string; confidence: number } {
    const validResponses = responses.filter(r => !r.error);

    if (validResponses.length === 0) {
      return {
        synthesizedResponse: 'All verification agents failed to respond.',
        confidence: 0,
      };
    }

    // Use best-of strategy by default
    const topRanked = analysis.responseRankings[0];
    const topResponse = validResponses.find(r => r.agentId === topRanked?.agentId);

    if (!topResponse) {
      return {
        synthesizedResponse: validResponses[0].response,
        confidence: 0.5,
      };
    }

    const agentTypes = responses.map(r => r.model.split(':')[0]);
    const uniqueTypes = [...new Set(agentTypes)];

    return {
      synthesizedResponse: `${topResponse.response}

---
*Multi-CLI Verification Summary*
- **Agents**: ${responses.length} (${uniqueTypes.join(', ')})
- **Agreement Points**: ${analysis.agreements.length}
- **Consensus Strength**: ${(analysis.consensusStrength * 100).toFixed(1)}%
- **Top Response**: ${topResponse.model} (${topResponse.personality || 'default'})`,
      confidence: Math.min(0.9, topRanked?.score || 0.5),
    };
  }

  /**
   * Estimate cost based on tokens and agent type
   */
  private estimateCost(tokens: number, agentType: string): number {
    const pricing: Record<string, number> = {
      'cli': 10, // $10 per million tokens (blended)
      'api': 15, // $15 per million tokens (blended)
    };
    const rate = pricing[agentType] || 10;
    return (tokens / 1_000_000) * rate;
  }

  // ============ Cancellation Methods ============

  /**
   * Cancel a specific verification session by ID
   * Terminates all running CLI processes and cleans up resources
   * @param verificationId The ID of the verification to cancel
   * @returns Object containing success status and details
   */
  async cancelVerification(verificationId: string): Promise<{
    success: boolean;
    agentsCancelled: number;
    error?: string;
  }> {
    const session = this.activeSessions.get(verificationId);

    if (!session) {
      // Check if it's an active verification without a session yet
      if (this.activeVerifications.has(verificationId)) {
        // Verification hasn't started agents yet, just remove it
        this.activeVerifications.delete(verificationId);
        this.emit('verification:cancelled', {
          verificationId,
          reason: 'Cancelled before agents started',
          agentsCancelled: 0,
        });
        return { success: true, agentsCancelled: 0 };
      }

      return {
        success: false,
        agentsCancelled: 0,
        error: `No active verification found with ID: ${verificationId}`,
      };
    }

    // Mark session as cancelled to prevent new work
    session.cancelled = true;

    // Terminate all active providers
    const terminationPromises: Promise<void>[] = [];
    const providerIds = Array.from(session.providers.keys());

    for (const [agentId, provider] of session.providers) {
      terminationPromises.push(
        (async () => {
          try {
            await provider.terminate(false); // Force terminate for immediate cancellation
            this.emit('verification:agent-cancelled', {
              verificationId,
              agentId,
            });
          } catch (error) {
            // Log but don't fail the cancellation
            logger.error('Failed to terminate agent', error instanceof Error ? error : undefined, { agentId });
          }
        })()
      );
    }

    // Wait for all terminations with timeout
    await Promise.race([
      Promise.all(terminationPromises),
      new Promise<void>((resolve) => setTimeout(resolve, 10000)), // 10s timeout
    ]);

    // Clean up session
    session.providers.clear();
    this.activeSessions.delete(verificationId);
    this.activeVerifications.delete(verificationId);

    this.emit('verification:cancelled', {
      verificationId,
      reason: 'User requested cancellation',
      agentsCancelled: providerIds.length,
    });

    return {
      success: true,
      agentsCancelled: providerIds.length,
    };
  }

  /**
   * Cancel all active verification sessions
   * @returns Summary of all cancellations
   */
  async cancelAllVerifications(): Promise<{
    success: boolean;
    sessionsCancelled: number;
    totalAgentsCancelled: number;
    errors: string[];
  }> {
    const sessionIds = Array.from(this.activeSessions.keys());
    let totalAgentsCancelled = 0;
    const errors: string[] = [];

    const cancellationPromises = sessionIds.map(async (sessionId) => {
      const result = await this.cancelVerification(sessionId);
      if (result.success) {
        totalAgentsCancelled += result.agentsCancelled;
      } else if (result.error) {
        errors.push(result.error);
      }
      return result;
    });

    await Promise.all(cancellationPromises);

    return {
      success: errors.length === 0,
      sessionsCancelled: sessionIds.length,
      totalAgentsCancelled,
      errors,
    };
  }

  /**
   * Check if a verification session is active
   */
  isVerificationActive(verificationId: string): boolean {
    return this.activeVerifications.has(verificationId) || this.activeSessions.has(verificationId);
  }

  // ============ Query Methods ============

  getResult(verificationId: string): VerificationResult | undefined {
    return this.results.get(verificationId);
  }

  getActiveVerifications(): VerificationRequest[] {
    return Array.from(this.activeVerifications.values());
  }

  getAllResults(): VerificationResult[] {
    return Array.from(this.results.values());
  }

  /**
   * Get information about active sessions (for debugging/monitoring)
   */
  getActiveSessions(): Array<{
    verificationId: string;
    agentCount: number;
    cancelled: boolean;
  }> {
    return Array.from(this.activeSessions.entries()).map(([id, session]) => ({
      verificationId: id,
      agentCount: session.providers.size,
      cancelled: session.cancelled,
    }));
  }
}

/**
 * Get the CLI verification coordinator singleton
 */
export function getCliVerificationCoordinator(): CliVerificationCoordinator {
  return CliVerificationCoordinator.getInstance();
}
