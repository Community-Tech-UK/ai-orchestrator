import type { AskUserQuestionEntry } from '../../../../shared/types/ask-user-question.types';

export interface UserActionRequest {
  id: string;
  instanceId: string;
  requestType: 'switch_mode' | 'approve_action' | 'confirm' | 'select_option' | 'input_required' | 'ask_questions';
  title: string;
  message: string;
  targetMode?: 'build' | 'plan' | 'review';
  options?: {
    id: string;
    label: string;
    description?: string;
  }[];
  /** For ask_questions: list of questions to present with text inputs */
  questions?: string[];
  /**
   * For Claude Code `AskUserQuestion` prompts (delivered as `input_required`
   * events): structured questions with clickable options. When present, the
   * card renders selectable chips instead of a freeform text box, and the
   * chosen answers are sent back to the CLI via the standard input_required
   * response path.
   */
  askQuestions?: AskUserQuestionEntry[];
  context?: Record<string, unknown>;
  createdAt: number;
  /** Permission metadata for input_required requests (action, path, etc.) */
  permissionMetadata?: {
    type?: string;
    tool_use_id?: string;
    action?: string;
    /** Display-friendly (possibly truncated) path shown in prompts. */
    path?: string;
    /**
     * Untruncated resource path or Bash command. Preferred over `path` when
     * building rule strings (e.g. for `~/.claude/settings.json` allow-lists).
     */
    full_path?: string;
    originalContent?: string;
    approvalTraceId?: string;
    /**
     * Canonical Claude CLI tool name for the denied tool_use (e.g. 'Edit',
     * 'Write'). Set by the adapter for `permission_denial` prompts and by
     * the hook bridge for `deferred_permission` prompts.
     */
    tool_name?: string;
    /** Tool input for deferred permission requests (e.g., { command: '...' }) */
    tool_input?: Record<string, unknown>;
    /** Session ID for deferred permission resume */
    session_id?: string;
  };
}
