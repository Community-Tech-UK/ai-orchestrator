/**
 * Tool Permission Types
 *
 * Granular tool permission model supporting three tiers:
 * - allow: Tool can execute without user interaction
 * - warn: Tool can execute but user is notified
 * - deny: Tool execution is blocked
 */

/**
 * Permission behavior for a tool execution request
 */
export type ToolBehavior = 'allow' | 'warn' | 'deny';

/**
 * Context for evaluating tool permissions
 */
export interface ToolPermissionContext {
  /** Instance requesting the tool */
  instanceId: string;
  /** Working directory of the instance */
  workingDirectory: string;
  /** Provider running the instance */
  provider: string;
  /** Whether this is an automated (non-interactive) execution */
  isAutomated: boolean;
  /** Parent instance ID (if child) */
  parentInstanceId?: string;
}

/**
 * Result of a permission check
 */
export interface ToolPermissionResult {
  /** The permission decision */
  behavior: ToolBehavior;
  /** Reason for the decision (for logging/display) */
  reason?: string;
  /** Warning message to show user (only when behavior is 'warn') */
  warningMessage?: string;
}

/**
 * Configuration for the tool permission system
 */
export interface ToolPermissionConfig {
  /** Tools that are always allowed without prompting (e.g., read-only tools) */
  automationExceptions: Set<string>;
  /** Tools that always require explicit approval */
  restrictedTools: Set<string>;
  /** Whether destructive operations require confirmation */
  confirmDestructive: boolean;
  /** Allowed working directories per instance (empty = unrestricted) */
  allowedDirectories: string[];
  /** Whether to log all permission checks */
  auditLog: boolean;
}

/**
 * Record of a permission denial for auditing
 */
export interface PermissionDenialRecord {
  timestamp: number;
  instanceId: string;
  toolName: string;
  behavior: ToolBehavior;
  reason: string;
  context: ToolPermissionContext;
}

/**
 * Default permission configuration
 */
export const DEFAULT_TOOL_PERMISSION_CONFIG: ToolPermissionConfig = {
  automationExceptions: new Set([
    'read_file',
    'list_files',
    'search_code',
    'get_status',
    'view_diff',
  ]),
  restrictedTools: new Set([
    'delete_file',
    'force_push',
    'drop_database',
    'rm_rf',
  ]),
  confirmDestructive: true,
  allowedDirectories: [],
  auditLog: true,
};
