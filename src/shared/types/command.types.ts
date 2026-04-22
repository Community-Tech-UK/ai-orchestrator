/**
 * Command Types - Custom user-defined commands and templates
 */

/**
 * A custom command template
 */
export interface CommandTemplate {
  id: string;
  name: string;          // Command name (e.g., "review", "commit")
  description: string;   // Human-readable description
  template: string;      // Template with placeholders ($1, $2, $ARGUMENTS)
  hint?: string;         // Hint shown when entering command
  shortcut?: string;     // Keyboard shortcut
  builtIn: boolean;      // Whether this is a built-in command
  /** Origin of this command definition */
  source?: 'builtin' | 'store' | 'file';
  /** File path for file-based commands */
  filePath?: string;
  /** Optional model preference for executing this command */
  model?: string;
  /** Optional agent preference for executing this command */
  agent?: string;
  /** If true, run command in a child/subtask instance by default */
  subtask?: boolean;
  /**
   * Source priority index assigned at load time.
   * Higher values indicate higher-priority (later) sources such as project-level overrides.
   * Callers can use this to render override indicators in the UI.
   */
  priority?: number;
  /**
   * How the resolved command should be executed.
   * Defaults to `prompt`, which expands the template and sends it to the model.
   */
  execution?: CommandExecution;
  createdAt: number;
  updatedAt: number;
}

export type CommandExecution =
  | { type: 'prompt' }
  | { type: 'compact' }
  | { type: 'ui'; actionId: string };

/**
 * Parsed command with resolved arguments
 */
export interface ParsedCommand {
  command: CommandTemplate;
  args: string[];
  resolvedPrompt: string;
  execution: CommandExecution;
}

/**
 * Built-in commands
 */
export const BUILT_IN_COMMANDS: Omit<CommandTemplate, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'help',
    description: 'Show all available commands',
    template: `Please list all available commands in this application. Here are the built-in commands:

**Available Commands:**
- \`/help\` - Show this help message
- \`/review\` - Review changes in the current branch
- \`/commit\` - Create a git commit with a generated message
- \`/explain <file or code>\` - Explain a file or code section
- \`/fix <issue>\` - Fix an issue or bug
- \`/test <file or function>\` - Generate tests for code
- \`/refactor <file or code>\` - Refactor code for better quality
- \`/pr\` - Create a pull request
- \`/plan <feature>\` - Create a plan for implementing a feature

**Tips:**
- Press \`Cmd+K\` (Mac) or \`Ctrl+K\` (Windows/Linux) to open the command palette
- Type \`/\` in the input box to see command suggestions
- Commands can include arguments after the command name

$ARGUMENTS`,
    hint: 'Show available commands',
    builtIn: true,
  },
  {
    name: 'review',
    description: 'Review changes in the current branch',
    template: 'Please review the changes in the current branch. Look at the git diff and provide feedback on:\n1. Code quality and best practices\n2. Potential bugs or issues\n3. Suggestions for improvement\n\n$ARGUMENTS',
    hint: 'Optional: specify what to focus on',
    builtIn: true,
  },
  {
    name: 'commit',
    description: 'Create a git commit with a generated message',
    template: 'Please review the staged changes (git diff --staged) and create an appropriate commit. Follow conventional commit format. $ARGUMENTS',
    hint: 'Optional: add context for the commit',
    builtIn: true,
  },
  {
    name: 'explain',
    description: 'Explain a file or code section',
    template: 'Please explain the following in detail:\n\n$ARGUMENTS',
    hint: 'Specify file path or paste code',
    builtIn: true,
  },
  {
    name: 'fix',
    description: 'Fix an issue or bug',
    template: 'Please fix the following issue:\n\n$ARGUMENTS\n\nAnalyze the problem, propose a solution, and implement the fix.',
    hint: 'Describe the issue',
    builtIn: true,
  },
  {
    name: 'test',
    description: 'Generate tests for code',
    template: 'Please generate comprehensive tests for:\n\n$ARGUMENTS\n\nInclude unit tests covering edge cases and error conditions.',
    hint: 'Specify file or function to test',
    builtIn: true,
  },
  {
    name: 'refactor',
    description: 'Refactor code for better quality',
    template: 'Please refactor the following code to improve:\n- Readability\n- Maintainability\n- Performance (if applicable)\n\n$ARGUMENTS',
    hint: 'Specify file or paste code',
    builtIn: true,
  },
  {
    name: 'pr',
    description: 'Create a pull request',
    template: 'Please create a pull request for the current branch. Generate:\n1. A descriptive title\n2. A summary of changes\n3. Testing instructions\n\n$ARGUMENTS',
    hint: 'Optional: add context',
    builtIn: true,
  },
  {
    name: 'plan',
    description: 'Create a plan for implementing a feature',
    template: 'Please create a detailed implementation plan for:\n\n$ARGUMENTS\n\nInclude:\n1. Steps to implement\n2. Files to modify/create\n3. Potential challenges\n4. Testing approach',
    hint: 'Describe the feature',
    builtIn: true,
  },
  {
    name: 'compact',
    description: 'Compact context to free up space',
    template: '',
    hint: 'Compact the current conversation context',
    execution: { type: 'compact' },
    builtIn: true,
  },
  {
    name: 'rlm',
    description: 'Open the RLM context manager',
    template: '',
    hint: 'Open the RLM page',
    execution: { type: 'ui', actionId: 'app.open-rlm' },
    builtIn: true,
  },
];

const DEFAULT_COMMAND_EXECUTION: CommandExecution = { type: 'prompt' };

export function getCommandExecution(command: Pick<CommandTemplate, 'execution'>): CommandExecution {
  return command.execution ?? DEFAULT_COMMAND_EXECUTION;
}

export function createMarkdownCommandId(name: string): string {
  return `file:${encodeURIComponent(name)}`;
}

export function isMarkdownCommandId(commandId: string): boolean {
  return commandId.startsWith('file:');
}

export function getMarkdownCommandNameFromId(commandId: string): string | null {
  if (!isMarkdownCommandId(commandId)) {
    return null;
  }

  const encodedName = commandId.slice('file:'.length);
  if (!encodedName) {
    return null;
  }

  try {
    return decodeURIComponent(encodedName);
  } catch {
    return null;
  }
}

/**
 * Resolve command template placeholders
 */
export function resolveTemplate(template: string, args: string[]): string {
  let result = template;

  // Replace numbered placeholders ($1, $2, etc.)
  args.forEach((arg, index) => {
    result = result.replace(new RegExp(`\\$${index + 1}`, 'g'), arg);
  });

  // Replace $ARGUMENTS with all args joined
  result = result.replace(/\$ARGUMENTS/g, args.join(' '));
  // Also support ${ARGUMENTS} (common in markdown templates)
  result = result.replace(/\$\{ARGUMENTS\}/g, args.join(' '));

  // Clean up any remaining unreplaced placeholders
  result = result.replace(/\$\d+/g, '');
  result = result.replace(/\$\{\d+\}/g, '');

  return result.trim();
}

/**
 * Parse a command string (e.g., "/review focus on error handling")
 */
export function parseCommandString(input: string): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  const name = parts[0] || '';
  const args = parts.slice(1);

  if (!name) return null;
  return { name, args };
}
