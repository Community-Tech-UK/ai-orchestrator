/**
 * Tool Activity Map - Maps Claude tool names to human-readable activity labels
 */

/**
 * Maps tool names to user-friendly activity descriptions
 */
export const TOOL_ACTIVITY_MAP: Record<string, string> = {
  // File reading tools
  Read: 'Gathering context',

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

  // Default fallback
  default: 'Working',
};

/**
 * Get human-readable activity label for a tool
 */
export function getToolActivity(toolName: string): string {
  return TOOL_ACTIVITY_MAP[toolName] || TOOL_ACTIVITY_MAP['default'];
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
    const topic = extractThinkingTopic(thinkingContent);
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
