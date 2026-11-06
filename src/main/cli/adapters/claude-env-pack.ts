import type { ClaudeCliSpawnOptions } from './claude-cli-adapter.types';
import { resolveClaudeCliVersion } from './claude-cli-feature-probes';
import { claudeSubagentArmForSession, resolveClaudeSubagentEnv, type ClaudeHelperAgentModelSetting } from './claude-subagent-policy';
/**
 * WS14 — Claude CLI hygiene env/flag pack.
 *
 * Verified against the installed CLI (2.1.296, macOS arm64), 10 Oct 2026:
 * - `DISABLE_UPDATES`, `CLAUDE_CODE_TMPDIR`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`
 *   are all present and supported.
 * - The stream watchdog is on by default since 2.1.196 (CHANGELOG.md:4179):
 *   it aborts and retries a stream silent for 5 minutes. Its switches are
 *   `CLAUDE_ENABLE_STREAM_WATCHDOG`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`, and
 *   `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS`. Harness sets none of them on purpose.
 *   Do not shorten Harness's own stall timers for Claude below 5 minutes
 *   without reading CHANGELOG.md:4179.
 *
 * Resume cache (10 Oct transcript scan): after edits/commits and a restart
 * within 55 minutes, 24 of 26 resumes read at least 90% of prior context from
 * cache (average 190K tokens); 34 of 34 without edits did so. All 82 resumes
 * after more than 55 minutes lost cache. Disabling git instructions offers
 * no measured gain and removes the git snapshot and built-in git safety rules,
 * so Harness does not set `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`.
 *
 * Machine-started sessions disable security-guidance through the settings
 * plugin overlay and `SECURITY_GUIDANCE_DISABLE`: its Stop hook performs an
 * additional git-diff model review. Interactive chats retain the plugin.
 *
 * Unknown env vars are inert to older CLIs, so version gating is unnecessary
 * for the vars we do set. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is nevertheless
 * gated behind a default-OFF setting: it scrubs env from CLI subprocesses,
 * and AIO's PreToolUse hook + RTK read `ORCHESTRATOR_*` vars from that same
 * subprocess env — enabling it blindly could break the approval flow. The
 * WS14 livetest flips the default only with evidence that hooks survive.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isInstanceTaskTools } from '../../instance/lifecycle/task-tools-scoping';

/** Add chat-only task tools to a fresh env overlay; explicit caller values win. */
export function applyClaudeTaskToolsEnv(env: Record<string, string>, instanceId?: string): void {
  if (isInstanceTaskTools(instanceId) && !('CLAUDE_CODE_ENABLE_TODO_TOOLS' in env)) {
    env['CLAUDE_CODE_ENABLE_TODO_TOOLS'] = '1';
  }
}

/** Fail-soft settings read, worker-safe (mirrors base-cli-adapter-degraded-output). */
function defaultReadSetting(key: string): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSettingsManager } = require('../../core/config/settings-manager') as {
      getSettingsManager: () => { get: (key: string) => unknown };
    };
    return getSettingsManager().get(key);
  } catch {
    return undefined;
  }
}

/** Injectable for tests — the lazy `require` above bypasses vitest's mock registry. */
let readSetting: (key: string) => unknown = defaultReadSetting;

export function _setSettingsReaderForTesting(reader: ((key: string) => unknown) | null): void {
  readSetting = reader ?? defaultReadSetting;
}

export function resolveClaudeHelperAgentModelSetting(): ClaudeHelperAgentModelSetting {
  const configured = readSetting('claudeHelperAgentModel');
  return configured === 'parent' || configured === 'sonnet' || configured === 'trial' ? configured : 'parent';
}

/**
 * Apply the hygiene vars to a spawn env in place. Caller-provided values are
 * never clobbered. The per-session tmp dir is created eagerly; if creation
 * fails the var is skipped (fail-soft — the CLI falls back to the system tmp).
 */
export function applyClaudeHygieneEnv(
  env: Record<string, string>,
  sessionId?: string,
  options?: ClaudeCliSpawnOptions,
): void {
  const setting = resolveClaudeHelperAgentModelSetting();
  const arm = sessionId ? claudeSubagentArmForSession(sessionId) : null;
  const subagentEnv = resolveClaudeSubagentEnv({ setting, sessionModel: options?.model,
    cliVersion: resolveClaudeCliVersion(null), arm, env });
  Object.assign(env, subagentEnv);
  if (options?.contextCeilingTokens && !('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in env)
      && process.env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'] === undefined) {
    env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'] = String(options.contextCeilingTokens);
  }
  if (options?.machineSession && !('SECURITY_GUIDANCE_DISABLE' in env)) env['SECURITY_GUIDANCE_DISABLE'] = '1';
  // Installed 2.1.304 changelog: depth (2.1.219), concurrency (2.1.217),
  // session spawn cap (2.1.212) and noninteractive forks (2.1.121).
  // Ordinary child helpers and reviewers intentionally keep native limits.
  const reason = options?.machineSession;
  if (reason === 'plan-queue' || reason === 'loop' || reason === 'automation') {
    const limits: Record<string, string> = {
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: reason === 'plan-queue' ? '1' : '2',
      CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: '60',
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '6',
      ...(reason !== 'automation' ? { CLAUDE_CODE_FORK_SUBAGENT: '0' } : {}),
    };
    for (const [key, value] of Object.entries(limits)) {
      if (!(key in env) && process.env[key] === undefined) env[key] = value;
    }
  }
  if (!('DISABLE_UPDATES' in env)) {
    env['DISABLE_UPDATES'] = '1';
  }

  if (!('CLAUDE_CODE_TMPDIR' in env)) {
    const tmpDir = path.join(os.tmpdir(), 'aio-claude-tmp', sessionId || 'shared');
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      env['CLAUDE_CODE_TMPDIR'] = tmpDir;
    } catch {
      // Fail-soft: the CLI uses the system tmp dir.
    }
  }

  if (!('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB' in env) && readSetting('claudeSubprocessEnvScrub') === true) {
    env['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'] = '1';
  }
}

/**
 * Resolve the `--fallback-model` value for a Claude spawn: an explicit spawn
 * option wins; otherwise the global `claudeFallbackModel` setting applies.
 * Empty/whitespace resolves to undefined (flag omitted).
 */
export function resolveClaudeFallbackModel(explicit?: string): string | undefined {
  const fromOption = explicit?.trim();
  if (fromOption) return fromOption;
  const fromSetting = readSetting('claudeFallbackModel');
  const trimmed = typeof fromSetting === 'string' ? fromSetting.trim() : '';
  return trimmed || undefined;
}

/**
 * Resolve whether a Claude spawn gets `--debug`: an explicit spawn option
 * wins; otherwise the global `claudeCliDebugLogging` setting applies.
 */
export function resolveClaudeDebugLogging(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return readSetting('claudeCliDebugLogging') === true;
}
