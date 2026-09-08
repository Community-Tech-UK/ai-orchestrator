/**
 * What the fresh-eyes instant-ALLOW rule is allowed to treat as "unchanged".
 *
 * Split out of `loop-coordinator-completion-gates.ts` for the LOC ratchet, but
 * it earns its own file: these two are the whole trust boundary for reusing a
 * previous review verdict, and Decision 15(b) made them load-bearing on the
 * shipped default. `loop-coordinator-completion-gates.ts` re-exports both, so
 * existing import sites are unchanged.
 */
import { spawnSync } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getLogger } from '../logging/logger';
import { LOOP_STATE_DIR_NAME } from './loop-artifact-paths';
import { IGNORED_UNTRACKED_PREFIXES } from './loop-diff';

const logger = getLogger('LoopReviewReuseAnchor');

/**
 * Fingerprint of the state a fresh-eyes verdict was issued against.
 *
 * **Derived from git directly, never from the reviewer's payload.** Three
 * earlier versions of this anchor were wrong, each time because it was built
 * out of something that under-reports:
 *
 * 1. `iteration.filesChanged` — the observed per-attempt delta, blind to
 *    writes between attempts and to a failed observation.
 * 2. `collectWorkspaceDiff().diff` alone — that diffs against HEAD, so
 *    committing the work returned it to empty and the digest never moved.
 * 3. `collectWorkspaceDiff()` at all — its output is bounded by
 *    `MAX_REVIEW_DIFF_CHARS` (60 000) and `DEFAULT_MAX_UNTRACKED_FILE_CHARS`
 *    (16 000). Past those bounds an equal-length edit leaves every input
 *    byte-identical. That is not an edge case: this repository's own
 *    `git diff HEAD` is roughly 475 000 characters, so any long-running loop
 *    lives permanently in the truncated regime.
 *
 * The reviewer's payload is *meant* to be bounded — it has to fit in a prompt.
 * A trust boundary must not be. So this reads its own unbounded inputs: the
 * commit, the full porcelain status (which carries renames, deletes and mode
 * changes), and the complete content of every changed or untracked file,
 * streamed so a large file costs no memory.
 *
 * Returns `null` when there is no readable HEAD or the status cannot be read —
 * a repository with no commits, or not a git checkout. Both are unanchorable
 * rather than unchanged, so the caller must fail closed.
 *
 * **Blind spots, enumerated because four earlier versions overclaimed here.**
 * This digest sees what `git diff HEAD --raw` and `ls-files` report for THIS
 * repository, plus the content of the paths they name, and nothing else.
 * (Porcelain status is run as a health probe but deliberately NOT hashed — see
 * the note at the status call.) The gaps:
 *
 * - gitignored paths — deliberate; a loop's own build output lives there and
 *   must not force a review;
 * - files marked `skip-worktree` or `assume-unchanged` — the user has told git
 *   to stop reporting them, which is the same class as an ignore;
 * - content inside a submodule or an embedded/nested git repository. Status
 *   reports the subrepo once (`M sub`, or `?? inner/`) and never changes as
 *   its contents do, and the path is a directory so no content is read;
 * - loop bookkeeping under `IGNORED_UNTRACKED_PREFIXES`, excluded on purpose
 *   so the loop's own `ITERATION_LOG.md` does not invalidate every attempt;
 * - a change confined to the INDEX while the worktree matches HEAD — staging
 *   content and then restoring the file, or `update-index --chmod` without a
 *   matching worktree change. Status shows `MM`, but `git diff HEAD` is EMPTY,
 *   so the reviewer sees nothing either and the digest is right to hold.
 *   Measured, not assumed: an earlier version of this comment asserted the
 *   reviewer's diff "would differ", which is false — `git diff HEAD` compares
 *   HEAD to the WORKING TREE, and that is unchanged here;
 * - a case-only rename on a case-insensitive filesystem, which git does not
 *   report at all — so the reviewer does not see it either.
 *
 * Symlinks are NOT on that list: they contribute their target path rather than
 * the bytes they point at, so a retarget is visible. That was a real hole once
 * (`openSync` follows links) and is covered by a test now.
 *
 * Do not describe this digest as covering every change on disk. If you need
 * the nested cases closed, recurse with `git -C <sub> status` per subrepo —
 * that is unimplemented, not overlooked.
 */
