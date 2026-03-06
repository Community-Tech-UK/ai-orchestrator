import { createVcsManager } from '../../workspace/git/vcs-manager';
import { getLogger } from '../../logging/logger';
import { getGitHostConnector as getGitHubConnector } from './github-connector';
import { getGitHostConnector as getGitLabConnector } from './gitlab-connector';

const logger = getLogger('GitHostConnector');

export type GitHostProvider = 'github' | 'gitlab';
export type GitHostEntityType = 'issue' | 'pull-request' | 'merge-request';

export interface GitHostRepositoryReference {
  provider: GitHostProvider;
  host: string;
  owner?: string;
  repo: string;
  projectPath: string;
  remoteUrl?: string;
  webUrl: string;
}

export interface GitHostWorkItemReference {
  provider: GitHostProvider;
  host: string;
  owner?: string;
  repo: string;
  projectPath: string;
  entityType: GitHostEntityType;
  number: number;
  url: string;
}

export interface GitHostWorkItemMetadata {
  reference: GitHostWorkItemReference;
  repository: GitHostRepositoryReference;
  title: string;
  description?: string;
  author?: string;
  state?: string;
  labels: string[];
  baseBranch?: string;
  headBranch?: string;
  fetchedAt: number;
}

export interface GitHostConnector {
  readonly provider: GitHostProvider;
  fetchWorkItem(reference: GitHostWorkItemReference): Promise<GitHostWorkItemMetadata>;
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, '');
}

function buildRepositoryReference(
  provider: GitHostProvider,
  host: string,
  projectPath: string,
  remoteUrl?: string,
): GitHostRepositoryReference | null {
  const normalizedPath = stripGitSuffix(projectPath).replace(/^\/+/, '');
  if (!normalizedPath) {
    return null;
  }

  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const repo = segments[segments.length - 1] || '';
  const owner = provider === 'github'
    ? segments[0]
    : segments.length > 1
      ? segments.slice(0, -1).join('/')
      : undefined;

  return {
    provider,
    host,
    owner,
    repo,
    projectPath: normalizedPath,
    remoteUrl,
    webUrl: `https://${host}/${normalizedPath}`,
  };
}

function parseRemoteUrl(remoteUrl: string): GitHostRepositoryReference | null {
  const sshMatch = remoteUrl.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const host = sshMatch[1].toLowerCase();
    const projectPath = sshMatch[2];
    if (host.includes('github.com')) {
      return buildRepositoryReference('github', host, projectPath, remoteUrl);
    }
    if (host.includes('gitlab')) {
      return buildRepositoryReference('gitlab', host, projectPath, remoteUrl);
    }
    return null;
  }

  try {
    const parsed = new URL(remoteUrl);
    const host = parsed.hostname.toLowerCase();
    const projectPath = parsed.pathname.replace(/^\/+/, '');
    if (host.includes('github.com')) {
      return buildRepositoryReference('github', host, projectPath, remoteUrl);
    }
    if (host.includes('gitlab')) {
      return buildRepositoryReference('gitlab', host, projectPath, remoteUrl);
    }
  } catch {
    return null;
  }

  return null;
}

function parseGitHubUrl(parsed: URL): GitHostWorkItemReference | null {
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 4) {
    return null;
  }

  const [owner, repo, entityToken, numberToken] = segments;
  if (!owner || !repo || !numberToken) {
    return null;
  }

  let entityType: GitHostEntityType | null = null;
  if (entityToken === 'pull') {
    entityType = 'pull-request';
  } else if (entityToken === 'issues') {
    entityType = 'issue';
  }

  const number = Number.parseInt(numberToken, 10);
  if (!entityType || !Number.isFinite(number)) {
    return null;
  }

  return {
    provider: 'github',
    host: parsed.hostname.toLowerCase(),
    owner,
    repo,
    projectPath: `${owner}/${repo}`,
    entityType,
    number,
    url: parsed.toString(),
  };
}

function parseGitLabUrl(parsed: URL): GitHostWorkItemReference | null {
  const segments = parsed.pathname.split('/').filter(Boolean);
  const dashIndex = segments.indexOf('-');
  if (dashIndex < 1 || dashIndex >= segments.length - 2) {
    return null;
  }

  const projectSegments = segments.slice(0, dashIndex);
  const entityToken = segments[dashIndex + 1];
  const numberToken = segments[dashIndex + 2];
  const projectPath = projectSegments.join('/');
  const repo = projectSegments[projectSegments.length - 1] || '';
  const owner = projectSegments.length > 1 ? projectSegments.slice(0, -1).join('/') : undefined;

  let entityType: GitHostEntityType | null = null;
  if (entityToken === 'merge_requests') {
    entityType = 'merge-request';
  } else if (entityToken === 'issues') {
    entityType = 'issue';
  }

  const number = Number.parseInt(numberToken || '', 10);
  if (!projectPath || !repo || !entityType || !Number.isFinite(number)) {
    return null;
  }

  return {
    provider: 'gitlab',
    host: parsed.hostname.toLowerCase(),
    owner,
    repo,
    projectPath,
    entityType,
    number,
    url: parsed.toString(),
  };
}

export function parseGitHostWorkItemUrl(url: string): GitHostWorkItemReference | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('github.com')) {
      return parseGitHubUrl(parsed);
    }
    if (host.includes('gitlab')) {
      return parseGitLabUrl(parsed);
    }
  } catch {
    return null;
  }

  return null;
}

export function resolveRepositoryFromWorkingDirectory(
  workingDirectory: string,
): GitHostRepositoryReference | null {
  const vcs = createVcsManager(workingDirectory);
  if (!vcs.isGitRepository()) {
    return null;
  }

  const fetchRemotes = vcs.getRemotes().filter((remote) => remote.type === 'fetch');
  const preferredRemote =
    fetchRemotes.find((remote) => remote.name === 'origin') ||
    fetchRemotes[0];

  if (!preferredRemote) {
    return null;
  }

  return parseRemoteUrl(preferredRemote.url);
}

export async function fetchGitHostWorkItemMetadata(
  reference: GitHostWorkItemReference,
): Promise<GitHostWorkItemMetadata> {
  const connector: GitHostConnector = reference.provider === 'github'
    ? getGitHubConnector(reference.provider)
    : getGitLabConnector(reference.provider);
  return connector.fetchWorkItem(reference);
}

export async function resolveGitHostMetadata(
  issueOrPrUrl: string,
  workingDirectory?: string,
): Promise<GitHostWorkItemMetadata | null> {
  const reference = parseGitHostWorkItemUrl(issueOrPrUrl);
  if (!reference) {
    return null;
  }

  if (workingDirectory) {
    const repository = resolveRepositoryFromWorkingDirectory(workingDirectory);
    if (repository && repository.provider === reference.provider) {
      const repositoryPath = repository.projectPath.toLowerCase();
      const referencePath = reference.projectPath.toLowerCase();
      if (repositoryPath !== referencePath) {
        logger.info('Remote work item points at a different repository than the current working directory', {
          workingDirectory,
          repositoryPath,
          referencePath,
        });
      }
    }
  }

  return fetchGitHostWorkItemMetadata(reference);
}
