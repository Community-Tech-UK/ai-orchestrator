/**
 * Enhanced Hook Executor - Thin Coordinator
 *
 * Advanced hook execution with:
 * - Blocking hooks that can modify/cancel tool execution
 * - Enhanced shell execution with streaming output
 * - Hook chaining and dependency resolution
 * - Conditional execution based on previous results
 *
 * This is a facade that delegates to focused sub-modules.
 */

import { EventEmitter } from 'events';
import { ChildProcess } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

// Import from decomposed modules
import {
  type HookTiming,
  type HookAction,
  type EnhancedHookConfig,
  type EnhancedHookHandler,
  type HookCondition,
  type HookExecutionContext,
  type HookExecutionResult,
  type BlockingResult,
  DEFAULT_ALLOWED_EXEC_DIRS
} from './executor/hook-types';

import { checkConditions } from './executor/hook-validation';
import { executeCommand } from './executor/hook-command';
import { executeScript } from './executor/hook-script';
import { executePrompt } from './executor/hook-prompt';
import { executeFunction } from './executor/hook-function';
import {
  resolveDependencies,
  sortByPriority,
  checkDependenciesSucceeded
} from './executor/hook-dependencies';
import { requestApproval } from './executor/hook-approval';

// Re-export types for backwards compatibility
export type {
  HookTiming,
  HookAction,
  EnhancedHookConfig,
  EnhancedHookHandler,
  HookCondition,
  HookExecutionContext,
  HookExecutionResult,
  BlockingResult
};

export class EnhancedHookExecutor extends EventEmitter {
  private static instance: EnhancedHookExecutor | null = null;
  private anthropic: Anthropic | null = null;
  private registeredFunctions: Map<
    string,
    (context: HookExecutionContext) => Promise<HookExecutionResult>
  > = new Map();
  private activeProcesses: Map<string, ChildProcess> = new Map();
  private allowedExecutableDirs: string[] = [...DEFAULT_ALLOWED_EXEC_DIRS];
  private allowedScriptDirs: string[] = [];

  private constructor() {
    super();
  }

  /**
   * Configure security allowlists
   */
  configureSecurity(options: {
    allowedExecutableDirs?: string[];
    allowedScriptDirs?: string[];
  }): void {
    if (options.allowedExecutableDirs) {
      this.allowedExecutableDirs = [...options.allowedExecutableDirs];
    }
    if (options.allowedScriptDirs) {
      this.allowedScriptDirs = [...options.allowedScriptDirs];
    }
    this.emit('security:configured', {
      allowedExecutableDirs: this.allowedExecutableDirs,
      allowedScriptDirs: this.allowedScriptDirs
    });
  }

  static getInstance(): EnhancedHookExecutor {
    if (!EnhancedHookExecutor.instance) {
      EnhancedHookExecutor.instance = new EnhancedHookExecutor();
    }
    return EnhancedHookExecutor.instance;
  }

  static _resetForTesting(): void {
    EnhancedHookExecutor.instance = null;
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
      timestamp: startTime
    };

    // Check conditions
    if (hook.conditions && !checkConditions(hook.conditions, context)) {
      return {
        ...baseResult,
        success: true,
        action: 'skip',
        output: 'Conditions not met',
        duration: Date.now() - startTime
      };
    }

    if (hook.approvalRequired && !hook.approved) {
      const approved = requestApproval(hook, context, this);
      if (!approved.approved) {
        this.emit('hook:approval-denied', { hookId: hook.id, hook, context });
        return {
          ...baseResult,
          success: false,
          action: hook.blocking ? 'block' : 'skip',
          error: 'Approval denied',
          duration: Date.now() - startTime
        };
      }

      if (approved.remember) {
        hook.approved = true;
      }
      this.emit('hook:approved', {
        hookId: hook.id,
        hook,
        context,
        remember: approved.remember
      });
    }

    try {
      switch (hook.handler.type) {
        case 'command':
          return await executeCommand(
            hook,
            context,
            this.allowedExecutableDirs,
            this.activeProcesses,
            this
          );
        case 'script':
          return await executeScript(
            hook,
            context,
            this.allowedExecutableDirs,
            this.allowedScriptDirs,
            this.activeProcesses,
            this
          );
        case 'prompt':
          return await executePrompt(hook, context, this.anthropic);
        case 'function':
          return await executeFunction(hook, context, this.registeredFunctions);
        default:
          return {
            ...baseResult,
            success: false,
            action: 'skip',
            error: `Unknown handler type: ${(hook.handler as { type: string }).type}`,
            duration: Date.now() - startTime
          };
      }
    } catch (error) {
      return {
        ...baseResult,
        success: false,
        action: 'skip',
        error: (error as Error).message,
        duration: Date.now() - startTime
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
    // Sort by priority then resolve dependencies
    const sortedHooks = sortByPriority(hooks);
    const orderedHooks = resolveDependencies(sortedHooks);

    const results: HookExecutionResult[] = [];
    let finalAction: HookAction = 'allow';
    let modifiedData: Record<string, unknown> | undefined;

    for (const hook of orderedHooks) {
      // Check if dependencies succeeded
      if (!checkDependenciesSucceeded(hook, results)) {
        results.push({
          hookId: hook.id,
          hookName: hook.name,
          success: false,
          action: 'skip',
          error: 'Dependency failed',
          duration: 0,
          timestamp: Date.now()
        });
        continue;
      }

      const result = await this.execute(hook, {
        ...context,
        previousResults: results,
        toolInput: modifiedData || context.toolInput
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
        modifiedData = { ...modifiedData, ...result.modifiedData };
        finalAction = 'modify';
      }
    }

    return {
      results,
      finalAction,
      blocked: finalAction === 'block',
      modifiedData
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
}

export function getEnhancedHookExecutor(): EnhancedHookExecutor {
  return EnhancedHookExecutor.getInstance();
}

export default EnhancedHookExecutor;
