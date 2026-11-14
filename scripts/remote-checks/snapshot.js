'use strict';
/**
 * Captures the exact files on disk, including uncommitted ones, or exactly what is staged,
 * as a git commit that exists only in a temporary object store.
 *
 * The real repository is never written to: other sessions share this checkout, and it
 * has lost work to `git stash` before. The index is a temporary copy, new objects go to
 * a temporary folder with the real store as a read-only alternate, and no ref is made.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_UNTRACKED_BYTES = 200 * 1024 * 1024;
const GITLINK_MODE = '160000';
const TEMP_PREFIX = 'aio-snapshot-';
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Never sent unless git already tracks them, in which case the committed copy goes: this
 * repository is public, and an edit on disk could be what shouldn't leave.
 */
const SECRET_NAME_GLOBS = [
  '.env', '.env.*', '.netrc', '.npmrc', '.git-credentials', 'credentials.json', 'service-account*.json',
  '*.pem', '*.key', '*.p8', '*.p12', '*.pfx', '*.keystore', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
];
const SECRET_EXCLUSIONS = SECRET_NAME_GLOBS.map(glob => `:(exclude,glob,icase)**/${glob}`);

/**
 * The far machine installs its own packages and keeps its `node_modules` through every checkout.
 * `node_modules/` in .gitignore matches only a directory, so a link of that name (a copy of the
 * repository pointing at another's packages) would otherwise go, and replace the far machine's
 * installed packages with a link to nothing.
 */
const LEFT_OUT = [...SECRET_EXCLUSIONS, ':(exclude,glob)**/node_modules'];
/** An ignored folder sent by name (`ignored` below) has no .gitignore rule to keep the files in its packages out. */
const IGNORED_LEFT_OUT = [...LEFT_OUT, ':(exclude,glob)**/node_modules/**'];

/**
 * Git exports these inside hooks. Left in place they would aim every command below at the real repository, or (the
 * pathspec ones, which `git --literal-pathspecs` and some editors set) turn the exclusions that keep secrets out into
 * plain paths.
 */
const SCOPED_GIT_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_PREFIX',
  'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
];

class SnapshotRefused extends Error {}

function cleanGitEnv(env = process.env) {
  const clean = { ...env };
  for (const key of SCOPED_GIT_ENV) delete clean[key];
  return clean;
}

function runGit(args, options) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function splitNul(text) {
  return text.split('\0').filter(Boolean);
}

/**
 * The untracked files `git add` would take from these folders, and from `ignored` ones with their ignored files too.
 * Empty for no folders: a pathspec of exclusions alone would mean every file.
 */
function untrackedIn(root, env, folders, ignored) {
  const list = (options, paths, leftOut) => (paths.length
    ? splitNul(runGit(['ls-files', '--others', ...options, '-z', '--', ...paths, ...leftOut], { cwd: root, env }))
    : []);
  return [...list(['--exclude-standard'], folders, LEFT_OUT), ...list([], ignored, IGNORED_LEFT_OUT)];
}

