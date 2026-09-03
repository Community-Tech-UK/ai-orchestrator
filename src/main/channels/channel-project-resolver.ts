/**
 * Channel project grouping and named-target resolution.
 *
 * Extracted from `channel-message-router.ts` so the router stays inside its
 * LOC ceiling. The router still owns pins and pending pick lists; this
 * module only groups instances and resolves project / instance names.
 * Behaviour matches the previous private methods.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getRecentDirectoriesManager } from '../core/config/recent-directories-manager';

export const NO_PROJECT_KEY = '__no_project__';
export const NO_PROJECT_LABEL = '(no project)';
export const ACTIVE_SESSION_STATUSES = new Set([
  'initializing',
  'ready',
  'idle',
  'busy',
  'processing',
  'thinking_deeply',
  'waiting_for_input',
  'waiting_for_permission',
  'interrupting',
  'cancelling',
  'interrupt-escalating',
  'cancelled',
  'respawning',
  'waking',
  'degraded',
]);

export interface ProjectDescriptor {
  key: string;
  label: string;
  workingDirectory: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activeInstances: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hibernatedInstances: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  historyEntries: any[];
  lastActivity: number;
}

export type ResolvedNamedTarget =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { kind: 'instance'; instance: any }
  | { kind: 'project'; project: ProjectDescriptor };

export interface ChannelProjectResolverDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getInstances: () => any[];
  getPendingProjects: (pickKey: string) => ProjectDescriptor[] | undefined;
}

export function getProjectKey(workingDirectory: string | null | undefined): string {
  const normalized = (workingDirectory ?? '').trim();
  return normalized ? normalized.toLowerCase() : NO_PROJECT_KEY;
}

export function getProjectLabel(
  workingDirectory: string | null | undefined,
  fallbackLabel?: string,
): string {
  const normalized = (workingDirectory ?? '').trim();
  if (fallbackLabel?.trim()) {
    return fallbackLabel.trim();
  }
  if (!normalized) {
    return NO_PROJECT_LABEL;
  }
  return path.basename(normalized) || normalized;
}

export function isSafeWorkingDirectory(dir: string): boolean {
  const resolved = path.resolve(dir);
  return resolved !== path.parse(resolved).root;
}

export function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isActiveSession(instance: any): boolean {
  return ACTIVE_SESSION_STATUSES.has(String(instance.status || ''));
}

export function sortByLastActivity<T extends { lastActivity?: number }>(instances: T[]): T[] {
  return [...instances].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getProjectMap(instances: any[]): Map<string, any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = new Map<string, any[]>();

  for (const inst of instances) {
    const dir = (inst.workingDirectory || '').trim();
    const key = getProjectKey(dir);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key)!.push(inst);
  }
  return map;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getActiveInstances(project: ProjectDescriptor): any[] {
  return sortByLastActivity(
    project.activeInstances.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (instance: any) => isActiveSession(instance),
    ),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRevivableInstances(project: ProjectDescriptor): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byId = new Map<string, any>();
  for (const entry of project.hibernatedInstances) {
    const id = entry.instanceId || entry.id;
    if (!id || byId.has(id)) {
      continue;
    }
    byId.set(id, {
      id,
      displayName: entry.displayName,
      workingDirectory: entry.workingDirectory || project.workingDirectory || '',
      status: 'hibernated',
      lastActivity: entry.hibernatedAt || entry.lastActivity,
    });
  }
  return sortByLastActivity([...byId.values()]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRouteableInstances(project: ProjectDescriptor): any[] {
  return [
    ...getActiveInstances(project),
    ...getRevivableInstances(project),
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getHibernatedByProject(): Map<string, any[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getHibernationManager } = require('../process/hibernation-manager');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hibernated: any[] = getHibernationManager().getHibernatedInstances?.() ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = new Map<string, any[]>();
    for (const h of hibernated) {
      const dir = (h.workingDirectory || '').trim();
      const key = getProjectKey(dir);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(h);
    }
    return map;
  } catch {
    return new Map();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getHistoryByProject(): Map<string, { dir: string; entries: any[] }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getHistoryManager } = require('../history/history-manager');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries: any[] = getHistoryManager().getEntries?.() ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = new Map<string, { dir: string; entries: any[] }>();
    for (const e of entries) {
      const dir = (e.workingDirectory || '').trim();
      const key = getProjectKey(dir);
      if (!map.has(key)) map.set(key, { dir, entries: [] });
      map.get(key)!.entries.push(e);
    }
    return map;
  } catch {
    return new Map();
  }
}

export async function resolveDefaultWorkingDirectory(): Promise<string> {
  try {
    const recent = await getRecentDirectoriesManager().getDirectories({ sortBy: 'lastAccessed' });
    for (const entry of recent) {
      const dir = (entry.path || '').trim();
      if (dir && isSafeWorkingDirectory(dir) && directoryExists(dir)) {
        return dir;
      }
    }
  } catch {
    // Ignore recent-directory failures; the home-dir fallback is always safe.
  }
  return os.homedir();
}

export async function getProjectDescriptors(
  deps: ChannelProjectResolverDeps,
): Promise<Map<string, ProjectDescriptor>> {
  const descriptors = new Map<string, ProjectDescriptor>();

  const ensureDescriptor = (
    workingDirectory: string | null | undefined,
    fallbackLabel?: string,
  ): ProjectDescriptor => {
    const normalized = (workingDirectory ?? '').trim() || null;
    const key = getProjectKey(normalized);
    const existing = descriptors.get(key);
    if (existing) {
      if (!existing.workingDirectory && normalized) {
        existing.workingDirectory = normalized;
      }
      if (existing.label === NO_PROJECT_LABEL && fallbackLabel?.trim()) {
        existing.label = fallbackLabel.trim();
      }
      return existing;
    }

    const descriptor: ProjectDescriptor = {
      key,
      label: getProjectLabel(normalized, fallbackLabel),
      workingDirectory: normalized,
      activeInstances: [],
      hibernatedInstances: [],
      historyEntries: [],
      lastActivity: 0,
    };
    descriptors.set(key, descriptor);
    return descriptor;
  };

  try {
    const recentDirectories = await getRecentDirectoriesManager().getDirectories({
      sortBy: 'lastAccessed',
    });
    for (const entry of recentDirectories) {
      const descriptor = ensureDescriptor(entry.path, entry.displayName);
      descriptor.lastActivity = Math.max(descriptor.lastActivity, entry.lastAccessed || 0);
    }
  } catch {
    // Ignore recent-directory failures; live/history state still builds a project list.
  }

  for (const instances of getProjectMap(deps.getInstances()).values()) {
    for (const instance of instances) {
      const descriptor = ensureDescriptor(instance.workingDirectory);
      if (instance.status === 'hibernated') {
        descriptor.hibernatedInstances.push({
          instanceId: instance.id,
          displayName: instance.displayName,
          workingDirectory: instance.workingDirectory,
          hibernatedAt: instance.lastActivity || 0,
        });
      } else {
        descriptor.activeInstances.push(instance);
      }
      descriptor.lastActivity = Math.max(descriptor.lastActivity, instance.lastActivity || 0);
    }
  }

  for (const instances of getHibernatedByProject().values()) {
    for (const instance of instances) {
      const descriptor = ensureDescriptor(instance.workingDirectory);
      descriptor.hibernatedInstances.push(instance);
      descriptor.lastActivity = Math.max(descriptor.lastActivity, instance.hibernatedAt || 0);
    }
  }

  for (const { dir, entries } of getHistoryByProject().values()) {
    const descriptor = ensureDescriptor(dir);
    descriptor.historyEntries.push(...entries);
    for (const entry of entries) {
      descriptor.lastActivity = Math.max(
        descriptor.lastActivity,
        entry.endedAt || entry.createdAt || 0,
      );
    }
  }

  return descriptors;
}

export async function resolveProject(
  deps: ChannelProjectResolverDeps,
  projectName: string,
): Promise<ProjectDescriptor | null> {
  const normalizedQuery = projectName.trim();
  if (!normalizedQuery) {
    return null;
  }

  const descriptors = await getProjectDescriptors(deps);
  const queryLower = normalizedQuery.toLowerCase();

  const byKey = descriptors.get(getProjectKey(normalizedQuery));
  if (byKey) {
    return byKey;
  }

  const exactLabelMatch = [...descriptors.values()].find(
    descriptor => descriptor.label.toLowerCase() === queryLower,
  );
  if (exactLabelMatch) {
    return exactLabelMatch;
  }

  const prefixMatch = [...descriptors.values()].find(descriptor => {
    const workingDirectory = descriptor.workingDirectory?.toLowerCase() || '';
    return descriptor.label.toLowerCase().startsWith(queryLower) || workingDirectory.startsWith(queryLower);
  });
  if (prefixMatch) {
    return prefixMatch;
  }

  if (fs.existsSync(normalizedQuery)) {
    const resolvedPath = path.resolve(normalizedQuery);
    if (fs.statSync(resolvedPath).isDirectory()) {
      return {
        key: getProjectKey(resolvedPath),
        label: getProjectLabel(resolvedPath),
        workingDirectory: resolvedPath,
        activeInstances: [],
        hibernatedInstances: [],
        historyEntries: [],
        lastActivity: Date.now(),
      };
    }
  }

  return null;
}

export async function resolveProjectByNumberOrName(
  deps: ChannelProjectResolverDeps,
  input: string,
  pickKey: string,
): Promise<ProjectDescriptor | null> {
  const num = parseInt(input, 10);
  const pending = deps.getPendingProjects(pickKey);
  if (!isNaN(num) && String(num) === input.trim() && pending) {
    if (num >= 1 && num <= pending.length) {
      return pending[num - 1];
    }
  }
  return resolveProject(deps, input);
}

export async function resolveNamedTarget(
  deps: ChannelProjectResolverDeps,
  projectName: string,
  instanceName?: string,
  strictInstanceName = false,
): Promise<ResolvedNamedTarget | null> {
  const project = await resolveProject(deps, projectName);
  if (!project) {
    return null;
  }

  const routeableInstances = getRouteableInstances(project);

  if (instanceName) {
    const needle = instanceName.toLowerCase();
    const matchedInstance = routeableInstances.find(instance => {
      const displayName = (instance.displayName || '').toLowerCase();
      return displayName.includes(needle) || String(instance.id || '').toLowerCase() === needle;
    });
    if (matchedInstance) {
      return { kind: 'instance', instance: matchedInstance };
    }
    return strictInstanceName ? null : project.workingDirectory ? { kind: 'project', project } : null;
  }

  if (routeableInstances.length > 0) {
    return { kind: 'instance', instance: routeableInstances[0] };
  }

  return project.workingDirectory ? { kind: 'project', project } : null;
}
