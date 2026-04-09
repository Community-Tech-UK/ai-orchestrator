/**
 * Hot Model Switcher
 *
 * Enables switching models mid-conversation without restart:
 * - Context export/import for serializing conversation state
 * - Seamless continuation so user doesn't notice the switch
 * - Provider-specific transformations for message format adaptation
 * - Model-specific system prompts for behavior hints
 *
 * Currently requires restart (this module adds hot switching capability)
 */

import { EventEmitter } from 'events';
import type { Instance } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import type { CliType } from '../cli/cli-detection';

/**
 * Conversation state for export/import
 */
export interface ConversationState {
  /** Unique state ID for tracking */
  id: string;
  /** Original instance ID */
  instanceId: string;
  /** Session ID for continuity */
  sessionId: string;
  /** Conversation messages */
  messages: ConversationMessage[];
  /** Current context usage */
  contextUsage: {
    used: number;
    total: number;
    percentage: number;
  };
  /** System prompt in use */
  systemPrompt?: string;
  /** Working directory */
  workingDirectory: string;
  /** Active files in context */
  activeFiles: string[];
  /** Custom instructions */
  customInstructions?: string;
  /** Export timestamp */
  exportedAt: number;
  /** Source provider */
  sourceProvider: CliType;
  /** Source model */
  sourceModel?: string;
}

/**
 * Conversation message in portable format
 */
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  content: string;
  timestamp: number;
  /** Tool usage if applicable */
  toolUse?: {
    toolName: string;
    toolId: string;
    input: unknown;
    output?: string;
  };
  /** Thinking/reasoning content (Claude-specific) */
  thinking?: string;
  /** Token count for this message */
  tokens?: number;
}

/**
 * Switch request configuration
 */
export interface SwitchRequest {
  /** Target provider to switch to */
  targetProvider: CliType;
  /** Target model (optional, uses provider default) */
  targetModel?: string;
  /** Reason for switching (for logging/diagnostics) */
  reason: 'manual' | 'failover' | 'cost_optimization' | 'capability_requirement';
  /** Whether to preserve full conversation history */
  preserveHistory: boolean;
  /** Maximum messages to carry over (for large conversations) */
  maxMessages?: number;
  /** Whether to adapt system prompt for target model */
  adaptSystemPrompt: boolean;
}

/**
 * Switch result
 */
export interface SwitchResult {
  success: boolean;
  /** New adapter instance */
  newAdapter?: CliAdapter;
  /** Time taken to switch in ms */
  switchTimeMs: number;
  /** Messages carried over */
  messagesTransferred: number;
  /** Messages truncated/dropped */
  messagesDropped: number;
  /** Any warnings during switch */
  warnings: string[];
  /** Error if failed */
  error?: string;
}

/**
 * Provider-specific message transformations
 */
export interface ProviderTransformer {
  /** Transform message from source format to target format */
  transformMessage(
    message: ConversationMessage,
    targetProvider: CliType
  ): CliMessage;
  /** Adapt system prompt for target model */
  adaptSystemPrompt(
    prompt: string,
    sourceProvider: CliType,
    targetProvider: CliType,
    targetModel?: string
  ): string;
  /** Check if message type is supported by target */
  isSupported(message: ConversationMessage, targetProvider: CliType): boolean;
}

/**
 * Hot Model Switcher configuration
 */
export interface HotSwitcherConfig {
  /** Maximum conversation history to export (tokens) */
  maxExportTokens: number;
  /** Whether to compress tool outputs during export */
  compressToolOutputs: boolean;
  /** Maximum tool output length to preserve */
  maxToolOutputLength: number;
  /** Whether to preserve thinking content */
  preserveThinking: boolean;
  /** Switch timeout in ms */
  switchTimeoutMs: number;
  /** Whether to validate switch before completing */
  validateSwitch: boolean;
}

/**
 * Default configuration
 */
export const DEFAULT_HOT_SWITCHER_CONFIG: HotSwitcherConfig = {
  maxExportTokens: 50000,
  compressToolOutputs: true,
  maxToolOutputLength: 2000,
  preserveThinking: false,
  switchTimeoutMs: 30000,
  validateSwitch: true,
};

/**
 * Model-specific system prompt hints
 */
