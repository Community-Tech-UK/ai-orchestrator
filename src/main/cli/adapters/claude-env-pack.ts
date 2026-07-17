/**
 * WS14 — Claude CLI hygiene env/flag pack.
 *
 * Verified against the installed CLI (2.1.211, macOS arm64) via binary-string
 * search on 2026-07-17:
 * - `DISABLE_UPDATES`, `CLAUDE_CODE_TMPDIR`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`
 *   are all present and supported.
 * - No stream-idle / watchdog env vars exist in the binary's `CLAUDE_CODE_*`
 *   namespace — the plan's "watchdog vars" item is verified-unsupported and
 *   deliberately omitted (env vars stay in agreement with app-side thresholds
 *   by NOT pretending the CLI honours any).
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

/**
 * Apply the hygiene vars to a spawn env in place. Caller-provided values are
 * never clobbered. The per-session tmp dir is created eagerly; if creation
 * fails the var is skipped (fail-soft — the CLI falls back to the system tmp).
 */
export function applyClaudeHygieneEnv(
  env: Record<string, string>,
  sessionId?: string,
): void {
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
