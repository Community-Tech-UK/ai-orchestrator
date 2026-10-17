/** Older OpenCode 2 releases ignore per-session config overlays. */
export const MIN_SUPPORTED_OPENCODE_2_VERSION = '2.0.30';

/** Pure and self-contained: also serialized into portable account login scripts. */
export function supportedOpenCodeMajor(text: string): 1 | 2 | undefined {
  const match = /(?:^|\s)v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?=\s|$)/.exec(text.trim());
  if (!match) return undefined;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  if (major === 1) return 1;
  if (major === 2 && (minor! > 0 || patch! >= 30)) return 2;
  return undefined;
}
