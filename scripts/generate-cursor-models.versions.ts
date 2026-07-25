/**
 * Version parsing + comparison for `generate-cursor-models.ts`.
 *
 * Split out of the script so it can be unit-tested: the script itself calls
 * `main()` at module scope (spawning the Cursor CLI and rewriting
 * provider.types.ts), so it cannot be imported from a spec.
 */

/** Compare two `[major, minor]` tuples; returns >0 when `a` is newer. */
export function compareVersion(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Pick the id with the newest version among `ids` for which `versionOf` returns
 * a non-null tuple. Deterministic: ties keep the first-seen id. Pure — the
 * label is derived from the winning id afterwards (never as an iteration
 * side-effect, which would capture the last match rather than the newest).
 */
export function pickNewest(
  ids: string[],
  versionOf: (id: string) => number[] | null,
): string | null {
  let best: { id: string; version: number[] } | null = null;
  for (const id of ids) {
    const version = versionOf(id);
    if (!version) continue;
    if (!best || compareVersion(version, best.version) > 0) {
      best = { id, version };
    }
  }
  return best?.id ?? null;
}

/**
 * Three Opus id shapes have shipped: `claude-opus-4-8-...` (major-minor),
 * `claude-opus-5-...` (major-only — Anthropic dropped the minor segment for the
 * 5 generation), and `claude-4.6-opus-...`.
 *
 * The minor segment must therefore be OPTIONAL: requiring it made
 * `claude-opus-5-thinking-high` unparseable, so it was silently dropped from
 * the candidate set and the generator kept reporting Opus 4.8 as "newest"
 * (with a cheerful "up to date" message).
 */
export function opusVersion(id: string): number[] | null {
  const m = id.match(/opus-(\d+)(?:-(\d+))?/) ?? id.match(/(\d+)(?:\.(\d+))?-opus/);
  if (!m) return null;
  return m[2] === undefined ? [Number(m[1])] : [Number(m[1]), Number(m[2])];
}

/** `[4, 8]` -> "Opus 4.8"; `[5]` -> "Opus 5". */
export function formatOpusName(version: number[]): string {
  return version.length > 1 ? `Opus ${version[0]}.${version[1]}` : `Opus ${version[0]}`;
}
