/**
 * Claude CLI Adapter - Spawns and manages Claude Code CLI processes
 * Extends BaseCliAdapter for multi-CLI support
 */

import { ChildProcess } from 'child_process';
import {
  BaseCliAdapter,
  CliAdapterConfig,
  CliCapabilities,
  CliStatus,
  CliMessage,
  CliResponse,
  CliToolCall,
  CliUsage
} from './base-cli-adapter';
import { NdjsonParser } from '../ndjson-parser';
import { InputFormatter } from '../input-formatter';
import { processAttachments, buildMessageWithFiles } from '../file-handler';
import type { CliStreamMessage } from '../../../shared/types/cli.types';
import type {
  OutputMessage,
  ContextUsage,
  InstanceStatus,
  ThinkingContent
} from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { extractThinkingContent } from '../../../shared/utils/thinking-extractor';
import {
  MODEL_PRICING,
  CLAUDE_MODELS
} from '../../../shared/types/provider.types';

/**
 * Claude CLI specific spawn options
 */
export interface ClaudeCliSpawnOptions {
  sessionId?: string;
  workingDirectory?: string;
  model?: string;
  maxTokens?: number;
  yoloMode?: boolean;
  resume?: boolean;
  forkSession?: boolean; // When resuming, create a new session ID instead of reusing
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
}

/**
 * Input required event payload - for permission prompts and other input requests
 */
export interface InputRequiredPayload {
  id: string;
  prompt: string;
  timestamp: number;
}

/**
 * Events emitted by ClaudeCliAdapter (backward compatible)
 */
export interface ClaudeCliAdapterEvents {
  output: (message: OutputMessage) => void;
  status: (status: InstanceStatus) => void;
  context: (usage: ContextUsage) => void;
  error: (error: Error) => void;
  exit: (code: number | null, signal: string | null) => void;
  spawned: (pid: number) => void;
  input_required: (payload: InputRequiredPayload) => void;
}

/**
 * Claude CLI Adapter - Implementation for Claude Code CLI
 */
export class ClaudeCliAdapter extends BaseCliAdapter {
  private parser: NdjsonParser;
  private formatter: InputFormatter | null = null;
  private spawnOptions: ClaudeCliSpawnOptions;
  /** Track pending permission requests to avoid duplicate prompts */
  private pendingPermissions: Set<string> = new Set();
  /** Track permissions that user has already approved (to avoid re-prompting after retry fails) */
  private approvedPermissions: Set<string> = new Set();

  constructor(options: ClaudeCliSpawnOptions = {}) {
    const config: CliAdapterConfig = {
      command: 'claude',
      args: [],
      cwd: options.workingDirectory,
      timeout: 300000,
      sessionPersistence: true
    };
    super(config);

    this.spawnOptions = options;
    this.sessionId = options.sessionId || generateId();
    this.parser = new NdjsonParser();
  }

  // ============ BaseCliAdapter Abstract Implementations ============

