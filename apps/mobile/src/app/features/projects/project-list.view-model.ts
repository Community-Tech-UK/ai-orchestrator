import type {
  MobileHistorySessionDto,
  MobileInstanceDto,
  MobileProjectDto,
  MobileRecentDirDto,
} from '../../core/models';
import {
  displayStatusLabel,
  isActiveSessionStatus,
  isWorkingOrLooping,
  needsAttention,
} from '../../core/status';
import type { MobileSessionRowView } from '../../shared/mobile-session-row.component';

export type SessionStateFilter = 'all' | 'active' | 'attention';

export interface ProjectSessionRow extends MobileSessionRowView {
  active: boolean;
}

export interface ProjectListGroup {
  project: MobileProjectDto;
  sessions: ProjectSessionRow[];
}

export interface NavigationTarget {
  commands: string[];
  queryParams?: { dir: string };
}

export interface ProjectGroupRenderState {
  rendered: ProjectListGroup[];
  pending: ProjectListGroup[] | null;
}

interface ProjectAccumulator {
  project: MobileProjectDto;
  sessionKeys: Set<string>;
}

export function mergeProjects(
  liveProjects: MobileProjectDto[],
  liveInstances: MobileInstanceDto[],
  history: MobileHistorySessionDto[],
  recentDirs: MobileRecentDirDto[],
): MobileProjectDto[] {
  const liveIds = new Set(liveInstances.map((instance) => instance.id));
  const byKey = new Map<string, ProjectAccumulator>();

  for (const project of liveProjects) {
    byKey.set(project.key, {
      project: {
        ...project,
        sessionCount: 0,
        busyCount: 0,
        pendingApprovalCount: 0,
        needsAttentionCount: 0,
      },
      sessionKeys: new Set<string>(),
    });
  }

  for (const instance of liveInstances) {
    const key = projectKey(instance.workingDirectory);
    const entry = ensureProject(byKey, key, instance.projectName, instance.lastActivity);
    entry.sessionKeys.add(`live:${instance.id}`);
    entry.project.lastActivity = Math.max(entry.project.lastActivity, instance.lastActivity);
    if (isWorkingOrLooping(instance)) entry.project.busyCount += 1;
    entry.project.pendingApprovalCount += instance.pendingApprovalCount;
    if (instance.attentionLevel === 'blocked' || instance.attentionLevel === 'failed') {
      entry.project.needsAttentionCount += 1;
    }
  }

  for (const session of history) {
    if (session.live && session.instanceId && liveIds.has(session.instanceId)) continue;
    const key = projectKey(session.workingDirectory);
    const entry = ensureProject(byKey, key, session.projectName, session.lastActiveAt);
    entry.sessionKeys.add(`history:${session.id}`);
    entry.project.lastActivity = Math.max(entry.project.lastActivity, session.lastActiveAt);
  }

  for (const directory of recentDirs) {
    ensureProject(byKey, directory.path, directory.displayName, directory.lastAccessed);
  }

  const projects = [...byKey.values()].map(({ project, sessionKeys }) => ({
    ...project,
    sessionCount: sessionKeys.size,
  }));

  return projects.sort((left, right) => {
    const rankDifference = projectRank(right) - projectRank(left);
    return rankDifference || right.lastActivity - left.lastActivity;
  });
}

export function buildProjectGroups(
  liveProjects: MobileProjectDto[],
  liveInstances: MobileInstanceDto[],
  history: MobileHistorySessionDto[],
  recentDirs: MobileRecentDirDto[],
): ProjectListGroup[] {
  const projects = mergeProjects(liveProjects, liveInstances, history, recentDirs);
  const liveIds = new Set(liveInstances.map((instance) => instance.id));

  return projects.map((project) => {
    const liveRows = liveInstances
      .filter((instance) => projectKey(instance.workingDirectory) === project.key)
      .map((instance) => ({ row: liveSessionRow(instance), lastActivity: instance.lastActivity }));
    const historyRows = history
      .filter((session) => projectKey(session.workingDirectory) === project.key)
      .filter(
        (session) => !(session.live && session.instanceId && liveIds.has(session.instanceId)),
      )
      .map((session) => ({ row: historySessionRow(session), lastActivity: session.lastActiveAt }));

    const sessions = [...liveRows, ...historyRows]
      .sort((left, right) => {
        if (left.row.live !== right.row.live) return left.row.live ? -1 : 1;
        return right.lastActivity - left.lastActivity;
      })
      .map(({ row }) => row);

    return { project, sessions };
  });
}

export function filterProjectGroups(
  groups: ProjectListGroup[],
  query: string,
  stateFilter: SessionStateFilter = 'all',
): ProjectListGroup[] {
  const normalized = query.trim().toLocaleLowerCase();

  const matches: ProjectListGroup[] = [];
  for (const group of groups) {
    const stateSessions = stateFilter === 'active'
      ? group.sessions.filter((session) => session.active)
      : stateFilter === 'attention'
        ? group.sessions.filter((session) => session.tone === 'attention' || session.tone === 'error')
        : group.sessions;
    if (stateFilter !== 'all' && stateSessions.length === 0) continue;
    if (!normalized) {
      matches.push(
        stateSessions === group.sessions ? group : { ...group, sessions: stateSessions },
      );
      continue;
    }

    const projectMatches = [group.project.name, group.project.path].some((value) =>
      value.toLocaleLowerCase().includes(normalized),
    );
    const sessions = projectMatches
      ? stateSessions
      : stateSessions.filter((session) =>
          [session.title, session.subtitle ?? '', session.statusLabel].some((value) =>
            value.toLocaleLowerCase().includes(normalized),
          ),
        );
    if (projectMatches || sessions.length > 0) matches.push({ ...group, sessions });
  }
  return matches;
}

