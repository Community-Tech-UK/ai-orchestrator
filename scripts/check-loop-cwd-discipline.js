#!/usr/bin/env node
/**
 * Loop cwd discipline checker for ai-orchestrator.
 *
 * A loop has TWO directories (see `src/main/orchestration/loop-cwd.ts`):
 *
 *   - state cwd      `workspaceCwd`                  — durable loop-owned state
 *   - execution cwd  `executionCwd ?? workspaceCwd`  — where the agent works
 *
 * Under `isolateLoopWorkspaces` they are ALWAYS different, and confusing them
 * is not a style problem — it is the defect that stopped every loop from
 * completing between 2026-06-30 and 2026-09-03. The completion gate spawned the
 * verify command in the repo root, so under isolation it graded other sessions'
 * uncommitted work, failed, and rejected every otherwise-approved completion.
 * No test caught it because no test asserted the spawn cwd.
 *
 * Five rules, each deliberately narrow so this stays a real gate rather than
 * background noise. Rules 2-4 were added by successive fresh-eyes reviews, each
 * after it found a live defect the existing rules could not see — the shape of
 * the misuse kept moving, so the rule set followed it:
 *
 *   1. INLINE RESOLUTION — nobody re-implements the fallback. The
 *      `executionCwd ?? workspaceCwd` expression must exist in exactly one
 *      place (`loop-cwd.ts`); everywhere else calls `loopExecutionCwd()`. A
 *      second copy is how the two drift apart. Matches only the fallback shape
 *      (operands adjacent), so legitimate isolation guards like
 *      `!executionCwd || samePath(executionCwd, workspaceCwd)` are not flagged.
 *   2. STATE-CWD-ALIAS — `const cwd = state.config.workspaceCwd`, then used
 *      further down. Binding it hides which directory the later code means.
 *   3. STATE-CWD-DESTRUCTURE — the same, reached via `const { workspaceCwd } = config`.
 *   4. STATE-CWD-POSITIONAL — the state cwd handed as a positional argument to
 *      something that watches, spawns, probes or diffs. This is how the
 *      `CompletedFileWatcher` watch root and two liveness probes escaped the
 *      keyed-property rules entirely.
 *   5. CONFIG-AS-CWD — a `cwd:` / `workingDirectory:` read straight off a
 *      LoopConfig (`config.workspaceCwd`, `state.config.workspaceCwd`) is
 *      almost certainly running a command in the wrong tree. Say which one you
 *      mean: `loopExecutionCwd(config)` or `loopStateCwd(config)`.
 *
 * Matching is whole-file, not line-by-line: the real call sites split the
 * function name and its `config.workspaceCwd` argument across lines, and a
 * per-line scan cannot see them together.
 *
 * Reviewer/param objects (`input.workspaceCwd`, `p.workspaceCwd`) are NOT
 * flagged: their caller already resolved the value, and re-resolving inside the
 * callee would be wrong.
 *
 * Run with: node scripts/check-loop-cwd-discipline.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** The one file allowed to implement the fallback. */
const CWD_HELPER_MODULE = 'src/main/orchestration/loop-cwd.ts';

/** Directories scanned. Loop cwd only has meaning in main-process loop code. */
const SCAN_DIRS = ['src/main'];

/**
 * @typedef {Object} CwdRule
 * @property {string} id
 * @property {RegExp} pattern    A line matching this is a violation.
 * @property {(rel: string) => boolean} [exempt] Files this rule ignores.
 * @property {string} message
 */

