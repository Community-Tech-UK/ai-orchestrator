/**
 * The trust boundary for reusing a previous fresh-eyes verdict.
 *
 * Both functions here decide when a completion attempt is allowed to skip a
 * real cross-model review, so the cases that matter are the ones where a wrong
 * answer costs correctness rather than tokens.
 */
import { describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted above module scope, so the spy must be too.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  isReviewDrivenProductionChange,
  workspaceAnchorDigest,
} from './loop-review-reuse-anchor';
import { collectWorkspaceDiff } from './loop-diff';

function git(cwd: string, ...args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/** A real checkout with one commit — the anchor reads git, so fixtures cannot. */
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'spec@example.invalid');
  git(dir, 'config', 'user.name', 'Anchor Spec');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'seed');
  return dir;
}

const write = (dir: string, rel: string, body: string) =>
  fs.writeFileSync(path.join(dir, rel), body);

describe('workspaceAnchorDigest', () => {
  it('is stable while nothing changes', () => {
    const dir = repo();
    expect(workspaceAnchorDigest(dir)).toBe(workspaceAnchorDigest(dir));
  });

  /**
   * **Stability against DISPLAY config.** The digest must depend on repository
   * state and nothing else. `git diff --raw` abbreviates blob shas to
   * `core.abbrev`, so changing that setting mid-run moved the digest with the
   * tree untouched — the cache would invalidate itself and the reuse quietly
   * stop working, which is defect 7's shape and just as invisible because it
   * fails closed. No behavioural test would have caught it; only running the
   * digest twice under different config does.
   */
  it.each([
    ['core.abbrev', '40'],
    ['diff.noprefix', 'true'],
    ['diff.renames', 'false'],
    ['diff.algorithm', 'histogram'],
    ['core.quotepath', 'true'],
    ['diff.relative', 'true'],
    ['status.showUntrackedFiles', 'normal'],
  ])('is unmoved by the display setting %s=%s', (key, value) => {
    const dir = repo();
    // The file must be TRACKED and then modified: `--raw` only emits blob shas
    // for tracked changes, so an untracked-only fixture leaves it empty and
    // the abbreviation setting has nothing to act on. A first version of this
    // test made exactly that mistake and passed with `--no-abbrev` deleted.
    write(dir, 'tracked.ts', 'v1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'add tracked file');
    write(dir, 'tracked.ts', 'v2\n');
    write(dir, 'untracked.ts', 'n\n');
    const before = workspaceAnchorDigest(dir);

    git(dir, 'config', key, value);

    expect(workspaceAnchorDigest(dir)).toBe(before);
  });

  it('moves for an ordinary edit', () => {
    const dir = repo();
    const before = workspaceAnchorDigest(dir);
    write(dir, 'a.ts', 'export const a = 1;\n');
    expect(workspaceAnchorDigest(dir)).not.toBe(before);
  });

  /** Pass-2 finding: the diff is taken against HEAD, so committing emptied it. */
  it('moves when the work is committed rather than left dirty', () => {
    const dir = repo();
    const before = workspaceAnchorDigest(dir);
    write(dir, 'shipped.ts', 'export const shipped = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'agent committed its own work');
    expect(workspaceAnchorDigest(dir)).not.toBe(before);
  });

  it('moves for a staged-only change', () => {
    const dir = repo();
    write(dir, 'staged.ts', 'export const s = 1;\n');
    git(dir, 'add', '-A');
    const before = workspaceAnchorDigest(dir);
    write(dir, 'staged.ts', 'export const s = 2;\n');
    git(dir, 'add', '-A');
    expect(workspaceAnchorDigest(dir)).not.toBe(before);
  });

  /**
   * Deletions ride on `git diff HEAD --raw`, not the path list — the path list
   * filters them out with `--diff-filter=d` so that "unreadable" can mean
   * unambiguously "something is wrong".
   *
   * An earlier comment here claimed the porcelain STATUS component was what
   * made this pass, and that dropping it would redden the test. That was never
   * verified and was false: `--raw` carries the `D` entry independently.
   * Status is no longer hashed at all.
   */
  it('moves for a deletion', () => {
    const dir = repo();
    write(dir, 'gone.ts', 'export const g = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'add');
    const before = workspaceAnchorDigest(dir);
    fs.rmSync(path.join(dir, 'gone.ts'));
    expect(workspaceAnchorDigest(dir)).not.toBe(before);
  });

  /**
   * **Pass-3 finding, and the reason this no longer reads `collectWorkspaceDiff`.**
   * That payload is capped at `MAX_REVIEW_DIFF_CHARS` (60 000) so it fits in a
   * prompt. Past the cap, an equal-length edit left every input byte-identical
   * and a stale verdict was reusable. This repo's own diff is ~475 000 chars,
   * so the truncated regime is the normal one, not an edge case.
   */
  it('moves for an equal-length edit past the reviewer payload’s 60 KB cap', () => {
    const dir = repo();
    write(dir, 'big.ts', `${'// filler line to blow past sixty thousand chars\n'.repeat(2_000)}export const ADMIN_BYPASS = "no!";\n`);
    const before = workspaceAnchorDigest(dir);
    // Same length, same line count, same --stat — only the value differs.
    write(dir, 'big.ts', `${'// filler line to blow past sixty thousand chars\n'.repeat(2_000)}export const ADMIN_BYPASS = "ON!";\n`);
    expect(workspaceAnchorDigest(dir)).not.toBe(before);
  });

  /** Same defect for untracked files, whose payload head is capped at 16 KB. */
  it('moves for an edit past the untracked payload’s 16 KB bound', () => {
    const dir = repo();
    write(dir, 'new-module.ts', `${'x'.repeat(20_000)}SAFE`);
    const before = workspaceAnchorDigest(dir);
    write(dir, 'new-module.ts', `${'x'.repeat(20_000)}EVIL`);
    expect(workspaceAnchorDigest(dir)).not.toBe(before);
  });

  it('moves for a binary change of identical size', () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    const before = workspaceAnchorDigest(dir);
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 4]));
    expect(workspaceAnchorDigest(dir)).not.toBe(before);
  });

  /**
   * The deliberate limit. A loop's own build output and caches are gitignored
   * and must not force a review, so the digest cannot see them. Documented so
   * nobody describes this as covering every change on disk.
   */
  it('does NOT see gitignored paths — the one accepted blind spot', () => {
    const dir = repo();
    write(dir, '.gitignore', 'dist/\n');
    fs.mkdirSync(path.join(dir, 'dist'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'ignore dist');
    write(dir, 'dist/bundle.js', 'console.log("v1")');
    const before = workspaceAnchorDigest(dir);
    write(dir, 'dist/bundle.js', 'console.log("v2")');
    expect(workspaceAnchorDigest(dir)).toBe(before);
  });

  /**
   * **The loop's own bookkeeping must not move the anchor.**
   *
   * `.aio-loop-state/<run>/ITERATION_LOG.md` is appended EVERY iteration, and
   * it only reaches `.gitignore` when a loop happens to have attachments. In a
   * workspace that has not already ignored it, hashing it moved the anchor
   * between every pair of completion attempts, so the reuse could never fire
   * and Decision 15(b) was silently inert. It failed CLOSED — extra reviews,
   * never skipped ones — which is why it would never have looked like a bug.
   *
   * `core.excludesFile` is neutralised deliberately: this machine's global
   * gitignore lists `.aio-loop-state/`, so without that line git would exclude
   * the file for us and this test would pass with the filter deleted.
   */
  it('ignores the loop’s own state files even when they are not gitignored', () => {
    const dir = repo();
    git(dir, 'config', 'core.excludesFile', '/dev/null');
    fs.mkdirSync(path.join(dir, '.aio-loop-state', 'run-1'), { recursive: true });
    write(dir, '.aio-loop-state/run-1/ITERATION_LOG.md', 'iteration 1\n');
    const before = workspaceAnchorDigest(dir);
    expect(before).not.toBeNull();

    write(dir, '.aio-loop-state/run-1/ITERATION_LOG.md', 'iteration 1\niteration 2\n');
    expect(workspaceAnchorDigest(dir), 'loop bookkeeping must not invalidate').toBe(before);

    // ...but real work in the same workspace still does.
    write(dir, 'real.ts', 'export const x = 1;\n');
    expect(workspaceAnchorDigest(dir)).not.toBe(before);
  });

  /**
   * Prefix semantics on the ignore list. `startsWith` on a prefix ending in
   * `/` is what keeps this narrow; switching it to `includes` silently widens
   * the ignore set — the unsafe direction — and survived every other test.
   * Both directions are pinned here.
   */
  it('ignores only the exact bookkeeping directories, not names that merely contain them', () => {
    const dir = repo();
    git(dir, 'config', 'core.excludesFile', '/dev/null');
    for (const rel of ['.aio-loop-statement/real.ts', 'node_modules_real/a.ts', 'sub/node_modules/dep.js']) {
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      write(dir, rel, 'v1\n');
    }
    const before = workspaceAnchorDigest(dir);

    // A directory whose name merely starts with, or contains, an ignored
    // prefix is ordinary work. `sub/node_modules/` is the `includes` case: the
    // reviewer hashes it too (`isIgnoredUntracked` is also prefix-anchored),
    // so the anchor must not diverge.
    write(dir, '.aio-loop-statement/real.ts', 'v2\n');
    expect(workspaceAnchorDigest(dir), '.aio-loop-statement/ is not .aio-loop-state/').not.toBe(before);
    const afterFirst = workspaceAnchorDigest(dir);
    write(dir, 'node_modules_real/a.ts', 'v2\n');
    expect(workspaceAnchorDigest(dir), 'node_modules_real/ is not node_modules/').not.toBe(afterFirst);
    const afterSecond = workspaceAnchorDigest(dir);
    write(dir, 'sub/node_modules/dep.js', 'v2\n');
    expect(workspaceAnchorDigest(dir), 'a NESTED node_modules/ is not the root one').not.toBe(afterSecond);
  });

  /**
   * A NEW loop-bookkeeping file must be as invisible as an append to an
   * existing one. The porcelain status used to be hashed unfiltered, so a
   * fresh `OUTSTANDING.md` under `.aio-loop-state/` added a `??` line and moved
   * the anchor even though the reviewer never sees one — defect 7's mechanism
   * arriving through a different input, equally invisible because it fails
   * closed.
   */
  it('ignores a NEW loop-bookkeeping file, not just appends to an existing one', () => {
    const dir = repo();
    git(dir, 'config', 'core.excludesFile', '/dev/null');
    fs.mkdirSync(path.join(dir, '.aio-loop-state', 'run-1'), { recursive: true });
    write(dir, '.aio-loop-state/run-1/ITERATION_LOG.md', 'iteration 1\n');
    const before = workspaceAnchorDigest(dir);

    write(dir, '.aio-loop-state/run-1/OUTSTANDING.md', 'something outstanding\n');

    expect(workspaceAnchorDigest(dir)).toBe(before);
  });

  /**
   * A symlink contributes its TARGET PATH, not the bytes it points at. Git
   * tracks the link value, so retargeting a dirty link to a different file
   * with identical content is a real change the reviewer is shown — but
   * `openSync` follows links and `--raw`'s destination sha is all-zeros for
   * worktree state, so it was invisible. The unsafe direction: it permitted a
   * reuse that should not have happened.
   */
  it('sees a symlink retargeted to a file with identical content', () => {
    const dir = repo();
    write(dir, 'prod.env', 'SECRET=1\n');
    write(dir, 'staging.env', 'SECRET=1\n');
    write(dir, 'canary.env', 'SECRET=1\n');
    fs.symlinkSync('prod.env', path.join(dir, 'active.env'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'seed links');

    // Dirty the link first: a clean path is not in the content list at all.
    fs.rmSync(path.join(dir, 'active.env'));
    fs.symlinkSync('staging.env', path.join(dir, 'active.env'));
    const before = workspaceAnchorDigest(dir);

    fs.rmSync(path.join(dir, 'active.env'));
    fs.symlinkSync('canary.env', path.join(dir, 'active.env'));

    expect(workspaceAnchorDigest(dir)).not.toBe(before);
  });

  /**
   * File modes. Porcelain status reports a mode change only on a path that is
   * otherwise clean, so `chmod +x` on an already-modified file moved nothing —
   * while the reviewer's diff prints `old mode`/`new mode`. The raw diff is
   * what closes that.
   */
  it('sees a mode change on an already-modified file', () => {
    const dir = repo();
    write(dir, 'deploy.sh', '#!/bin/sh\necho hi\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'add script');
    write(dir, 'deploy.sh', '#!/bin/sh\necho hi\necho dirty\n');
    const before = workspaceAnchorDigest(dir);

    fs.chmodSync(path.join(dir, 'deploy.sh'), 0o755);

    expect(workspaceAnchorDigest(dir)).not.toBe(before);
  });

  /**
   * The bookkeeping filter applies to UNTRACKED paths only, exactly where the
   * reviewer applies it. A committed file under one of those prefixes —
   * vendored dependencies, or loop state an agent swept in with `git add -A` —
   * is real content the reviewer is shown, so the anchor must see it too.
   */
  it('sees a TRACKED file under a bookkeeping prefix, because the reviewer does', () => {
    const dir = repo();
    git(dir, 'config', 'core.excludesFile', '/dev/null');
    fs.mkdirSync(path.join(dir, 'node_modules', 'vendored'), { recursive: true });
    write(dir, 'node_modules/vendored/index.js', 'v1\n');
    git(dir, 'add', '-A', '-f');
    git(dir, 'commit', '-qm', 'vendor a dependency');
    write(dir, 'node_modules/vendored/index.js', 'v2\n');
    const before = workspaceAnchorDigest(dir);

    write(dir, 'node_modules/vendored/index.js', 'v3 - a backdoor\n');

    expect(workspaceAnchorDigest(dir)).not.toBe(before);
  });

  /**
   * **The subdirectory workspace.** `git diff --name-only` returns
   * repo-root-relative paths while `ls-files --others` returns cwd-relative
   * ones, so joining both onto the workspace made every tracked path resolve
   * to a nonexistent file. Each read failed, each contributed the same
   * constant, and the digest silently degraded to a path-set anchor that could
   * not see content at all — while still returning a healthy-looking hash.
   * `apps/mobile` in this repo is exactly this shape, so it is supported, not
   * exotic. The second edit is the one that matters: it does not change the
   * SET of modified paths, only their content.
   */
  it('sees content when the workspace is a subdirectory of the repo', () => {
    const dir = repo();
    fs.mkdirSync(path.join(dir, 'sub', 'src'), { recursive: true });
    write(dir, 'sub/src/a.ts', 'v1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'add nested source');
    const sub = path.join(dir, 'sub');

    write(dir, 'sub/src/a.ts', 'v2\n');
    const before = workspaceAnchorDigest(sub);
    expect(before).not.toBeNull();
    // Same path set, different content.
    write(dir, 'sub/src/a.ts', 'TOTALLY DIFFERENT, SAME PATH SET\n');

    expect(workspaceAnchorDigest(sub)).not.toBe(before);
  });

  /**
   * **The anchor is repo-wide, matching the reviewer.** An earlier fix scoped
   * it to the workspace subtree with a `-- .` pathspec, on the assumption that
   * a sibling directory's churn was not this loop's business. That was wrong:
   * `collectWorkspaceDiff` runs a plain `git diff HEAD`, which from a
   * subdirectory still covers the whole repository — so the reviewer sees a
   * root-level edit while the scoped anchor did not, and a verdict covering
   * that edit could be reused after it changed again. The anchor must cover
   * exactly what the review covered.
   */
  /**
   * The untracked half of the same defect. `ls-files --others` is cwd-scoped,
   * so running it at the workspace instead of the toplevel hides untracked
   * files elsewhere in the repo.
   *
   * Note the anchor is deliberately STRICTER than the reviewer here:
   * `collectWorkspaceDiff` runs its own `ls-files --others` at `workspaceCwd`,
   * so it does NOT show an untracked file outside the subtree. Covering more
   * than the review costs an occasional extra review and never skips one, so
   * the asymmetry is safe — but it IS an asymmetry, and an earlier version of
   * this comment wrongly claimed the reviewer saw it too.
   */
  it('sees an EDIT to an untracked file outside the workspace subtree', () => {
    const dir = repo();
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    write(dir, 'sub/keep.ts', 'x\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'add sub');
    const sub = path.join(dir, 'sub');

    // The file must already EXIST before the anchor is taken. Creating it
    // moves the digest via the status line alone, so a first version of this
    // test passed with `ls-files` mis-scoped. Editing it does not change
    // status (`?? new-at-root.ts` either way), so only content hashing can
    // see it — which is the property being pinned.
    write(dir, 'new-at-root.ts', 'v1\n');
    const before = workspaceAnchorDigest(sub);
    write(dir, 'new-at-root.ts', 'v2 - the reviewer would be shown this\n');

    expect(workspaceAnchorDigest(sub)).not.toBe(before);
  });

  it('sees a TRACKED change outside the workspace subtree, because the reviewer does', () => {
    const dir = repo();
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    write(dir, 'sub/keep.ts', 'x\n');
    // `elsewhere.ts` must be COMMITTED. An untracked file outside the subtree
    // is picked up by the repo-wide `ls-files` regardless of how status is
    // scoped, so an earlier version of this test passed even with the anchor
    // narrowed — it proved nothing about tracked changes.
    write(dir, 'elsewhere.ts', 'v1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'add sub and a root file');
    const sub = path.join(dir, 'sub');
    const before = workspaceAnchorDigest(sub);

    write(dir, 'elsewhere.ts', 'a root-level edit the reviewer would be shown\n');

    expect(workspaceAnchorDigest(sub)).not.toBe(before);
  });

  /**
   * Framing must be INJECTIVE for arbitrary bytes, not just text. `\0` used to
   * be the only separator while file content could itself contain `\0`, so one
   * file's content could absorb a neighbour's path and a genuinely different
   * tree hashed the same — a reuse-permitting collision, found by a gate pass.
   * Entries now carry a fixed-length sub-digest with the kind out of band.
   */
  it('resists a NUL-in-content collision between different trees', () => {
    const one = repo();
    write(one, 'a', 'X');
    write(one, 'b', 'Y');
    const two = repo();
    // `X \0 b \0 Y` — the exact bytes the old framing produced for `one`.
    fs.writeFileSync(path.join(two, 'a'), Buffer.from([0x58, 0, 0x62, 0, 0x59]));

    expect(workspaceAnchorDigest(one)).not.toBe(workspaceAnchorDigest(two));
  });

  /**
   * The kind markers were in-band too, so a regular file whose bytes spelled
   * `\u0002symlink\0<target>` impersonated a symlink. Kind is a separate field
   * now, so content cannot forge it.
   */
  it('does not let a regular file impersonate a symlink', () => {
    const one = repo();
    write(one, 'target.txt', 't');
    fs.symlinkSync('target.txt', path.join(one, 'link'));
    const two = repo();
    write(two, 'target.txt', 't');
    fs.writeFileSync(path.join(two, 'link'), Buffer.concat([
      Buffer.from([2]), Buffer.from('symlink'), Buffer.from([0]), Buffer.from('target.txt'),
    ]));

    expect(workspaceAnchorDigest(one)).not.toBe(workspaceAnchorDigest(two));
  });

  /**
   * The case that makes the out-of-band `kind` field load-bearing rather than
   * merely defensive: a symlink POINTING AT `target.txt` and a regular file
   * CONTAINING the text `target.txt` produce the same sub-digest, because one
   * hashes the link value and the other hashes its bytes. Only the kind tag
   * separates them. Without this the kind mutant survived — the forgery test
   * above happens to differ in its sub-digest anyway.
   */
  it('distinguishes a symlink from a file whose contents equal the link target', () => {
    const one = repo();
    write(one, 'target.txt', 't');
    fs.symlinkSync('target.txt', path.join(one, 'link'));
    const two = repo();
    write(two, 'target.txt', 't');
    write(two, 'link', 'target.txt');

    expect(workspaceAnchorDigest(one)).not.toBe(workspaceAnchorDigest(two));
  });

  /**
   * The text case of the same property. Both repos need the SAME HEAD sha and
   * the same status text or the assertion passes for an unrelated reason —
   * hence the pinned commit dates. `a='b.txt', b=''` and `a='', b='b.txt'`
   * both concatenate to `a.txt` + `b.txt` + `b.txt`.
   *
   * Two earlier fixtures here were wrong and the second one's comment claimed
   * a verification that had not been done. No mutant table is quoted now: the
   * framing it described no longer exists, and re-quoting one without
   * re-measuring it is how that comment went stale in the first place.
   */
  it('distinguishes trees whose file contents concatenate identically', () => {
    const build = (a: string, b: string): string => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-sep-'));
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 'spec@example.invalid');
      git(dir, 'config', 'user.name', 'Anchor Spec');
      git(dir, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(dir, 'seed.md'), 'seed\n');
      git(dir, 'add', '-A');
      // Pinned so both repos land on an identical commit sha.
      spawnSync('git', ['commit', '-qm', 'seed', '--date=2020-01-01T00:00:00Z'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' },
      });
      write(dir, 'a.txt', a);
      write(dir, 'b.txt', b);
      return dir;
    };
    // Contents chosen so both trees concatenate to the same bytes ONCE the
    // delimiters are gone: 'a.txt'+'b.txt'+'b.txt'+'' == 'a.txt'+''+'b.txt'+'b.txt'.
    const one = build('b.txt', '');
    const two = build('', 'b.txt');
    expect(workspaceAnchorDigest(one), 'precondition: both anchorable').not.toBeNull();
    expect(workspaceAnchorDigest(one)).not.toBe(workspaceAnchorDigest(two));
  });

  /**
   * Fail-closed on a git failure, not just on a missing repo. `index.lock`
   * contention makes git exit non-zero on a perfectly healthy checkout, and
   * treating that as "nothing changed" would reuse a verdict on an unknown
   * tree.
   *
   * This pins the BEHAVIOUR, not any single guard. The five guards are
   * mutually redundant by construction — an empty repo fails `rev-parse HEAD`
   * and `diff HEAD` together while `status` succeeds, so no input isolates
   * one. Removing any single one leaves this green; removing the set does not.
   */
  it('refuses to anchor when git itself fails', () => {
    const dir = repo();
    expect(workspaceAnchorDigest(dir)).not.toBeNull();
    // A directory where .git is unreadable: every git call fails.
    fs.renameSync(path.join(dir, '.git'), path.join(dir, '.git-moved'));
    expect(workspaceAnchorDigest(dir)).toBeNull();
  });

  /**
   * Index-only divergence is a blind spot the REVIEWER shares, so holding is
   * correct rather than a hole. `git diff HEAD` compares HEAD to the working
   * tree; staging a change and then restoring the file leaves that empty. The
   * assertion on the reviewer's own view is the point — without it this reads
   * as the anchor missing something the review would have caught.
   */
  it('holds for index-only divergence, which the reviewer also cannot see', () => {
    const dir = repo();
    write(dir, 'f.txt', 'HEAD\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'seed f');
    const before = workspaceAnchorDigest(dir);

    write(dir, 'f.txt', 'STAGED\n');
    git(dir, 'add', 'f.txt');
    write(dir, 'f.txt', 'HEAD\n');

    expect(collectWorkspaceDiff(dir).diff, 'precondition: the reviewer sees nothing').toBe('');
    expect(workspaceAnchorDigest(dir)).toBe(before);
  });

  /**
   * `--diff-filter=d` is what keeps the "unreadable" warning meaningful. Its
   * only observable is that warning, so this is the one place the logger has
   * to be asserted on: without the filter, every ordinary tracked deletion
   * lands in the path list, fails to read, and cries wolf. A mutant removing
   * the filter survived every other test in this file.
   */
  it('does not warn about a tracked deletion', () => {
    const dir = repo();
    write(dir, 'gone.ts', 'x\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'add');
    fs.rmSync(path.join(dir, 'gone.ts'));

    warn.mockClear();
    expect(workspaceAnchorDigest(dir)).not.toBeNull();

    expect(warn, 'a deletion is expected, not a malfunction').not.toHaveBeenCalled();
  });

  it('refuses to anchor a directory that is not a git checkout', () => {
    expect(workspaceAnchorDigest(fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-nogit-')))).toBeNull();
  });

  /**
   * A repo with no commits: `git diff HEAD` fails and `ls-files --others`
   * omits staged paths, so staging a file then rewriting it left every input
   * identical. Unanchorable, not unchanged.
   */
  it('refuses to anchor a repository with no commits', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-empty-'));
    git(dir, 'init', '-q');
    write(dir, 'x.ts', 'before');
    git(dir, 'add', '-A');
    expect(workspaceAnchorDigest(dir)).toBeNull();
  });
});

describe('isReviewDrivenProductionChange', () => {
  it('counts ordinary source as production', () => {
    expect(isReviewDrivenProductionChange('src/app.ts')).toBe(true);
  });

  /**
   * These pin the path NORMALISATION, and have to be phrased against a path
   * that is EXCLUDED to do so. Asserting `'./src/app.ts' → true` was vacuous:
   * it passed whether or not the `./` and backslash handling existed, because
   * an unnormalised path falls through to `true` anyway.
   */
  it('normalises leading ./ and Windows separators before matching', () => {
    expect(isReviewDrivenProductionChange('.aio-loop-state/loop-1/NOTES.md')).toBe(false);
    expect(isReviewDrivenProductionChange('.aio-loop-state\\loop-1\\NOTES.md')).toBe(false);
    expect(isReviewDrivenProductionChange('.\\server\\logs\\latest.log')).toBe(false);
    // The `./` cases must use a rule that ANCHORS on `^`. `.aio-loop-state` is
    // matched with `.includes()`, so `./` in front changes nothing and those
    // assertions passed with the normalisation deleted.
    expect(isReviewDrivenProductionChange('./server/world/region/r.0.0.mca')).toBe(false);
    expect(isReviewDrivenProductionChange('./server/server.properties')).toBe(false);
  });

  /** The bare directory name, not just paths beneath it. */
  it('does not count the loop state directory itself', () => {
    expect(isReviewDrivenProductionChange('.aio-loop-state')).toBe(false);
  });

  it('does not count databases or logs anywhere', () => {
    expect(isReviewDrivenProductionChange('data/app.sqlite3')).toBe(false);
    expect(isReviewDrivenProductionChange('var/log/output.txt')).toBe(false);
    expect(isReviewDrivenProductionChange('latest.log')).toBe(false);
  });

  /**
   * Path SHAPES taken from the tree this rule was written for
   * (`~/work/Minecraft/one-more-floor/server`). 17 of the 25 exist verbatim
   * today; the rest are shape-equivalent to files that do (a UUID-named
   * `playerdata/*.dat`, a jar under `versions/`, a transient SQLite `-wal`
   * sidecar). Counted rather than asserted, because a previous version of this
   * comment claimed 24 and an earlier one claimed all of them. An earlier
   * version of this list asserted `server/world_nether/region/...`, a path
   * that does not exist — Paper nests the nether and end one level deeper
   * under `DIM-1`/`DIM1`, and the world here is named `omf_dungeon`, not
   * `world`. The tests passed on a layout that was not real.
   */
  it.each([
    'server/logs/latest.log',
    'server/plugins/CoreProtect/database.db',
    'server/plugins/OneMoreFloor/database.db-wal',
    'server/plugins/FancyHolograms/holograms.yml',
    'server/omf_dungeon/level.dat',
    'server/omf_dungeon/region/r.0.0.mca',
    'server/omf_dungeon/data/raids.dat',
    'server/omf_dungeon/session.lock',
    'server/world/advancements/123e4567-e89b-12d3-a456-426614174000.json',
    'server/world/stats/123e4567-e89b-12d3-a456-426614174000.json',
    'server/world/playerdata/uuid.dat',
    'server/world_nether/DIM-1/region/r.0.0.mca',
    'server/world_the_end/DIM1/data/raids.dat',
    'server/backups/omf_dungeon-pre-phase4-20260516-091705/region/r.0.0.mca',
    'server/crash-reports/crash-2026-09-07.txt',
    'server/libraries/paper-api.jar',
    'server/versions/1.21.11.jar',
    'server/paper-1.21.11-131.jar',
    'server/usercache.json',
    'server/banned-players.json',
    'server/server.properties',
    'server/eula.txt',
    'server/spigot.yml',
    'server/start.sh',
    'server/map-color-cache.dat',
  ])('does not count Minecraft server runtime artifact %s', (p) => {
    expect(isReviewDrivenProductionChange(p)).toBe(false);
  });

  /**
   * The defect the narrowing fixes, plus the second-order one. A blanket
   * `server/` exclusion swallowed a conventional source directory; the first
   * narrowing then excluded `config/`, `versions/`, `libraries/` and `cache/`,
   * which are equally conventional SOURCE directory names. Ambiguous names now
   * count as production — erring that way costs a review, erring the other way
   * skips one that was needed.
   */
  it.each([
    'server/src/main/java/Plugin.java',
    'server/api/routes.ts',
    'server/package.json',
    'server/tsconfig.json',
    'server/docker-compose.yml',
    'server/Dockerfile',
    'server/config/database.ts',
    'server/versions/v1/routes.ts',
    'server/libraries/util.ts',
    'server/cache/redis-client.ts',
    // The second-order defect: matching world-content directory names at any
    // depth swallowed the most common directory names in a Node backend.
    'server/src/entities/user.entity.ts',
    'server/entities/order.ts',
    'server/src/stats/aggregator.ts',
    'server/src/region/eu-west.ts',
    'server/src/poi/points-of-interest.ts',
    'server/src/advancements/service.ts',
    // A bare `.lock` extension rule swallowed every dependency lockfile.
    'server/yarn.lock',
    'server/Cargo.lock',
    'server/bun.lock',
    // Plugin SOURCE and build files are real work; plugin DATA is not. A
    // directory-level `server/plugins/` rule swallowed all of these — the
    // fastify-cli layout puts application source directly in `plugins/`.
    'server/plugins/OneMoreFloor/src/Main.java',
    'server/plugins/index.ts',
    'server/plugins/db.ts',
    'server/plugins/auth.plugin.ts',
    'server/plugins/README.md',
    'server/plugins/MyPlugin/pom.xml',
    'server/plugins/MyPlugin/build.gradle.kts',
  ])('counts server-side SOURCE as production: %s', (p) => {
    expect(isReviewDrivenProductionChange(p)).toBe(true);
  });

  /** `server` as a filename, or a nested `server/`, must not be swallowed. */
  it('only excludes the runtime dirs at the workspace root', () => {
    expect(isReviewDrivenProductionChange('src/server/plugins/thing.ts')).toBe(true);
    expect(isReviewDrivenProductionChange('server.ts')).toBe(true);
  });
});
