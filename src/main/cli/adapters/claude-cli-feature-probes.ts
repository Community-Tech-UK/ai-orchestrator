import type { ChildProcess } from 'child_process';
import { getCliDetectionService } from '../cli-detection';
export { CLAUDE_CLI_FEATURE_FLOORS } from '../../../shared/utils/cli-version-floors';

/** The optional, version-dependent prompt-cache optimization flag. */
export const EXCLUDE_DYNAMIC_SECTIONS_FLAG = '--exclude-dynamic-system-prompt-sections';

/**
 * Whether a `claude --help` output advertises the exclude-dynamic-sections flag.
 *
 * The flag is a recent prompt-cache optimization. Older CLI builds can reject it
 * with `error: unknown option '--exclude-dynamic-system-prompt-sections'`.
 * Probing `--help` is version-agnostic and machine-local, so each adapter only
 * passes the flag to a CLI that actually accepts it.
 */
export function helpAdvertisesExcludeDynamicSections(helpOutput: string): boolean {
  return helpOutput.includes(EXCLUDE_DYNAMIC_SECTIONS_FLAG);
}

export const EXCLUDE_DYNAMIC_MIN_VERSION = '2.1.268';
export const RECORDED_PROMPT_MIN_VERSION = '2.1.267';

function parseVersion(version: string | undefined | null): number[] | null {
  return version && /^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : null;
}

export function isVersionAtLeast(version: string | undefined | null, minimumVersion: string): boolean {
  const current = parseVersion(version);
  const minimum = parseVersion(minimumVersion);
  if (!current || !minimum) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== minimum[index]) return current[index] > minimum[index];
  }
  return true;
}

export function isKnownOlderThan(version: string | undefined | null, minimumVersion: string): boolean {
  return !!parseVersion(version) && !!parseVersion(minimumVersion) && !isVersionAtLeast(version, minimumVersion);
}

/** One fallback for main-process callers; workers probe their machine when it returns null. */
export function resolveClaudeCliVersion(adapterVersion: string | undefined | null): string | null {
  if (parseVersion(adapterVersion)) return adapterVersion!;
  try {
    const detected = getCliDetectionService().peekCachedResult()?.detected.find(entry => entry.name === 'claude')?.version;
    return parseVersion(detected) ? detected! : null;
  } catch { return null; }
}

export function detectExcludeDynamicSectionsSupport(
  spawnHelpProcess: () => ChildProcess,
  timeoutMs = 5000,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (supported: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(supported);
    };

    // Armed before the spawn so finish() can always clear it, including when
    // spawnHelpProcess() throws. It only touches `proc` after the deadline, by
    // which point finish() has either cleared it or `proc` has been assigned.
    const timeoutHandle = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      finish(false);
    }, timeoutMs);

    let proc: ChildProcess;
    try {
      proc = spawnHelpProcess();
    } catch {
      finish(false);
      return;
    }

    let output = '';
    proc.stdout?.on('data', (data) => { output += data.toString(); });
    proc.stderr?.on('data', (data) => { output += data.toString(); });
    proc.on('close', () => finish(helpAdvertisesExcludeDynamicSections(output)));
    proc.on('error', () => finish(false));
  });
}
