/**
 * Agent Types - Defines agent profiles with different capabilities
 */

/**
 * Available agent mode types
 */
export type AgentMode = 'build' | 'plan' | 'review' | 'custom';

/**
 * Tool permission levels
 */
export type ToolPermission = 'allow' | 'deny' | 'ask';

/**
 * Agent tool permissions
 */
export interface AgentToolPermissions {
  /** File reading (read, glob, grep) */
  read: ToolPermission;
  /** File writing (write, edit) */
  write: ToolPermission;
  /** Bash command execution */
  bash: ToolPermission;
  /** Web fetching */
  web: ToolPermission;
  /** Task spawning (subagents) */
  task: ToolPermission;
}

/**
 * Agent profile definition
 */
export interface AgentProfile {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Short description */
  description: string;
  /** Agent mode type */
  mode: AgentMode;
  /** Color for UI (CSS color string) */
  color: string;
  /** Icon name (for UI) */
  icon: string;
  /** Keyboard shortcut hint */
  shortcutHint?: string;
  /** System prompt to prepend */
  systemPrompt?: string;
  /** Tool permissions */
  permissions: AgentToolPermissions;
  /** Model override (optional) */
  modelOverride?: string;
  /** Whether this is a built-in profile */
  builtin: boolean;
}

/**
 * Built-in agent profiles
 */
export const BUILTIN_AGENTS: AgentProfile[] = [
  {
    id: 'build',
    name: 'Build',
    description: 'Full access mode for development tasks',
    mode: 'build',
    color: '#10b981', // Green
    icon: 'hammer',
    shortcutHint: 'Tab to switch',
    permissions: {
      read: 'allow',
      write: 'allow',
      bash: 'allow',
      web: 'allow',
      task: 'allow',
    },
    builtin: true,
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only mode for exploration and planning',
    mode: 'plan',
    color: '#6366f1', // Indigo
    icon: 'map',
    shortcutHint: 'Tab to switch',
    systemPrompt: `You are in PLAN MODE. This is a read-only exploration mode.

IMPORTANT RESTRICTIONS:
- You can READ files, search code, and explore the codebase
- You can NOT write, edit, or create files
- You can NOT execute bash commands that modify anything
- You can run read-only commands like: ls, cat, grep, find, git status, git log, git diff

Your goal is to:
1. Understand the codebase structure
2. Analyze existing code
3. Create a detailed plan for changes
4. Identify potential issues or concerns

When you're ready to implement changes, tell the user to switch to BUILD mode.`,
    permissions: {
      read: 'allow',
      write: 'deny',
      bash: 'ask', // Allow read-only commands, deny others
      web: 'allow',
      task: 'allow',
    },
    builtin: true,
  },
  {
    id: 'review',
    name: 'Review',
    description: 'Code review mode for analyzing changes',
    mode: 'review',
    color: '#f59e0b', // Amber
    icon: 'eye',
    systemPrompt: `You are in REVIEW MODE. Focus on code review and analysis.

Your goals:
1. Review code changes for bugs, security issues, and best practices
2. Suggest improvements and optimizations
3. Check for test coverage and edge cases
4. Verify documentation accuracy

Provide constructive, specific feedback with examples when possible.`,
    permissions: {
      read: 'allow',
      write: 'deny',
      bash: 'ask',
      web: 'allow',
      task: 'allow',
    },
    builtin: true,
  },
  {
    id: 'retriever',
    name: 'Retriever',
    description: 'Fast file discovery and context extraction',
    mode: 'plan',
    color: '#0ea5e9', // Sky
    icon: 'map',
    systemPrompt: `You are in RETRIEVER MODE. Your job is to quickly locate files, symbols, and relevant snippets.

Rules:
- Only perform read-only actions
- Prefer concise outputs with file paths and small excerpts
- Do not suggest code changes or refactors
- If a request requires edits, say so and stop`,
    permissions: {
      read: 'allow',
      write: 'deny',
      bash: 'deny',
      web: 'deny',
      task: 'deny',
    },
    modelOverride: 'claude-3-5-haiku-20241022',
    builtin: true,
  },
];

/**
 * Get the default agent profile
 */
export function getDefaultAgent(): AgentProfile {
  return BUILTIN_AGENTS.find((a) => a.id === 'build')!;
}

/**
 * Get an agent profile by ID
 */
export function getAgentById(id: string): AgentProfile | undefined {
  return BUILTIN_AGENTS.find((a) => a.id === id);
}

/**
 * Get all available agent profiles
 */
export function getAllAgents(): AgentProfile[] {
  return [...BUILTIN_AGENTS];
}

/**
 * Check if a tool is allowed for an agent
 */
export function isToolAllowed(
  agent: AgentProfile,
  tool: keyof AgentToolPermissions
): ToolPermission {
  return agent.permissions[tool];
}
