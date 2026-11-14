/**
 * Claude policy constants for sessions Harness starts itself (reviewers, loops,
 * automations, plan-queue workers). James's own chats are not affected.
 */

/**
 * The only built-in tools a read-only Claude reviewer gets (`--tools`).
 * Keep `ToolSearch`: `--tools` turns every other built-in into a deny rule, and
 * with ToolSearch denied the CLI sends every deferred connector tool with its
 * full schema in each request. `Skill` stays, but under `dontAsk` a skill that
 * needs approval is refused.
 */
export const CLAUDE_READ_ONLY_REVIEW_TOOLS = ['Read', 'Grep', 'Glob', 'ToolSearch', 'Skill'];

/** Turn cap for Claude reviewers (fresh-eyes, `aio review`, second opinions). */
export const CLAUDE_REVIEWER_MAX_TURNS = 8;

/** Plugins switched off through the `--settings` overlay for machine-started sessions. */
export const MACHINE_SESSION_DISABLED_PLUGINS = ['security-guidance@claude-plugins-official'];