/** Refuses what shouldn't be sent before anything is hashed. */
function checkUntracked(root, env, maxBytes, folders, ignored) {
  const untracked = untrackedIn(root, env, folders, ignored);
  let total = 0;
  for (const rel of untracked) {
    if (rel.endsWith('/')) {
      throw new SnapshotRefused(`${rel} is a separate git repository, so its files would be left out`);
    }
    try {
      total += fs.lstatSync(path.join(root, rel)).size;
    } catch {
      /* removed since the listing; git add decides */
    }
    if (total > maxBytes) {
      throw new SnapshotRefused(`untracked files are over ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
  }
}

/** A run killed outright can't clean up after itself. */
function removeAbandonedSnapshots() {
  const cutoff = Date.now() - ABANDONED_AFTER_MS;
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const dir = path.join(os.tmpdir(), name);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* another run got there first */
    }
  }
}

function gitlinks(root, env) {
  const staged = splitNul(runGit(['ls-files', '--stage', '-z'], { cwd: root, env }));
  return new Set(staged.filter(entry => entry.startsWith(`${GITLINK_MODE} `)).map(entry => entry.split('\t')[1]));
}

/**
 * Sets up a temporary index and object store, lets `fill` shape the index, and commits it.
 * Returns `{ commit, tree, head, env, cleanup }`. `env` reaches the snapshot's objects, so
 * use it for anything that reads them, and call `cleanup()` when finished.
 */
function snapshotFrom(root, baseEnv, sourceIndex, fill) {
  const repoEnv = cleanGitEnv(baseEnv);
  const realIndex = path.resolve(root, runGit(['rev-parse', '--git-path', 'index'], { cwd: root, env: repoEnv }).trim());
  const realObjects = path.resolve(root, runGit(['rev-parse', '--git-path', 'objects'], { cwd: root, env: repoEnv }).trim());
  removeAbandonedSnapshots();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const cleanup = () => fs.rmSync(tempDir, { recursive: true, force: true });

  try {
    const tempIndex = path.join(tempDir, 'index');
    const index = sourceIndex ?? realIndex;
    if (fs.existsSync(index)) fs.copyFileSync(index, tempIndex);
    const objects = path.join(tempDir, 'objects');
    fs.mkdirSync(objects);
    const env = {
      ...repoEnv,
      GIT_INDEX_FILE: tempIndex,
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: realObjects,
    };

    fill(env);

    const tree = runGit(['write-tree'], { cwd: root, env }).trim();
    let head = null;
    try {
      head = runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, env }).trim();
    } catch {
      /* a repository with no commits yet */
    }
    const commit = runGit(
      ['-c', 'user.name=harness', '-c', 'user.email=harness@localhost.invalid',
        'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'remote checks snapshot'],
      { cwd: root, env },
    ).trim();
    return { commit, tree, head, env, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Whether git has anything at this path in the index, as it does for a tracked folder deleted from disk. */
function inIndex(root, env, rel) {
  return runGit(['ls-files', '-z', '--', rel], { cwd: root, env }).length > 0;
}

/**
 * The exact files on disk, including uncommitted ones. With `folders`, unstaged and untracked
 * files outside them are left out, and the rest goes as the index has it. `ignored` names folders
 * git ignores whose untracked files go too: data the tests read that must never be committed.
 * A folder this copy doesn't have is skipped, as a Plan Queue copy made from a commit has no
 * ignored folders and may lack others.
 */
function takeSnapshot(root, {
  maxUntrackedBytes = MAX_UNTRACKED_BYTES, baseEnv = process.env, folders = ['.'], ignored = [],
} = {}) {
  return snapshotFrom(root, baseEnv, null, (env) => {
    const onDisk = rel => fs.existsSync(path.join(root, rel));
    const present = folders.filter(rel => onDisk(rel) || inIndex(root, env, rel));
    const presentIgnored = ignored.filter(onDisk);
    checkUntracked(root, env, maxUntrackedBytes, present, presentIgnored);
    const knownGitlinks = gitlinks(root, env);
    // With no folder named, git would read the exclusions alone as every file.
    if (present.length) runGit(['add', '-A', '--', ...present, ...LEFT_OUT], { cwd: root, env });
    // By name: once exclusions are given, git's own walk never enters an ignored folder, even with --force.
    const ignoredFiles = untrackedIn(root, env, [], presentIgnored);
    if (ignoredFiles.length) {
      runGit(['--literal-pathspecs', 'add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        cwd: root, env, input: ignoredFiles.join('\0'), stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    for (const gitlink of gitlinks(root, env)) {
      if (!knownGitlinks.has(gitlink)) {
        throw new SnapshotRefused(`${gitlink} is a separate git repository, so its files would be left out`);
      }
    }
  });
}

/**
 * Exactly what is about to be committed, whatever else is on disk: other sessions share this
 * checkout, and their unstaged edits must not be tested or blamed on this commit. `git commit -a`
 * and `git commit <path>` build a temporary index and name it in GIT_INDEX_FILE for the hook, so
 * that is the one to read when it is set.
 *
 * Nothing can be left out of a tree that has to match the commit, so a staged secret-looking
 * file is refused rather than sent.
 */
function takeStagedSnapshot(root, { baseEnv = process.env } = {}) {
  const hookIndex = baseEnv.GIT_INDEX_FILE ? path.resolve(root, baseEnv.GIT_INDEX_FILE) : null;
  return snapshotFrom(root, baseEnv, hookIndex, (env) => {
    const secrets = splitNul(runGit(
      ['diff', '--cached', '--name-only', '--diff-filter=d', '-z', '--', ...SECRET_NAME_GLOBS.map(glob => `:(glob,icase)**/${glob}`)],
      { cwd: root, env },
    ));
    if (secrets.length) throw new SnapshotRefused(`${secrets[0]} has a secret-looking name`);
  });
}

/** The lockfile's hash inside the snapshot, for the result line to be checked against. */
function snapshotFileHash(root, snapshot, name) {
  try {
    const content = execFileSync('git', ['cat-file', 'blob', `${snapshot.tree}:${name}`], {
      cwd: root, env: snapshot.env, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return 'none';
  }
}

function snapshotFileText(root, snapshot, name) {
  return runGit(['cat-file', 'blob', `${snapshot.tree}:${name}`], { cwd: root, env: snapshot.env }).trim();
}

module.exports = { SnapshotRefused, cleanGitEnv, snapshotFileHash, snapshotFileText, takeSnapshot, takeStagedSnapshot };
