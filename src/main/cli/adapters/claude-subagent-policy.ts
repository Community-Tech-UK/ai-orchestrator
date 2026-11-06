/**
 * Claude helper-agent policy (A18, Phase 1 Step 2).
 *
 * Two fixed rules and one model lever for Claude's own helper agents:
 * - When explicitly enabled after fork-cache proof, the waiting rule (a
 *   `--append-subagent-system-prompt-file` file) tells subagents to check in
 *   at least every four minutes while they wait for
 *   a long command, so its cheap cached memory does not expire.
 * - The reviewer rule (a `claude-helper-rules` system-prompt block) tells a
 *   main session to give review/verify/check helpers its own model family.
 * - `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` moves Claude's built-in
 *   general-purpose (and catch-all) helper agents to Sonnet. Since CLI
 *   2.1.251 the variable is only a default: an agent definition's `model:`
 *   and an explicit per-spawn model still win, so James's own agents and
 *   forks keep their models. Never set `_FORCE` (that would override them).
 *
 * Trial (choice 4): under `'trial'` a session's group comes from the last hex
 * digit of its native session id — '0'-'7' run helpers on Sonnet, '8'-'f' run
 * them same-as-session. The group is fixed for the session's life and is
 * written to the session-policy log. Sessions with no id at spawn get no
 * change and are left out of the analysis.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isVersionAtLeast } from './claude-cli-feature-probes';

/** `CLAUDE_CODE_SUBAGENT_MODEL` became a default (not an override) in 2.1.251.
 *  On an older CLI the variable would also move James's own agents and forks,
 *  so it is never sent below this version or when the version is unknown. */
export const CLAUDE_SUBAGENT_MODEL_MIN_VERSION = '2.1.251';

/** The documented `--append-subagent-system-prompt-file` form arrived in
 *  2.1.261 (CHANGELOG.md:2438). The plain (non-file) flag exists but is
 *  hidden and marked internal; this plan uses the documented form only. */
export const CLAUDE_SUBAGENT_PROMPT_FILE_MIN_VERSION = '2.1.261';

/** Fork cache sharing has not passed its live ship gate. Keep production off. */
export const CLAUDE_SUBAGENT_WAITING_RULE_ROLLOUT = false;

/** The waiting rule prepared for opted-in subagents (plan Step 2 item 4; fixed text,
 *  so it stays in the prompt cache). */
export const CLAUDE_SUBAGENT_WAITING_RULE =
  'When you wait for a command that may take longer than two minutes, wait at most four minutes at a time, then check its progress before waiting again. For example, start the full test run in the background, check its output after four minutes, and repeat until it finishes.';

/** The reviewer rule sent to Claude main sessions (plan Step 2 item 5). */
export const CLAUDE_HELPER_REVIEWER_RULE =
  'When you start a helper agent to review, verify or check finished work, give it the same model family you are running on, for example "opus".';

export type ClaudeHelperAgentModelSetting = 'parent' | 'sonnet' | 'trial';

/** Trial group for a session, fixed for its life. */
export type ClaudeSubagentArm = 'same-as-session' | 'sonnet';

/**
 * Half-and-half split from the last hex digit of the native session id
 * (the id Harness passes as `--session-id` or `--resume`):
 * '0'-'7' → Sonnet helpers, '8'-'f' → same-as-session. Written down here so
 * the trial report and the logs agree on the split.
 */
export function claudeSubagentArmForSession(nativeSessionId: string): ClaudeSubagentArm {
  const last = nativeSessionId.trim().toLowerCase().slice(-1);
  return /^[0-7]$/.test(last) ? 'sonnet' : 'same-as-session';
}

/** True when the session model is known to be a cheap tier (Sonnet or Haiku),
 *  where moving helpers to Sonnet saves nothing. Unknown models count as
 *  expensive (the guard is best-effort). */
export function isCheapSessionModel(sessionModel: string | undefined | null): boolean {
  if (!sessionModel) return false;
  const name = sessionModel.toLowerCase();
  return name.includes('sonnet') || name.includes('haiku');
}

export interface ResolveClaudeSubagentEnvInput {
  setting: ClaudeHelperAgentModelSetting;
  /** The session's model; nothing changes for known Sonnet/Haiku sessions. */
  sessionModel?: string | undefined;
  /** Resolved Claude CLI version (`resolveClaudeCliVersion(...)`), or null. */
  cliVersion: string | null;
  /** Trial group; null when the spawn has no native session id. */
  arm?: ClaudeSubagentArm | null;
  /** The spawn env, checked for the caller's own choice. */
  env?: Record<string, string> | undefined;
}

/**
 * Resolve `CLAUDE_CODE_SUBAGENT_MODEL` for a Claude spawn. Returns an empty
 * map when nothing should change. Caller values always win: if the variable
 * (or its `_FORCE` sibling) is already set in the spawn env or in Harness's
 * own environment, nothing is returned. `_FORCE` is never set here.
 */
export function resolveClaudeSubagentEnv(input: ResolveClaudeSubagentEnvInput): Record<string, string> {
  const { setting, sessionModel, cliVersion, arm = null, env } = input;

  // Version gate: unknown or older CLIs get nothing (an older CLI would also
  // move James's own agents and forks, which name their own models only on
  // newer CLIs).
  if (!isVersionAtLeast(cliVersion, CLAUDE_SUBAGENT_MODEL_MIN_VERSION)) return {};

  // Expensive sessions only: a Sonnet/Haiku session has nothing to gain.
  if (isCheapSessionModel(sessionModel)) return {};

  // James's choice wins, in the spawn env or in Harness's own environment.
  const spawnEnv = env ?? {};
  if ('CLAUDE_CODE_SUBAGENT_MODEL' in spawnEnv || 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE' in spawnEnv) return {};
  if (process.env['CLAUDE_CODE_SUBAGENT_MODEL'] || process.env['CLAUDE_CODE_SUBAGENT_MODEL_FORCE']) return {};

  const wantsSonnet =
    setting === 'sonnet' || (setting === 'trial' && arm === 'sonnet');
  if (!wantsSonnet) return {};
  return { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' };
}

/**
 * `--append-subagent-system-prompt-file` args for a spawn: only on 2.1.261 or
 * newer (the documented form), nothing when the version is unknown or older.
 */
export function resolveClaudeSubagentPromptArgs(
  cliVersion: string | null,
  ruleFilePath: string,
  enabled = CLAUDE_SUBAGENT_WAITING_RULE_ROLLOUT,
): string[] {
  if (!enabled || !isVersionAtLeast(cliVersion, CLAUDE_SUBAGENT_PROMPT_FILE_MIN_VERSION)) return [];
  return ['--append-subagent-system-prompt-file', ruleFilePath];
}

let waitingRuleFilePath: string | null = null;

/**
 * Materialize the fixed waiting rule once per app run into a private temp
 * folder (mode 0600), and return the path every spawn points at. The rule is
 * fixed text, so one cache write per subagent then cheap reads. Writes are
 * fail-soft: a write failure returns null and the spawn omits the flag.
 */
export function materializeSubagentWaitingRuleFile(): string | null {
  if (waitingRuleFilePath) return waitingRuleFilePath;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'aio-subagent-rule-'));
    const file = join(dir, 'waiting-rule.txt');
    writeFileSync(file, CLAUDE_SUBAGENT_WAITING_RULE, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    waitingRuleFilePath = file;
    return file;
  } catch {
    return null;
  }
}

export function _resetSubagentPolicyForTesting(): void {
  waitingRuleFilePath = null;
}
