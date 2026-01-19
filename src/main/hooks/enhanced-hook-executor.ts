/**
 * Enhanced Hook Executor
 *
 * Advanced hook execution with:
 * - Blocking hooks that can modify/cancel tool execution
 * - Enhanced shell execution with streaming output
 * - Hook chaining and dependency resolution
 * - Conditional execution based on previous results
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';

export type HookTiming = 'pre' | 'post';
export type HookAction = 'allow' | 'block' | 'modify' | 'skip';

export interface EnhancedHookConfig {
  id: string;
  name: string;
  enabled: boolean;
  event: string;
  timing: HookTiming;
  handler: EnhancedHookHandler;
  /** Priority for execution order (lower = earlier) */
  priority?: number;
  /** Dependencies on other hooks */
  dependsOn?: string[];
  /** Conditions for execution */
  conditions?: HookCondition[];
  /** Whether this hook can block execution */
  blocking?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
}

export interface EnhancedHookHandler {
  type: 'command' | 'prompt' | 'script' | 'function';
  /** Command string for 'command' type */
  command?: string;
  /** Script path for 'script' type */
  scriptPath?: string;
  /** Prompt template for 'prompt' type */
  prompt?: string;
  /** Model for prompt evaluation */
  model?: string;
  /** Function name for 'function' type */
  functionName?: string;
  /** Capture and stream output */
  streamOutput?: boolean;
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  workingDirectory?: string;
}

export interface HookCondition {
  type: 'file_pattern' | 'tool_name' | 'content_match' | 'env_var' | 'custom';
  value: string;
  operator?: 'equals' | 'contains' | 'matches' | 'not_equals' | 'exists';
}

export interface HookExecutionContext {
  instanceId?: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  filePath?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  command?: string;
  content?: string;
  dryRun?: boolean;
  /** Results from previous hooks in chain */
  previousResults?: HookExecutionResult[];
  /** Original tool call data */
  originalToolCall?: {
    name: string;
    input: Record<string, unknown>;
  };
}

export interface HookExecutionResult {
  hookId: string;
  hookName: string;
  success: boolean;
  action: HookAction;
  output?: string;
  error?: string;
  duration: number;
  timestamp: number;
  /** Modified data if action is 'modify' */
  modifiedData?: Record<string, unknown>;
  /** Reason for blocking if action is 'block' */
  blockReason?: string;
  /** Stream output chunks if streaming */
  streamChunks?: string[];
}

export interface BlockingResult {
  blocked: boolean;
  reason?: string;
  modifiedInput?: Record<string, unknown>;
}

const DEFAULT_TIMEOUT = 30000;
const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB

export class EnhancedHookExecutor extends EventEmitter {
  private static instance: EnhancedHookExecutor | null = null;
  private anthropic: Anthropic | null = null;
  private registeredFunctions: Map<string, (context: HookExecutionContext) => Promise<HookExecutionResult>> = new Map();
  private activeProcesses: Map<string, ChildProcess> = new Map();

  private constructor() {
    super();
  }

  static getInstance(): EnhancedHookExecutor {
    if (!EnhancedHookExecutor.instance) {
      EnhancedHookExecutor.instance = new EnhancedHookExecutor();
    }
    return EnhancedHookExecutor.instance;
  }