export function workspaceAnchorDigest(cwd: string): string | null {
  // The five fail-closed guards below (four `status !== 0` plus an empty-`root`
  // check) are deliberately redundant: any one catches a non-repo, an empty
  // repo, or a git that cannot run (an `index.lock` held by a concurrent
  // process exits non-zero on a perfectly healthy checkout). No single input
  // isolates one, so mutation testing shows each as individually survivable —
  // removing the whole set is what reddens `refuses to anchor when git itself
  // fails`. Keep them all: the cost is five comparisons, and the failure they
  // prevent is reusing a review verdict against a tree nobody could read.
  const head = runGit(['rev-parse', 'HEAD'], cwd);
  if (head.status !== 0) return null;
  // **The path-producing git calls run at the repository TOPLEVEL, not at
  // `cwd`** (`rev-parse` and the HEAD read necessarily run at `cwd` — they are
  // how the toplevel is discovered). Two separate defects came from getting
  // this wrong.
  //
  // First, path bases: `git diff --name-only` emits REPO-ROOT-relative paths
  // while `ls-files --others` emits CWD-relative ones. Joining both onto `cwd`
  // made every tracked path resolve to a file that does not exist whenever the
  // workspace was a SUBDIRECTORY of the repo (a supported shape — `apps/mobile`
  // here is one). Every read failed, each contributed the same constant, and
  // the digest silently degraded to a path-set anchor while still returning a
  // healthy-looking hash.
  //
  // Second, scope: the obvious repair was `--relative` plus a `-- .` pathspec,
  // which fixed the bases but narrowed the anchor to the subtree. The REVIEWER
  // is not narrowed — `collectWorkspaceDiff` runs a plain `git diff HEAD`,
  // which from a subdirectory still covers the whole repository. An agent in
  // `apps/mobile` editing a root file would have that change reviewed and yet
  // never invalidate the cache. **The anchor must cover exactly what the review
  // covered**, so it is repo-wide, and running at the toplevel makes every
  // output root-relative against one consistent base.
  //
  // `--diff-filter=d` drops DELETED paths: they cannot be read, and the
  // deletion is already carried by `--raw` above (a `D` entry). Excluding them
  // is what lets "unreadable" below mean unambiguously "something is wrong"
  // rather than "a file was deleted, as expected". (An earlier version of this
  // sentence credited the porcelain status, which is not hashed at all.)
  const top = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (top.status !== 0) return null;
  const root = top.stdout.trim();
  if (!root) return null;
  // NOTE: porcelain status is deliberately NOT hashed. It was, and it carried
  // an unfiltered `?? .aio-loop-state/...` line, so a NEW loop-bookkeeping file
  // moved the anchor even though the reviewer never sees one — defect 7's
  // mechanism through a different input. It is also fully redundant: `--raw`
  // carries every tracked add/modify/delete/rename/mode, and untracked files
  // are carried by the path list and their content. Dropping it removes the
  // leak at no cost. It is still RUN, as a fail-closed health probe: a repo
  // whose status cannot be read is one we refuse to anchor.
  const status = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root);
  if (status.status !== 0) return null;
  const tracked = runGit(['-c', 'core.pager=cat', 'diff', 'HEAD', '--name-only', '-z', '--diff-filter=d'], root);
  // `--raw` carries the src/dst FILE MODES. Porcelain status reports a mode
  // change only on a path that is otherwise clean, so `chmod +x` on an
  // already-modified file moved neither the status text nor any hashed byte —
  // while the reviewer's diff prints `old mode`/`new mode` explicitly. Making
  // a deploy or verify script executable is exactly the kind of change that
  // must not slip through on a reused verdict.
  // `--no-abbrev` because `--raw` otherwise shortens blob shas to `core.abbrev`,
  // which is a DISPLAY setting: changing it mid-run moved the digest without
  // anything in the tree changing. A gratuitously unstable anchor invalidates
  // its own cache and quietly disables the reuse — the same shape as defect 7,
  // and just as invisible, because it fails closed.
  const raw = runGit(['-c', 'core.pager=cat', 'diff', 'HEAD', '--raw', '-z', '--no-abbrev'], root);
  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z'], root);
  if (tracked.status !== 0 || untracked.status !== 0 || raw.status !== 0) return null;

  const hash = createHash('sha256');
  hash.update(head.stdout.trim()).update('\0').update(raw.stdout).update('\0');
  // Ignore exactly what the reviewer ignores. `.aio-loop-state/` holds an
  // `ITERATION_LOG.md` the coordinator appends to EVERY iteration, and it is
  // only added to `.gitignore` when a loop happens to have attachments
  // (`ensureLoopAttachmentsIgnored` is called under that condition alone). In
  // any workspace that has not already ignored it, hashing it moved the anchor
  // between every pair of completion attempts, so the instant ALLOW could
  // never fire and Decision 15(b) was inert. That failed CLOSED — extra
  // reviews, never skipped ones — which is exactly why it would not have shown
  // up as a bug, only as a feature that quietly did nothing.
  // The filter applies to the UNTRACKED list ONLY, because that is exactly
  // where the reviewer applies it (`isIgnoredUntracked`, used solely on
  // `ls-files --others`). Filtering the tracked list too made a *committed*
  // path under one of these prefixes — vendored `node_modules/`, or loop state
  // an agent swept in with `git add -A` — invisible to the anchor while fully
  // visible to the reviewer, which is the asymmetry this whole function exists
  // to avoid.
  const paths = [...new Set([
    ...splitNul(tracked.stdout),
    ...splitNul(untracked.stdout).filter((relative) => !isLoopBookkeepingPath(relative)),
  ])].sort();
  // **Each entry contributes a FIXED-LENGTH sub-digest, not raw bytes.**
  // Framing the outer hash as `path \0 content \0` was not injective: file
  // content may itself contain NUL, so one file's content could absorb a
  // neighbour's path and a genuinely different tree could hash the same. The
  // in-band `unreadable`/`symlink` markers were forgeable for the same reason
  // — a regular file containing those bytes impersonated the sentinel. A
  // 64-char hex sub-digest plus a separate kind tag removes the ambiguity:
  // paths cannot contain NUL, and every other field is fixed width.
  let unreadable = 0;
  for (const relative of paths) {
    const entry = createHash('sha256');
    const kind = hashPathEntry(entry, path.join(root, relative));
    if (kind === 'unreadable') unreadable += 1;
    hash.update(relative).update('\0').update(kind).update('\0').update(entry.digest('hex')).update('\0');
  }
  // Every path in the list is one git says exists — deletions are filtered out
  // above — so an unreadable path means the content half of this anchor is not
  // doing its job. That is exactly how the subdirectory-workspace defect stayed
  // invisible: it still returned a plausible hash while reading nothing.
  // A DIRECTORY is not counted: a submodule or embedded repo legitimately
  // appears as a path with no readable content, and is a documented blind spot
  // rather than a malfunction.
  if (unreadable > 0) {
    logger.warn('Workspace anchor could not read files git reports as present - content is not covered for them', {
      cwd,
      unreadable,
      pathCount: paths.length,
    });
  }
  return hash.digest('hex');
}

