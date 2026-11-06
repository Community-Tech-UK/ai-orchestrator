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
 *
 * macOS refuses a sandbox inside a sandbox, and Chromium's own sandbox is one.
 * Inside the fence a test browser launched with its sandbox on dies with
 * "sandbox initialization failed: Operation not permitted", so Playwright's
 * Chromium builds alone start outside the fence, where they can sandbox
 * themselves. Everything else a session runs stays fenced. This guards against
 * the accident above, not a session determined to leave: anything copied into
 * those folders would start outside the fence too.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';

export const SIGNAL_FENCE_EXEC = '/usr/bin/sandbox-exec';

/** Every program inside Playwright's downloaded Chromium builds, as a Seatbelt regex. */
export const PLAYWRIGHT_CHROMIUM_PATTERN = [
  `^${os.homedir().replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')}`,
  '/Library/Caches/ms-playwright/chromium(_headless_shell)?-[0-9]+/',
].join('');

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
  `(allow process-exec (regex #"${PLAYWRIGHT_CHROMIUM_PATTERN}") (with no-sandbox))`,
  '',
].join('\n');

/**
 * macOS starts a sandbox inside a sandbox only when both compile to the same
 * rules. A process already inside a different one (a dev app or test run
 * started from a session on an older fence) would have every CLI refused, and
 * is already fenced anyway. Any other failure stays for the real spawn to report.
 */
export function isRefusedAsNested(result: { status: number | null; stderr?: string | null }): boolean {
  return result.status !== 0 && result.stderr?.includes('sandbox_apply: Operation not permitted') === true;
}

let available: boolean | undefined;

export function isSignalFenceAvailable(): boolean {
  available ??= process.platform === 'darwin' && fs.existsSync(SIGNAL_FENCE_EXEC) && !isRefusedAsNested(
    spawnSync(SIGNAL_FENCE_EXEC, ['-p', SIGNAL_FENCE_POLICY, '--', '/usr/bin/true'], { encoding: 'utf8', timeout: 5_000 }),
  );
  return available;
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
