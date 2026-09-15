import { Injectable, inject } from '@angular/core';
import { HostStore } from './host-store';

export type MobileBrowseRoute = '/projects' | '/history';
export interface MobileBrowseState {
  query: string;
  filter: 'all' | 'active' | 'attention';
  mode: 'project' | 'chronological';
  expandedKeys: string[] | null;
  showAllKeys: string[];
  scrollTop: number;
}

function emptyState(): MobileBrowseState {
  return { query: '', filter: 'all', mode: 'project', expandedKeys: null, showAllKeys: [], scrollTop: 0 };
}

/** Only allow known browse destinations from the same paired host. */
export function safeBrowseReturnRoute(
  state: unknown,
  hostId: string | null,
  fallback: MobileBrowseRoute = '/projects',
): MobileBrowseRoute {
  if (!hostId || !state || typeof state !== 'object') return fallback;
  const origin = (state as Record<string, unknown>)['mobileBrowseOrigin'];
  if (!origin || typeof origin !== 'object') return fallback;
  const value = origin as Record<string, unknown>;
  return value['hostId'] === hostId && (value['route'] === '/projects' || value['route'] === '/history')
    ? value['route'] : fallback;
}

/** In-memory browse preferences; no paths, model selections or draft text cross hosts. */
@Injectable({ providedIn: 'root' })
export class MobileBrowseStateStore {
  private readonly hosts = inject(HostStore);
  private readonly states = new Map<string, MobileBrowseState>();

  read(route: MobileBrowseRoute, hostId = this.hosts.activeHost()?.id ?? null): MobileBrowseState {
    const state = hostId ? this.states.get(JSON.stringify([hostId, route])) : undefined;
    return state ? { ...state, expandedKeys: state.expandedKeys?.slice() ?? null, showAllKeys: state.showAllKeys.slice() } : emptyState();
  }

  save(route: MobileBrowseRoute, state: MobileBrowseState, hostId = this.hosts.activeHost()?.id ?? null): void {
    if (!hostId) return;
    this.states.set(JSON.stringify([hostId, route]), {
      ...state,
      expandedKeys: state.expandedKeys?.slice() ?? null,
      showAllKeys: state.showAllKeys.slice(),
      scrollTop: Number.isFinite(state.scrollTop) ? Math.max(0, state.scrollTop) : 0,
    });
  }

  navigationState(route: MobileBrowseRoute): { mobileBrowseOrigin: { hostId: string | null; route: MobileBrowseRoute } } {
    return { mobileBrowseOrigin: { hostId: this.hosts.activeHost()?.id ?? null, route } };
  }

  returnRoute(state: unknown, fallback: MobileBrowseRoute = '/projects'): MobileBrowseRoute {
    return safeBrowseReturnRoute(state, this.hosts.activeHost()?.id ?? null, fallback);
  }
}
