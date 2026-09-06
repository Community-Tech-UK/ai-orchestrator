/**
 * Decides whether a tool call's `arguments` object carries anything worth
 * hashing for repeat detection.
 *
 * ACP agents (Copilot, Cursor, Grok) describe a tool call with a `kind`
 * discriminator (`'read'`, `'search'`, `'execute'`, …) plus an optional
 * `rawInput`. Cursor sends `rawInput: {}` for its grep and Read File tools and
 * only populates it for `execute` (live probe of `cursor-agent acp`,
 * 2026-09-05). `AcpCliAdapter` therefore emits `{ kind: 'search' }` for every
 * grep, and anything that hashes those arguments concludes that every grep in
 * the session was the same call. That is exactly what parked loop
 * `loop-1788631546543-593083f8`: Signal G reported "Read File called 78×",
 * Signal I reported "grep returned the same result hash 21×", and the
 * `DoomLoopDetector` raised `repeat-no-progress` — none of it real.
 *
 * "Uncaptured" is deliberately narrow: an object whose only keys are the ACP
 * `kind` string and/or an empty `rawInput` record. A plain `{}` from a
 * non-ACP adapter keeps hashing as before, so a genuinely argument-less tool
 * called repeatedly is still visible to the detectors.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns the arguments when they carry material that can distinguish one
 * call from another, or `undefined` when the adapter exposed nothing beyond an
 * ACP `kind` discriminator. Callers hash the return value; an `undefined`
 * result means "do not hash, fail open".
 */
export function readCapturedToolArguments(
  args: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(args)) return undefined;
  const keys = Object.keys(args);
  if (keys.length === 0) return args;
  const kind = args['kind'];
  if (typeof kind !== 'string') return args;
  for (const key of keys) {
    if (key === 'kind') continue;
    if (key === 'rawInput') {
      const rawInput = args[key];
      if (isRecord(rawInput) && Object.keys(rawInput).length === 0) continue;
      return args;
    }
    return args;
  }
  return undefined;
}
