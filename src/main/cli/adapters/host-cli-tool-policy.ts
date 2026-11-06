/**
 * Host-CLI tool policy — tool names that Harness must always deny on spawned Claude
 * Code instances, independent of agent permissions or spawn path.
 *
 * AskUserQuestion, EnterPlanMode and ExitPlanMode require an interactive terminal
 * and auto-deny in --print mode. Exclude them from warm and cold launches alike.
 *
 * The host CLI (Claude Code) also ships a cloud "routines"/`schedule` skill backed
 * by CronCreate and RemoteTrigger. They create/launch cloud remote agents with
 * NO browser and no access to the user's logged-in sessions — and the user cannot
 * see or manage them inside Harness. Scheduling must go through Harness's native
 * `create_automation` instead (local execution, inherits the chat's tools incl. the
 * authenticated browser, visible in the Automations UI).
 *
 * This constant is the single source of truth. It is enforced authoritatively in
 * `ClaudeCliAdapter.buildArgs()` (which every process launch — cold, warm-start,
 * resume, replay, continuity-recovery — passes through), so the guarantee cannot be
 * bypassed by a spawn path that forgets to wire `disallowedTools`. It is also folded
 * into `buildToolPermissionConfig()` for the cold-spawn path's explicit denylist.
 *
 * `CronCreate` is the creation tool; `RemoteTrigger` launches a routine run. The
 * read-only `CronList`/`CronDelete` are intentionally NOT blocked so an agent can
 * still inspect or clean up any pre-existing cloud routines.
 */
export const DEFAULT_DISALLOWED_TOOLS: readonly string[] = [
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'CronCreate', 'RemoteTrigger',
];
