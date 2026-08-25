/**
 * Exact-host GitHub remote parsing for Copilot account routing.
 *
 * Deliberately NOT reusing `git-host-connector.ts`'s `parseRemoteUrl`:
 *
 *  - it is not exported;
 *  - it matches hosts with `host.includes('github.com')`, so
 *    `github.com.evil.example` reads as GitHub; and
 *  - `resolveRepositoryFromWorkingDirectory()` keeps only `origin`, discarding
 *    the conflict evidence routing needs.
 *
 * Routing decides which GitHub *identity* services a repository. A near-miss
 * host must therefore never match, and a workspace whose remotes disagree must
 * surface as ambiguous rather than silently picking one.
 */

import { createVcsManager } from '../../workspace/git/vcs-manager';
import { getLogger } from '../../logging/logger';

const logger = getLogger('GitHubRemoteIdentity');

export interface GitHubRemoteIdentity {
  /** Remote name (`origin`, `upstream`, …). Display/ordering only. */
  remoteName: string;
  /** Lowercased host, for comparison. */
  host: string;
  /** Lowercased owner, for comparison. */
  owner: string;
  /** Lowercased repository name with any single trailing `.git` removed. */
  repo: string;
  /** Original-case `owner/repo` for display. */
  displayPath: string;
}

function stripGitSuffix(segment: string): string {
  return segment.endsWith('.git') ? segment.slice(0, -4) : segment;
}

function isExactKnownHost(host: string, knownHosts: readonly string[]): boolean {
  const normalized = host.toLowerCase();
  return knownHosts.some((candidate) => candidate.toLowerCase() === normalized);
}

/**
 * Parse a single remote URL into a GitHub identity, or `null` when it is not a
 * remote on one of `knownHosts`.
 *
 * `knownHosts` is the set of hosts configured on the user's Copilot account
 * profiles. Anything else — including an unrecognised SSH alias such as
 * `git@work-github:owner/repo` — returns `null`, which the resolver treats as
 * *no evidence*, not as a guess.
 */
export function parseGitHubRemote(
  url: string,
  knownHosts: readonly string[],
  remoteName = 'origin',
): GitHubRemoteIdentity | null {
  const trimmed = url.trim();
  if (!trimmed || knownHosts.length === 0) {
    return null;
  }

  const build = (host: string, rawPath: string): GitHubRemoteIdentity | null => {
    if (!isExactKnownHost(host, knownHosts)) {
      return null;
    }
    const segments = rawPath.split('/').filter(Boolean);
    // Exactly owner/repo. A deeper path is a GitLab-style subgroup or a URL
    // that is not a repository root; either way it is not routable evidence.
    if (segments.length !== 2) {
      return null;
    }
    const owner = segments[0];
    const repo = stripGitSuffix(segments[1]);
    if (!owner || !repo) {
      return null;
    }
    return {
      remoteName,
      host: host.toLowerCase(),
      owner: owner.toLowerCase(),
      repo: repo.toLowerCase(),
      displayPath: `${owner}/${repo}`,
    };
  };

  // scp-like syntax: [user@]host:owner/repo(.git)
  // Matched before URL parsing because `new URL()` treats `git@host:path` as an
  // unknown-scheme URL rather than failing.
  const scpMatch = trimmed.match(/^(?:([^@/\s]+)@)?([^:/\s]+):(?!\/)(.+)$/);
  if (scpMatch) {
    return build(scpMatch[2], scpMatch[3]);
  }

  try {
    const parsed = new URL(trimmed);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) {
      return null;
    }
    return build(parsed.hostname, decodeURIComponent(parsed.pathname));
  } catch {
    return null;
  }
}

export interface CollectFetchRemoteOptions {
  /** Injected for tests; production builds a real VCS manager. */
  createVcs?: typeof createVcsManager;
}

/**
 * Every *fetch* remote of `cwd` that resolves to a known GitHub host, `origin`
 * first for display. Push-only remotes are excluded: they describe where code
 * goes, not which repository is checked out.
 *
 * Returns `[]` for a non-git directory or a repository with no matching
 * remote — the caller must treat that as no evidence, never as a default match.
 */
export function collectFetchRemoteIdentities(
  cwd: string,
  knownHosts: readonly string[],
  options: CollectFetchRemoteOptions = {},
): GitHubRemoteIdentity[] {
  if (!cwd) {
    return [];
  }
  const factory = options.createVcs ?? createVcsManager;
  let remotes: { name: string; url: string; type: 'fetch' | 'push' }[];
  try {
    const vcs = factory(cwd);
    if (!vcs.isGitRepository()) {
      return [];
    }
    remotes = vcs.getRemotes();
  } catch (error) {
    logger.debug('Could not enumerate git remotes for Copilot routing', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const identities: GitHubRemoteIdentity[] = [];
  const seen = new Set<string>();
  for (const remote of remotes) {
    if (remote.type !== 'fetch') {
      continue;
    }
    const identity = parseGitHubRemote(remote.url, knownHosts, remote.name);
    if (!identity) {
      continue;
    }
    // `git remote -v` lists a remote once per direction; dedupe identical
    // fetch entries so one remote cannot look like corroborating evidence.
    const key = `${remote.name}::${identity.host}/${identity.owner}/${identity.repo}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    identities.push(identity);
  }

  return identities.sort((a, b) => {
    if (a.remoteName === b.remoteName) return 0;
    if (a.remoteName === 'origin') return -1;
    if (b.remoteName === 'origin') return 1;
    return a.remoteName.localeCompare(b.remoteName);
  });
}
