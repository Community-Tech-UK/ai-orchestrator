/**
 * git-env — strip repo-scoping git environment variables from a base env.
 *
 * When git runs a hook (pre-commit / pre-push), it exports GIT_DIR,
 * GIT_INDEX_FILE, GIT_WORK_TREE, etc. into the hook's environment, scoping every
 * child git process to the *outer* repo. Any code that shells out to git for a
 * DIFFERENT repository — worktree create/merge/reap against another working
 * tree, or tests operating on temp repos — inherits those vars and fails with
 * errors like `fatal: .git/index: index file open failed: Not a directory`.
 *
 * Running git with a scrubbed env makes the operation hermetic to its `cwd`,
 * which is exactly what worktree management needs (it is always cwd-scoped and
 * must never be hijacked by an inherited GIT_DIR).
 */

const GIT_SCOPED_ENV_VARS = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_INDEX_VERSION',
  'GIT_CONFIG',
] as const;

/**
 * Return a copy of `base` (defaults to process.env) with all repo-scoping git
 * environment variables removed, so a spawned git command resolves its repo
 * purely from `cwd`.
 */
export function hermeticGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of GIT_SCOPED_ENV_VARS) {
    delete env[key];
  }
  return env;
}

/**
 * Delete repo-scoping git env vars from `env` IN PLACE (defaults to process.env).
 * Used by the test setup so every spec that shells out to git is hermetic even
 * when the whole suite runs inside a pre-commit/pre-push hook (which exports
 * GIT_INDEX_FILE=.git/index etc.). Returns the same object for convenience.
 */
export function stripScopedGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  for (const key of GIT_SCOPED_ENV_VARS) {
    delete env[key];
  }
  return env;
}
