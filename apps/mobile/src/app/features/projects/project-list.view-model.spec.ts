import { describe, expect, it } from 'vitest';
import type {
  MobileHistorySessionDto,
  MobileInstanceDto,
  MobileRecentDirDto,
} from '../../core/models';
import {
  buildProjectGroups,
  filterProjectGroups,
  flattenChronologicalSessions,
  initialExpandedProjectKeys,
  mergeProjects,
  newSessionNavigation,
  projectComposeAriaLabel,
  reconcileProjectGroupUpdate,
  releasePendingProjectGroups,
  sessionTargetRoute,
  toggleExpandedProjectKey,
} from './project-list.view-model';

const live: MobileInstanceDto[] = [
  {
    id: 'live-1',
    displayName: 'Polish Harness Mobile UX',
    status: 'busy',
    provider: 'codex',
    model: 'gpt-5.6',
    workingDirectory: '/work/aio',
    projectName: 'aio',
    createdAt: 1,
    lastActivity: 20,
    pendingApprovalCount: 0,
    hasUnreadCompletion: false,
  },
];

const history: MobileHistorySessionDto[] = [
  {
    id: 'history-live-1',
    name: 'Polish Harness Mobile UX',
    provider: 'codex',
    model: 'gpt-5.6',
    workingDirectory: '/work/aio',
    projectName: 'aio',
    createdAt: 1,
    lastActiveAt: 20,
    archived: false,
    live: true,
    instanceId: 'live-1',
  },
  {
    id: 'history-2',
    name: 'Older session',
    provider: 'claude',
    model: null,
    workingDirectory: '/work/aio',
    projectName: 'aio',
    createdAt: 1,
    lastActiveAt: 10,
    archived: true,
    live: false,
  },
];

const recent: MobileRecentDirDto[] = [
  {
    path: '/work/empty',
    displayName: 'empty',
    lastAccessed: 5,
    isPinned: false,
  },
];

describe('project list view model', () => {
  it('merges live, history, and recent directories without double-counting live history', () => {
    const projects = mergeProjects([], live, history, recent);

    expect(projects.map((project) => [project.name, project.sessionCount])).toEqual([
      ['aio', 2],
      ['empty', 0],
    ]);
  });

  it('builds one live and one history row with the live status presentation', () => {
    const groups = buildProjectGroups([], live, history, recent);

    expect(groups[0].sessions.map((row) => row.id)).toEqual(['live-1', 'history-2']);
    expect(groups[0].sessions[0]).toMatchObject({
      title: 'Polish Harness Mobile UX',
      subtitle: 'Codex · gpt-5.6',
      statusLabel: 'busy',
      tone: 'working',
      live: true,
    });
  });

  it('filters session matches without losing project context', () => {
    const groups = buildProjectGroups([], live, history, recent);

    expect(filterProjectGroups(groups, 'older')[0].sessions.map((row) => row.id)).toEqual([
      'history-2',
    ]);
    expect(filterProjectGroups(groups, 'aio')[0].sessions).toHaveLength(2);
    expect(filterProjectGroups(groups, 'missing')).toEqual([]);
  });

  it('routes live and history rows to their existing destinations', () => {
    const groups = buildProjectGroups([], live, history, recent);

    expect(sessionTargetRoute('/work/aio', groups[0].sessions[0])).toEqual([
      '/projects',
      '/work/aio',
      'sessions',
      'live-1',
    ]);
    expect(sessionTargetRoute('/work/aio', groups[0].sessions[1])).toEqual([
      '/history',
      'history-2',
    ]);
    expect(newSessionNavigation('/work/aio')).toEqual({
      commands: ['/new-session'],
      queryParams: { dir: '/work/aio' },
    });
    expect(newSessionNavigation()).toEqual({ commands: ['/new-session'] });
  });

  it('prioritizes approval and loop tones over generic idle presentation', () => {
    const groups = buildProjectGroups(
      [],
      [
        { ...live[0], status: 'idle', isLooping: true },
        {
          ...live[0],
          id: 'approval',
          displayName: 'Needs approval',
          status: 'waiting_for_permission',
          pendingApprovalCount: 1,
          lastActivity: 30,
        },
      ],
      [],
      [],
    );

    expect(groups[0].sessions.map((row) => [row.id, row.tone])).toEqual([
      ['approval', 'attention'],
      ['live-1', 'loop'],
    ]);
  });

  it('initially expands projects with sessions and toggles disclosure immutably', () => {
    const groups = buildProjectGroups([], live, history, recent);
    const initial = initialExpandedProjectKeys(groups);
    const collapsed = toggleExpandedProjectKey(initial, '/work/aio');

    expect([...initial]).toEqual(['/work/aio']);
    expect([...collapsed]).toEqual([]);
    expect([...toggleExpandedProjectKey(collapsed, '/work/aio')]).toEqual(['/work/aio']);
  });

  it('holds live resorting during a press and releases the newest pending groups', () => {
    const original = buildProjectGroups([], live, history, recent);
    const updated = buildProjectGroups([], [{ ...live[0], lastActivity: 100 }], history, recent);
    const held = reconcileProjectGroupUpdate(original, null, updated, true);

    expect(held.rendered).toBe(original);
    expect(held.pending).toBe(updated);
    expect(releasePendingProjectGroups(held.rendered, held.pending)).toBe(updated);
  });

  it('flattens sessions by activity and names project compose actions', () => {
    const groups = buildProjectGroups([], live, history, recent);

    expect(flattenChronologicalSessions(groups).map((row) => row.id)).toEqual([
      'live-1',
      'history-2',
    ]);
    expect(projectComposeAriaLabel(groups[0].project)).toBe('New session in aio');
  });
});
