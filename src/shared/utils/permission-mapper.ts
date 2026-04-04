/**
 * Permission Mapper - Maps agent permissions to CLI tool restrictions
 *
 * Claude Code tool names:
 * - Read tools: Read, Glob, Grep
 * - Write tools: Edit, Write, NotebookEdit
 * - Bash: Bash
 * - Web: WebFetch, WebSearch
 * - Task: Task
 */

import type { AgentToolPermissions, ToolPermission } from '../types/agent.types';
import type { SpecialistConstraints } from '../types/specialist.types';

// Tool categories mapped to Claude Code tool names
export const TOOL_CATEGORIES = {
  read: ['Read', 'Glob', 'Grep'],
  write: ['Edit', 'Write', 'NotebookEdit'],
  bash: ['Bash'],
  web: ['WebFetch', 'WebSearch'],
  task: ['Task'],
} as const;

/**
 * Get disallowed tools based on agent permissions
 * Tools with 'deny' permission are added to disallowed list
 * Tools with 'ask' permission are NOT disallowed (CLI will prompt)
 */
export function getDisallowedTools(permissions: AgentToolPermissions): string[] {
  const disallowed: string[] = [];

  for (const [category, permission] of Object.entries(permissions)) {
    if (permission === 'deny') {
      const tools = TOOL_CATEGORIES[category as keyof typeof TOOL_CATEGORIES];
      if (tools) {
        disallowed.push(...tools);
      }
    }
  }

  return disallowed;
}

/**
 * Get allowed tools based on agent permissions
 * This is the inverse - only explicitly allowed tools
 * Used when you want to restrict to ONLY these tools
 */
export function getAllowedTools(permissions: AgentToolPermissions): string[] {
  const allowed: string[] = [];

  for (const [category, permission] of Object.entries(permissions)) {
    if (permission === 'allow') {
      const tools = TOOL_CATEGORIES[category as keyof typeof TOOL_CATEGORIES];
      if (tools) {
        allowed.push(...tools);
      }
    }
  }

  return allowed;
}

/**
 * Check if a specific tool is allowed
 */
export function isToolAllowed(permissions: AgentToolPermissions, toolName: string): ToolPermission {
  // Find which category this tool belongs to
  for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
    if ((tools as readonly string[]).includes(toolName)) {
      return permissions[category as keyof AgentToolPermissions];
    }
  }
  // Unknown tools default to 'ask'
  return 'ask';
}

/**
 * Pattern-based permission rules for files
 */
export interface FilePermissionRule {
  /** Pattern to match (glob-like, e.g., "*.env", "secrets/*") */
  pattern: string;
  /** Permission for read operations */
  read: ToolPermission;
  /** Permission for write operations */
  write: ToolPermission;
  /** Description of the rule */
  description?: string;
}

/**
 * Default file permission rules
 * These protect sensitive files by default
 */
export const DEFAULT_FILE_RULES: FilePermissionRule[] = [
  {
    pattern: '*.env',
    read: 'ask',
    write: 'deny',
    description: 'Environment files may contain secrets',
  },
  {
    pattern: '.env*',
    read: 'ask',
    write: 'deny',
    description: 'Environment files may contain secrets',
  },
  {
    pattern: '*.key',
    read: 'deny',
    write: 'deny',
    description: 'Private key files',
  },
  {
    pattern: '*.pem',
    read: 'ask',
    write: 'deny',
    description: 'Certificate/key files',
  },
  {
    pattern: 'id_rsa*',
    read: 'deny',
    write: 'deny',
    description: 'SSH private keys',
  },
  {
    pattern: 'credentials.json',
    read: 'ask',
    write: 'deny',
    description: 'Credential files',
  },
  {
    pattern: 'secrets/*',
    read: 'ask',
    write: 'deny',
    description: 'Secrets directory',
  },
];

/**
 * Check if a file path matches a permission rule pattern
 * Simple glob-like matching (*, **)
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/\./g, '\\.')     // Escape dots
    .replace(/\*\*/g, '.*')    // ** matches anything
    .replace(/\*/g, '[^/]*');  // * matches anything except /

  const regex = new RegExp(`(^|/)${regexPattern}$`);
  return regex.test(filePath);
}

/**
 * Get the permission for a file based on rules
 */
export function getFilePermission(
  filePath: string,
  operation: 'read' | 'write',
  rules: FilePermissionRule[] = DEFAULT_FILE_RULES
): ToolPermission {
  for (const rule of rules) {
    if (matchesPattern(filePath, rule.pattern)) {
      return rule[operation];
    }
  }
  // Default: allow
  return 'allow';
}

/**
 * Applies specialist constraints as hard permission overrides.
 * Never weakens existing permissions — only tightens them.
 */
export function applySpecialistConstraints(
  permissions: AgentToolPermissions,
  constraints: SpecialistConstraints
): AgentToolPermissions {
  const result = { ...permissions };

  if (constraints.readOnlyMode) {
    result.write = 'deny';
  }

  if (constraints.sandboxedExecution) {
    // Only tighten: deny stays deny, allow becomes ask
    if (result.bash !== 'deny') {
      result.bash = 'ask';
    }
  }

  return result;
}
