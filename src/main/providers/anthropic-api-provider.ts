/**
 * Anthropic API Provider - Direct SDK integration for API-key users
 *
 * This provider uses the Anthropic SDK directly (instead of CLI spawning).
 * It's an OPTIONAL alternative for users who want to use their own API key
 * instead of the Claude CLI (which uses their Claude subscription).
 *
 * Features:
 * - Prompt caching with explicit cache_control markers (50-90% cost reduction)
 * - Context editing API for emergency context management
 * - Full control over API request parameters
 *
 * NOTE: The Claude CLI already handles prompt caching internally.
 * Most users should use ClaudeCliProvider - it's cheaper (subscription-based)
 * and handles caching automatically. Only use this provider if you specifically
 * need direct API access with your own API key.
 */

import Anthropic from '@anthropic-ai/sdk';
import { EventEmitter } from 'events';
import { BaseProvider } from './provider-interface';
import { getPromptCacheManager, CacheableContext } from '../memory/prompt-cache';
import { getContextEditingFallback, ContextState } from '../memory/context-editing-fallback';
import { getMetricsCollector } from '../learning/metrics-collector';
import { generateId } from '../../shared/utils/id-generator';
import type {
  ProviderType,
  ProviderCapabilities,
  ProviderConfig,
  ProviderStatus,
  ProviderUsage,
  ProviderSessionOptions,
  ProviderAttachment,
} from '../../shared/types/provider.types';
import {
  MODEL_PRICING,
  CLAUDE_MODELS,
  getProviderModelContextWindow
} from '../../shared/types/provider.types';
import type {
  OutputMessage,
  InstanceStatus,
  ContextUsage,
} from '../../shared/types/instance.types';
import type {
  CacheableSystemPrompt,
  CacheUsageMetrics,
} from '../../shared/types/api-features.types';
import {
  supportsPromptCaching,
  supportsContextEditing,
} from '../../shared/types/api-features.types';

// ============================================
// Types
// ============================================

/**
 * Session state for tracking conversation context
 */
interface SessionState {
  messages: Anthropic.MessageParam[];
  systemPrompt: CacheableSystemPrompt | string;
  contextTokens: number;
  maxContextTokens: number;
  compactionAttempted: boolean;
}

/**
 * Configuration specific to Anthropic API provider
 */
export interface AnthropicApiProviderConfig extends ProviderConfig {
  /** API key (defaults to ANTHROPIC_API_KEY env var) */
  apiKey?: string;
  /** Enable prompt caching (default: true) */
  enablePromptCaching?: boolean;
  /** Enable context editing fallback (default: true) */
  enableContextEditing?: boolean;
  /** Project context (CLAUDE.md, rules) for caching */
  projectContext?: string;
  /** Active skills for caching */
  skills?: string[];
  /** Tool definitions for caching */
  toolDefinitions?: string;
}

// ============================================
// Anthropic API Provider
// ============================================

/**
 * Anthropic API Provider
 *
 * Uses the Anthropic SDK directly with integrated prompt caching
 * and context editing capabilities.
 */
// @ts-expect-error wave2-task9 — provider + capabilities declared in Task 9
export class AnthropicApiProvider extends BaseProvider {
  private client: Anthropic | null = null;
  private session: SessionState | null = null;
  private currentUsage: ProviderUsage | null = null;
  private model: string = CLAUDE_MODELS.SONNET;
  private maxTokens: number = 4096;
  private options: AnthropicApiProviderConfig;

  constructor(config: ProviderConfig) {
    super(config);
    this.options = config as AnthropicApiProviderConfig;
  }

  // ============================================
  // Provider Interface Implementation
  // ============================================

