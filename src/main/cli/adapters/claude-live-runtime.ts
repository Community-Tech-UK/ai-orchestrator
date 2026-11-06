/**
 * Claude live runtime switch (A8.3, Step 14d).
 *
 * `set_model` / `apply_flag_settings` on the resident session, verified by
 * `get_settings` before anything is committed. Any error, refusal (including a
 * PreModelSwitch hook), timeout or mismatch returns `{ok:false}` so the caller
 * falls back to restart-from-summary. The exact effort key (`effortLevel`) is
 * inferred from the CLI binary; Live check 4 pins it.
 */

import { getLogger } from '../../logging/logger';
import type { ClaudeControlReply } from './claude-control-channel';

const logger = getLogger('ClaudeLiveRuntime');

export interface LiveRuntimeChange {
  model?: string;
  effort?: string | null;
}

export interface LiveRuntimeHost {
  requestControl(
    subtype: string,
    fields: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ClaudeControlReply>;
  /** Called only after every step verified — commit the switch. */
  commit(model: string | undefined, effort: string | null | undefined): void;
}

export type LiveRuntimeResult = { ok: true } | { ok: false; reason: string };

const STEP_TIMEOUT_MS = 10_000;

/** Trim, lower-case, drop a trailing `[...]` context suffix and a `-YYYYMMDD` date. */
export function cleanModelId(value: string): string {
  return stripContextSuffix(value.trim().toLowerCase()).replace(/-\d{8}$/, '');
}

/**
 * Same result as `.replace(/\[.*\]$/, '')` in linear time. That regex retries
 * from every `[` and rescans to the end each time, so a reply made of many `[`
 * cost seconds. `.` does not cross a line terminator, so the cut point is the
 * first `[` after the last line terminator, and only when the value ends in `]`.
 */
function stripContextSuffix(value: string): string {
  const last = value.length - 1;
  if (last < 1 || value.charCodeAt(last) !== 0x5d /* ] */) return value;
  let from = 0;
  for (let i = last - 1; i >= 0; i--) {
    const code = value.charCodeAt(i);
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) {
      from = i + 1;
      break;
    }
  }
  const open = value.indexOf('[', from);
  return open === -1 ? value : value.slice(0, open);
}

/** Normalize concrete IDs; family matching is only valid for an unversioned alias. */
function modelMatches(applied: unknown, desired: string): boolean {
  if (typeof applied !== 'string') return false;
  const a = cleanModelId(applied);
  const d = cleanModelId(desired);
  if (a === d) return true;
  const alias = /^(?:claude-)?(opus|sonnet|haiku)$/;
  const aAlias = alias.exec(a)?.[1];
  const dAlias = alias.exec(d)?.[1];
  // Modern IDs place the family first; legacy IDs place the version first.
  const family = (value: string): string | undefined =>
    alias.exec(value)?.[1]
    ?? /^claude-(?:\d+(?:-\d+)*-)?(opus|sonnet|haiku)(?:-\d+(?:-\d+)*)?$/.exec(value)?.[1];
  return Boolean((aAlias && aAlias === family(d)) || (dAlias && dAlias === family(a)));
}

function effortMatches(applied: unknown, desired: string): boolean {
  return typeof applied === 'string' && applied.trim().toLowerCase() === desired.trim().toLowerCase();
}

export async function applyClaudeLiveRuntime(
  host: LiveRuntimeHost,
  change: LiveRuntimeChange,
): Promise<LiveRuntimeResult> {
  // The live flag protocol has no verified provider-default reset. Fall back
  // before changing either setting so replay can clear the spawn-time effort.
  if (change.effort === null) {
    return { ok: false, reason: 'Provider-default effort requires restarting the Claude session.' };
  }
  if (change.model !== undefined) {
    const reply = await host.requestControl('set_model', { model: change.model }, STEP_TIMEOUT_MS);
    if (!reply.ok) {
      return { ok: false, reason: `set_model ${reply.code}: ${reply.message}` };
    }
  }
  if (change.effort !== undefined && change.effort !== null) {
    const reply = await host.requestControl(
      'apply_flag_settings',
      { settings: { effortLevel: change.effort } },
      STEP_TIMEOUT_MS,
    );
    if (!reply.ok) {
      return { ok: false, reason: `apply_flag_settings ${reply.code}: ${reply.message}` };
    }
  }

  const settings = await host.requestControl('get_settings', {}, STEP_TIMEOUT_MS);
  if (!settings.ok) {
    return { ok: false, reason: `get_settings ${settings.code}: ${settings.message}` };
  }
  const applied = (settings.payload as { applied?: Record<string, unknown> }).applied ?? {};
  if (change.model !== undefined && !modelMatches(applied['model'], change.model)) {
    return {
      ok: false,
      reason: `the CLI reports model ${String(applied['model'])} after switching to ${change.model}`,
    };
  }
  if (change.effort !== undefined && change.effort !== null
    && !effortMatches(applied['effort'], change.effort)) {
    return {
      ok: false,
      reason: `the CLI reports effort ${String(applied['effort'])} after switching to ${change.effort}`,
    };
  }
  host.commit(change.model, change.effort ?? undefined);
  logger.info('Claude live runtime switch verified', {
    model: change.model,
    effort: change.effort,
  });
  return { ok: true };
}
