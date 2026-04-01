/**
 * Tool Permission Checker
 *
 * Evaluates tool execution requests against the permission model.
 * Tracks permission denials for auditing.
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import {
  DEFAULT_TOOL_PERMISSION_CONFIG,
  PermissionDenialRecord,
  ToolBehavior,
  ToolPermissionConfig,
  ToolPermissionContext,
  ToolPermissionResult,
} from '../../shared/types/tool-permission.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('ToolPermissionChecker');

/**
 * Known destructive tool patterns
 */
const DESTRUCTIVE_PATTERNS = [
  /delete/i,
  /remove/i,
  /drop/i,
  /reset.*hard/i,
  /force.*push/i,
  /rm\b/i,
  /truncate/i,
  /destroy/i,
];

export class ToolPermissionChecker extends EventEmitter {
  private static instance: ToolPermissionChecker | null = null;
  private config: ToolPermissionConfig;
  private denials: PermissionDenialRecord[] = [];
  private readonly maxDenialHistory = 1000;

  private constructor(config?: Partial<ToolPermissionConfig>) {
    super();
    this.config = {
      ...DEFAULT_TOOL_PERMISSION_CONFIG,
      ...config,
      // Merge sets properly
      automationExceptions: config?.automationExceptions ?? DEFAULT_TOOL_PERMISSION_CONFIG.automationExceptions,
      restrictedTools: config?.restrictedTools ?? DEFAULT_TOOL_PERMISSION_CONFIG.restrictedTools,
    };
  }

  static getInstance(): ToolPermissionChecker {
    if (!this.instance) {
      this.instance = new ToolPermissionChecker();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Check if a tool is allowed to execute in the given context.
   */
  checkPermission(toolName: string, context: ToolPermissionContext): ToolPermissionResult {
    // 1. Explicitly restricted tools are always denied
    if (this.config.restrictedTools.has(toolName)) {
      return this.recordDenial(toolName, context, {
        behavior: 'deny',
        reason: `Tool '${toolName}' is in the restricted list`,
      });
    }

    // 2. Check working directory restrictions
    if (this.config.allowedDirectories.length > 0) {
      const isAllowed = this.config.allowedDirectories.some(
        dir => context.workingDirectory.startsWith(path.resolve(dir))
      );
      if (!isAllowed) {
        return this.recordDenial(toolName, context, {
          behavior: 'deny',
          reason: `Working directory '${context.workingDirectory}' is outside allowed directories`,
        });
      }
    }

    // 3. Automation exceptions bypass further checks
    if (context.isAutomated && this.config.automationExceptions.has(toolName)) {
      return { behavior: 'allow' };
    }

    // 4. Destructive tool detection
    if (this.config.confirmDestructive && this.isDestructive(toolName)) {
      return {
        behavior: 'warn',
        reason: `Tool '${toolName}' appears to be destructive`,
        warningMessage: `'${toolName}' may modify or delete data. Proceed?`,
      };
    }

    // 5. Default: allow
    return { behavior: 'allow' };
  }

  /**
   * Check if a tool name matches destructive patterns.
   */
  isDestructive(toolName: string): boolean {
    return DESTRUCTIVE_PATTERNS.some(pattern => pattern.test(toolName));
  }

  /**
   * Get all permission denials (for audit display).
   */
  getDenials(): readonly PermissionDenialRecord[] {
    return this.denials;
  }

  /**
   * Get denials for a specific instance.
   */
  getDenialsForInstance(instanceId: string): PermissionDenialRecord[] {
    return this.denials.filter(d => d.instanceId === instanceId);
  }

  /**
   * Clear denial history.
   */
  clearDenials(): void {
    this.denials = [];
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(updates: Partial<ToolPermissionConfig>): void {
    this.config = { ...this.config, ...updates };
    logger.info('Tool permission config updated', {
      automationExceptions: this.config.automationExceptions.size,
      restrictedTools: this.config.restrictedTools.size,
      confirmDestructive: this.config.confirmDestructive,
    });
  }

  private recordDenial(
    toolName: string,
    context: ToolPermissionContext,
    result: ToolPermissionResult,
  ): ToolPermissionResult {
    const record: PermissionDenialRecord = {
      timestamp: Date.now(),
      instanceId: context.instanceId,
      toolName,
      behavior: result.behavior as ToolBehavior,
      reason: result.reason ?? 'Unknown',
      context,
    };

    this.denials.push(record);

    // Trim old denials
    if (this.denials.length > this.maxDenialHistory) {
      this.denials = this.denials.slice(-this.maxDenialHistory);
    }

    if (this.config.auditLog) {
      logger.info('Tool permission check', {
        toolName,
        behavior: result.behavior,
        reason: result.reason,
        instanceId: context.instanceId,
      });
    }

    this.emit('permission:checked', record);
    return result;
  }
}

export function getToolPermissionChecker(): ToolPermissionChecker {
  return ToolPermissionChecker.getInstance();
}