/** @type {CwdRule[]} */
const RULES = [
  {
    id: 'inline-resolution',
    // `executionCwd ?? workspaceCwd` / `executionCwd?.trim() || workspaceCwd`,
    // with or without a receiver prefix. Bounded to one line, no `;` crossing,
    // so it cannot run away across statements.
    // Only the FALLBACK shape: the two operands adjacent, separated by nothing
    // but an optional `?.trim()`. A wider window matched boolean guards like
    // `!executionCwd || samePath(executionCwd, input.workspaceCwd)`, which are
    // legitimate isolation checks, not a second copy of the resolution.
    pattern: /executionCwd(?:\?\.trim\(\))?\s*(?:\?\?|\|\|)\s*(?:[A-Za-z0-9_$]+\.)*workspaceCwd\b/,
    exempt: (rel) => rel === CWD_HELPER_MODULE,
    message:
      'Re-implements the execution-cwd fallback. Call loopExecutionCwd(config) from '
      + `${CWD_HELPER_MODULE} instead, so there is exactly one definition.`,
  },
  {
    // Added after a fresh-eyes review found `const cwd = state.config.workspaceCwd`
    // in `loop-context-survival.ts` — a real wrong-directory defect that both
    // rules below sailed past, because the misuse happened on a LATER line than
    // the read. Binding the state cwd to a local is the move that hides intent,
    // so require the author to name which cwd they mean at the binding.
    id: 'state-cwd-alias',
    pattern: /\b(?:const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*(?:[A-Za-z0-9_$]+\.)*config\.workspaceCwd\s*[;,]/,
    exempt: (rel) => rel === CWD_HELPER_MODULE,
    message:
      'Aliases the loop STATE cwd into a local, which hides which directory the '
      + 'later code actually means. Bind loopExecutionCwd(config) or loopStateCwd(config) instead.',
  },
  {
    // Same hazard as `state-cwd-alias`, reached by destructuring. A cycle-2
    // review confirmed the alias rule missed `const { workspaceCwd } = config`.
    // No file exploits it today; the rule keeps it that way.
    id: 'state-cwd-destructure',
    pattern: /\b(?:const|let|var)\s*\{[^}]*\bworkspaceCwd\b[^}]*\}\s*=\s*(?:[A-Za-z0-9_$]+\.)*config\b/,
    exempt: (rel) => rel === CWD_HELPER_MODULE,
    message:
      'Destructures the loop STATE cwd out of a config, which hides which directory '
      + 'the later code means. Bind loopExecutionCwd(config) or loopStateCwd(config) instead.',
  },
  {
    // Positional arguments are how the `CompletedFileWatcher` watch-root defect
    // (cycle 2, finding 1) escaped the keyed-property rules: the wrong cwd was
    // simply the first constructor argument. Flag the state cwd being handed to
    // anything whose name says it consumes a directory.
    id: 'state-cwd-positional',
    pattern: new RegExp(
      String.raw`(?:\bnew\s+[A-Za-z0-9_$]+|\b[A-Za-z0-9_$]*(?:Watcher|Spawn|spawn|exec|Exec|Runner|runIn|Probe|probe|Diff|diff)[A-Za-z0-9_$]*)\s*\(\s*(?:[A-Za-z0-9_$]+\.)*config\.workspaceCwd\s*[,)]`,
    ),
    exempt: (rel) => rel === CWD_HELPER_MODULE,
    message:
      'Passes the loop STATE cwd positionally into something that watches, spawns or '
      + 'diffs. Pass loopExecutionCwd(config) — or loopStateCwd(config) if the repo root '
      + 'really is intended.',
  },
  {
    // The ternary spelling of the fallback: `x.executionCwd ? x.executionCwd :
    // x.workspaceCwd`. Cycle 4 noted rule 1 only matches `??`/`||`.
    id: 'state-cwd-ternary',
    pattern: /\?\s*(?:[A-Za-z0-9_$]+\.)*executionCwd\s*:\s*(?:[A-Za-z0-9_$]+\.)*workspaceCwd\b/,
    exempt: (rel) => rel === CWD_HELPER_MODULE,
    message:
      'Re-implements the execution-cwd fallback as a ternary. Call loopExecutionCwd(config) '
      + `from ${CWD_HELPER_MODULE} instead.`,
  },
  {
    id: 'config-as-cwd',
    // `cwd: config.workspaceCwd` / `workingDirectory: state.config.workspaceCwd`
    // and the `this.config` / `foo.config` variants.
    pattern: /(?:cwd|workingDirectory)\s*:\s*(?:[A-Za-z0-9_$]+\.)*config\.workspaceCwd\b/,
    message:
      'Spawns/reads using the loop STATE cwd. Anything that executes or inspects the '
      + 'agent\'s work product must use loopExecutionCwd(config); if the state cwd really '
      + 'is intended, say so explicitly with loopStateCwd(config).',
  },
];

/**
 * Blank out comments while preserving every newline, so whole-file matching
 * still reports accurate line numbers. Necessary because these rules describe
 * the invariant in prose constantly — matching comment text would be pure noise.
 * Deliberately simple — it is not a lexer, so a `//` inside a string literal
 * (a URL) blanks the rest of that line. Known limitation: a violation placed
 * after a URL literal ON THE SAME LINE would be missed. Verified no such line
 * exists in `src/main`, and the trade is worth it — a real lexer here would be
 * far more code than the rule it serves.
 */
function stripComments(source) {
  return source
    // A block-comment opener must be at the start of the file or preceded by
    // whitespace or an opening delimiter. Without that guard, a glob inside a
    // string (`src/api/routes/*.ts`) opens a fake comment that runs to the next
    // `*/` anywhere later in the file — measured at 149 blanked source lines in
    // `orchestration-protocol.prompts.ts` alone, silencing every rule across
    // that span. A stray unstripped inline comment can at worst cause a false
    // positive, which fails safe for a guard; a runaway causes false negatives,
    // which does not.
    .replace(/(^|[\s(,;={[])\/\*[\s\S]*?\*\//g, (m, lead) => lead + m.slice(lead.length).replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

/** Recursively collect .ts files, skipping tests and build output. */
function collectSourceFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'dist') continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

function checkLoopCwdDiscipline() {
  const files = [];
  for (const dir of SCAN_DIRS) collectSourceFiles(path.join(ROOT, dir), files);

  let violations = 0;
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const raw = fs.readFileSync(file, 'utf8');
    // Whole-file matching, not line-by-line: the call sites that matter split a
    // function name and its `config.workspaceCwd` argument across lines, and a
    // per-line scan can never see them together. That blind spot is exactly how
    // two live liveness-probe defects survived the first two review rounds.
    const source = stripComments(raw);
    const rawLines = raw.split('\n');

    for (const rule of RULES) {
      if (rule.exempt?.(rel)) continue;
      const pattern = new RegExp(rule.pattern.source, 'g');
      for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
        const lineIndex = source.slice(0, match.index).split('\n').length - 1;
        console.error(
          `LOOP CWD VIOLATION [${rule.id}]\n`
          + `  File: ${rel}:${lineIndex + 1}\n`
          + `  Code: ${match[0].replace(/\s+/g, ' ').trim()}\n`
          + `  Line: ${(rawLines[lineIndex] ?? '').trim()}\n`
          + `  Rule: ${rule.message}\n`,
        );
        violations++;
        // A zero-length match would spin forever; defensive only.
        if (match.index === pattern.lastIndex) pattern.lastIndex++;
      }
    }
  }
  return violations;
}

const violations = checkLoopCwdDiscipline();
if (violations > 0) {
  console.error(`${violations} loop cwd discipline violation(s) found.`);
  process.exit(1);
} else {
  console.log('Loop cwd discipline check passed.');
}
