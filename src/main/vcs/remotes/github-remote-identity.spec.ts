import { describe, expect, it, vi } from 'vitest';
import {
  collectFetchRemoteIdentities,
  parseGitHubRemote,
} from './github-remote-identity';

const HOSTS = ['github.com', 'ghe.example.com'];

function fakeVcs(
  remotes: { name: string; url: string; type: 'fetch' | 'push' }[],
  isRepo = true,
) {
  return () =>
    ({
      isGitRepository: () => isRepo,
      getRemotes: () => remotes,
    }) as unknown as ReturnType<typeof import('../../workspace/git/vcs-manager').createVcsManager>;
}

describe('parseGitHubRemote URL matrix', () => {
  it.each([
    ['https://github.com/Octocat/Hello-World.git', 'github.com', 'octocat', 'hello-world'],
    ['https://github.com/Octocat/Hello-World', 'github.com', 'octocat', 'hello-world'],
    ['git@github.com:Octocat/Hello-World.git', 'github.com', 'octocat', 'hello-world'],
    ['ssh://git@github.com/Octocat/Hello-World.git', 'github.com', 'octocat', 'hello-world'],
    ['git://github.com/Octocat/Hello-World.git', 'github.com', 'octocat', 'hello-world'],
    ['https://user@github.com/Octocat/Hello-World', 'github.com', 'octocat', 'hello-world'],
    ['deploy@ghe.example.com:Team/Repo.git', 'ghe.example.com', 'team', 'repo'],
    ['https://ghe.example.com/Team/Repo', 'ghe.example.com', 'team', 'repo'],
  ])('parses %s', (url, host, owner, repo) => {
    const identity = parseGitHubRemote(url, HOSTS);
    expect(identity).not.toBeNull();
    expect(identity?.host).toBe(host);
    expect(identity?.owner).toBe(owner);
    expect(identity?.repo).toBe(repo);
  });

  it('preserves original case for display while comparing lowercase', () => {
    const identity = parseGitHubRemote('https://github.com/Octocat/Hello-World.git', HOSTS);
    expect(identity?.displayPath).toBe('Octocat/Hello-World');
  });

  it('strips only a single trailing .git', () => {
    expect(parseGitHubRemote('https://github.com/o/repo.git.git', HOSTS)?.repo).toBe('repo.git');
  });

  it('rejects near-miss hosts', () => {
    for (const url of [
      'https://github.com.evil.example/octocat/hello-world.git',
      'git@github.com.evil.example:octocat/hello-world.git',
      'https://notgithub.com/octocat/hello-world.git',
      'https://gitlab.com/octocat/hello-world.git',
    ]) {
      expect(parseGitHubRemote(url, HOSTS), url).toBeNull();
    }
  });

  it('treats an unrecognised SSH alias as no evidence', () => {
    expect(parseGitHubRemote('git@work-github:octocat/hello-world.git', HOSTS)).toBeNull();
  });

  it('rejects paths that are not exactly owner/repo', () => {
    for (const url of [
      'https://github.com/octocat',
      'https://github.com/',
      'https://github.com/group/sub/repo.git',
      'git@github.com:octocat',
    ]) {
      expect(parseGitHubRemote(url, HOSTS), url).toBeNull();
    }
  });

  it('rejects unsupported schemes and empty input', () => {
    expect(parseGitHubRemote('file:///tmp/github.com/o/r', HOSTS)).toBeNull();
    expect(parseGitHubRemote('   ', HOSTS)).toBeNull();
    expect(parseGitHubRemote('https://github.com/o/r', [])).toBeNull();
  });
});

describe('collectFetchRemoteIdentities', () => {
  it('returns every matching fetch remote, origin first', () => {
    const identities = collectFetchRemoteIdentities('/w', HOSTS, {
      createVcs: fakeVcs([
        { name: 'upstream', url: 'https://github.com/upstream-owner/repo.git', type: 'fetch' },
        { name: 'upstream', url: 'https://github.com/upstream-owner/repo.git', type: 'push' },
        { name: 'origin', url: 'git@github.com:octocat/repo.git', type: 'fetch' },
        { name: 'origin', url: 'git@github.com:octocat/repo.git', type: 'push' },
      ]),
    });
    expect(identities.map((identity) => identity.remoteName)).toEqual(['origin', 'upstream']);
    expect(identities[0].owner).toBe('octocat');
    expect(identities[1].owner).toBe('upstream-owner');
  });

  it('excludes push-only remotes', () => {
    const identities = collectFetchRemoteIdentities('/w', HOSTS, {
      createVcs: fakeVcs([
        { name: 'mirror', url: 'https://github.com/mirror-owner/repo.git', type: 'push' },
      ]),
    });
    expect(identities).toEqual([]);
  });

  it('drops remotes on unknown hosts but keeps the rest', () => {
    const identities = collectFetchRemoteIdentities('/w', HOSTS, {
      createVcs: fakeVcs([
        { name: 'origin', url: 'https://github.com/octocat/repo.git', type: 'fetch' },
        { name: 'evil', url: 'https://github.com.evil.example/octocat/repo.git', type: 'fetch' },
      ]),
    });
    expect(identities).toHaveLength(1);
    expect(identities[0].remoteName).toBe('origin');
  });

  it('returns nothing for a non-git directory, a remoteless repo, or no cwd', () => {
    expect(collectFetchRemoteIdentities('/w', HOSTS, { createVcs: fakeVcs([], false) }).length).toBe(
      0,
    );
    expect(collectFetchRemoteIdentities('/w', HOSTS, { createVcs: fakeVcs([]) }).length).toBe(0);
    expect(collectFetchRemoteIdentities('', HOSTS).length).toBe(0);
  });

  it('returns nothing when the VCS manager throws', () => {
    const throwing = vi.fn(() => {
      throw new Error('git missing');
    });
    expect(
      collectFetchRemoteIdentities('/w', HOSTS, {
        createVcs: throwing as unknown as typeof import('../../workspace/git/vcs-manager').createVcsManager,
      }),
    ).toEqual([]);
  });
});
