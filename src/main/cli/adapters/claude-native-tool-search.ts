/**
 * A17 / backlog 17.3 — detect whether Claude's own deferred tool search
 * (`ENABLE_TOOL_SEARCH`) is active for a spawn.
 *
 * When it is, Harness's MCP tool surfaces should be listed eagerly: Claude's
 * own `ToolSearch` hides them until asked for, so Harness must not ALSO hide
 * them behind `browser_tool_search` / `orchestrator_tool_search` — the double
 * layer costs the model two extra reveal turns every time. When detection says
 * `'off'` or `'unknown'`, the existing deferral settings win unchanged.
 *
 * `claudeNativeToolSearch` is pure: every input is explicit. Precedence for
 * `ENABLE_TOOL_SEARCH` and `ANTHROPIC_BASE_URL` is the spawn env first, then
 * the `env` block of the Claude settings file that session uses (see
 * `readClaudeSettingsEnv`), then the process env. Only `'true'` and `'auto:0'`
 * guarantee deferral (`auto` / `auto:N` with a larger N defers only past a
 * size threshold), so everything else is `'unknown'` and treated as off.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ClaudeNativeToolSearchState = 'on' | 'off' | 'unknown';

export interface ClaudeNativeToolSearchInput {
  /** Model name for this spawn; `haiku` never supports tool search. */
  model?: string;
  /** The spawn env (highest precedence). */
  env?: Record<string, string | undefined>;
  /** The `env` block of the Claude settings file this session uses. */
  settingsEnv?: Record<string, string | undefined>;
  /** Lowest precedence; production relies on `env` carrying the process env. */
  processEnv?: Record<string, string | undefined>;
}

export function claudeNativeToolSearch(
  input: ClaudeNativeToolSearchInput,
): ClaudeNativeToolSearchState {
  const lookup = (key: string): string | undefined =>
    input.env?.[key] ?? input.settingsEnv?.[key] ?? input.processEnv?.[key];

  const flag = lookup('ENABLE_TOOL_SEARCH')?.trim().toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'off') return 'off';

  const model = input.model?.trim().toLowerCase();
  if (model && model.includes('haiku')) return 'off';

  const baseUrl = lookup('ANTHROPIC_BASE_URL')?.trim();
  if (baseUrl && !isAnthropicHost(baseUrl) && flag !== 'true') return 'off';

  if (flag === 'true' || flag === 'auto:0') return 'on';
  return 'unknown';
}

/**
 * Read the `env` block of the Claude settings file a session with this spawn
 * env uses: `$CLAUDE_CONFIG_DIR/settings.json` for account-pool profiles
 * (the `claude-cli-profiles` directory homes, which carry the same env keys),
 * else `~/.claude/settings.json`. Fail-soft: any problem reads as `{}`.
 */
export function readClaudeSettingsEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const configDir = env['CLAUDE_CONFIG_DIR']?.trim() || join(homedir(), '.claude');
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
      env?: Record<string, unknown>;
    };
    const block = parsed?.env;
    if (!block || typeof block !== 'object') return {};
    const out: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(block)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Production detection at the final Claude MCP config seam, after account
 * routing. Explicit spawn env wins, then that profile's settings, then the
 * remaining ambient environment. Harness never sets ENABLE_TOOL_SEARCH here.
 */
export function detectClaudeNativeToolSearch(
  model?: string,
  env: Record<string, string | undefined> = {},
  processEnv: Record<string, string | undefined> = process.env,
): ClaudeNativeToolSearchState {
  return claudeNativeToolSearch({
    model,
    env,
    settingsEnv: readClaudeSettingsEnv({ ...processEnv, ...env }),
    processEnv,
  });
}

function isAnthropicHost(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'anthropic.com' || hostname.endsWith('.anthropic.com');
  } catch {
    return false;
  }
}
