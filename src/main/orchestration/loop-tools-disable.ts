/**
 * D2 (#6): forced tools-disabled wrap-up for the loop's final (cap-out)
 * iteration — adapter-side enforcement so the structured hand-off cannot
 * start new work, instead of relying on the prompt directive alone.
 *
 * Per-provider reality (kept honest — the spec accepts a prompt-only interim
 * where a CLI has no tools-disable mechanism):
 *
 * - **claude**: ENFORCED. `ClaudeCliAdapter` rebuilds its argv from
 *   `spawnOptions` on every `sendMessage` spawn, and `--disallowedTools`
 *   removes tools even under `--dangerously-skip-permissions` (the host
 *   cloud-scheduler denylist already relies on this). We inject a
 *   per-send override via `setDisallowedToolsOverride` and clear it after
 *   the wrap-up send, so borrowed/persistent adapters are not permanently
 *   mutated. Known gap: MCP-provided tools can't be enumerated here, so
 *   they stay available — the wrap-up prompt directive still covers them.
 * - **codex**: NOT ENFORCED (prompt-only fallback). `CodexCliConfig` exposes
 *   sandbox/approval policy but no tool allow/deny list, and the app-server
 *   thread keeps one config for its lifetime.
 * - **gemini**: NOT ENFORCED (prompt-only fallback). `GeminiCliConfig` has no
 *   tool restriction knob. (Gemini CLI's `excludeTools` settings key is a
 *   future avenue — it would need a per-send settings rewrite.)
 * - **copilot / cursor / others**: NOT ENFORCED (prompt-only fallback). The
 *   copilot `-p` mode always passes `--allow-all-tools`; no deny list is
 *   plumbed.
 *
 * Kept dependency-light (no electron, no barrels) so worker bundles that pull
 * orchestration helpers never trip the transitive-electron-import crash.
 */

/**
 * Built-in Claude Code tools denied during a tools-disabled wrap-up.
 *
 * Deliberately NOT a full disable: the wrap-up directive
 * (`buildCapWrapUpDirective`) explicitly instructs the agent to update
 * `LOOP_TASKS.md` and `NOTES.md` so the run leaves a durable, resumable
 * hand-off — Read/Glob/Grep/Edit/Write/Todo* therefore stay AVAILABLE for
 * that bookkeeping. What the deny list enforces is the directive's "no new
 * work" clause: no command execution (Bash family), no sub-agent delegation
 * (Task/Agent), no network (WebFetch/WebSearch), no mode/skill escapes.
 * Edit-scope discipline ("do NOT begin new edits") remains prompt-enforced —
 * `--disallowedTools` cannot distinguish NOTES.md from source files.
 *
 * Includes the legacy `Agent` alias — unknown names in `--disallowedTools`
 * are ignored by the CLI, so the superset is harmless.
 */
export const LOOP_WRAP_UP_DISALLOWED_TOOLS: readonly string[] = [
  'Task',
  'Agent',
  'Bash',
  'BashOutput',
  'KillShell',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'ExitPlanMode',
  'SlashCommand',
];

interface DisallowedToolsOverridable {
  setDisallowedToolsOverride?: (tools: readonly string[] | null) => void;
}

export interface WrapUpToolsDisableHandle {
  /** True when the adapter supports tool disabling and the override was applied. */
  applied: boolean;
  /** Clears the override. Safe to call multiple times; no-op when not applied. */
  restore: () => void;
}

/**
 * Applies the wrap-up tools-disable override to an adapter when it supports
 * one (duck-typed — today only `ClaudeCliAdapter`). Returns whether it was
 * enforced plus a restore handle the caller MUST invoke after the send, so a
 * reused (persistent/borrowed) adapter regains its tools for later turns.
 */
export function applyWrapUpToolsDisable(adapter: unknown): WrapUpToolsDisableHandle {
  const target = adapter as DisallowedToolsOverridable | null | undefined;
  const setter = target?.setDisallowedToolsOverride;
  if (typeof setter !== 'function') {
    return { applied: false, restore: () => { /* provider gap: prompt-only fallback */ } };
  }
  setter.call(target, LOOP_WRAP_UP_DISALLOWED_TOOLS);
  let restored = false;
  return {
    applied: true,
    restore: () => {
      if (restored) return;
      restored = true;
      setter.call(target, null);
    },
  };
}
