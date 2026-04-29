/**
 * Command Types - Custom user-defined commands and templates
 */

import type { InstanceProvider, InstanceStatus } from './instance.types';

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
  aliases?: string[];
  category?: CommandCategory;
  usage?: string;
  examples?: string[];
  applicability?: CommandApplicability;
  disabledReason?: string;
  rankHints?: CommandRankHints;
  createdAt: number;
  updatedAt: number;
}

export type CommandCategory =
  | 'review'
  | 'navigation'
  | 'workflow'
  | 'session'
  | 'orchestration'
  | 'diagnostics'
  | 'memory'
  | 'settings'
  | 'skill'
  | 'custom';

export const COMMAND_CATEGORIES: readonly CommandCategory[] = [
  'review',
  'navigation',
  'workflow',
  'session',
  'orchestration',
  'diagnostics',
  'memory',
  'settings',
  'skill',
  'custom',
] as const;

export interface CommandApplicability {
  provider?: InstanceProvider | InstanceProvider[];
  instanceStatus?: InstanceStatus | InstanceStatus[];
  requiresWorkingDirectory?: boolean;
  requiresGitRepo?: boolean;
  featureFlag?: string;
  hideWhenIneligible?: boolean;
}

export interface CommandRankHints {
  pinned?: boolean;
  providerAffinity?: InstanceProvider[];
  weight?: number;
}

export type CommandResolutionResult =
  | { kind: 'exact'; command: CommandTemplate; args: string[]; matchedBy: 'name' }
  | { kind: 'alias'; command: CommandTemplate; args: string[]; matchedBy: 'alias'; alias: string }
  | { kind: 'ambiguous'; query: string; candidates: CommandTemplate[]; conflictingAlias?: string }
  | { kind: 'fuzzy'; query: string; suggestions: CommandTemplate[] }
  | { kind: 'none'; query: string };

export type CommandDiagnosticCode =
  | 'alias-collision'
  | 'alias-shadowed-by-name'
  | 'name-collision'
  | 'invalid-frontmatter-type'
  | 'unknown-category'
  | 'unknown-applicability-key'
  | 'invalid-rank-hints'
  | 'unknown-feature-flag';

export interface CommandDiagnostic {
  code: CommandDiagnosticCode;
  message: string;
  commandId?: string;
  alias?: string;
  filePath?: string;
  candidates?: string[];
  severity: 'warn' | 'error';
}

export interface CommandRegistrySnapshot {
  commands: CommandTemplate[];
  diagnostics: CommandDiagnostic[];
  scanDirs: string[];
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
    template: '',
    hint: 'Show available commands',
    aliases: ['?'],
    category: 'navigation',
    usage: '/help',
    examples: ['/help'],
    execution: { type: 'ui', actionId: 'app.open-command-help' },
    rankHints: { pinned: true },
    builtIn: true,
  },
  {
    name: 'review',
    description: 'Review changes in the current branch',
    template: 'Please review the changes in the current branch. Look at the git diff and provide feedback on:\n1. Code quality and best practices\n2. Potential bugs or issues\n3. Suggestions for improvement\n\n$ARGUMENTS',
    hint: 'Optional: specify what to focus on',
    aliases: ['r'],
    category: 'review',
    usage: '/review [focus area]',
    examples: ['/review staged changes', '/review auth flow'],
    rankHints: { pinned: true, providerAffinity: ['claude', 'codex'] },
    builtIn: true,
  },
  {
    name: 'commit',
    description: 'Create a git commit with a generated message',
    template: 'Please review the staged changes (git diff --staged) and create an appropriate commit. Follow conventional commit format. $ARGUMENTS',
    hint: 'Optional: add context for the commit',
    aliases: ['ci'],
    category: 'workflow',
    usage: '/commit [context]',
    examples: ['/commit auth refactor', '/commit'],
    applicability: { requiresWorkingDirectory: true, requiresGitRepo: true },
    disabledReason: 'Requires a git repository',
    builtIn: true,
  },
  {
    name: 'explain',
    description: 'Explain a file or code section',
    template: 'Please explain the following in detail:\n\n$ARGUMENTS',
    hint: 'Specify file path or paste code',
    aliases: ['why'],
    category: 'review',
    usage: '/explain <file or code>',
    examples: ['/explain src/main/index.ts'],
    builtIn: true,
  },
  {
    name: 'fix',
    description: 'Fix an issue or bug',
    template: 'Please fix the following issue:\n\n$ARGUMENTS\n\nAnalyze the problem, propose a solution, and implement the fix.',
    hint: 'Describe the issue',
    aliases: ['bug'],
    category: 'workflow',
    usage: '/fix <issue>',
    examples: ['/fix failing login test'],
    builtIn: true,
  },
  {
    name: 'test',
    description: 'Generate tests for code',
    template: 'Please generate comprehensive tests for:\n\n$ARGUMENTS\n\nInclude unit tests covering edge cases and error conditions.',
    hint: 'Specify file or function to test',
    aliases: ['spec'],
    category: 'workflow',
    usage: '/test <file or function>',
    examples: ['/test command-manager'],
    builtIn: true,
  },
  {
    name: 'refactor',
    description: 'Refactor code for better quality',
    template: 'Please refactor the following code to improve:\n- Readability\n- Maintainability\n- Performance (if applicable)\n\n$ARGUMENTS',
    hint: 'Specify file or paste code',
    aliases: ['clean'],
    category: 'workflow',
    usage: '/refactor <file or code>',
    examples: ['/refactor src/renderer/app/core/state/command.store.ts'],
    builtIn: true,
  },
  {
    name: 'pr',
    description: 'Create a pull request',
    template: 'Please create a pull request for the current branch. Generate:\n1. A descriptive title\n2. A summary of changes\n3. Testing instructions\n\n$ARGUMENTS',
    hint: 'Optional: add context',
    aliases: ['pull-request'],
    category: 'workflow',
    usage: '/pr [context]',
    examples: ['/pr command overlay foundation'],
    applicability: { requiresWorkingDirectory: true, requiresGitRepo: true },
    disabledReason: 'Requires a git repository',
    builtIn: true,
  },
  {
    name: 'plan',
    description: 'Create a plan for implementing a feature',
    template: 'Please create a detailed implementation plan for:\n\n$ARGUMENTS\n\nInclude:\n1. Steps to implement\n2. Files to modify/create\n3. Potential challenges\n4. Testing approach',
    hint: 'Describe the feature',
    aliases: ['design'],
    category: 'workflow',
    usage: '/plan <feature>',
    examples: ['/plan prompt history recall'],
    builtIn: true,
  },
  {
    name: 'compact',
    description: 'Compact context to free up space',
    template: '',
    hint: 'Compact the current conversation context',
    execution: { type: 'compact' },
    category: 'memory',
    usage: '/compact',
    examples: ['/compact'],
    applicability: { instanceStatus: ['idle', 'busy', 'processing', 'thinking_deeply'] },
    builtIn: true,
  },
  {
    name: 'rlm',
    description: 'Open the RLM context manager',
    template: '',
    hint: 'Open the RLM page',
    execution: { type: 'ui', actionId: 'app.open-rlm' },
    category: 'memory',
    usage: '/rlm',
    examples: ['/rlm'],
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
