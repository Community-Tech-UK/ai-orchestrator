import type {
  GitHostConnector,
  GitHostEntityType,
  GitHostProvider,
  GitHostWorkItemMetadata,
  GitHostWorkItemReference,
} from './git-host-connector';

const provider: GitHostProvider = 'gitlab';

function getAuthHeaders(): Record<string, string> {
  const token = process.env['GITLAB_TOKEN']?.trim();
  if (!token) {
    return {};
  }

  return {
    'PRIVATE-TOKEN': token,
  };
}

function mapEntityType(entityType: GitHostEntityType): 'merge_requests' | 'issues' {
  return entityType === 'merge-request' ? 'merge_requests' : 'issues';
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...getAuthHeaders(),
    },
  });

  if (!response.ok) {
    throw new Error(`GitLab API request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

class GitLabConnector implements GitHostConnector {
  readonly provider = provider;

  async fetchWorkItem(reference: GitHostWorkItemReference): Promise<GitHostWorkItemMetadata> {
    const entityPath = mapEntityType(reference.entityType);
    const apiBase = `https://${reference.host}/api/v4/projects/${encodeURIComponent(reference.projectPath)}`;
    const apiUrl = `${apiBase}/${entityPath}/${reference.number}`;
    const payload = await fetchJson<Record<string, unknown>>(apiUrl);
    const author = payload['author'] as Record<string, unknown> | undefined;
    const sourceBranch = String(payload['source_branch'] ?? '') || undefined;
    const targetBranch = String(payload['target_branch'] ?? '') || undefined;
    const labels = Array.isArray(payload['labels'])
      ? payload['labels'].map((label) => String(label)).filter(Boolean)
      : [];

    return {
      reference,
      repository: {
        provider,
        host: reference.host,
        owner: reference.owner,
        repo: reference.repo,
        projectPath: reference.projectPath,
        webUrl: `https://${reference.host}/${reference.projectPath}`,
      },
      title: String(payload['title'] ?? ''),
      description: String(payload['description'] ?? '') || undefined,
      author: author ? String(author['username'] ?? '') || undefined : undefined,
      state: String(payload['state'] ?? '') || undefined,
      labels,
      baseBranch: targetBranch,
      headBranch: sourceBranch,
      fetchedAt: Date.now(),
    };
  }
}

const connector = new GitLabConnector();

export function getGitHostConnector(requestedProvider: GitHostProvider): GitHostConnector {
  if (requestedProvider !== provider) {
    throw new Error(`Unsupported connector request: ${requestedProvider}`);
  }
  return connector;
}
