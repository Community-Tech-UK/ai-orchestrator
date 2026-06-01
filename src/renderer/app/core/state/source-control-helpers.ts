import type { StorageField } from '../../shared/utils/typed-storage';
import type {
  GitStatusResponse,
  RepoState,
} from '../../features/source-control/source-control.types';

/**
 * Result envelope for the store's write-action methods (stageFiles,
 * unstageFiles, etc.). Keeps the renderer surface minimal: callers primarily
 * want "did it work, and if not, what's the user-visible error".
 */
export interface IpcWriteResult {
  success: boolean;
  error?: string;
}

/**
 * Per-repo state for an in-flight fetch / pull / push. Powers the progress UI
 * and the cancel button.
 */
export interface LongOpState {
  opId: string;
  kind: 'fetch' | 'pull' | 'push';
  phase: 'started' | 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: number;
}

export interface RepoVisibility {
  visibleRepos: RepoState[];
  nestedRepoCount: number;
  hiddenNestedRepoCount: number;
  canToggleNestedRepos: boolean;
  showingNestedRepos: boolean;
}

export interface RepoStatusIpcResponse {
  success: boolean;
  data?: unknown;
  error?: { message?: string };
}

export const NESTED_REPO_VISIBILITY_FIELD: StorageField<Record<string, boolean>> = {
  key: 'source-control:nested-repos',
  version: 1,
  defaultValue: {},
  validate: isBooleanRecord,
};

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(entry => typeof entry === 'boolean');
}

export function normalizeRepoPath(root: string): string {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || '/';
}

export function normalizeRootStorageKey(root: string): string {
  return normalizeRepoPath(root);
}

export function createRepoState(root: string, absolutePath: string, previous?: RepoState): RepoState {
  if (previous) {
    return { ...previous, loading: true };
  }
  return {
    absolutePath,
    name: absolutePath.split('/').filter(Boolean).pop() ?? absolutePath,
    relativePath: relativeFromRoot(root, absolutePath),
    status: null,
    error: null,
    loading: true,
  };
}

export function applyStatusResponseToRepo(
  repo: RepoState,
  statusResponse: RepoStatusIpcResponse,
  opts?: { clearStatusOnError?: boolean }
): RepoState {
  if (statusResponse.success) {
    return {
      ...repo,
      status: statusResponse.data as GitStatusResponse,
      error: null,
      loading: false,
    };
  }
  return {
    ...repo,
    status: opts?.clearStatusOnError ? null : repo.status,
    error: statusResponse.error?.message ?? 'git status failed',
    loading: false,
  };
}

export function deriveRepoVisibility(
  root: string | null,
  repos: RepoState[],
  nestedRepoVisibilityPrefs: Record<string, boolean>
): RepoVisibility {
  if (!root || repos.length === 0) {
    return defaultRepoVisibility(repos);
  }

  const normalizedRoot = normalizeRepoPath(root);
  const rootRepo = repos.find(repo => normalizeRepoPath(repo.absolutePath) === normalizedRoot) ?? null;
  if (!rootRepo) {
    return defaultRepoVisibility(repos);
  }

  const nestedRepos = repos.filter(repo => repo.absolutePath !== rootRepo.absolutePath);
  if (nestedRepos.length === 0) {
    return defaultRepoVisibility(repos);
  }

  const rootKey = normalizeRootStorageKey(normalizedRoot);
  const showingNestedRepos = nestedRepoVisibilityPrefs[rootKey] === true;
  return {
    visibleRepos: showingNestedRepos ? repos : [rootRepo],
    nestedRepoCount: nestedRepos.length,
    hiddenNestedRepoCount: showingNestedRepos ? 0 : nestedRepos.length,
    canToggleNestedRepos: true,
    showingNestedRepos,
  };
}

function defaultRepoVisibility(repos: RepoState[]): RepoVisibility {
  return {
    visibleRepos: repos,
    nestedRepoCount: 0,
    hiddenNestedRepoCount: 0,
    canToggleNestedRepos: false,
    showingNestedRepos: true,
  };
}

/**
 * Generate a renderer-side operation id for fetch / pull / push so the
 * main-process progress events can correlate. Prefers `crypto.randomUUID()`
 * but degrades to a timestamp + random suffix if the API is absent.
 */
export function generateOpId(prefix: string): string {
  try {
    const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
    if (uuid) return `${prefix}-${uuid}`;
  } catch {
    // fall through
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

/** Pure helper, exported for tests. */
export function relativeFromRoot(root: string, absolute: string): string {
  const normalizedRoot = normalizeRepoPath(root);
  const normalizedAbsolute = normalizeRepoPath(absolute);
  if (normalizedAbsolute === normalizedRoot) return '.';
  if (normalizedAbsolute.startsWith(normalizedRoot + '/')) {
    return normalizedAbsolute.slice(normalizedRoot.length + 1);
  }
  return normalizedAbsolute;
}
