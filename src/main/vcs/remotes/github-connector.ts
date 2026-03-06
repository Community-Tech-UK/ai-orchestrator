import type {
  GitHostConnector,
  GitHostEntityType,
  GitHostProvider,
  GitHostWorkItemMetadata,
  GitHostWorkItemReference,
} from './git-host-connector';

const provider: GitHostProvider = 'github';

function getAuthHeaders(): Record<string, string> {
  const token = process.env['GITHUB_TOKEN']?.trim();
  if (!token) {
    return {};
  }

  return {
    Authorization: `Bearer ${token}`,
  };
}

function mapEntityType(entityType: GitHostEntityType): 'pulls' | 'issues' {
  return entityType === 'pull-request' ? 'pulls' : 'issues';
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'claude-orchestrator',
      ...getAuthHeaders(),
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

class GitHubConnector implements GitHostConnector {
  readonly provider = provider;

  async fetchWorkItem(reference: GitHostWorkItemReference): Promise<GitHostWorkItemMetadata> {
    const owner = reference.owner;
    if (!owner) {
      throw new Error('GitHub work item is missing an owner');
    }

    const entityPath = mapEntityType(reference.entityType);
    const apiUrl = `https://api.github.com/repos/${owner}/${reference.repo}/${entityPath}/${reference.number}`;
    const payload = await fetchJson<Record<string, unknown>>(apiUrl);
    const head = payload['head'] as Record<string, unknown> | undefined;
    const base = payload['base'] as Record<string, unknown> | undefined;
    const user = payload['user'] as Record<string, unknown> | undefined;
    const labels = Array.isArray(payload['labels'])
      ? payload['labels']
        .map((label) => label && typeof label === 'object' ? String((label as Record<string, unknown>)['name'] ?? '') : '')
        .filter(Boolean)
      : [];

    return {
      reference,
      repository: {
        provider,
        host: reference.host,
        owner,
        repo: reference.repo,
        projectPath: reference.projectPath,
        webUrl: `https://${reference.host}/${owner}/${reference.repo}`,
      },
      title: String(payload['title'] ?? ''),
      description: String(payload['body'] ?? '') || undefined,
      author: user ? String(user['login'] ?? '') || undefined : undefined,
      state: String(payload['state'] ?? '') || undefined,
      labels,
      baseBranch: base ? String(base['ref'] ?? '') || undefined : undefined,
      headBranch: head ? String(head['ref'] ?? '') || undefined : undefined,
      fetchedAt: Date.now(),
    };
  }
}

const connector = new GitHubConnector();

export function getGitHostConnector(requestedProvider: GitHostProvider): GitHostConnector {
  if (requestedProvider !== provider) {
    throw new Error(`Unsupported connector request: ${requestedProvider}`);
  }
  return connector;
}
