import { HELD_ORCHESTRATOR_TOOL_MATCHER } from './harness-tool-allowlist';

export type CommandHookEntry = { matcher: string; hooks: { type: 'command'; command: string }[] };
export interface ClaudePermissionHooks {
  PreToolUse: CommandHookEntry[];
  PermissionRequest?: CommandHookEntry[];
}

/**
 * Every tool. In a session Harness started itself, Claude asks a PermissionRequest
 * hook only about calls it would otherwise refuse, and the hook script refuses them
 * with text that says whether a person was asked and what would allow the call.
 */
const PERMISSION_REQUEST_MATCHER = '.*';

/**
 * The permission hooks for Claude's `--settings`, shared by both argv builders.
 * `hookCommand` is the resolved Bash hook command (rewrite-only for an
 * auto-approve session, the defer hook otherwise). Ask-first sessions also hold
 * Harness's own tools that are not allowed outright, so approving the card runs
 * the waiting call.
 */
export function claudePermissionHooks(
  hookCommand: string | undefined,
  options: { yoloMode?: boolean; machineSession?: string },
): ClaudePermissionHooks | undefined {
  if (!hookCommand) return undefined;
  const entry = (matcher: string): CommandHookEntry => ({ matcher, hooks: [{ type: 'command', command: hookCommand }] });
  if (options.yoloMode) return { PreToolUse: [entry('Bash')] };
  return {
    PreToolUse: [entry('Bash'), entry(HELD_ORCHESTRATOR_TOOL_MATCHER)],
    ...(options.machineSession ? { PermissionRequest: [entry(PERMISSION_REQUEST_MATCHER)] } : {}),
  };
}
