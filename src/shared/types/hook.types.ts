/**
 * Hook Types - Rule engine for pre/post tool use hooks
 * Validated architecture from Claude Code hookify plugin
 */

export type HookEvent =
  | 'PreToolUse' // Before tool executes
  | 'PostToolUse' // After tool completes
  | 'Stop' // When Claude signals done
  | 'StopFailure' // When instance stops due to API/provider error (CC 2.1.78)
  | 'PostCompact' // After context compaction completes (CC 2.1.76)
  | 'CwdChanged' // Working directory changed (CC 2.1.83)
  | 'FileChanged' // Watched file changed (CC 2.1.83)
  | 'SessionStart' // Session begins
  | 'SessionEnd' // Session ends
  | 'BeforeCommit' // Before git commit
  | 'UserPromptSubmit'; // Before user prompt sent

export type HookAction = 'warn' | 'block';

export type ConditionOperator =
  | 'regex_match'
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'starts_with'
  | 'ends_with';

export interface HookCondition {
  field: string; // Field to match (command, file_path, new_text, etc.)
  operator: ConditionOperator;
  pattern: string;
}

export interface HookRule {
  id: string;
  name: string;
  enabled: boolean;

  // Matching
  event: HookEvent | 'all';
  toolMatcher?: string; // Tool name pattern (e.g., "Bash", "Edit|Write")
  conditions: HookCondition[]; // All must match (AND logic)

  /**
   * Optional lightweight predicate conditions evaluated BEFORE the main conditions.
   * Uses the same HookCondition syntax. All must match (AND logic).
   * When present, the hook is skipped entirely if any `if` condition fails,
   * avoiding unnecessary executor spawns in multi-instance scenarios.
   * Inspired by Claude Code 2.1.85 conditional hook execution.
   */
  if?: HookCondition[];

  // Action
  action: HookAction;
  message: string; // Message to show

  // Metadata
  source: 'built-in' | 'project' | 'user';
  createdAt: number;
  updatedAt?: number;
}

export interface HookResult {
  matched: boolean;
  action?: HookAction;
  message?: string;
  rules?: HookRule[]; // All matched rules
}

export interface HookContext {
  event: HookEvent;
  sessionId: string;
  instanceId: string;

  // Tool context (for PreToolUse/PostToolUse)
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;

  // File context (for Edit/Write tools)
  filePath?: string;
  oldContent?: string;
  newContent?: string;

  // Bash context
  command?: string;

  // User prompt context
  userPrompt?: string;

  // Stop context
  stopReason?: string;
  transcript?: string;

  // StopFailure context (for API/provider error hooks)
  errorMessage?: string;
  errorProvider?: string;

  // PostCompact context (for compaction hooks)
  compactionMethod?: 'native' | 'restart-with-summary';
  compactionSuccess?: boolean;
  previousContextUsage?: number; // percentage before compaction

  // CwdChanged context
  oldCwd?: string;
  newCwd?: string;

  // FileChanged context
  changeType?: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  changedPath?: string;
  changedRelativePath?: string;
}

// IPC payload types
export interface HookCreatePayload {
  rule: Omit<HookRule, 'id' | 'createdAt'>;
}

export interface HookUpdatePayload {
  ruleId: string;
  updates: Partial<Omit<HookRule, 'id' | 'createdAt' | 'source'>>;
}

export interface HookDeletePayload {
  ruleId: string;
}

export interface HookEvaluatePayload {
  context: HookContext;
}

export interface HookListPayload {
  event?: HookEvent;
  source?: 'built-in' | 'project' | 'user';
}

// Events
export type HookEventType =
  | 'hook:registered'
  | 'hook:updated'
  | 'hook:deleted'
  | 'hook:triggered'
  | 'hook:blocked'
  | 'hook:warned';

export interface HookEngineEvent {
  type: HookEventType;
  rule: HookRule;
  context?: HookContext;
  result?: HookResult;
}

// Helper functions
export function createHookRule(
  name: string,
  event: HookEvent | 'all',
  conditions: HookCondition[],
  action: HookAction,
  message: string,
  source: 'built-in' | 'project' | 'user' = 'user'
): HookRule {
  return {
    id: `hook-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    name,
    enabled: true,
    event,
    conditions,
    action,
    message,
    source,
    createdAt: Date.now(),
  };
}

export function createCondition(
  field: string,
  operator: ConditionOperator,
  pattern: string
): HookCondition {
  return { field, operator, pattern };
}

// Pre-configured condition builders
export const conditions = {
  commandContains: (pattern: string): HookCondition =>
    createCondition('command', 'contains', pattern),

  commandMatches: (regex: string): HookCondition =>
    createCondition('command', 'regex_match', regex),

  filePathContains: (pattern: string): HookCondition =>
    createCondition('filePath', 'contains', pattern),

  filePathMatches: (regex: string): HookCondition =>
    createCondition('filePath', 'regex_match', regex),

  newContentContains: (pattern: string): HookCondition =>
    createCondition('newContent', 'contains', pattern),

  newContentNotContains: (pattern: string): HookCondition =>
    createCondition('newContent', 'not_contains', pattern),

  toolNameEquals: (toolName: string): HookCondition =>
    createCondition('toolName', 'equals', toolName),
};

// Validation
export function validateHookRule(rule: Partial<HookRule>): string[] {
  const errors: string[] = [];

  if (!rule.name || rule.name.trim().length === 0) {
    errors.push('Rule name is required');
  }

  if (!rule.event) {
    errors.push('Event type is required');
  }

  if (!rule.conditions || rule.conditions.length === 0) {
    errors.push('At least one condition is required');
  }

  if (!rule.action) {
    errors.push('Action is required');
  }

  if (!rule.message || rule.message.trim().length === 0) {
    errors.push('Message is required');
  }

  // Validate conditions
  if (rule.conditions) {
    for (const cond of rule.conditions) {
      if (!cond.field) {
        errors.push('Condition field is required');
      }
      if (!cond.operator) {
        errors.push('Condition operator is required');
      }
      if (cond.operator === 'regex_match') {
        try {
          new RegExp(cond.pattern);
        } catch {
          errors.push(`Invalid regex pattern: ${cond.pattern}`);
        }
      }
    }
  }

  return errors;
}

// Serialize/deserialize for storage
export function serializeHookRule(rule: HookRule): string {
  return JSON.stringify(rule);
}

export function deserializeHookRule(json: string): HookRule {
  return JSON.parse(json) as HookRule;
}
