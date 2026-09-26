/**
 * Signal fence for provider CLI processes (macOS Seatbelt).
 *
 * A session's own shell can otherwise `pkill -f "opencode acp"` (or the same
 * for grok, codex, claude, …) and SIGTERM every other live provider process
 * on the machine. That is what killed instance itym7sgg8 on 2026-09-26: a
 * sibling OpenCode subagent's probe ran `pkill -f "opencode acp"` and the
 * pattern matched the in-flight session.
 *
 * The fence is allow-by-default with signals limited to the sandboxed tree.
 * A tool can still kill the processes it spawned (`target same-sandbox`).
 * It cannot signal a sibling session. The unsandboxed parent (Harness) can
 * still SIGTERM the CLI for a real shutdown. Hardened mode already denies
 * cross-sandbox signals via its deny-default policy, so this wrap is only
 * for spawns that are not already jailed.
 */

import * as fs from 'node:fs';

export const SIGNAL_FENCE_EXEC = '/usr/bin/sandbox-exec';

/**
 * Allow everything the CLI already does, except signalling a process that
 * is not this sandbox. `(target children)` covers a direct `kill` of a
 * child; `(target same-sandbox)` covers `pkill` from a grandchild, which
 * sees its siblings rather than its own children.
 */
export const SIGNAL_FENCE_POLICY = [
  '(version 1)',
  '(allow default)',
  '(deny signal)',
  '(allow signal (target self))',
  '(allow signal (target children))',
  '(allow signal (target same-sandbox))',
  '',
].join('\n');

export function isSignalFenceAvailable(): boolean {
  return process.platform === 'darwin' && fs.existsSync(SIGNAL_FENCE_EXEC);
}

export interface FencedSpawn {
  command: string;
  args: string[];
}

/**
 * Wrap a CLI spawn so its descendants cannot signal processes outside the
 * sandbox. No-op when disabled or when Seatbelt is unavailable, so Linux,
 * Windows, and tests that pass `enabled: false` keep the raw command.
 */
export function applySignalFence(params: {
  command: string;
  args: readonly string[];
  enabled?: boolean;
}): FencedSpawn {
  const enabled = params.enabled ?? isSignalFenceAvailable();
  if (!enabled) {
    return { command: params.command, args: [...params.args] };
  }
  return {
    command: SIGNAL_FENCE_EXEC,
    args: ['-p', SIGNAL_FENCE_POLICY, '--', params.command, ...params.args],
  };
}

/** The CLI command inside a fence wrap, or the spawn itself when unfenced. */
export function unwrapSignalFence(command: string, args: readonly string[]): FencedSpawn {
  if (command !== SIGNAL_FENCE_EXEC) {
    return { command, args: [...args] };
  }
  const sep = args.lastIndexOf('--');
  if (sep < 0 || sep + 1 >= args.length) {
    return { command, args: [...args] };
  }
  const inner = args.slice(sep + 1);
  return { command: inner[0] ?? command, args: inner.slice(1) };
}
