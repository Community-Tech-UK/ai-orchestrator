/**
 * Hook Manager
 * Central manager for hook registration, configuration, and execution coordination
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getLogger } from '../logging/logger';
import type { HookEvent } from '../../shared/types/hook.types';
import {
  HookExecutor,
  getHookExecutor,
  type HookConfig,
  type HookExecutionContext,
  type HookExecutorResult
} from './hook-executor';

// Local type for hook matchers
export interface HookMatcher {
  toolName?: string | string[];
  toolPattern?: string;
  filePattern?: string;
}

// Extended hook config for manager
export interface ManagedHookConfig extends HookConfig {
  matcher?: HookMatcher;
  stopOnFailure?: boolean;
  /** Require explicit approval before execution */
  approvalRequired?: boolean;
  /** Whether this hook has been approved */
  approved?: boolean;
}

export interface HookManagerConfig {
  enabled: boolean;
  maxConcurrentHooks: number;
  defaultTimeout: number;
  stopOnFirstFailure: boolean;
}

const logger = getLogger('HookManager');

export class HookManager extends EventEmitter {
  private static instance: HookManager;
  private hooks = new Map<string, ManagedHookConfig>();
  private executor: HookExecutor;
  private config: HookManagerConfig;
  private executionHistory: HookExecutorResult[] = [];
  private maxHistorySize = 1000;
  private approvalsFilePath: string;

  private defaultConfig: HookManagerConfig = {
    enabled: true,
    maxConcurrentHooks: 5,
    defaultTimeout: 30000,
    stopOnFirstFailure: false
  };

  static getInstance(): HookManager {
    if (!this.instance) {
      this.instance = new HookManager();
    }
    return this.instance;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
    this.executor = getHookExecutor();
    // Initialize approvals persistence path
    const userData = app?.getPath?.('userData') || process.cwd();
    this.approvalsFilePath = path.join(userData, 'hook-approvals.json');
  }

  // ============ Configuration ============

  configure(config: Partial<HookManagerConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('config:updated', this.config);
  }

  getConfig(): HookManagerConfig {
    return { ...this.config };
  }

  // ============ Hook Registration ============

  registerHook(hook: ManagedHookConfig): void {
    if (this.hooks.has(hook.id)) {
      throw new Error(`Hook with id ${hook.id} already exists`);
    }
    this.hooks.set(hook.id, hook);
    this.emit('hook:registered', hook);
  }

  updateHook(
    hookId: string,
    updates: Partial<ManagedHookConfig>
  ): ManagedHookConfig | undefined {
    const hook = this.hooks.get(hookId);
    if (!hook) return undefined;

    const updated = { ...hook, ...updates, id: hookId }; // Prevent id change
    this.hooks.set(hookId, updated);
    this.emit('hook:updated', updated);
    return updated;
  }

  unregisterHook(hookId: string): boolean {
    const removed = this.hooks.delete(hookId);
    if (removed) {
      this.emit('hook:unregistered', { hookId });
    }
    return removed;
  }

  getHook(hookId: string): ManagedHookConfig | undefined {
    return this.hooks.get(hookId);
  }

  approveHook(hookId: string, approved = true): ManagedHookConfig | undefined {
    const hook = this.hooks.get(hookId);
    if (!hook) return undefined;
    const updated = { ...hook, approved };
    this.hooks.set(hookId, updated);
    this.emit('hook:approval-updated', { hookId, approved });
    // Persist approval state
    void this.saveApprovals();
    return updated;
  }

  getAllHooks(): ManagedHookConfig[] {
    return Array.from(this.hooks.values());
  }

  getHooksByEvent(event: HookEvent): ManagedHookConfig[] {
    return this.getAllHooks().filter((h) => h.event === event && h.enabled);
  }

  // ============ Hook Execution ============

