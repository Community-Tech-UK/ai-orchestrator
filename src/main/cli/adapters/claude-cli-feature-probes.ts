import type { ChildProcess } from 'child_process';

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

export function isVersionAtLeast(version: string | undefined, minimumVersion: string): boolean {
  if (!version || version === 'unknown') {
    return false;
  }

  const currentParts = version.split('.').map((part) => Number.parseInt(part, 10));
  const minimumParts = minimumVersion.split('.').map((part) => Number.parseInt(part, 10));
  const maxLength = Math.max(currentParts.length, minimumParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const currentPart = Number.isFinite(currentParts[index]) ? currentParts[index] : 0;
    const minimumPart = Number.isFinite(minimumParts[index]) ? minimumParts[index] : 0;
    if (currentPart > minimumPart) {
      return true;
    }
    if (currentPart < minimumPart) {
      return false;
    }
  }

  return true;
}

export function detectExcludeDynamicSectionsSupport(
  spawnHelpProcess: () => ChildProcess,
  timeoutMs = 5000,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const finish = (supported: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve(supported);
    };

    let proc: ChildProcess;
    try {
      proc = spawnHelpProcess();
    } catch {
      finish(false);
      return;
    }

    timeoutHandle = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      finish(false);
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (data) => { output += data.toString(); });
    proc.stderr?.on('data', (data) => { output += data.toString(); });
    proc.on('close', () => finish(helpAdvertisesExcludeDynamicSections(output)));
    proc.on('error', () => finish(false));
  });
}