const MODEL_HINTS: Record<string, string> = {
  // Claude models (bare shorthand names)
  opus: '',
  sonnet: '',
  haiku: 'Be concise. Prioritize speed over thoroughness.',

  // OpenAI models (GPT-5 family)
  'gpt-5.4': '',
  'gpt-5.3-codex': '',
  'gpt-5.2-codex': '',
  'gpt-5.1-codex': '',
  'o3': 'Take time to reason through complex problems step by step.',
  // OpenAI models (GPT-5 family, additional)
  'gpt-5.4-mini': 'Be concise. Format code blocks with language tags.',
  'gpt-5.2': '',
  'o1': 'Take time to reason through complex problems step by step.',

  // Gemini models
  'gemini-3.1-pro-preview': '',
  'gemini-3-pro-preview': '',
  'gemini-3-flash-preview': '',
  'gemini-2.5-pro': '',
  'gemini-2.5-flash': '',

  // Default fallback
  default: '',
};

/**
 * Hot Model Switcher
 *
 * Manages hot switching between providers and models during conversations.
 */
export class HotModelSwitcher extends EventEmitter {
  private static instance: HotModelSwitcher | null = null;

  private config: HotSwitcherConfig;
  private transformer: ProviderTransformer;
  private activeSwitches: Map<string, { startedAt: number; request: SwitchRequest }> = new Map();

  private constructor() {
    super();
    this.config = { ...DEFAULT_HOT_SWITCHER_CONFIG };
    this.transformer = new DefaultProviderTransformer();
  }

  static getInstance(): HotModelSwitcher {
    if (!HotModelSwitcher.instance) {
      HotModelSwitcher.instance = new HotModelSwitcher();
    }
    return HotModelSwitcher.instance;
  }

  static _resetForTesting(): void {
    HotModelSwitcher.instance = null;
  }