export function sessionTargetRoute(
  project: string,
  session: MobileSessionRowView,
): string[] {
  return session.live
    ? ['/projects', project, 'sessions', session.id]
    : ['/history', session.id];
}

export function newSessionNavigation(directory?: string): NavigationTarget {
  return directory
    ? { commands: ['/new-session'], queryParams: { dir: directory } }
    : { commands: ['/new-session'] };
}

export function initialExpandedProjectKeys(groups: ProjectListGroup[]): Set<string> {
  return new Set(groups.filter((group) => group.sessions.length > 0).map((group) => group.project.key));
}

export function toggleExpandedProjectKey(current: Set<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function reconcileProjectGroupUpdate(
  rendered: ProjectListGroup[],
  pending: ProjectListGroup[] | null,
  incoming: ProjectListGroup[],
  interactionLocked: boolean,
): ProjectGroupRenderState {
  return interactionLocked
    ? { rendered, pending: incoming }
    : { rendered: incoming, pending: null };
}

export function releasePendingProjectGroups(
  rendered: ProjectListGroup[],
  pending: ProjectListGroup[] | null,
): ProjectListGroup[] {
  return pending ?? rendered;
}

export function flattenChronologicalSessions(groups: ProjectListGroup[]): MobileSessionRowView[] {
  return groups
    .flatMap((group) => group.sessions)
    .sort((left, right) => right.lastActivity - left.lastActivity);
}

export function projectComposeAriaLabel(project: MobileProjectDto): string {
  return `New session in ${project.name}`;
}

function ensureProject(
  projects: Map<string, ProjectAccumulator>,
  key: string,
  fallbackName: string,
  lastActivity: number,
): ProjectAccumulator {
  const existing = projects.get(key);
  if (existing) return existing;

  const path = key === '__no_workspace__' ? '' : key;
  const project = {
    key,
    path,
    name: fallbackName || projectName(path),
    sessionCount: 0,
    busyCount: 0,
    pendingApprovalCount: 0,
    needsAttentionCount: 0,
    lastActivity,
  };
  const created = { project, sessionKeys: new Set<string>() };
  projects.set(key, created);
  return created;
}

function liveSessionRow(instance: MobileInstanceDto): ProjectSessionRow {
  const status = instance.pendingApprovalCount > 0 ? 'Awaiting approval' : displayStatusLabel(instance);
  return {
    id: instance.id,
    title: instance.displayName,
    subtitle: sessionSubtitle(instance.provider, instance.model),
    statusLabel: status,
    tone: sessionTone(instance),
    unread: instance.hasUnreadCompletion,
    live: true,
    lastActivity: instance.lastActivity,
    active: isActiveSessionStatus(instance.status),
  };
}

function historySessionRow(session: MobileHistorySessionDto): ProjectSessionRow {
  return {
    id: session.id,
    title: session.name,
    subtitle: sessionSubtitle(session.provider ?? 'session', session.model ?? undefined),
    statusLabel: session.archived ? 'archived' : 'past',
    tone: 'history',
    unread: false,
    live: false,
    lastActivity: session.lastActiveAt,
    active: false,
  };
}

function sessionTone(instance: MobileInstanceDto): MobileSessionRowView['tone'] {
  if (instance.pendingApprovalCount > 0 || needsAttention(instance.status)) return 'attention';
  if (['error', 'failed', 'degraded'].includes(instance.status)) return 'error';
  if (instance.isLooping === true) return 'loop';
  if (isWorkingOrLooping(instance)) return 'working';
  return 'idle';
}

function sessionSubtitle(provider: string, model?: string): string {
  const label = provider
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toLocaleUpperCase() + part.slice(1))
    .join(' ');
  return model ? `${label} · ${model}` : label;
}

function projectKey(workingDirectory: string): string {
  return workingDirectory || '__no_workspace__';
}

function projectName(path: string): string {
  if (!path) return 'No workspace';
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function projectRank(project: MobileProjectDto): number {
  if (project.busyCount > 0 || project.pendingApprovalCount > 0) return 2;
  if (project.sessionCount > 0) return 1;
  return 0;
}

export const PROJECT_SESSION_PREVIEW = 5;

export function projectSessionPreview(group: ProjectListGroup, query: string, showAll: boolean): ProjectSessionRow[] {
  return query.trim() || showAll ? group.sessions : group.sessions.slice(0, PROJECT_SESSION_PREVIEW);
}

export function projectSummary(group: ProjectListGroup): string {
  const running = group.project.busyCount;
  const attention = group.sessions.filter((row) => row.tone === 'attention').length;
  const failed = group.sessions.filter((row) => row.tone === 'error').length;
  return [running ? `${running} running` : '', attention ? `${attention} needs you` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ');
}

export function projectParentLabel(group: ProjectListGroup, groups: ProjectListGroup[]): string {
  const siblings = groups.filter((item) => item.project.name === group.project.name);
  if (siblings.length < 2) return '';
  const parentParts = (item: ProjectListGroup) => item.project.path.split(/[\\/]/).filter(Boolean).slice(0, -1);
  const parts = parentParts(group);
  for (let count = 1; count <= parts.length; count++) {
    const label = parts.slice(-count).join('/');
    if (siblings.every((item) => item.project.key === group.project.key || parentParts(item).slice(-count).join('/') !== label)) return label;
  }
  return parts.join('/') || group.project.path;
}