  async triggerHooks(
    event: HookEvent,
    context: HookExecutionContext
  ): Promise<HookExecutorResult[]> {
    if (!this.config.enabled) {
      return [];
    }

    const matchingHooks = this.findMatchingHooks(event, context);
    if (matchingHooks.length === 0) {
      return [];
    }

    this.emit('hooks:triggered', {
      event,
      hookCount: matchingHooks.length,
      context
    });

    const results: HookExecutorResult[] = [];

    for (const hook of matchingHooks) {
      try {
        if (hook.approvalRequired && !hook.approved) {
          const approvalResult: HookExecutorResult = {
            hookId: hook.id,
            success: false,
            error: 'Approval required',
            duration: 0,
            timestamp: Date.now()
          };
          results.push(approvalResult);
          this.recordResult(approvalResult);
          this.emit('hook:approval-required', {
            hookId: hook.id,
            hook,
            context
          });
          continue;
        }
        const result = await this.executor.execute(hook, context);
        results.push(result);
        this.recordResult(result);

        this.emit('hook:executed', result);

        // Check if we should stop on failure
        if (!result.success && hook.stopOnFailure) {
          this.emit('hooks:stopped', {
            reason: 'Hook failure',
            hookId: hook.id
          });
          break;
        }

        if (!result.success && this.config.stopOnFirstFailure) {
          this.emit('hooks:stopped', {
            reason: 'Config stopOnFirstFailure',
            hookId: hook.id
          });
          break;
        }
      } catch (error) {
        const errorResult: HookExecutorResult = {
          hookId: hook.id,
          success: false,
          error: (error as Error).message,
          duration: 0,
          timestamp: Date.now()
        };
        results.push(errorResult);
        this.recordResult(errorResult);
        this.emit('hook:error', {
          hookId: hook.id,
          error: (error as Error).message
        });

        if (hook.stopOnFailure || this.config.stopOnFirstFailure) {
          break;
        }
      }
    }

    this.emit('hooks:completed', { event, results });
    return results;
  }

  private findMatchingHooks(
    event: HookEvent,
    context: HookExecutionContext
  ): ManagedHookConfig[] {
    return this.getHooksByEvent(event).filter((hook) =>
      this.matchesContext(hook.matcher, context)
    );
  }

  private matchesContext(
    matcher: HookMatcher | undefined,
    context: HookExecutionContext
  ): boolean {
    if (!matcher) return true; // No matcher means match all

    // Tool name matching
    if (matcher.toolName) {
      const toolNames = Array.isArray(matcher.toolName)
        ? matcher.toolName
        : [matcher.toolName];
      if (context.toolName && !toolNames.includes(context.toolName)) {
        return false;
      }
    }

    // Tool pattern matching (glob)
    if (matcher.toolPattern && context.toolName) {
      if (!this.matchGlob(context.toolName, matcher.toolPattern)) {
        return false;
      }
    }

    // File pattern matching
    if (matcher.filePattern && context.filePath) {
      if (!this.matchGlob(context.filePath, matcher.filePattern)) {
        return false;
      }
    }

    return true;
  }

  private matchGlob(value: string, pattern: string): boolean {
    // Simple glob matching (supports * and **)
    const regexPattern = pattern
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(value);
  }

  // ============ Execution History ============

