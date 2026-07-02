/**
 * D6 (#7) part 2 — canonical command matcher.
 *
 * Compares an agent's CLAIMED verify command against the loop's configured
 * `completion.verifyCommand` so equivalent invocations match and a narrowed
 * run can't masquerade as repo-green:
 *
 * - `pytest` ≡ `python -m pytest` ≡ `uv run pytest` (runner wrappers unwrap)
 * - `env CI=1 time pytest` → `pytest` (env/VAR=/time prefixes strip)
 * - `npm run lint && npm test` matches configured `npm test`
 *   (segment subsequence inside `&&` / `;` / `||`)
 * - `pytest tests/test_login.py` or `pytest -k login` vs configured `pytest`
 *   classifies as `'targeted'`, NOT `'full'` — one test file or a `-k` filter
 *   is not the whole suite.
 *
 * Pure module: no I/O, no state.
 */

export type ClaimedVerifyMatch = 'full' | 'targeted' | 'unrelated';

/** Env-style prefixes that never change what the command runs. */
const TRANSPARENT_PREFIXES = new Set(['env', 'time', 'command', 'nice']);

/**
 * Flags that narrow a runner's scope to a subset of tests. A claimed command
 * carrying one of these (or any extra positional arg — a path/selector) is a
 * `'targeted'` run relative to the configured command.
 */
const NARROWING_FLAGS = new Set([
  '-k',
  '-m',
  '-g',
  '-t',
  '--grep',
  '--filter',
  '--match',
  '--only',
  '--spec',
  '--file',
  '--scope',
  '--shard',
  '--testNamePattern',
  '--test-name-pattern',
  '--testPathPattern',
  '--testPathPatterns',
]);

/**
 * Extra positional tokens that do NOT narrow scope (`vitest run` is still the
 * full suite). Everything else positional is treated as a path/selector.
 */
const NEUTRAL_POSITIONALS = new Set(['run']);

/** Split a compound shell command into independently-runnable segments. */
export function splitCommandSegments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function basename(token: string): string {
  const idx = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return idx >= 0 ? token.slice(idx + 1) : token;
}

/**
 * Canonicalize one command segment into comparable tokens:
 * strip `VAR=` assignments and transparent prefixes, unwrap runner wrappers
 * (`python -m X`, `uv|poetry|pipenv run X`, `bundle|pnpm|yarn exec X`,
 * `npx X`), basename the executable, normalize `npm test` → `npm run test`,
 * and drop `--` separators.
 */
export function canonicalizeCommandSegment(segment: string): string[] {
  let tokens = segment.trim().split(/\s+/).filter((t) => t.length > 0 && t !== '--');

  for (;;) {
    const head = tokens[0];
    if (!head) return [];
    const exe = basename(head);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || TRANSPARENT_PREFIXES.has(exe)) {
      tokens = tokens.slice(1);
      continue;
    }
    if ((exe === 'python' || exe === 'python3') && tokens[1] === '-m' && tokens[2]) {
      tokens = tokens.slice(2);
      continue;
    }
    if ((exe === 'uv' || exe === 'poetry' || exe === 'pipenv') && tokens[1] === 'run' && tokens[2]) {
      tokens = tokens.slice(2);
      continue;
    }
    if ((exe === 'bundle' || exe === 'pnpm' || exe === 'yarn') && tokens[1] === 'exec' && tokens[2]) {
      tokens = tokens.slice(2);
      continue;
    }
    if ((exe === 'npx' || exe === 'pnpx') && tokens[1]) {
      // Drop npx and any of its own flags before the target binary.
      tokens = tokens.slice(1);
      while (tokens[0]?.startsWith('-')) tokens = tokens.slice(1);
      continue;
    }
    break;
  }

  if (tokens.length === 0) return tokens;
  const canonical = [basename(tokens[0]!), ...tokens.slice(1)];
  const exe = canonical[0]!;
  if ((exe === 'npm' || exe === 'pnpm' || exe === 'yarn') && (canonical[1] === 'test' || canonical[1] === 't')) {
    return [exe, 'run', 'test', ...canonical.slice(2)];
  }
  return canonical;
}

/**
 * Match one canonical claimed segment against one canonical configured
 * segment. `'full'` requires every configured token to appear in the claimed
 * segment (in order) with no scope-narrowing extras; extras that are paths,
 * selectors, or narrowing flags produce `'targeted'`; a different executable
 * or missing configured tokens produce `'unrelated'`.
 */
function matchSegment(claimed: string[], configured: string[]): ClaimedVerifyMatch {
  if (claimed.length === 0 || configured.length === 0) return 'unrelated';
  if (claimed[0] !== configured[0]) return 'unrelated';

  // Every configured token must appear in the claimed segment, in order.
  let searchFrom = 0;
  for (const token of configured) {
    const idx = claimed.indexOf(token, searchFrom);
    if (idx === -1) return 'unrelated';
    searchFrom = idx + 1;
  }

  // Multiset of claimed tokens not accounted for by the configured command.
  const remaining = [...claimed];
  for (const token of configured) {
    const idx = remaining.indexOf(token);
    if (idx !== -1) remaining.splice(idx, 1);
  }

  for (const token of remaining) {
    if (token.startsWith('-')) {
      const flagName = token.split('=')[0]!;
      if (NARROWING_FLAGS.has(flagName)) return 'targeted';
      // Unknown flags (-q, --reporter=dot, …) don't narrow scope.
      continue;
    }
    if (!NEUTRAL_POSITIONALS.has(token)) return 'targeted';
  }
  return 'full';
}

/**
 * Match a claimed verify command against the configured one.
 *
 * - `'full'`      — every configured segment is fully covered by some claimed
 *                   segment (canonically equivalent, no scope narrowing).
 * - `'targeted'`  — every configured segment is covered, but at least one only
 *                   by a narrowed run (specific file / `-k` filter / selector).
 * - `'unrelated'` — at least one configured segment has no counterpart at all.
 */
export function matchClaimedVerifyCommand(
  claimedCommand: string,
  configuredCommand: string,
): ClaimedVerifyMatch {
  const configured = splitCommandSegments(configuredCommand)
    .map(canonicalizeCommandSegment)
    .filter((s) => s.length > 0);
  const claimed = splitCommandSegments(claimedCommand)
    .map(canonicalizeCommandSegment)
    .filter((s) => s.length > 0);
  if (configured.length === 0 || claimed.length === 0) return 'unrelated';

  // A `cd <dir>` earlier in the claimed chain re-scopes every later segment
  // to a subdirectory — `cd packages/x && npm test` is NOT the configured
  // root-level `npm test`, it's a narrowed run. Conservatively cap any match
  // that sits after a `cd` at 'targeted' (even `cd` back to the root — the
  // matcher can't resolve paths, and a false 'targeted' only costs a re-run).
  const afterCd: boolean[] = [];
  let sawCd = false;
  for (const segment of claimed) {
    afterCd.push(sawCd);
    if (segment[0] === 'cd') sawCd = true;
  }

  let sawTargeted = false;
  for (const configuredSegment of configured) {
    let best: ClaimedVerifyMatch = 'unrelated';
    for (let i = 0; i < claimed.length; i++) {
      let match = matchSegment(claimed[i]!, configuredSegment);
      if (match === 'full' && afterCd[i]) match = 'targeted';
      if (match === 'full') {
        best = 'full';
        break;
      }
      if (match === 'targeted') best = 'targeted';
    }
    if (best === 'unrelated') return 'unrelated';
    if (best === 'targeted') sawTargeted = true;
  }
  return sawTargeted ? 'targeted' : 'full';
}
