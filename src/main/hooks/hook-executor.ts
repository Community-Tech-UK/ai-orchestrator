/**
 * Hook Executor
 * Executes individual hooks (command-based and prompt-based)
 */

import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getLLMService } from '../rlm/llm-service';
import { retryWithBackoff } from '../core/error-recovery';
import { getLogger } from '../logging/logger';

// Local types for hook execution
export interface CommandHook {
  type: 'command';
  command: string;
  timeout?: number;
  captureOutput?: boolean;
  /** Allow shell features like pipes/redirects (disabled by default) */
  allowShell?: boolean;
}

export interface PromptHook {
  type: 'prompt';
  prompt: string;
  model?: string;
}

/**
 * External binary hook (claude2.md §12.6).
 * Receives HookExecutionContext as JSON on stdin, writes
 * `{ ok: boolean; message?: string }` JSON to stdout.
 */
export interface ExecutableHook {
  type: 'executable';
  executablePath: string;
  timeout?: number;
  env?: Record<string, string>;
}

export type HookHandler = CommandHook | PromptHook | ExecutableHook;

export interface HookConfig {
  id: string;
  name: string;
  enabled: boolean;
  event: string;
  handler: HookHandler;
}

export interface HookExecutionContext {
  instanceId?: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  filePath?: string;
  toolName?: string;
  command?: string;
  content?: string;
  dryRun?: boolean;

  // PreSampling context
  messageCount?: number;
  estimatedTokens?: number;

  // PostSampling context
  modelResponse?: string;
  responseTokens?: number;
  modelId?: string;
}

export interface HookExecutorResult {
  hookId: string;
  success: boolean;
  output?: string;
  error?: string;
  duration: number;
  timestamp: number;
}

export interface HookExecutorConfig {
  defaultTimeout: number;
  shell: string;
  maxOutputSize: number;
}

const hookLogger = getLogger('HookExecutor');

export class HookExecutor extends EventEmitter {
  private static instance: HookExecutor | null = null;
  private config: HookExecutorConfig;

  private defaultConfig: HookExecutorConfig = {
    defaultTimeout: 30000,
    shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
    maxOutputSize: 1024 * 1024 // 1MB
  };

