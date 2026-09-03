import { describe, expect, it } from 'vitest';
import {
  getProjectKey,
  getProjectLabel,
  getRouteableInstances,
  isSafeWorkingDirectory,
  NO_PROJECT_KEY,
  NO_PROJECT_LABEL,
  resolveNamedTarget,
  resolveProject,
  type ChannelProjectResolverDeps,
  type ProjectDescriptor,
} from './channel-project-resolver';

function emptyDeps(overrides: Partial<ChannelProjectResolverDeps> = {}): ChannelProjectResolverDeps {
  return {
    getInstances: () => [],
    getPendingProjects: () => undefined,
    ...overrides,
  };
}

function project(partial: Partial<ProjectDescriptor> = {}): ProjectDescriptor {
  return {
    key: 'proj',
    label: 'demo',
    workingDirectory: '/tmp/demo',
    activeInstances: [],
    hibernatedInstances: [],
    historyEntries: [],
    lastActivity: 0,
    ...partial,
  };
}

describe('channel-project-resolver', () => {
  it('normalizes empty directories to the no-project key', () => {
    expect(getProjectKey('')).toBe(NO_PROJECT_KEY);
    expect(getProjectKey('  ')).toBe(NO_PROJECT_KEY);
    expect(getProjectKey('/Users/me/App')).toBe('/users/me/app');
  });

  it('prefers an explicit label over the directory basename', () => {
    expect(getProjectLabel('/Users/me/App', 'My App')).toBe('My App');
    expect(getProjectLabel('/Users/me/App')).toBe('App');
    expect(getProjectLabel('')).toBe(NO_PROJECT_LABEL);
  });

  it('rejects the filesystem root as a working directory', () => {
    expect(isSafeWorkingDirectory('/')).toBe(false);
    expect(isSafeWorkingDirectory('/Users/me/project')).toBe(true);
  });

  it('prefers active sessions over hibernated ones when routing', () => {
    const routed = getRouteableInstances(project({
      activeInstances: [
        { id: 'old', status: 'idle', lastActivity: 10, displayName: 'old' },
        { id: 'new', status: 'idle', lastActivity: 99, displayName: 'new' },
      ],
      hibernatedInstances: [
        { instanceId: 'hib', displayName: 'hib', hibernatedAt: 50 },
      ],
    }));
    expect(routed[0]?.id).toBe('new');
    expect(routed.some((instance) => instance.id === 'hib')).toBe(true);
  });

  it('resolves a project by exact label from live instances', async () => {
    const found = await resolveProject(emptyDeps({
      getInstances: () => [{
        id: 'i1',
        displayName: 'alpha',
        workingDirectory: '/tmp/demo',
        status: 'idle',
        lastActivity: 1,
      }],
    }), 'demo');
    expect(found?.label).toBe('demo');
    expect(found?.workingDirectory).toBe('/tmp/demo');
  });

  it('returns null for an empty project query', async () => {
    expect(await resolveProject(emptyDeps(), '   ')).toBeNull();
  });

  it('matches a named instance inside a resolved project', async () => {
    const target = await resolveNamedTarget(emptyDeps({
      getInstances: () => [{
        id: 'i1',
        displayName: 'Login Probe',
        workingDirectory: '/tmp/demo',
        status: 'idle',
        lastActivity: 1,
      }],
    }), 'demo', 'login');
    expect(target?.kind).toBe('instance');
    if (target?.kind === 'instance') {
      expect(target.instance.id).toBe('i1');
    }
  });
});
