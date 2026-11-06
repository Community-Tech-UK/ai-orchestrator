import { isVersionAtLeast } from './claude-cli-feature-probes';

/** Claude's successful-command output setting was introduced in this release. */
export const BASH_OUTPUT_MAX_CHARS_MIN_VERSION = '2.1.261';

/** Main has persisted settings; standalone workers may have no settings manager. */
function readSetting(key: string): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSettingsManager } = require('../../core/config/settings-manager') as {
      getSettingsManager: () => { get: (key: string) => unknown };
    };
    return getSettingsManager().get(key);
  } catch { return undefined; }
}

export function resolveClaudeBashOutputMaxChars(
  explicit?: number,
  read: (key: string) => unknown = readSetting,
): number | undefined {
  if (explicit !== undefined) return explicit === 0 ? undefined : explicit;
  const value = read('claudeBashOutputMaxChars');
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(128_000, Math.max(4_000, Math.floor(value))) : undefined;
}

export function claudeOutputCapSettings(cap: number | undefined, cliVersion: string | null): { bashOutputMaxChars?: number } {
  return typeof cap === 'number' && Number.isInteger(cap) && cap >= 4_000 && cap <= 128_000
    && isVersionAtLeast(cliVersion, BASH_OUTPUT_MAX_CHARS_MIN_VERSION) ? { bashOutputMaxChars: cap } : {};
}