function runGit(args: string[], cwd: string): { status: number | null; stdout: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '' };
}

function isLoopBookkeepingPath(relative: string): boolean {
  const normalized = relative.split('\\').join('/');
  return IGNORED_UNTRACKED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function splitNul(out: string): string[] {
  return out.split('\0').filter((entry) => entry.length > 0);
}

type PathEntryKind = 'file' | 'symlink' | 'directory' | 'unreadable';

/**
 * Hash one path's payload into `entry` and report what kind of thing it was.
 *
 * The kind is carried OUT OF BAND by the caller rather than mixed into the
 * bytes, so a regular file whose contents spell a marker cannot impersonate a
 * symlink or an unreadable path.
 *
 * A SYMLINK contributes its target path, not the bytes it points at. Git
 * tracks the link value, so retargeting a link to a file with identical
 * content is a real change the reviewer is shown — but `openSync` follows
 * links, and `--raw`'s destination sha is all-zeros for worktree state, so it
 * was invisible. That was a gate finding in the unsafe direction: it permitted
 * a REUSE that should not have happened.
 */
function hashPathEntry(entry: Hash, absolutePath: string): PathEntryKind {
  let fd: number | undefined;
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      entry.update(fs.readlinkSync(absolutePath));
      return 'symlink';
    }
    // A submodule or embedded repo: git names the path, there is no content.
    if (stat.isDirectory()) return 'directory';
    fd = fs.openSync(absolutePath, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      entry.update(buffer.subarray(0, read));
    }
    return 'file';
  } catch {
    return 'unreadable';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

export function isReviewDrivenProductionChange(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (normalized.includes(`${LOOP_STATE_DIR_NAME}/`)) return false;
  if (normalized === LOOP_STATE_DIR_NAME) return false;
  // Minecraft server RUNTIME artifacts, not source. This was a blanket
  // `server/` exclusion until 2026-09-07; a fresh-eyes gate flagged it as an
  // uncommented rule swallowing a conventional source directory, and the
  // reason turned out to be real but much narrower than the rule.
  //
  // Excluding all of `server/` was wrong in two opposite directions at once: a
  // `server/`-only edit could advance the clean-review streak toward
  // completion (too lenient), while ping-pong counted the same round as the
  // builder changing nothing and marched it toward `builder-unreliable` (too
  // harsh). Narrowed per James, 2026-09-07.
  //
  // **Caveat, recorded because the rationale is weaker than it reads.** The
  // paths that motivated the original rule come from a synthetic test fixture,
  // not observed behaviour, and in the real repo `/server/` is gitignored
  // ("Nothing inside server/ is intended to be tracked"). A git-rooted
  // workspace makes attempt observation git-only, so no `server/**` path
  // reaches `iteration.filesChanged` there at all — this rule is effectively
  // unreachable for the workspace it was written for. It is kept, and
  // narrowed, for the general case: a monorepo with a TRACKED `server/`.
  //
  // Matching is by Minecraft-specific file extension and world-content
  // directory name rather than by a list of top-level directories. A first
  // narrowing tried the latter and got it wrong in both directions — it
  // anchored `region`/`data` at depth 2 while Paper puts the nether and end
  // one level deeper (`world_nether/DIM-1/region`), and it excluded
  // `config/`, `versions/`, `libraries/` and `cache/`, which are all
  // conventional SOURCE directory names. Ambiguous names are deliberately
  // treated as production now: erring that way costs a review, erring the
  // other way skips one that was needed.
  // Plugin DATA, matched by file type. A directory-level `server/plugins/`
  // rule (with a `/src/` carve-out) was the last top-level-directory match
  // left, and it swallowed `server/plugins/index.ts` — the standard
  // fastify-cli layout — along with `pom.xml` and `build.gradle.kts`. Same
  // class as the `server/src/entities/` defect it was meant to avoid. (The
  // `logs|crash-reports` rule below is still directory-shaped; both names are
  // unambiguous enough to keep, and `logs/` is covered by a global rule anyway.)
  if (/^server\/plugins\/.*\.(yml|yaml|properties|txt|log)$/.test(normalized)) return false;
  if (/^server\/(logs|crash-reports)\//.test(normalized)) return false;
  // Matched by Minecraft-specific FILE type rather than directory name. A
  // previous version matched `region|poi|entities|playerdata|stats|advancements`
  // at any depth to reach Paper's `world_nether/DIM-1/region`, and thereby
  // swallowed `server/src/entities/user.entity.ts` — the single most common
  // directory name in a Node backend. Extensions cannot make that mistake.
  if (/^server\/.*\.(mca|mcr|dat|dat_old|jar)$/.test(normalized)) return false;
  if (/^server\/.*\/session\.lock$/.test(normalized)) return false;
  // `stats/` and `advancements/` hold UUID-named json. Pinning the UUID keeps
  // `server/src/stats/aggregator.ts` production.
  if (/^server\/.*\/(stats|advancements)\/[0-9a-fA-F-]{36}\.json$/.test(normalized)) return false;
  if (/^server\/(server\.properties|eula\.txt|start\.sh)$/.test(normalized)) return false;
  if (/^server\/(usercache|banned-ips|banned-players|ops|whitelist|version_history)\.json$/.test(normalized)) return false;
  if (/^server\/(bukkit|spigot|permissions|commands|help|wepif|paper)\.yml$/.test(normalized)) return false;
  if (/\.(db|db-shm|db-wal|sqlite|sqlite3|mv\.db)$/i.test(normalized)) return false;
  if (/\/logs?\//i.test(normalized) || /(^|\/)latest\.log$/i.test(normalized)) return false;
  return true;
}
