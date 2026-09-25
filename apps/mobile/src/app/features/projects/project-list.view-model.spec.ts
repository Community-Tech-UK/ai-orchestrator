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
  projectSummary,
  projectParentLabel,
  projectSessionPreview,
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
    attentionLevel: 'working',
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

  it('shows only desktop-active live rows and removes projects without active sessions', () => {
    const groups = buildProjectGroups(
      [],
      [
        ...live,
        {
          ...live[0],
          id: 'idle-2',
          displayName: 'Waiting for the next prompt',
          status: 'idle',
          lastActivity: 15,
        },
        {
          ...live[0],
          id: 'hibernated-4',
          displayName: 'Hibernated session',
          status: 'hibernated',
          lastActivity: 12,
        },
        {
          ...live[0],
          id: 'failed-3',
          displayName: 'Failed terminal session',
          status: 'failed',
          workingDirectory: '/work/terminal',
          projectName: 'terminal',
          lastActivity: 30,
        },
      ],
      history,
      recent,
    );

    const active = filterProjectGroups(groups, '', 'active');

    expect(active.map((group) => group.project.name)).toEqual(['aio']);
    expect(active[0].sessions.map((row) => row.id)).toEqual(['live-1', 'idle-2', 'hibernated-4']);
  });

  it('applies text search without restoring rows removed by the active filter', () => {
    const groups = buildProjectGroups([], live, history, recent);

    expect(filterProjectGroups(groups, 'older', 'active')).toEqual([]);
    expect(
      filterProjectGroups(groups, 'aio', 'active')[0].sessions.map((row) => row.id),
    ).toEqual(['live-1']);
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

describe('project attention and large-group previews', () => {
  it('rebuilds the canonical needs-attention count from instance attention levels', () => {
    const projects = mergeProjects(
      [{
        key: '/work/aio',
        path: '/work/aio',
        name: 'aio',
        sessionCount: 99,
        busyCount: 99,
        pendingApprovalCount: 99,
        needsAttentionCount: 99,
        lastActivity: 1,
      }],
      [
        { ...live[0], id: 'blocked', attentionLevel: 'blocked', status: 'waiting_for_input' },
        { ...live[0], id: 'failed', attentionLevel: 'failed', status: 'degraded' },
        { ...live[0], id: 'review', attentionLevel: 'review', status: 'idle' },
      ],
      [],
      [],
    );

    expect(projects[0].needsAttentionCount).toBe(2);
  });

  it('finds failed and approval work separately from the unchanged Active filter', () => {
    const groups = buildProjectGroups([], [
      live[0],
      { ...live[0], id: 'failed', status: 'failed' },
      { ...live[0], id: 'approval', pendingApprovalCount: 1, status: 'waiting_for_permission' },
      { ...live[0], id: 'hibernated', status: 'hibernated' },
    ], [], []);
    expect(filterProjectGroups(groups, '', 'attention')[0].sessions.map((row) => row.id)).toEqual(['failed', 'approval']);
    expect(filterProjectGroups(groups, '', 'active')[0].sessions.map((row) => row.id)).toEqual(['live-1', 'approval', 'hibernated']);
    expect(projectSummary(groups[0])).toBe('1 running · 1 needs you · 1 failed');
  });

  it('limits disclosure previews while searching every row and disambiguating duplicate folders', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ ...live[0], id: `row-${i}`, displayName: `Session ${i}`, lastActivity: i }));
    const groups = buildProjectGroups([], [...rows, { ...live[0], id: 'other', workingDirectory: '/different/aio' }], [], []);
    const group = groups.find((value) => value.project.key === '/work/aio')!;
    expect(projectSessionPreview(group, '', false)).toHaveLength(5);
    expect(projectSessionPreview(group, '', true)).toHaveLength(12);
    const found = filterProjectGroups(groups, 'Session 0')[0];
    expect(projectSessionPreview(found, 'Session 0', false).map((row) => row.id)).toEqual(['row-0']);
    expect(projectParentLabel(group, groups)).toBe('work');
  });

  it('uses enough parent path to distinguish deeply nested duplicate folder names', () => {
    const groups = buildProjectGroups([], [
      { ...live[0], workingDirectory: '/one/shared/work/aio' },
      { ...live[0], id: 'other', workingDirectory: '/two/shared/work/aio' },
    ], [], []);
    expect(projectParentLabel(groups[0], groups)).toBe('one/shared/work');
    expect(projectParentLabel(groups[1], groups)).toBe('two/shared/work');
  });

  it('handles a 30-project and 200-session browse fixture without losing results', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ ...live[0], id: `row-${i}`, displayName: `Fixture session ${i}`, workingDirectory: `/work/project-${i % 30}`, projectName: `project-${i % 30}`, lastActivity: i }));
    const started = performance.now();
    const groups = buildProjectGroups([], rows, [], []);
    const found = filterProjectGroups(groups, 'Fixture session 199');
    const duration = performance.now() - started;
    expect(groups).toHaveLength(30);
    expect(groups.flatMap((group) => group.sessions)).toHaveLength(200);
    expect(found[0].sessions[0].id).toBe('row-199');
    console.warn(`30-project/200-session view model: ${duration.toFixed(2)}ms`);
  });
});
