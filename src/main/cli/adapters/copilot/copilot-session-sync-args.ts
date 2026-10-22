/**
 * The Copilot flag that keeps a Harness-owned session out of the account's
 * remote session sync.
 *
 * Copilot 1.0.103 retired `--remote`/`--no-remote`: given `--no-remote` it
 * prints "--no-remote was removed" and exits 1 before ACP `initialize`, so
 * every spawn — new sessions and history restores alike — dies at startup.
 * Its replacement, `--sync-session=off`, is rejected by 1.0.102 and older
 * ("unexpected argument"). With neither flag, 1.0.103 syncs by default.
 *
 * Copilot updates itself in place (the CLI updater runs `copilot update`), so
 * the installed version can change under a running app without its path
 * changing. The flag is therefore read from the installed CLI's own `--help`
 * at every spawn rather than cached.
 */

import { execFile } from 'child_process';
import { buildCliSpawnOptions } from '../../cli-environment';
import type { CopilotCliLaunchConfig } from '../../copilot-cli-launch';
import { getLogger } from '../../../logging/logger';
import { resolveWindowsSpawn } from '../windows-cli-spawn';

const logger = getLogger('CopilotSessionSyncArgs');

const HELP_PROBE_TIMEOUT_MS = 10_000;
const SESSION_SYNC_OFF_FLAGS = new Set(['--sync-session=off', '--no-remote']);

/** The session-sync-off flag a `copilot --help` text advertises, if any. */
export function selectCopilotSessionSyncOffArgs(helpText: string): string[] {
  // Lookahead, not `\b`: `--no-remote-export` must not count as `--no-remote`.
  if (/--sync-session(?![\w-])/.test(helpText)) return ['--sync-session=off'];
  if (/--no-remote(?![\w-])/.test(helpText)) return ['--no-remote'];
  return [];
}

/**
 * Ask the installed CLI which flag it accepts. Resolves `[]` (start without
 * one, logged) when the help text names neither or the probe fails: a flag the
 * CLI rejects stops the session from starting at all.
 */
export function probeCopilotSessionSyncOffArgs(launch: CopilotCliLaunchConfig): Promise<string[]> {
  return new Promise((resolve) => {
    const finish = (helpText: string, error: Error | null): void => {
      const flags = selectCopilotSessionSyncOffArgs(helpText);
      if (flags.length === 0) {
        logger.warn('Copilot CLI help names no session-sync-off flag; starting without one', {
          probeFailed: Boolean(error),
          ...(error ? { code: (error as NodeJS.ErrnoException).code ?? 'unknown' } : {}),
        });
      }
      resolve(flags);
    };
    try {
      const spawnOptions = buildCliSpawnOptions();
      // Same launcher resolution as the session spawn: on Windows the npm shim
      // runs shell-free, so a profile path with spaces cannot break the probe.
      const target = resolveWindowsSpawn(
        launch.command,
        [...launch.argsPrefix, '--help', '--no-auto-update'],
        Boolean(spawnOptions.shell),
        spawnOptions.env ?? process.env,
      );
      const child = execFile(
        target.command,
        target.args,
        { ...spawnOptions, shell: target.shell, encoding: 'utf8', timeout: HELP_PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => finish(`${stdout ?? ''}\n${stderr ?? ''}`, error),
      );
      // Nothing to answer: a `gh copilot` install prompt must not wait out the timeout.
      child.stdin?.end();
    } catch (error) {
      finish('', error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Build the adapter's `prepareSpawn`: put the probed flag into `args` (the
 * array the adapter spawns from) in place of any earlier one, then run the
 * private MCP config preparation when there is one.
 */
export function prepareCopilotSpawn(
  args: string[],
  launch: CopilotCliLaunchConfig,
  disableSessionSync: boolean,
  prepareMcpConfig?: () => () => void,
): () => Promise<() => void> {
  return async () => {
    for (let index = args.length - 1; index >= 0; index -= 1) {
      if (SESSION_SYNC_OFF_FLAGS.has(args[index])) args.splice(index, 1);
    }
    if (disableSessionSync) args.push(...await probeCopilotSessionSyncOffArgs(launch));
    return prepareMcpConfig?.() ?? (() => undefined);
  };
}