  private recordResult(result: HookExecutorResult): void {
    this.executionHistory.push(result);
    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory.shift();
    }
  }

  getExecutionHistory(options?: {
    hookId?: string;
    event?: HookEvent;
    limit?: number;
  }): HookExecutorResult[] {
    let history = this.executionHistory;

    if (options?.hookId) {
      history = history.filter((r) => r.hookId === options.hookId);
    }

    if (options?.limit) {
      history = history.slice(-options.limit);
    }

    return history;
  }

  clearHistory(): void {
    this.executionHistory = [];
    this.emit('history:cleared');
  }

  // ============ Hook Testing ============

  async testHook(
    hookId: string,
    testContext: HookExecutionContext
  ): Promise<HookExecutorResult> {
    const hook = this.hooks.get(hookId);
    if (!hook) {
      return {
        hookId,
        success: false,
        error: 'Hook not found',
        duration: 0,
        timestamp: Date.now()
      };
    }

    // Execute in dry-run mode
    return this.executor.execute(hook, { ...testContext, dryRun: true });
  }

  // ============ Import/Export ============

  exportHooks(): ManagedHookConfig[] {
    return this.getAllHooks();
  }

  importHooks(
    hooks: ManagedHookConfig[],
    options?: { overwrite?: boolean }
  ): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;

    for (const hook of hooks) {
      if (this.hooks.has(hook.id)) {
        if (options?.overwrite) {
          this.hooks.set(hook.id, hook);
          imported++;
        } else {
          skipped++;
        }
      } else {
        this.hooks.set(hook.id, hook);
        imported++;
      }
    }

    this.emit('hooks:imported', { imported, skipped });
    return { imported, skipped };
  }

  // ============ Statistics ============

  getStats(): {
    totalHooks: number;
    enabledHooks: number;
    byEvent: Record<string, number>;
    executionStats: {
      total: number;
      successful: number;
      failed: number;
      avgDuration: number;
    };
  } {
    const hooks = this.getAllHooks();
    const byEvent: Record<string, number> = {};

    for (const hook of hooks) {
      byEvent[hook.event] = (byEvent[hook.event] || 0) + 1;
    }

    const history = this.executionHistory;
    const successful = history.filter((r) => r.success).length;
    const avgDuration =
      history.length > 0
        ? history.reduce((sum, r) => sum + r.duration, 0) / history.length
        : 0;

    return {
      totalHooks: hooks.length,
      enabledHooks: hooks.filter((h) => h.enabled).length,
      byEvent,
      executionStats: {
        total: history.length,
        successful,
        failed: history.length - successful,
        avgDuration
      }
    };
  }

  // ============ Persistence ============

  /**
   * Save approved hook IDs to disk
   */
  async saveApprovals(): Promise<void> {
    try {
      const approvedIds = this.getAllHooks()
        .filter((h) => h.approvalRequired && h.approved)
        .map((h) => h.id);
      await fs.promises.writeFile(
        this.approvalsFilePath,
        JSON.stringify({ approvedHookIds: approvedIds }, null, 2),
        'utf-8'
      );
      this.emit('approvals:saved', { count: approvedIds.length });
    } catch (error) {
      logger.error('Failed to save hook approvals', error instanceof Error ? error : undefined);
      this.emit('approvals:save-error', { error: (error as Error).message });
    }
  }

  /**
   * Load approved hook IDs from disk and apply to registered hooks
   */
  async loadApprovals(): Promise<void> {
    try {
      if (!fs.existsSync(this.approvalsFilePath)) {
        return;
      }
      const content = await fs.promises.readFile(
        this.approvalsFilePath,
        'utf-8'
      );
      const data = JSON.parse(content) as { approvedHookIds?: string[] };
      const approvedIds = new Set(data.approvedHookIds || []);
      let applied = 0;
      for (const hook of this.hooks.values()) {
        if (hook.approvalRequired && approvedIds.has(hook.id)) {
          hook.approved = true;
          applied++;
        }
      }
      this.emit('approvals:loaded', { total: approvedIds.size, applied });
    } catch (error) {
      logger.error('Failed to load hook approvals', error instanceof Error ? error : undefined);
      this.emit('approvals:load-error', { error: (error as Error).message });
    }
  }

  /**
   * Clear all saved approvals
   */
  async clearApprovals(): Promise<void> {
    try {
      for (const hook of this.hooks.values()) {
        if (hook.approvalRequired) {
          hook.approved = false;
        }
      }
      await this.saveApprovals();
      this.emit('approvals:cleared');
    } catch (error) {
      logger.error('Failed to clear hook approvals', error instanceof Error ? error : undefined);
      this.emit('approvals:clear-error', { error: (error as Error).message });
    }
  }
}

// Export singleton getter
export function getHookManager(): HookManager {
  return HookManager.getInstance();
}