  getName(): string {
    return 'claude-cli';
  }

  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: true,
      fileAccess: true,
      shellExecution: true,
      multiTurn: true,
      vision: true,
      codeExecution: true,
      contextWindow: 200000, // Claude 3.5 context window
      outputFormats: ['ndjson', 'text', 'json']
    };
  }

  /**
   * Enable resume mode - next spawn will use --resume with the session ID
   * to continue an existing conversation.
   */
  setResume(resume: boolean): void {
    this.spawnOptions.resume = resume;
    console.log(`[ClaudeCliAdapter] Resume mode set to: ${resume}, session: ${this.sessionId}`);
  }

  async checkStatus(): Promise<CliStatus> {
    return new Promise((resolve) => {
      const proc = this.spawnProcess(['--version']);
      let output = '';

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 || output.includes('claude')) {
          const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
          resolve({
            available: true,
            version: versionMatch?.[1] || 'unknown',
            path: 'claude',
            authenticated: true // Claude CLI handles auth internally
          });
        } else {
          resolve({
            available: false,
            error: `Claude CLI not found or not configured: ${output}`
          });
        }
      });

      proc.on('error', (err) => {
        resolve({
          available: false,
          error: `Failed to spawn claude: ${err.message}`
        });
      });

      // Timeout
      setTimeout(() => {
        proc.kill();
        resolve({
          available: false,
          error: 'Timeout checking Claude CLI'
        });
      }, 5000);
    });
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    const startTime = Date.now();
    this.outputBuffer = '';

    return new Promise(async (resolve, reject) => {
      const args = this.buildArgs(message);
      this.process = this.spawnProcess(args);

      // Set up stdin formatter
      if (this.process.stdin) {
        this.formatter = new InputFormatter(this.process.stdin);
      }

      // Prepare message content with file attachments
      let finalMessage = message.content;
      const imageAttachments =
        message.attachments?.filter(
          (a) => a.mimeType?.startsWith('image/') || a.type === 'image'
        ) || [];
      const otherAttachments =
        message.attachments?.filter(
          (a) => !a.mimeType?.startsWith('image/') && a.type !== 'image'
        ) || [];

      // Process non-image attachments
      if (otherAttachments.length > 0 && this.config.cwd) {
        const processed = await processAttachments(
          otherAttachments.map((a) => ({
            type: a.mimeType || 'text/plain',
            name: a.name || 'attachment',
            data: a.content || '',
            size: a.content?.length || 0
          })),
          this.sessionId || generateId(),
          this.config.cwd
        );
        finalMessage = buildMessageWithFiles(message.content, processed);
      }

      // Send the message
      if (this.formatter && this.formatter.isWritable()) {
        await this.formatter.sendMessage(
          finalMessage,
          imageAttachments.length > 0
            ? imageAttachments.map((a) => ({
                type: a.mimeType || 'image/png',
                name: a.name || 'image',
                data: a.content || '',
                size: a.content?.length || 0
              }))
            : undefined
        );
      }

      // Handle stdout (NDJSON stream)
      this.process.stdout?.on('data', (chunk: Buffer) => {
        const raw = chunk.toString();
        this.outputBuffer += raw;

        const messages = this.parser.parse(raw);
        for (const msg of messages) {
          this.processCliMessage(msg);
        }
      });

      // Handle stderr
      this.process.stderr?.on('data', (chunk: Buffer) => {
        this.emit('error', new Error(chunk.toString().trim()));
      });

      // Handle exit
      this.process.on('close', (code) => {
        // Flush remaining buffer
        const remaining = this.parser.flush();
        for (const msg of remaining) {
          this.processCliMessage(msg);
        }

        const duration = Date.now() - startTime;

        if (code === 0 || this.outputBuffer) {
          const response = this.parseOutput(this.outputBuffer);
          response.usage = {
            ...response.usage,
            duration
          };
          this.emit('complete', response);
          resolve(response);
        } else {
          reject(new Error(`Claude CLI exited with code ${code}`));
        }

        this.process = null;
        this.formatter = null;
        this.parser.reset();
      });

      // Timeout handling
      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGTERM');
          reject(new Error('Claude CLI timeout'));
        }
      }, this.config.timeout);

      this.process.on('close', () => clearTimeout(timeout));
    });
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    const args = this.buildArgs(message);
    this.process = this.spawnProcess(args);

    // Set up stdin formatter
    if (this.process.stdin) {
      this.formatter = new InputFormatter(this.process.stdin);
    }

    // Send the message
    if (this.formatter && this.formatter.isWritable()) {
      await this.formatter.sendMessage(message.content);
    }

    const stdout = this.process.stdout;
    if (!stdout) return;

    for await (const chunk of stdout) {
      const raw = chunk.toString();
      const messages = this.parser.parse(raw);

      for (const msg of messages) {
        if (msg.type === 'assistant' && (msg as any).message?.content) {
          const content = (msg as any).message.content
            .filter((block: any) => block.type === 'text' && block.text)
            .map((block: any) => block.text)
            .join('');
          if (content) {
            yield content;
          }
        }
      }
    }
  }

  parseOutput(raw: string): CliResponse {
    const id = this.generateResponseId();
    const toolCalls: CliToolCall[] = [];
    let content = '';
    let usage: CliUsage = {};

    // Parse all NDJSON lines
    const lines = raw.split('\n').filter((line) => line.trim());

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);

        if (msg.type === 'assistant' && msg.message?.content) {
          // Extract text content
          const textContent = msg.message.content
            .filter((block: any) => block.type === 'text' && block.text)
            .map((block: any) => block.text)
            .join('');
          if (textContent) {
            content += textContent;
          }

          // Extract tool uses
          const toolUses = msg.message.content.filter(
            (block: any) => block.type === 'tool_use'
          );
          for (const tool of toolUses) {
            toolCalls.push({
              id: tool.id || generateId(),
              name: tool.name,
              arguments: tool.input || {}
            });
          }
        }

        if (
          msg.type === 'system' &&
          msg.subtype === 'context_usage' &&
          msg.usage
        ) {
          usage = {
            totalTokens: msg.usage.total_tokens
          };
        }
      } catch {
        // Ignore non-JSON lines
      }
    }

    return {
      id,
      content: content.trim(),
      role: 'assistant',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      raw
    };
  }

  protected buildArgs(message: CliMessage): string[] {
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose'
    ];

    // YOLO mode - auto-approve all permissions
    if (this.spawnOptions.yoloMode) {
      console.warn('[Security] YOLO mode enabled for Claude CLI instance', {
        sessionId: this.sessionId,
        model: this.spawnOptions.model
      });
      args.push('--dangerously-skip-permissions');
    } else {
      // Explicitly set permission mode to default to ensure prompts appear
      console.log('[ClaudeCliAdapter] NON-YOLO mode: adding --permission-mode default');
      args.push('--permission-mode', 'default');
    }

    if (this.spawnOptions.resume && this.sessionId) {
      args.push('--resume', this.sessionId);
      // Fork session creates a new session ID while preserving conversation history
      if (this.spawnOptions.forkSession) {
        args.push('--fork-session');
      }
    } else if (this.sessionId) {
      args.push('--session-id', this.sessionId);
    }

    if (this.spawnOptions.model) {
      args.push('--model', this.spawnOptions.model);
    }

    if (this.spawnOptions.maxTokens) {
      args.push('--max-tokens', this.spawnOptions.maxTokens.toString());
    }

    if (
      this.spawnOptions.allowedTools &&
      this.spawnOptions.allowedTools.length > 0
    ) {
      args.push('--allowed-tools', this.spawnOptions.allowedTools.join(','));
    }

    if (
      this.spawnOptions.disallowedTools &&
      this.spawnOptions.disallowedTools.length > 0
    ) {
      args.push(
        '--disallowed-tools',
        this.spawnOptions.disallowedTools.join(',')
      );
    }

    // Don't pass system prompt when resuming - the session already has one
    // and Claude CLI doesn't support changing it mid-session
    if (this.spawnOptions.systemPrompt && !this.spawnOptions.resume) {
      args.push('--system-prompt', this.spawnOptions.systemPrompt);
    }

    console.log('[ClaudeCliAdapter] buildArgs complete:', {
      yoloMode: this.spawnOptions.yoloMode,
      args: args.join(' ')
    });

    return args;
  }

  // ============ Legacy API Methods (Backward Compatibility) ============

  /**
   * Spawn the Claude CLI process (legacy API)
   */
  async spawn(): Promise<number> {
    if (this.process) {
      throw new Error('Process already spawned');
    }

    const args = this.buildArgs({ role: 'user', content: '' });

    this.process = this.spawnProcess(args);

    if (!this.process.pid) {
      throw new Error('Failed to spawn Claude CLI process');
    }

    // Set up stdin formatter
    if (this.process.stdin) {
      this.formatter = new InputFormatter(this.process.stdin);
    }

    // Set up stdout handler (NDJSON stream)
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.handleStdout(chunk);
    });

    // Set up stderr handler
    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.handleStderr(chunk);
    });

    // Set up exit handler
    this.process.on('exit', (code, signal) => {
      this.handleExit(code, signal);
    });

    // Set up error handler
    this.process.on('error', (error) => {
      this.emit('error', error);
    });

    return this.process.pid;
  }

  /**
   * Send a message to the CLI (legacy API)
   */
  async sendInput(message: string, attachments?: any[]): Promise<void> {
    if (!this.formatter || !this.formatter.isWritable()) {
      throw new Error('CLI not ready for input');
    }

    // Separate images (inline) from other files (need file path)
    const imageAttachments =
      attachments?.filter((a) => a.type?.startsWith('image/')) || [];
    const otherAttachments =
      attachments?.filter((a) => !a.type?.startsWith('image/')) || [];

    let finalMessage = message;

    // For non-image files, save to working directory and add file paths to message
    if (otherAttachments.length > 0 && this.config.cwd) {
      const processed = await processAttachments(
        otherAttachments,
        this.sessionId || generateId(),
        this.config.cwd
      );
      finalMessage = buildMessageWithFiles(message, processed);
    }

    await this.formatter.sendMessage(
      finalMessage,
      imageAttachments.length > 0 ? imageAttachments : undefined
    );
    this.emit('status', 'busy' as InstanceStatus);
  }

  /**
   * Send raw text input (for permission prompts, etc.)
   * When using stream-json input format, all responses need to be JSON formatted as user messages
   */
  async sendRaw(text: string, permissionKey?: string): Promise<void> {
    if (!this.formatter || !this.formatter.isWritable()) {
      throw new Error('CLI not ready for input');
    }

    // Clear the pending permission if one was specified
    if (permissionKey && this.pendingPermissions.has(permissionKey)) {
      this.pendingPermissions.delete(permissionKey);
      console.log('ClaudeCliAdapter.sendRaw: Cleared pending permission:', permissionKey);
    }

    // Check if this is a permission approval response
    const isPermissionApproval = text.toLowerCase().includes('permission granted') ||
                                  text.toLowerCase().includes('allow') ||
                                  text.toLowerCase().startsWith('y');

    if (isPermissionApproval && permissionKey) {
      // Track that user approved this permission (prevents re-prompting on retry failure)
      this.approvedPermissions.add(permissionKey);
      console.log('ClaudeCliAdapter.sendRaw: Added to approved permissions:', permissionKey);

      // For permission approvals, first try sending 'y' directly to stdin
      // Claude Code CLI may be waiting for a simple y/n response
      console.log('ClaudeCliAdapter.sendRaw: Detected permission approval, sending y to stdin');
      await this.formatter.sendRaw('y');
    }

    // When using stream-json input format, all input needs to be in JSON format
    // Send all text as user messages so Claude can understand the response
    const userMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: text
      }
    };
    const jsonMessage = JSON.stringify(userMessage);
    console.log('ClaudeCliAdapter.sendRaw: Sending as user message:', jsonMessage);
    await this.formatter.sendRaw(jsonMessage);

    this.emit('status', 'busy' as InstanceStatus);
  }

  /**
   * Clear a pending permission (called when user responds to permission prompt)
   */
  clearPendingPermission(permissionKey: string): void {
    if (this.pendingPermissions.has(permissionKey)) {
      this.pendingPermissions.delete(permissionKey);
      console.log('ClaudeCliAdapter: Cleared pending permission:', permissionKey);
    }
  }

  // ============ Private Helper Methods ============

  private handleStdout(chunk: Buffer): void {
    const raw = chunk.toString();

    // Log ALL message types coming through for debugging
    const typeMatch = raw.match(/"type"\s*:\s*"([^"]+)"/g);
    if (typeMatch) {
      console.log('[ClaudeCliAdapter] handleStdout: Message types in chunk:', typeMatch);
    }

    // Log raw output for debugging permission issues
    if (raw.includes('input_required') || raw.includes('permission') || raw.includes('approve')) {
      console.log('=== [ClaudeCliAdapter] RAW STDOUT (permission-related) ===');
      console.log(raw);
      console.log('=== [ClaudeCliAdapter] END RAW STDOUT ===');
    }

    const messages = this.parser.parse(raw);
    console.log('[ClaudeCliAdapter] handleStdout: Parsed', messages.length, 'messages, types:', messages.map(m => m.type));

    for (const message of messages) {
      // Log all message types for debugging
      if (message.type === 'input_required') {
        console.log('[ClaudeCliAdapter] handleStdout: Parsed input_required message, forwarding to processCliMessage');
      }
      this.processCliMessage(message);
    }
  }

  private handleStderr(chunk: Buffer): void {
    const errorText = chunk.toString().trim();
    console.log('[ClaudeCliAdapter] handleStderr received:', errorText.substring(0, 500));

    if (errorText) {
      // Check if this looks like a permission prompt
      if (errorText.includes('permission') || errorText.includes('approve') || errorText.includes('allow') || errorText.includes('y/n')) {
        console.log('=== [ClaudeCliAdapter] STDERR CONTAINS PERMISSION-LIKE CONTENT ===');
        console.log(errorText);
        console.log('=== END STDERR PERMISSION CONTENT ===');
      }

      const errorMessage: OutputMessage = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: errorText
      };
      this.emit('output', errorMessage);
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    // Flush any remaining parser buffer
    const remaining = this.parser.flush();
    for (const message of remaining) {
      this.processCliMessage(message);
    }

    this.process = null;
    this.formatter = null;
    this.parser.reset();

    this.emit('exit', code, signal);
  }

  private processCliMessage(message: CliStreamMessage): void {
    switch (message.type) {
      case 'assistant':
        const assistantMsg = message as any;
        let assistantContent = '';
        const thinkingBlocks: ThinkingContent[] = [];

        if (assistantMsg.message?.content) {
          for (const block of assistantMsg.message.content) {
            // Handle structured thinking blocks from Claude API (extended thinking)
            if (block.type === 'thinking' && block.thinking) {
              thinkingBlocks.push({
                id: generateId(),
                content: block.thinking,
                format: 'structured',
                timestamp: message.timestamp || Date.now()
              });
            } else if (block.type === 'text' && block.text) {
              assistantContent += block.text;
            }
          }
        } else if (typeof assistantMsg.content === 'string') {
          assistantContent = assistantMsg.content;
        }

        // Also extract any inline thinking from text content (XML tags, brackets, headers)
        const extracted = extractThinkingContent(assistantContent);
        assistantContent = extracted.response;
        thinkingBlocks.push(...extracted.thinking.map(t => ({
          ...t,
          timestamp: message.timestamp || Date.now()
        })));

        if (assistantContent.trim()) {
          this.emit('output', {
            id: generateId(),
            timestamp: message.timestamp || Date.now(),
            type: 'assistant',
            content: assistantContent,
            // Include thinking blocks if any were found
            thinking: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
            thinkingExtracted: true
          });
        }

        // Extract context usage from assistant message (for real-time updates)
        if (assistantMsg.message?.usage) {
          const usage = assistantMsg.message.usage;
          // input_tokens + output_tokens = actual context window usage
          // Cache tokens are cumulative across session and used for billing, not context
          const totalUsedTokens =
            (usage.input_tokens || 0) +
            (usage.output_tokens || 0);

          // Default context window - will be updated by result message
          const contextWindow = 200000;
          const percentage = (totalUsedTokens / contextWindow) * 100;

          this.emit('context', {
            used: totalUsedTokens,
            total: contextWindow,
            percentage: Math.min(percentage, 100)
          });
        }

        this.emit('status', 'busy' as InstanceStatus);
        break;

      case 'user':
        const userMsg = message as any;

        // Check for permission denial in tool_result content
        // Claude CLI returns these as user messages with tool_result content when permissions are denied
        if (userMsg.message?.content && Array.isArray(userMsg.message.content)) {
          for (const block of userMsg.message.content) {
            if (
              block.type === 'tool_result' &&
              block.is_error === true &&
              typeof block.content === 'string' &&
              block.content.includes("haven't granted it yet")
            ) {
              console.log('=== [ClaudeCliAdapter] PERMISSION DENIAL DETECTED IN TOOL_RESULT ===');
              console.log('[ClaudeCliAdapter] Tool use ID:', block.tool_use_id);
              console.log('[ClaudeCliAdapter] Content:', block.content);

              // Extract the path from the message if possible
              const pathMatch = block.content.match(/permissions to (\w+) to (.+),/);
              const action = pathMatch?.[1] || 'access';
              const path = pathMatch?.[2] || 'a file';

              // Create a unique key for this permission request to avoid duplicate prompts
              const permissionKey = `${action}:${path}`;

              // Skip if we already have a pending request for this exact permission
              if (this.pendingPermissions.has(permissionKey)) {
                console.log('[ClaudeCliAdapter] Skipping duplicate permission prompt for:', permissionKey);
                break;
              }

              // Skip if user already approved this permission (retry still failed but don't re-prompt)
              if (this.approvedPermissions.has(permissionKey)) {
                console.log('[ClaudeCliAdapter] User already approved this permission, not re-prompting:', permissionKey);
                console.log('[ClaudeCliAdapter] Permission still failing - Claude Code CLI requires YOLO mode for programmatic approval');
                // Emit a system message to inform user - only once per permission
                const hintKey = `hint:${permissionKey}`;
                if (!this.approvedPermissions.has(hintKey)) {
                  this.approvedPermissions.add(hintKey);
                  this.emit('output', {
                    id: generateId(),
                    timestamp: Date.now(),
                    type: 'system',
                    content: `Permission for "${action} ${path}" requires YOLO mode. Click the ⚡ YOLO button in the header to enable auto-approval for this session.`,
                    metadata: { permissionHint: true, suggestYolo: true }
                  });
                }
                break;
              }

              // Track this permission request
              this.pendingPermissions.add(permissionKey);
              console.log('[ClaudeCliAdapter] Added to pending permissions:', permissionKey);

              const inputRequestId = generateId();
              const prompt = `Permission required: Claude wants to ${action} ${path}. Allow?`;
              const timestamp = message.timestamp || Date.now();

              console.log('[ClaudeCliAdapter] Emitting input_required for permission denial');

              this.emit('status', 'waiting_for_input' as InstanceStatus);

              // Emit the input_required event for UI to handle
              this.emit('input_required', {
                id: inputRequestId,
                prompt,
                timestamp,
                metadata: {
                  type: 'permission_denial',
                  tool_use_id: block.tool_use_id,
                  action,
                  path,
                  originalContent: block.content,
                  permissionKey // Include for cleanup after response
                }
              });

              // Also emit as system output for visibility in chat
              this.emit('output', {
                id: inputRequestId,
                timestamp,
                type: 'system',
                content: prompt,
                metadata: { requiresInput: true, permissionDenial: true }
              });

              console.log('=== [ClaudeCliAdapter] PERMISSION DENIAL HANDLING COMPLETE ===');
            }
          }
          break;
        }
        if (typeof message.content === 'string' && message.content.trim()) {
          this.emit('output', {
            id: generateId(),
            timestamp: message.timestamp || Date.now(),
            type: 'user',
            content: message.content
          });
        }
        break;

      case 'system':
        if (message.subtype === 'context_usage' && message.usage) {
          const modelId = this.spawnOptions.model || CLAUDE_MODELS.SONNET;
          const pricing = MODEL_PRICING[modelId] || {
            input: 3.0,
            output: 15.0
          };

          const totalTokens = message.usage.total_tokens;
          const estimatedInputTokens = Math.floor(totalTokens * 0.7);
          const estimatedOutputTokens = totalTokens - estimatedInputTokens;

          const inputCost = (estimatedInputTokens / 1_000_000) * pricing.input;
          const outputCost =
            (estimatedOutputTokens / 1_000_000) * pricing.output;
          const costEstimate = inputCost + outputCost;

          this.emit('context', {
            used: message.usage.total_tokens,
            total: message.usage.max_tokens,
            percentage: message.usage.percentage,
            costEstimate
          });
        }
        if (message.session_id) {
          this.sessionId = message.session_id;
        }
        if (message.content) {
          this.emit('output', {
            id: generateId(),
            timestamp: message.timestamp || Date.now(),
            type: 'system',
            content: message.content
          });
        }
        break;

      case 'tool_use':
        this.emit('output', {
          id: generateId(),
          timestamp: message.timestamp || Date.now(),
          type: 'tool_use',
          content: `Using tool: ${message.tool.name}`,
          metadata: message.tool
        });
        break;

      case 'tool_result':
        this.emit('output', {
          id: generateId(),
          timestamp: message.timestamp || Date.now(),
          type: 'tool_result',
          content: message.content,
          metadata: {
            tool_use_id: message.tool_use_id,
            is_error: message.is_error
          }
        });
        break;

      case 'result':
        const resultMsg = message as any;

        // Extract context usage from result message
        if (resultMsg.modelUsage || resultMsg.usage) {
          // Get the model's context window from modelUsage if available
          let contextWindow = 200000; // Default
          let totalUsedTokens = 0;

          if (resultMsg.modelUsage) {
            // modelUsage is keyed by model name, get the first one
            const modelKeys = Object.keys(resultMsg.modelUsage);
            if (modelKeys.length > 0) {
              const modelData = resultMsg.modelUsage[modelKeys[0]];
              contextWindow = modelData.contextWindow || 200000;
              // inputTokens + outputTokens = actual context window usage
              totalUsedTokens =
                (modelData.inputTokens || 0) +
                (modelData.outputTokens || 0);
            }
          } else if (resultMsg.usage) {
            // input_tokens + output_tokens = actual context window usage
            totalUsedTokens =
              (resultMsg.usage.input_tokens || 0) +
              (resultMsg.usage.output_tokens || 0);
          }

          const percentage = (totalUsedTokens / contextWindow) * 100;
          const costEstimate = resultMsg.total_cost_usd || 0;

          this.emit('context', {
            used: totalUsedTokens,
            total: contextWindow,
            percentage: Math.min(percentage, 100),
            costEstimate
          });
        }

        this.emit('status', 'idle' as InstanceStatus);
        break;

      case 'error':
        this.emit('output', {
          id: generateId(),
          timestamp: message.timestamp || Date.now(),
          type: 'error',
          content: message.error.message,
          metadata: { code: message.error.code }
        });
        this.emit('status', 'error' as InstanceStatus);
        break;

      case 'input_required':
        console.log('=== [ClaudeCliAdapter] INPUT_REQUIRED MESSAGE RECEIVED ===');
        console.log('[ClaudeCliAdapter] Raw message:', JSON.stringify(message, null, 2));

        this.emit('status', 'waiting_for_input' as InstanceStatus);
        const inputRequestId = generateId();
        const prompt = message.prompt || 'Input required';
        const timestamp = message.timestamp || Date.now();

        console.log('[ClaudeCliAdapter] Generated request ID:', inputRequestId);
        console.log('[ClaudeCliAdapter] Prompt:', prompt);
        console.log('[ClaudeCliAdapter] Emitting input_required event...');

        // Emit the input_required event for UI to handle
        this.emit('input_required', {
          id: inputRequestId,
          prompt,
          timestamp
        });
        console.log('[ClaudeCliAdapter] input_required event emitted');

        // Also emit as system output for visibility in chat
        console.log('[ClaudeCliAdapter] Emitting output event for chat visibility...');
        this.emit('output', {
          id: inputRequestId,
          timestamp,
          type: 'system',
          content: prompt,
          metadata: { requiresInput: true }
        });
        console.log('[ClaudeCliAdapter] output event emitted');
        console.log('=== [ClaudeCliAdapter] INPUT_REQUIRED HANDLING COMPLETE ===');
        break;
    }
  }
}
