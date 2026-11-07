/**
 * Tool Activity Map - Maps Claude tool names to human-readable activity labels
 */
import type { OutputMessage } from '../../../../shared/types/instance.types';
import { liveThoughtLine } from '../../../../shared/utils/live-thought-line';

/**
 * Maps tool names to user-friendly activity descriptions.
 *
 * Keys cover both:
 *  - Claude tool names (Read, Grep, Edit, Bash, …) — the original set.
 *  - ACP tool kinds (read, edit, search, execute, fetch, think, move, delete, other)
 *    emitted by the AcpCliAdapter for Copilot/Cursor sessions. Without these,
 *    the "Searching the codebase" progress pill in the session view would only
 *    appear for Claude.
 */
export const TOOL_ACTIVITY_MAP: Record<string, string> = {
  // File reading tools
  Read: 'Reading files',

  // Search tools
  Grep: 'Searching the codebase',
  Glob: 'Searching the codebase',

  // Editing tools
  Edit: 'Making edits',
  Write: 'Making edits',
  NotebookEdit: 'Making edits',

  // Shell tools
  Bash: 'Running commands',

  // Task delegation
  Task: 'Delegating work',

  // Planning tools
  TodoWrite: 'Planning next steps',
  TodoRead: 'Reviewing tasks',

  // Web tools
  WebFetch: 'Searching the web',
  WebSearch: 'Searching the web',

  // Navigation & Exploration
  ListDirectory: 'Exploring files',

  // ACP tool kinds (Copilot / Cursor via agent-client-protocol).
  // See src/shared/types/cli.types.ts → AcpToolKind.
  read: 'Reading files',
  edit: 'Making edits',
  move: 'Making edits',
  delete: 'Making edits',
  search: 'Searching the codebase',
  execute: 'Running commands',
  fetch: 'Searching the web',
  think: 'Thinking',
  other: 'Working',

  // Default fallback
  default: 'Working',
};

/**
 * Get human-readable activity label for a tool
 */
export function getToolActivity(toolName: string): string {
  return Object.hasOwn(TOOL_ACTIVITY_MAP, toolName) ? TOOL_ACTIVITY_MAP[toolName] : TOOL_ACTIVITY_MAP['default'];
}

export type ToolCategory = 'read' | 'search' | 'edit' | 'command' | 'web' | 'delegate' | 'plan' | 'server' | 'other';

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  Read: 'read', read: 'read', ListDirectory: 'read',
  Grep: 'search', Glob: 'search', search: 'search',
  Edit: 'edit', Write: 'edit', NotebookEdit: 'edit', edit: 'edit', move: 'edit', delete: 'edit', apply_patch: 'edit',
  Bash: 'command', execute: 'command', exec_command: 'command', write_stdin: 'command',
  WebFetch: 'web', WebSearch: 'web', fetch: 'web', web_search: 'web',
  Task: 'delegate', Agent: 'delegate', spawn_agent: 'delegate',
  TodoWrite: 'plan', TodoRead: 'plan', update_plan: 'plan',
};

/** Categories share the activity vocabulary, including the provider-native aliases. */
export function toolCategory(name: string): ToolCategory {
  return /^mcp__[^_].*?__/.test(name) ? 'server' : Object.hasOwn(TOOL_CATEGORIES, name) ? TOOL_CATEGORIES[name] : 'other';
}

/**
 * Extract thinking topic from markdown content.
 * Looks for **topic** patterns in the beginning of content.
 *
 * @example
 * // Returns "authentication flow"
 * extractThinkingTopic("**authentication flow**\nLet me think about...");
 *
 * @example
 * // Returns null (no topic found)
 * extractThinkingTopic("Let me think about this...");
 */
export function extractThinkingTopic(content: string): string | null {
  if (!content) return null;

  // Match **topic** at the beginning of content (with optional whitespace)
  const match = content.match(/^\s*\*\*([^*]+)\*\*/);
  if (match && match[1]) {
    const topic = match[1].trim();
    // Only return if it's a reasonable length for a topic (not a full sentence)
    if (topic.length > 0 && topic.length <= 50) {
      return topic;
    }
  }

  return null;
}

/**
 * Generate activity status from tool use or thinking content
 */
export function generateActivityStatus(
  toolName?: string,
  thinkingContent?: string
): string {
  // If we have thinking content with a topic, show that
  if (thinkingContent) {
    const topic = liveThoughtLine(thinkingContent);
    if (topic) {
      return `Thinking · ${topic}`;
    }
  }

  // Otherwise, use tool-based activity
  if (toolName) {
    return getToolActivity(toolName);
  }

  return 'Processing';
}

/** Transient progress from real output shapes; never derives a thought from answer text. */
export function activityFromOutput(message: OutputMessage): { activity: string; tool: string } | null {
  if (message.type === 'tool_use') {
    const name = message.metadata?.['name'];
    return typeof name === 'string' && name.trim() ? { activity: getToolActivity(name), tool: name } : null;
  }
  if (message.type !== 'assistant') return null;
  const text = message.thinking?.at(-1)?.content;
  const line = text ? liveThoughtLine(text) : null;
  return line ? { activity: `Thinking · ${line}`, tool: 'thinking' } : null;
}
