/**
 * Hook Executor
 * Executes individual hooks (command-based and prompt-based)
 */

import { EventEmitter } from 'events';
import { spawn } from 'child_process';

// Local types for hook execution
export interface CommandHook {
  type: 'command';
  command: string;
  timeout?: number;
  captureOutput?: boolean;
}

export interface PromptHook {
  type: 'prompt';
  prompt: string;
  model?: string;
}

export type HookHandler = CommandHook | PromptHook;

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

export class HookExecutor extends EventEmitter {
  private static instance: HookExecutor;
  private config: HookExecutorConfig;

  private defaultConfig: HookExecutorConfig = {
    defaultTimeout: 30000,
    shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
    maxOutputSize: 1024 * 1024, // 1MB
  };

  static getInstance(): HookExecutor {
    if (!this.instance) {
      this.instance = new HookExecutor();
    }
    return this.instance;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
  }

  configure(config: Partial<HookExecutorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============ Hook Execution ============

  async execute(hook: HookConfig, context: HookExecutionContext): Promise<HookExecutorResult> {
    const startTime = Date.now();

    try {
      if (hook.handler.type === 'command') {
        return await this.executeCommand(hook, hook.handler as CommandHook, context);
      } else if (hook.handler.type === 'prompt') {
        return await this.executePrompt(hook, hook.handler as PromptHook, context);
      } else {
        return {
          hookId: hook.id,
          success: false,
          error: `Unknown handler type: ${(hook.handler as { type: string }).type}`,
          duration: Date.now() - startTime,
          timestamp: startTime,
        };
      }
    } catch (error) {
      return {
        hookId: hook.id,
        success: false,
        error: (error as Error).message,
        duration: Date.now() - startTime,
        timestamp: startTime,
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
        timestamp: startTime,
      };
    }

    return new Promise<HookExecutorResult>(resolve => {
      let output = '';
      let error = '';
      let timedOut = false;

      const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];

      const proc = spawn(this.config.shell, shellArgs, {
        cwd: context.workingDirectory || process.cwd(),
        env: { ...process.env, ...context.env },
      });

      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeout);

      proc.stdout.on('data', data => {
        const chunk = data.toString();
        if (output.length + chunk.length <= this.config.maxOutputSize) {
          output += chunk;
        }
      });

      proc.stderr.on('data', data => {
        const chunk = data.toString();
        if (error.length + chunk.length <= this.config.maxOutputSize) {
          error += chunk;
        }
      });

      proc.on('close', code => {
        clearTimeout(timeoutId);

        const duration = Date.now() - startTime;

        if (timedOut) {
          resolve({
            hookId: hook.id,
            success: false,
            error: `Command timed out after ${timeout}ms`,
            output,
            duration,
            timestamp: startTime,
          });
        } else if (code === 0) {
          resolve({
            hookId: hook.id,
            success: true,
            output: handler.captureOutput ? output : undefined,
            duration,
            timestamp: startTime,
          });
        } else {
          resolve({
            hookId: hook.id,
            success: false,
            error: error || `Command exited with code ${code}`,
            output: handler.captureOutput ? output : undefined,
            duration,
            timestamp: startTime,
          });
        }
      });

      proc.on('error', err => {
        clearTimeout(timeoutId);
        resolve({
          hookId: hook.id,
          success: false,
          error: `Failed to execute command: ${err.message}`,
          duration: Date.now() - startTime,
          timestamp: startTime,
        });
      });
    });
  }

  private interpolateCommand(command: string, context: HookExecutionContext): string {
    return command
      .replace(/\$\{file\}/g, context.filePath || '')
      .replace(/\$\{tool\}/g, context.toolName || '')
      .replace(/\$\{command\}/g, context.command || '')
      .replace(/\$\{cwd\}/g, context.workingDirectory || process.cwd())
      .replace(/\$\{instanceId\}/g, context.instanceId || '');
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
        timestamp: startTime,
      };
    }

    // Placeholder for actual LLM evaluation
    // In real implementation, this would call the LLM API
    try {
      const result = await this.evaluatePrompt(prompt, handler.model);

      return {
        hookId: hook.id,
        success: result.approved,
        output: result.reasoning,
        duration: Date.now() - startTime,
        timestamp: startTime,
      };
    } catch (error) {
      return {
        hookId: hook.id,
        success: false,
        error: (error as Error).message,
        duration: Date.now() - startTime,
        timestamp: startTime,
      };
    }
  }

  private interpolatePrompt(prompt: string, context: HookExecutionContext): string {
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
    // Placeholder - actual implementation would call LLM
    // For now, return a default approval
    return {
      approved: true,
      reasoning: `Prompt evaluation: ${prompt.slice(0, 50)}... (LLM evaluation not implemented)`,
    };
  }
}

// Export singleton getter
export function getHookExecutor(): HookExecutor {
  return HookExecutor.getInstance();
}