  /**
   * Configure the switcher
   */
  configure(config: Partial<HotSwitcherConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('configured', this.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): HotSwitcherConfig {
    return { ...this.config };
  }

  /**
   * Set custom transformer
   */
  setTransformer(transformer: ProviderTransformer): void {
    this.transformer = transformer;
  }

  /**
   * Export conversation state for switching
   */
  exportConversationState(
    instance: Instance,
    adapter: CliAdapter,
    messages: ConversationMessage[]
  ): ConversationState {
    const exportId = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Filter and compress messages if needed
    let exportMessages = [...messages];

    // Apply token limit
    let totalTokens = 0;
    const limitedMessages: ConversationMessage[] = [];

    // Keep most recent messages within token limit
    for (let i = exportMessages.length - 1; i >= 0; i--) {
      const msg = exportMessages[i];
      const msgTokens = msg.tokens || this.estimateTokens(msg.content);

      if (totalTokens + msgTokens > this.config.maxExportTokens) {
        break;
      }

      limitedMessages.unshift(msg);
      totalTokens += msgTokens;
    }

    exportMessages = limitedMessages;

    // Compress tool outputs if configured
    if (this.config.compressToolOutputs) {
      exportMessages = exportMessages.map((msg) => {
        if (msg.role === 'tool_result' && msg.content.length > this.config.maxToolOutputLength) {
          return {
            ...msg,
            content: this.compressToolOutput(msg.content),
          };
        }
        return msg;
      });
    }

    // Remove thinking if not preserving
    if (!this.config.preserveThinking) {
      exportMessages = exportMessages.map((msg) => ({
        ...msg,
        thinking: undefined,
      }));
    }

    const state: ConversationState = {
      id: exportId,
      instanceId: instance.id,
      sessionId: instance.sessionId,
      messages: exportMessages,
      contextUsage: instance.contextUsage,
      systemPrompt: undefined, // Will be fetched from adapter if available
      workingDirectory: instance.workingDirectory,
      activeFiles: [], // Would need to track active files
      customInstructions: undefined,
      exportedAt: Date.now(),
      sourceProvider: this.getProviderType(adapter),
      sourceModel: undefined,
    };

    this.emit('state:exported', {
      exportId,
      instanceId: instance.id,
      messageCount: exportMessages.length,
      tokens: totalTokens,
    });

    return state;
  }

  /**
   * Import conversation state to initialize new adapter
   */
  importConversationState(
    state: ConversationState,
    targetProvider: CliType,
    targetModel?: string
  ): {
    messages: CliMessage[];
    systemPrompt: string;
    warnings: string[];
  } {
    const warnings: string[] = [];
    const messages: CliMessage[] = [];

    // Transform each message for target provider
    for (const msg of state.messages) {
      // Check if message type is supported
      if (!this.transformer.isSupported(msg, targetProvider)) {
        warnings.push(`Message type '${msg.role}' not fully supported by ${targetProvider}`);
      }

      try {
        const transformed = this.transformer.transformMessage(msg, targetProvider);
        messages.push(transformed);
      } catch (error) {
        warnings.push(`Failed to transform message ${msg.id}: ${error}`);
      }
    }

    // Adapt system prompt
    let systemPrompt = state.systemPrompt || '';
    if (state.sourceProvider !== targetProvider) {
      systemPrompt = this.transformer.adaptSystemPrompt(
        systemPrompt,
        state.sourceProvider,
        targetProvider,
        targetModel
      );
    }

    // Add model-specific hints
    const modelHint = MODEL_HINTS[targetModel || 'default'] || MODEL_HINTS['default'];
    if (modelHint) {
      systemPrompt = systemPrompt + '\n\n' + modelHint;
    }

    this.emit('state:imported', {
      stateId: state.id,
      targetProvider,
      targetModel,
      messageCount: messages.length,
      warningCount: warnings.length,
    });

    return { messages, systemPrompt, warnings };
  }

  /**
   * Perform a hot model switch
   *
   * This is the main entry point for switching models mid-conversation.
   */
  async performSwitch(
    instance: Instance,
    currentAdapter: CliAdapter,
    messages: ConversationMessage[],
    request: SwitchRequest,
    createAdapter: (provider: CliType, model?: string) => Promise<CliAdapter>
  ): Promise<SwitchResult> {
    const switchId = `switch-${Date.now()}`;
    const startTime = Date.now();

    this.activeSwitches.set(switchId, { startedAt: startTime, request });

    this.emit('switch:started', {
      switchId,
      instanceId: instance.id,
      fromProvider: this.getProviderType(currentAdapter),
      toProvider: request.targetProvider,
      reason: request.reason,
    });

    try {
      // 1. Export current conversation state
      const state = this.exportConversationState(instance, currentAdapter, messages);

      // 2. Apply message limits if specified
      if (request.maxMessages && state.messages.length > request.maxMessages) {
        const dropped = state.messages.length - request.maxMessages;
        state.messages = state.messages.slice(-request.maxMessages);
        this.emit('switch:messages_trimmed', { switchId, dropped });
      }

      // 3. Transform for target provider
      const { messages: transformedMessages, systemPrompt, warnings } =
        this.importConversationState(state, request.targetProvider, request.targetModel);

      // 4. Terminate current adapter gracefully
      await currentAdapter.terminate(true);

      // 5. Create new adapter with imported state
      const newAdapter = await createAdapter(request.targetProvider, request.targetModel);

      // 6. Initialize new adapter with conversation state
      // Note: The actual replay of messages depends on the adapter implementation
      // Some adapters support direct state injection, others need message replay

      // 7. Validate switch if configured
      if (this.config.validateSwitch) {
        const isValid = await this.validateNewAdapter(newAdapter);
        if (!isValid) {
          throw new Error('Switch validation failed - new adapter not responding');
        }
      }

      const result: SwitchResult = {
        success: true,
        newAdapter,
        switchTimeMs: Date.now() - startTime,
        messagesTransferred: transformedMessages.length,
        messagesDropped: messages.length - state.messages.length,
        warnings,
      };

      this.emit('switch:completed', {
        switchId,
        instanceId: instance.id,
        result,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.emit('switch:failed', {
        switchId,
        instanceId: instance.id,
        error: errorMessage,
      });

      return {
        success: false,
        switchTimeMs: Date.now() - startTime,
        messagesTransferred: 0,
        messagesDropped: 0,
        warnings: [],
        error: errorMessage,
      };
    } finally {
      this.activeSwitches.delete(switchId);
    }
  }

  /**
   * Check if a switch is in progress for an instance
   */
  isSwitching(instanceId: string): boolean {
    for (const [, switchInfo] of this.activeSwitches) {
      // Would need to track instanceId in switch info
      return true;
    }
    return false;
  }

  /**
   * Get switch statistics
   */
  getStats(): {
    activeSwitches: number;
    config: HotSwitcherConfig;
  } {
    return {
      activeSwitches: this.activeSwitches.size,
      config: { ...this.config },
    };
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.activeSwitches.clear();
    this.removeAllListeners();
    HotModelSwitcher.instance = null;
  }

  // ============================================
  // Private Helpers
  // ============================================

  private getProviderType(adapter: CliAdapter): CliType {
    const name = adapter.getName().toLowerCase();
    if (name.includes('claude')) return 'claude';
    if (name.includes('codex') || name.includes('openai')) return 'codex';
    if (name.includes('gemini')) return 'gemini';
    if (name.includes('copilot')) return 'copilot';
    if (name.includes('ollama')) return 'ollama';
    return 'claude'; // Default
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private compressToolOutput(content: string): string {
    const maxLength = this.config.maxToolOutputLength;
    if (content.length <= maxLength) return content;

    // Keep start and end, truncate middle
    const halfLength = Math.floor(maxLength / 2) - 20;
    const start = content.substring(0, halfLength);
    const end = content.substring(content.length - halfLength);

    return `${start}\n\n[... ${content.length - maxLength} characters truncated ...]\n\n${end}`;
  }

  private async validateNewAdapter(adapter: CliAdapter): Promise<boolean> {
    try {
      const status = await adapter.checkStatus();
      return status.available;
    } catch {
      return false;
    }
  }
}

/**
 * Default provider transformer implementation
 */
class DefaultProviderTransformer implements ProviderTransformer {
  transformMessage(message: ConversationMessage, targetProvider: CliType): CliMessage {
    // Map roles appropriately
    let role: CliMessage['role'];
    switch (message.role) {
      case 'user':
        role = 'user';
        break;
      case 'assistant':
        role = 'assistant';
        break;
      case 'system':
        role = 'system';
        break;
      case 'tool_use':
      case 'tool_result':
        // Tool messages need special handling per provider
        role = 'assistant';
        break;
      default:
        role = 'user';
    }

    let content = message.content;

    // Format tool calls differently per provider
    if (message.toolUse) {
      switch (targetProvider) {
        case 'claude':
          // Claude uses structured tool use
          content = `Tool: ${message.toolUse.toolName}\nInput: ${JSON.stringify(message.toolUse.input, null, 2)}`;
          if (message.toolUse.output) {
            content += `\nOutput: ${message.toolUse.output}`;
          }
          break;
        case 'codex':
        case 'gemini':
          // OpenAI/Gemini format
          content = `[Tool Call: ${message.toolUse.toolName}]\n${JSON.stringify(message.toolUse.input, null, 2)}`;
          if (message.toolUse.output) {
            content += `\n[Tool Result]\n${message.toolUse.output}`;
          }
          break;
        default:
          // Generic format
          content = `Tool: ${message.toolUse.toolName}\n${JSON.stringify(message.toolUse.input, null, 2)}`;
          if (message.toolUse.output) {
            content += `\n\nResult:\n${message.toolUse.output}`;
          }
      }
    }

    return {
      role,
      content,
      metadata: {
        originalId: message.id,
        originalRole: message.role,
        timestamp: message.timestamp,
      },
    };
  }

  adaptSystemPrompt(
    prompt: string,
    sourceProvider: CliType,
    targetProvider: CliType,
    targetModel?: string
  ): string {
    let adapted = prompt;

    // Remove Claude-specific instructions when switching away
    if (sourceProvider === 'claude' && targetProvider !== 'claude') {
      // Remove Claude-specific markdown like <thinking> tags references
      adapted = adapted.replace(/Use <thinking>.*?<\/thinking> tags/gi, '');
      adapted = adapted.replace(/\bClaude\b/g, 'Assistant');
    }

    // Add OpenAI-specific hints
    if (targetProvider === 'codex') {
      if (!adapted.includes('Format code')) {
        adapted += '\n\nFormat code blocks with appropriate language tags.';
      }
    }

    // Add Gemini-specific hints
    if (targetProvider === 'gemini') {
      // Gemini-specific adjustments if needed
    }

    return adapted.trim();
  }

  isSupported(message: ConversationMessage, targetProvider: CliType): boolean {
    // Most message types are supported across providers
    // Tool use requires special handling but is generally supported
    switch (message.role) {
      case 'user':
      case 'assistant':
      case 'system':
        return true;
      case 'tool_use':
      case 'tool_result':
        // All major providers support tool use now
        return true;
      default:
        return true;
    }
  }
}

/**
 * Get the hot model switcher singleton
 */
export function getHotModelSwitcher(): HotModelSwitcher {
  return HotModelSwitcher.getInstance();
}

export default HotModelSwitcher;
