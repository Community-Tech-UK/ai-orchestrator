/**
 * Hook Types Module
 *
 * Type definitions and interfaces for the hook executor.
 */

export type HookTiming = 'pre' | 'post';
export type HookAction = 'allow' | 'block' | 'modify' | 'skip';

export interface EnhancedHookConfig {
  id: string;
  name: string;
  enabled: boolean;
  event: string;
  timing: HookTiming;
  handler: EnhancedHookHandler;
  /** Priority for execution order (lower = earlier) */
  priority?: number;
  /** Dependencies on other hooks */
  dependsOn?: string[];
  /** Conditions for execution */
  conditions?: HookCondition[];
  /** Whether this hook can block execution */
  blocking?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Require explicit approval before execution */
  approvalRequired?: boolean;
  /** Whether this hook has been approved */
  approved?: boolean;
}

export interface EnhancedHookHandler {
  /** command=shell, script=file, prompt=LLM, function=registry, executable=external binary (stdin/stdout JSON) */
  type: 'command' | 'prompt' | 'script' | 'function' | 'executable';
  /** Command string for 'command' type */
  command?: string;
  /** Script path for 'script' type */
  scriptPath?: string;
  /** Prompt template for 'prompt' type */
  prompt?: string;
  /** Model for prompt evaluation */
  model?: string;
  /** Function name for 'function' type */
  functionName?: string;
  /** Absolute path to external executable for 'executable' type. Receives context as JSON on stdin; writes {ok,message} JSON to stdout. */
  executablePath?: string;
  /** Capture and stream output */
  streamOutput?: boolean;
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  workingDirectory?: string;
  /** Allow shell features like pipes/redirects (disabled by default) */
  allowShell?: boolean;
  /** Allow script execution (disabled by default) */
  allowScript?: boolean;
  /** Allowed executables (absolute paths or basenames) */
  allowedExecutables?: string[];
  /** Allowed script directories (absolute paths) */
  allowedScriptDirs?: string[];
}

export interface HookCondition {
  type: 'file_pattern' | 'tool_name' | 'content_match' | 'env_var' | 'custom';
  value: string;
  operator?: 'equals' | 'contains' | 'matches' | 'not_equals' | 'exists';
}

export interface HookExecutionContext {
  instanceId?: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  filePath?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  command?: string;
  content?: string;
  dryRun?: boolean;
  /** Results from previous hooks in chain */
  previousResults?: HookExecutionResult[];
  /** Original tool call data */
  originalToolCall?: {
    name: string;
    input: Record<string, unknown>;
  };
}

export interface HookExecutionResult {
  hookId: string;
  hookName: string;
  success: boolean;
  action: HookAction;
  output?: string;
  error?: string;
  duration: number;
  timestamp: number;
  /** Modified data if action is 'modify' */
  modifiedData?: Record<string, unknown>;
  /** Reason for blocking if action is 'block' */
  blockReason?: string;
  /** Stream output chunks if streaming */
  streamChunks?: string[];
}

export interface BlockingResult {
  blocked: boolean;
  reason?: string;
  modifiedInput?: Record<string, unknown>;
}

export const DEFAULT_TIMEOUT = 30000;
export const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB
export const SHELL_METACHAR_PATTERN = /[|&;<>()`$\n\r]/;

export const DEFAULT_ALLOWED_EXEC_DIRS = (() => {
  const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '';
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    `${homeDir}/.local/bin`,
    `${homeDir}/.npm-global/bin`,
    `${homeDir}/.nvm/versions/node/current/bin`,
    '/usr/bin',
    '/bin'
  ].filter(Boolean);
})();