  /**
   * Initialize with API key for prompt hooks
   */
  initialize(apiKey?: string): void {
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
    }
    this.emit('initialized');
  }

  /**
   * Register a custom function hook
   */
  registerFunction(
    name: string,
    fn: (context: HookExecutionContext) => Promise<HookExecutionResult>
  ): void {
    this.registeredFunctions.set(name, fn);
    this.emit('function-registered', { name });
  }

  /**
   * Unregister a function hook
   */
  unregisterFunction(name: string): boolean {
    const removed = this.registeredFunctions.delete(name);
    if (removed) {
      this.emit('function-unregistered', { name });
    }
    return removed;
  }

  /**
   * Execute a hook
   */
  async execute(
    hook: EnhancedHookConfig,
    context: HookExecutionContext
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();
    const baseResult = {
      hookId: hook.id,
      hookName: hook.name,
      timestamp: startTime,
    };

    // Check conditions
    if (hook.conditions && !this.checkConditions(hook.conditions, context)) {
      return {
        ...baseResult,
        success: true,
        action: 'skip',
        output: 'Conditions not met',
        duration: Date.now() - startTime,
      };
    }

    try {
      switch (hook.handler.type) {
        case 'command':
          return await this.executeCommand(hook, context);
        case 'script':
          return await this.executeScript(hook, context);
        case 'prompt':
          return await this.executePrompt(hook, context);
        case 'function':
          return await this.executeFunction(hook, context);
        default:
          return {
            ...baseResult,
            success: false,
            action: 'skip',
            error: `Unknown handler type: ${(hook.handler as { type: string }).type}`,
            duration: Date.now() - startTime,
          };
      }
    } catch (error) {
      return {
        ...baseResult,
        success: false,
        action: 'skip',
        error: (error as Error).message,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute a chain of hooks
   */
  async executeChain(
    hooks: EnhancedHookConfig[],
    context: HookExecutionContext
  ): Promise<{
    results: HookExecutionResult[];
    finalAction: HookAction;
    blocked: boolean;
    modifiedData?: Record<string, unknown>;
  }> {
    // Sort by priority
    const sortedHooks = [...hooks].sort((a, b) => (a.priority || 0) - (b.priority || 0));

    // Resolve dependencies
    const orderedHooks = this.resolveDependencies(sortedHooks);

    const results: HookExecutionResult[] = [];
    let finalAction: HookAction = 'allow';
    let modifiedData: Record<string, unknown> | undefined;

    for (const hook of orderedHooks) {
      // Check if dependencies succeeded
      if (hook.dependsOn && hook.dependsOn.length > 0) {
        const depsFailed = hook.dependsOn.some(depId => {
          const depResult = results.find(r => r.hookId === depId);
          return !depResult || !depResult.success;
        });

        if (depsFailed) {
          results.push({
            hookId: hook.id,
            hookName: hook.name,
            success: false,
            action: 'skip',
            error: 'Dependency failed',
            duration: 0,
            timestamp: Date.now(),
          });
          continue;
        }
      }

      const result = await this.execute(hook, {
        ...context,
        previousResults: results,
        toolInput: modifiedData || context.toolInput,
      });

      results.push(result);
      this.emit('hook-executed', result);

      // Handle blocking
      if (hook.blocking && result.action === 'block') {
        finalAction = 'block';
        break;
      }

      // Handle modification
      if (result.action === 'modify' && result.modifiedData) {
        modifiedData = { ...(modifiedData || {}), ...result.modifiedData };
        finalAction = 'modify';
      }
    }

    return {
      results,
      finalAction,
      blocked: finalAction === 'block',
      modifiedData,
    };
  }

  /**
   * Cancel an active hook execution
   */
  cancel(hookId: string): boolean {
    const process = this.activeProcesses.get(hookId);
    if (process) {
      process.kill('SIGTERM');
      this.activeProcesses.delete(hookId);
      this.emit('hook-cancelled', { hookId });
      return true;
    }
    return false;
  }

  /**
   * Cancel all active executions
   */
  cancelAll(): void {
    for (const [hookId, process] of this.activeProcesses) {
      process.kill('SIGTERM');
      this.emit('hook-cancelled', { hookId });
    }
    this.activeProcesses.clear();
  }

  // ============ Condition Checking ============

  private checkConditions(conditions: HookCondition[], context: HookExecutionContext): boolean {
    return conditions.every(condition => this.checkCondition(condition, context));
  }

  private checkCondition(condition: HookCondition, context: HookExecutionContext): boolean {
    const operator = condition.operator || 'equals';

    switch (condition.type) {
      case 'file_pattern': {
        if (!context.filePath) return operator === 'not_equals';
        return this.matchPattern(context.filePath, condition.value, operator);
      }

      case 'tool_name': {
        if (!context.toolName) return operator === 'not_equals';
        return this.matchPattern(context.toolName, condition.value, operator);
      }

      case 'content_match': {
        if (!context.content) return operator === 'not_equals';
        return this.matchPattern(context.content, condition.value, operator);
      }

      case 'env_var': {
        const [varName, expectedValue] = condition.value.split('=');
        const actualValue = context.env?.[varName] || process.env[varName];

        if (operator === 'exists') {
          return actualValue !== undefined;
        }

        if (!actualValue) return operator === 'not_equals';
        return this.matchPattern(actualValue, expectedValue || '', operator);
      }

      case 'custom':
        // Custom conditions need external evaluation
        return true;

      default:
        return true;
    }
  }

  private matchPattern(value: string, pattern: string, operator: string): boolean {
    switch (operator) {
      case 'equals':
        return value === pattern;
      case 'not_equals':
        return value !== pattern;
      case 'contains':
        return value.includes(pattern);
      case 'matches':
        try {
          return new RegExp(pattern).test(value);
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  // ============ Command Execution ============

  private async executeCommand(
    hook: EnhancedHookConfig,
    context: HookExecutionContext
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();
    const handler = hook.handler;
    const command = this.interpolateString(handler.command || '', context);
    const timeout = hook.timeout || DEFAULT_TIMEOUT;

    if (context.dryRun) {
      return {
        hookId: hook.id,
        hookName: hook.name,
        success: true,
        action: 'allow',
        output: `[DRY RUN] Would execute: ${command}`,
        duration: Date.now() - startTime,
        timestamp: startTime,
      };
    }

    return new Promise<HookExecutionResult>(resolve => {
      let output = '';
      let errorOutput = '';
      let timedOut = false;
      const streamChunks: string[] = [];

      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
      const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];

      const cwd = handler.workingDirectory || context.workingDirectory || process.cwd();
      const env = { ...process.env, ...context.env, ...handler.env };

      const proc = spawn(shell, shellArgs, { cwd, env });

      this.activeProcesses.set(hook.id, proc);

      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeout);

      proc.stdout.on('data', data => {
        const chunk = data.toString();
        if (output.length + chunk.length <= MAX_OUTPUT_SIZE) {
          output += chunk;
        }
        if (handler.streamOutput) {
          streamChunks.push(chunk);
          this.emit('hook-output', { hookId: hook.id, chunk, stream: 'stdout' });
        }
      });

      proc.stderr.on('data', data => {
        const chunk = data.toString();
        if (errorOutput.length + chunk.length <= MAX_OUTPUT_SIZE) {
          errorOutput += chunk;
        }
        if (handler.streamOutput) {
          streamChunks.push(chunk);
          this.emit('hook-output', { hookId: hook.id, chunk, stream: 'stderr' });
        }
      });

      proc.on('close', code => {
        clearTimeout(timeoutId);
        this.activeProcesses.delete(hook.id);

        const duration = Date.now() - startTime;

        if (timedOut) {
          resolve({
            hookId: hook.id,
            hookName: hook.name,
            success: false,
            action: 'skip',
            error: `Command timed out after ${timeout}ms`,
            output,
            duration,
            timestamp: startTime,
            streamChunks: handler.streamOutput ? streamChunks : undefined,
          });
          return;
        }

        // Parse blocking result from output if blocking hook
        let action: HookAction = 'allow';
        let blockReason: string | undefined;
        let modifiedData: Record<string, unknown> | undefined;

        if (hook.blocking && code !== 0) {
          action = 'block';
          blockReason = errorOutput || `Hook exited with code ${code}`;
        } else if (output.includes('HOOK_BLOCK:')) {
          action = 'block';
          blockReason = output.split('HOOK_BLOCK:')[1]?.trim();
        } else if (output.includes('HOOK_MODIFY:')) {
          action = 'modify';
          try {
            const jsonStr = output.split('HOOK_MODIFY:')[1]?.trim();
            modifiedData = JSON.parse(jsonStr);
          } catch {
            // Invalid JSON, ignore modification
          }
        }

        resolve({
          hookId: hook.id,
          hookName: hook.name,
          success: code === 0 || action === 'allow',
          action,
          output,
          error: code !== 0 ? (errorOutput || `Exit code ${code}`) : undefined,
          duration,
          timestamp: startTime,
          blockReason,
          modifiedData,
          streamChunks: handler.streamOutput ? streamChunks : undefined,
        });
      });

      proc.on('error', err => {
        clearTimeout(timeoutId);
        this.activeProcesses.delete(hook.id);

        resolve({
          hookId: hook.id,
          hookName: hook.name,
          success: false,
          action: 'skip',
          error: `Failed to execute: ${err.message}`,
          duration: Date.now() - startTime,
          timestamp: startTime,
        });
      });
    });
  }

  // ============ Script Execution ============

  private async executeScript(
    hook: EnhancedHookConfig,
    context: HookExecutionContext
  ): Promise<HookExecutionResult> {
    const handler = hook.handler;
    const scriptPath = this.interpolateString(handler.scriptPath || '', context);

    // Determine script type by extension
    const ext = path.extname(scriptPath).toLowerCase();
    let interpreter: string;

    switch (ext) {
      case '.js':
        interpreter = 'node';
        break;
      case '.py':
        interpreter = 'python3';
        break;
      case '.rb':
        interpreter = 'ruby';
        break;
      case '.sh':
        interpreter = '/bin/bash';
        break;
      case '.ps1':
        interpreter = 'powershell';
        break;
      default:
        interpreter = '/bin/bash';
    }

    // Execute as command with interpreter
    const commandHook: EnhancedHookConfig = {
      ...hook,
      handler: {
        ...handler,
        type: 'command',
        command: `${interpreter} "${scriptPath}"`,
      },
    };

    return this.executeCommand(commandHook, context);
  }

  // ============ Prompt Execution ============

  private async executePrompt(
    hook: EnhancedHookConfig,
    context: HookExecutionContext
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();
    const handler = hook.handler;
    const prompt = this.interpolateString(handler.prompt || '', context);

    if (context.dryRun) {
      return {
        hookId: hook.id,
        hookName: hook.name,
        success: true,
        action: 'allow',
        output: `[DRY RUN] Would evaluate prompt: ${prompt.slice(0, 100)}...`,
        duration: Date.now() - startTime,
        timestamp: startTime,
      };
    }

    if (!this.anthropic) {
      return {
        hookId: hook.id,
        hookName: hook.name,
        success: false,
        action: 'skip',
        error: 'Anthropic client not initialized for prompt hooks',
        duration: Date.now() - startTime,
        timestamp: startTime,
      };
    }

    try {
      const response = await this.anthropic.messages.create({
        model: handler.model || 'claude-3-haiku-20240307',
        max_tokens: 1024,
        system: `You are a security and code review assistant evaluating whether a tool call should be allowed.

Respond with a JSON object:
- action: "allow", "block", or "modify"
- reason: explanation of your decision
- modification: (optional) modified parameters if action is "modify"

Be concise and security-focused.`,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const responseText = response.content[0].type === 'text' ? response.content[0].text : '';

      // Parse response
      try {
        const parsed = JSON.parse(responseText);
        return {
          hookId: hook.id,
          hookName: hook.name,
          success: true,
          action: parsed.action || 'allow',
          output: parsed.reason,
          blockReason: parsed.action === 'block' ? parsed.reason : undefined,
          modifiedData: parsed.modification,
          duration: Date.now() - startTime,
          timestamp: startTime,
        };
      } catch {
        // Non-JSON response, assume allow
        return {
          hookId: hook.id,
          hookName: hook.name,
          success: true,
          action: 'allow',
          output: responseText,
          duration: Date.now() - startTime,
          timestamp: startTime,
        };
      }
    } catch (error) {
      return {
        hookId: hook.id,
        hookName: hook.name,
        success: false,
        action: 'skip',
        error: (error as Error).message,
        duration: Date.now() - startTime,
        timestamp: startTime,
      };
    }
  }

  // ============ Function Execution ============

  private async executeFunction(
    hook: EnhancedHookConfig,
    context: HookExecutionContext
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();
    const functionName = hook.handler.functionName;

    if (!functionName) {
      return {
        hookId: hook.id,
        hookName: hook.name,
        success: false,
        action: 'skip',
        error: 'No function name specified',
        duration: Date.now() - startTime,
        timestamp: startTime,
      };
    }

    const fn = this.registeredFunctions.get(functionName);
    if (!fn) {
      return {
        hookId: hook.id,
        hookName: hook.name,
        success: false,
        action: 'skip',
        error: `Function not registered: ${functionName}`,
        duration: Date.now() - startTime,
        timestamp: startTime,
      };
    }

    try {
      const result = await fn(context);
      return {
        ...result,
        hookId: hook.id,
        hookName: hook.name,
        duration: Date.now() - startTime,
        timestamp: startTime,
      };
    } catch (error) {
      return {
        hookId: hook.id,
        hookName: hook.name,
        success: false,
        action: 'skip',
        error: (error as Error).message,
        duration: Date.now() - startTime,
        timestamp: startTime,
      };
    }
  }

  // ============ Dependency Resolution ============

  private resolveDependencies(hooks: EnhancedHookConfig[]): EnhancedHookConfig[] {
    const resolved: EnhancedHookConfig[] = [];
    const seen = new Set<string>();
    const visiting = new Set<string>();

    const visit = (hook: EnhancedHookConfig): void => {
      if (seen.has(hook.id)) return;
      if (visiting.has(hook.id)) {
        throw new Error(`Circular dependency detected: ${hook.id}`);
      }

      visiting.add(hook.id);

      // Visit dependencies first
      if (hook.dependsOn) {
        for (const depId of hook.dependsOn) {
          const depHook = hooks.find(h => h.id === depId);
          if (depHook) {
            visit(depHook);
          }
        }
      }

      visiting.delete(hook.id);
      seen.add(hook.id);
      resolved.push(hook);
    };

    for (const hook of hooks) {
      visit(hook);
    }

    return resolved;
  }

  // ============ String Interpolation ============

  private interpolateString(str: string, context: HookExecutionContext): string {
    return str
      .replace(/\$\{file\}/g, context.filePath || '')
      .replace(/\$\{tool\}/g, context.toolName || '')
      .replace(/\$\{command\}/g, context.command || '')
      .replace(/\$\{content\}/g, context.content || '')
      .replace(/\$\{cwd\}/g, context.workingDirectory || process.cwd())
      .replace(/\$\{instanceId\}/g, context.instanceId || '')
      .replace(/\$\{toolInput\}/g, JSON.stringify(context.toolInput || {}))
      .replace(/\$\{env\.(\w+)\}/g, (_, name) => context.env?.[name] || process.env[name] || '');
  }
}

export default EnhancedHookExecutor;