  getType(): ProviderType {
    return 'anthropic-api';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      toolExecution: true,
      streaming: true,
      multiTurn: true,
      vision: true,
      fileAttachments: true,
      functionCalling: true,
      builtInCodeTools: false, // No built-in tools like Claude CLI
    };
  }

  async checkStatus(): Promise<ProviderStatus> {
    try {
      // Check if API key is available
      const apiKey = this.options.apiKey || process.env['ANTHROPIC_API_KEY'];
      if (!apiKey) {
        return {
          type: 'anthropic-api',
          available: false,
          authenticated: false,
          error: 'ANTHROPIC_API_KEY not set',
        };
      }

      // Create a temporary client to test connection
      const testClient = new Anthropic({ apiKey });

      // Make a minimal API call to verify authentication
      // Using a simple message that should work and be cheap
      await testClient.messages.create({
        model: CLAUDE_MODELS.HAIKU,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      });

      return {
        type: 'anthropic-api',
        available: true,
        authenticated: true,
      };
    } catch (error) {
      const errorMessage = (error as Error).message;
      return {
        type: 'anthropic-api',
        available: true, // API endpoint is reachable
        authenticated: errorMessage.includes('401') ? false : true,
        error: errorMessage,
      };
    }
  }

  async initialize(options: ProviderSessionOptions): Promise<void> {
    if (this.client) {
      throw new Error('Provider already initialized');
    }

    const apiKey = this.options.apiKey || process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }

    this.client = new Anthropic({ apiKey });
    this.sessionId = options.sessionId || generateId();
    this.model = options.model || this.config.defaultModel || CLAUDE_MODELS.SONNET;
    this.maxTokens = options.maxTokens || 4096;

    // Configure prompt cache manager for this model
    const cacheManager = getPromptCacheManager();
    cacheManager.configureForModel(this.model);

    // Build system prompt with caching if enabled
    let systemPrompt: CacheableSystemPrompt | string;

    if (this.options.enablePromptCaching !== false && supportsPromptCaching(this.model)) {
      const context: CacheableContext = {
        systemPrompt: options.systemPrompt || '',
        projectContext: this.options.projectContext || '',
        skills: this.options.skills || [],
        toolDefinitions: this.options.toolDefinitions,
      };
      systemPrompt = cacheManager.wrapForCaching(context);
    } else {
      systemPrompt = options.systemPrompt || '';
    }

    // Initialize session state
    this.session = {
      messages: [],
      systemPrompt,
      contextTokens: 0,
      maxContextTokens: getProviderModelContextWindow('anthropic-api', this.model),
      compactionAttempted: false,
    };

    this.isActive = true;
    this.emit('spawned', null); // No PID for API-based provider
    this.emit('status', 'idle' as InstanceStatus);
  }

  async sendMessage(message: string, attachments?: ProviderAttachment[]): Promise<void> {
    if (!this.client || !this.session) {
      throw new Error('Provider not initialized');
    }

    this.emit('status', 'busy' as InstanceStatus);

    try {
      // Build user message with attachments
      const userMessage = this.buildUserMessage(message, attachments);
      this.session.messages.push(userMessage);

      // Check if we need context editing fallback
      const contextState: ContextState = {
        utilizationPercent: (this.session.contextTokens / this.session.maxContextTokens) * 100,
        compactionAttempted: this.session.compactionAttempted,
        sessionId: this.sessionId,
        model: this.model,
      };

      const contextEditingFallback = getContextEditingFallback();
      const useContextEditing =
        this.options.enableContextEditing !== false &&
        supportsContextEditing(this.model) &&
        contextEditingFallback.shouldUseFallback(contextState);

      let response: Anthropic.Message;

      if (useContextEditing) {
        // Use context editing fallback
        response = await contextEditingFallback.createMessageWithClearing(
          this.client,
          {
            model: this.model,
            max_tokens: this.maxTokens,
            messages: this.session.messages,
            system: this.session.systemPrompt as any,
          },
          this.sessionId
        );
      } else {
        // Standard API call with caching
        response = await this.client.messages.create({
          model: this.model,
          max_tokens: this.maxTokens,
          system: this.session.systemPrompt as any,
          messages: this.session.messages,
        }, {
          headers: {
            'anthropic-beta': 'token-efficient-tools-2025-02-19',
          },
        });
      }

      // Process response
      this.processResponse(response);

      // Extract cache metrics if available
      const cacheManager = getPromptCacheManager();
      if (response.usage) {
        const usage = response.usage as CacheUsageMetrics;
        if (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined) {
          cacheManager.extractMetrics(usage, this.sessionId);
        }
      }

      // Update context usage
      this.updateContextUsage(response);

      this.emit('status', 'idle' as InstanceStatus);
    } catch (error) {
      this.emit('error', error as Error);
      this.emit('status', 'error' as InstanceStatus);
      throw error;
    }
  }

  async terminate(graceful: boolean = true): Promise<void> {
    this.client = null;
    this.session = null;
    this.isActive = false;
    this.emit('exit', 0, null);
  }

  override getUsage(): ProviderUsage | null {
    return this.currentUsage;
  }

  // ============================================
  // Private Helper Methods
  // ============================================

  /**
   * Build user message with attachments
   */
  private buildUserMessage(
    message: string,
    attachments?: ProviderAttachment[]
  ): Anthropic.MessageParam {
    const content: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [];

    // Add text content
    if (message) {
      content.push({ type: 'text', text: message });
    }

    // Add image attachments
    if (attachments) {
      for (const attachment of attachments) {
        if (attachment.mimeType?.startsWith('image/')) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: attachment.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: attachment.data,
            },
          });
        }
      }
    }

    return { role: 'user', content };
  }

  /**
   * Process API response and emit events
   */
  private processResponse(response: Anthropic.Message): void {
    // Add assistant message to session
    this.session!.messages.push({
      role: 'assistant',
      content: response.content,
    });

    // Extract and emit text content
    let textContent = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        // Emit tool use event
        const toolOutput: OutputMessage = {
          id: generateId(),
          timestamp: Date.now(),
          type: 'tool_use',
          content: `Using tool: ${block.name}`,
          metadata: {
            id: block.id,
            name: block.name,
            input: block.input,
          },
        };
        this.emit('output', toolOutput);
      }
    }

    if (textContent) {
      const output: OutputMessage = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'assistant',
        content: textContent,
      };
      this.emit('output', output);
    }
  }

  /**
   * Update context usage from response
   */
  private updateContextUsage(response: Anthropic.Message): void {
    const usage = response.usage;
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    const totalTokens = inputTokens + outputTokens;

    // Update session context tracking
    this.session!.contextTokens = totalTokens;

    // Calculate context percentage
    const percentage = (totalTokens / this.session!.maxContextTokens) * 100;

    // Emit context usage
    const contextUsage: ContextUsage = {
      used: totalTokens,
      total: this.session!.maxContextTokens,
      percentage: Math.min(percentage, 100),
    };
    this.emit('context', contextUsage);

    // Update usage statistics
    const modelId = this.model;
    const pricing = (MODEL_PRICING as any)[modelId] || { input: 3.0, output: 15.0 };

    // Calculate cost, accounting for cache pricing if available
    const cacheUsage = usage as CacheUsageMetrics;
    let inputCost: number;

    if (cacheUsage.cache_read_input_tokens !== undefined) {
      // Cache reads cost 10% of base
      const cacheReadCost =
        (cacheUsage.cache_read_input_tokens / 1_000_000) * pricing.input * 0.1;
      // Cache creation costs 125% of base
      const cacheCreationCost =
        ((cacheUsage.cache_creation_input_tokens || 0) / 1_000_000) * pricing.input * 1.25;
      // Regular input tokens
      const regularCost =
        ((cacheUsage.input_tokens || 0) / 1_000_000) * pricing.input;
      inputCost = cacheReadCost + cacheCreationCost + regularCost;
    } else {
      inputCost = (inputTokens / 1_000_000) * pricing.input;
    }

    const outputCost = (outputTokens / 1_000_000) * pricing.output;

    this.currentUsage = {
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCost: inputCost + outputCost,
    };

    // Report to metrics collector
    try {
      const metricsCollector = getMetricsCollector();
      const percentage = (totalTokens / this.session!.maxContextTokens) * 100;
      metricsCollector.recordContextUsage(totalTokens, percentage);
    } catch {
      // Metrics collector not available - ignore
    }
  }

  // ============================================
  // Advanced Features
  // ============================================

  /**
   * Update the system prompt with new project context
   * Useful when files change and context needs refreshing
   */
  async updateProjectContext(projectContext: string, skills?: string[]): Promise<void> {
    if (!this.session) {
      throw new Error('Provider not initialized');
    }

    if (this.options.enablePromptCaching !== false && supportsPromptCaching(this.model)) {
      const cacheManager = getPromptCacheManager();
      const baseSystemPrompt =
        Array.isArray(this.session.systemPrompt)
          ? this.session.systemPrompt[0]?.text || ''
          : this.session.systemPrompt;

      const context: CacheableContext = {
        systemPrompt: baseSystemPrompt,
        projectContext,
        skills: skills || this.options.skills || [],
        toolDefinitions: this.options.toolDefinitions,
      };
      this.session.systemPrompt = cacheManager.wrapForCaching(context);
    }
  }

  /**
   * Get cache performance metrics for this session
   */
  getCacheMetrics(): {
    hitRate: number;
    costSavingsPercent: number;
    totalCreation: number;
    totalRead: number;
  } {
    const cacheManager = getPromptCacheManager();
    const cumulative = cacheManager.getCumulativeMetrics();
    return {
      hitRate: cumulative.overallHitRate,
      costSavingsPercent: cumulative.estimatedTotalSavings > 0 ? 50 : 0, // Rough estimate
      totalCreation: cumulative.totalCreation,
      totalRead: cumulative.totalRead,
    };
  }

  /**
   * Force context compaction using the editing fallback
   */
  async forceContextCompaction(): Promise<void> {
    if (!this.session) {
      throw new Error('Provider not initialized');
    }

    this.session.compactionAttempted = true;

    // The next sendMessage call will use context editing if thresholds are met
  }

  /**
   * Clear conversation history (start fresh)
   */
  clearHistory(): void {
    if (this.session) {
      this.session.messages = [];
      this.session.contextTokens = 0;
      this.session.compactionAttempted = false;
    }
  }
}

// ============================================
// Factory Export
// ============================================

export function createAnthropicApiProvider(config: ProviderConfig): AnthropicApiProvider {
  return new AnthropicApiProvider(config);
}