  static getInstance(): HookExecutor {
    if (!this.instance) {
      this.instance = new HookExecutor();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
  }

  configure(config: Partial<HookExecutorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============ Hook Execution ============

  async execute(
    hook: HookConfig,
    context: HookExecutionContext
  ): Promise<HookExecutorResult> {
    const startTime = Date.now();

    try {
      if (hook.handler.type === 'command') {
        return await this.executeCommand(
          hook,
          hook.handler as CommandHook,
          context
        );
      } else if (hook.handler.type === 'prompt') {
        return await this.executePrompt(
          hook,
          hook.handler as PromptHook,
          context
        );
      } else if (hook.handler.type === 'executable') {
        return await this.executeExternalBinary(hook, hook.handler as unknown as ExecutableHook, context, startTime);
      } else {
        return {
          hookId: hook.id,
          success: false,
          error: `Unknown handler type: ${(hook.handler as { type: string }).type}`,
          duration: Date.now() - startTime,
          timestamp: startTime
        };
      }
    } catch (error) {
      return {
        hookId: hook.id,
        success: false,
        error: (error as Error).message,
        duration: Date.now() - startTime,
        timestamp: startTime
      };
    }
  }

  // ============ Command Execution ============

  private async executeCommand(
    hook: HookConfig,
    handler: CommandHook,
    context: HookExecutionContext
  ): Promise<HookExecutorResult> {
    const startTime = Date.now();

    // Interpolate variables in command
    const command = this.interpolateCommand(handler.command, context);
    const timeout = handler.timeout || this.config.defaultTimeout;

    if (context.dryRun) {
      return {
        hookId: hook.id,
        success: true,
        output: `[DRY RUN] Would execute: ${command}`,
        duration: Date.now() - startTime,
        timestamp: startTime
      };
    }

    if (!command.trim()) {
      return {
        hookId: hook.id,
        success: false,
        error: 'Empty command',
        duration: Date.now() - startTime,
        timestamp: startTime
      };
    }

    const containsShellMetachars = /[|&;<>()`$\n\r]/.test(command);
    if (containsShellMetachars && !handler.allowShell) {
      return {
        hookId: hook.id,
        success: false,
        error:
          'Shell features are disabled for hooks. Set allowShell: true to enable.',
        duration: Date.now() - startTime,
        timestamp: startTime
      };
    }

    if (!containsShellMetachars) {
      const parsed = this.parseCommand(command);
      if (!parsed) {
        return {
          hookId: hook.id,
          success: false,
          error: 'Failed to parse command',
          duration: Date.now() - startTime,
          timestamp: startTime
        };
      }

      const cwd = context.workingDirectory || process.cwd();
      const resolvedExecutable = this.resolveExecutable(parsed.command, cwd);
      if (!resolvedExecutable) {
        return {
          hookId: hook.id,
          success: false,
          error: `Executable not found: ${parsed.command}`,
          duration: Date.now() - startTime,
          timestamp: startTime
        };
      }

      return new Promise<HookExecutorResult>((resolve) => {
        let output = '';
        let error = '';
        let timedOut = false;

        const proc = spawn(resolvedExecutable, parsed.args, {
          cwd,
          env: { ...process.env, ...context.env }
        });

        const timeoutId = setTimeout(() => {
          timedOut = true;
          proc.kill('SIGTERM');
        }, timeout);

        proc.stdout.on('data', (data) => {
          const chunk = data.toString();
          if (output.length + chunk.length <= this.config.maxOutputSize) {
            output += chunk;
          }
        });

        proc.stderr.on('data', (data) => {
          const chunk = data.toString();
          if (error.length + chunk.length <= this.config.maxOutputSize) {
            error += chunk;
          }
        });

        proc.on('close', (code) => {
          clearTimeout(timeoutId);

          const duration = Date.now() - startTime;

          if (timedOut) {
            resolve({
              hookId: hook.id,
              success: false,
              error: `Command timed out after ${timeout}ms`,
              output,
              duration,
              timestamp: startTime
            });
          } else if (code === 0) {
            resolve({
              hookId: hook.id,
              success: true,
              output: handler.captureOutput ? output : undefined,
              duration,
              timestamp: startTime
            });
          } else {
            resolve({
              hookId: hook.id,
              success: false,
              error: error || `Command exited with code ${code}`,
              output: handler.captureOutput ? output : undefined,
              duration,
              timestamp: startTime
            });
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timeoutId);
          resolve({
            hookId: hook.id,
            success: false,
            error: `Failed to execute command: ${err.message}`,
            duration: Date.now() - startTime,
            timestamp: startTime
          });
        });
      });
    }

    return new Promise<HookExecutorResult>((resolve) => {
      let output = '';
      let error = '';
      let timedOut = false;

      const shellArgs =
        process.platform === 'win32' ? ['/c', command] : ['-c', command];

      const proc = spawn(this.config.shell, shellArgs, {
        cwd: context.workingDirectory || process.cwd(),
        env: { ...process.env, ...context.env }
      });

      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeout);

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        if (output.length + chunk.length <= this.config.maxOutputSize) {
          output += chunk;
        }
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        if (error.length + chunk.length <= this.config.maxOutputSize) {
          error += chunk;
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeoutId);

        const duration = Date.now() - startTime;

        if (timedOut) {
          resolve({
            hookId: hook.id,
            success: false,
            error: `Command timed out after ${timeout}ms`,
            output,
            duration,
            timestamp: startTime
          });
        } else if (code === 0) {
          resolve({
            hookId: hook.id,
            success: true,
            output: handler.captureOutput ? output : undefined,
            duration,
            timestamp: startTime
          });
        } else {
          resolve({
            hookId: hook.id,
            success: false,
            error: error || `Command exited with code ${code}`,
            output: handler.captureOutput ? output : undefined,
            duration,
            timestamp: startTime
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        resolve({
          hookId: hook.id,
          success: false,
          error: `Failed to execute command: ${err.message}`,
          duration: Date.now() - startTime,
          timestamp: startTime
        });
      });
    });
  }

  private interpolateCommand(
    command: string,
    context: HookExecutionContext
  ): string {
    return command
      .replace(/\$\{file\}/g, context.filePath || '')
      .replace(/\$\{tool\}/g, context.toolName || '')
      .replace(/\$\{command\}/g, context.command || '')
      .replace(/\$\{cwd\}/g, context.workingDirectory || process.cwd())
      .replace(/\$\{instanceId\}/g, context.instanceId || '');
  }

  private parseCommand(
    command: string
  ): { command: string; args: string[] } | null {
    const args: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\' && !inSingle) {
        escaped = true;
        continue;
      }
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
      if (!inSingle && !inDouble && /\s/.test(ch)) {
        if (current) {
          args.push(current);
          current = '';
        }
        continue;
      }
      current += ch;
    }

    if (escaped || inSingle || inDouble) {
      return null;
    }

    if (current) args.push(current);
    if (args.length === 0) return null;
    const [cmd, ...rest] = args;
    return { command: cmd, args: rest };
  }

  private resolveExecutable(command: string, cwd: string): string | null {
    const hasPath = command.includes('/') || command.includes('\\');
    const candidate = hasPath ? path.resolve(cwd, command) : command;
    if (hasPath && fs.existsSync(candidate)) {
      return candidate;
    }

    const pathEntries = (process.env['PATH'] || '')
      .split(path.delimiter)
      .filter(Boolean);
    for (const entry of pathEntries) {
      const fullPath = path.join(entry, command);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }

    return null;
  }

  // ============ External Binary Execution ============
  // (claude2.md §12.6: user-written Python/Bash hooks, cross-language)

  private executeExternalBinary(
    hook: HookConfig,
    handler: ExecutableHook,
    context: HookExecutionContext,
    startTime: number,
  ): Promise<HookExecutorResult> {
    return new Promise((resolve) => {
      const timeout = handler.timeout ?? this.config.defaultTimeout;
      const env: Record<string, string> = { ...process.env, ...(handler.env ?? {}) } as Record<string, string>;

      const child = spawn(handler.executablePath, [], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout);

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            hookId: hook.id,
            success: false,
            error: `Executable hook timed out after ${timeout}ms`,
            duration: Date.now() - startTime,
            timestamp: startTime,
          });
          return;
        }
        if (code !== 0) {
          resolve({
            hookId: hook.id,
            success: false,
            error: stderr.trim() || `Executable hook exited with code ${code}`,
            duration: Date.now() - startTime,
            timestamp: startTime,
          });
          return;
        }
        try {
          const result = JSON.parse(stdout.trim()) as { ok?: boolean; message?: string };
          resolve({
            hookId: hook.id,
            success: result.ok !== false,
            output: result.message,
            duration: Date.now() - startTime,
            timestamp: startTime,
          });
        } catch {
          resolve({
            hookId: hook.id,
            success: true,
            output: stdout.trim() || undefined,
            duration: Date.now() - startTime,
            timestamp: startTime,
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          hookId: hook.id,
          success: false,
          error: `Failed to spawn executable: ${err.message}`,
          duration: Date.now() - startTime,
          timestamp: startTime,
        });
      });

      // Write context to stdin and close it
      child.stdin.write(JSON.stringify(context));
      child.stdin.end();
    });
  }

  // ============ Prompt Execution ============

  private async executePrompt(
    hook: HookConfig,
    handler: PromptHook,
    context: HookExecutionContext
  ): Promise<HookExecutorResult> {
    const startTime = Date.now();

    // Interpolate variables in prompt
    const prompt = this.interpolatePrompt(handler.prompt, context);

    if (context.dryRun) {
      return {
        hookId: hook.id,
        success: true,
        output: `[DRY RUN] Would evaluate prompt: ${prompt.slice(0, 100)}...`,
        duration: Date.now() - startTime,
        timestamp: startTime
      };
    }

    try {
      const result = await this.evaluatePrompt(prompt, handler.model);

      return {
        hookId: hook.id,
        success: result.approved,
        output: result.reasoning,
        duration: Date.now() - startTime,
        timestamp: startTime
      };
    } catch (error) {
      return {
        hookId: hook.id,
        success: false,
        error: (error as Error).message,
        duration: Date.now() - startTime,
        timestamp: startTime
      };
    }
  }

  private interpolatePrompt(
    prompt: string,
    context: HookExecutionContext
  ): string {
    return prompt
      .replace(/\$\{file\}/g, context.filePath || '')
      .replace(/\$\{tool\}/g, context.toolName || '')
      .replace(/\$\{command\}/g, context.command || '')
      .replace(/\$\{content\}/g, context.content || '')
      .replace(/\$\{instanceId\}/g, context.instanceId || '');
  }

  private async evaluatePrompt(
    prompt: string,
    _model?: string
  ): Promise<{ approved: boolean; reasoning: string }> {
    const systemPrompt = `You are a security evaluator for an AI orchestrator. Evaluate whether the following operation should be allowed.
Respond with a JSON object: {"approved": true/false, "reasoning": "brief explanation"}
Only deny operations that are clearly dangerous, destructive, or violate security policies.
When in doubt, approve the operation.`;

    try {
      const llmService = getLLMService();
      const response = await retryWithBackoff(
        () => llmService.subQuery({
          requestId: `hook-eval-${Date.now()}`,
          prompt,
          context: systemPrompt,
          depth: 0,
        }),
        { maxRetries: 2, initialDelayMs: 500, source: 'hook-executor' }
      );

      // Parse JSON response from LLM
      const jsonMatch = response.match(/\{[\s\S]*"approved"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { approved: boolean; reasoning: string };
        return {
          approved: Boolean(parsed.approved),
          reasoning: parsed.reasoning || 'No reasoning provided',
        };
      }

      // If LLM didn't return valid JSON, check for approval keywords
      const lowerResponse = response.toLowerCase();
      const approved = lowerResponse.includes('approved') || lowerResponse.includes('allow');
      return { approved, reasoning: response.slice(0, 200) };
    } catch (error) {
      // Fail-open: if LLM is unavailable, approve with a warning
      hookLogger.warn('LLM evaluation failed, falling back to approve', {
        error: (error as Error).message,
        prompt: prompt.slice(0, 100),
      });
      return {
        approved: true,
        reasoning: `LLM evaluation unavailable (${(error as Error).message}). Defaulting to approved.`,
      };
    }
  }
}

// Export singleton getter
export function getHookExecutor(): HookExecutor {
  return HookExecutor.getInstance();
}
