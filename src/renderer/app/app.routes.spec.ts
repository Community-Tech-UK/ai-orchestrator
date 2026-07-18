import type { Route, Routes } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { routes } from './app.routes';
import { CONTROL_SURFACES } from './shared/control-surface/control-surface.registry';

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function childPath(parent: string, child: string | undefined): string {
  if (!child) {
    return parent || '/';
  }
  const joined = `${parent}/${child}`.replace(/\/+/g, '/');
  return normalizePath(joined);
}

function routeHasControlSurfaceData(route: Route): boolean {
  return typeof route.data?.['controlSurfaceId'] === 'string';
}

function collectTopLevelPaths(appRoutes: Routes): string[] {
  return appRoutes
    .filter((route) => route.path && route.redirectTo === undefined)
    .map((route) => normalizePath(route.path as string));
}

function findShellRoute(appRoutes: Routes): Route | undefined {
  return appRoutes.find((route) =>
    route.path === ''
    && Boolean(route.children?.length)
    && route.loadComponent !== undefined
  );
}

function collectShellChildPaths(shellRoute: Route): string[] {
  return (shellRoute.children ?? [])
    .filter((route) => route.path && route.redirectTo === undefined)
    .map((route) => childPath('', route.path));
}

function collectShellChildrenByPath(shellRoute: Route): Map<string, Route> {
  return new Map(
    (shellRoute.children ?? [])
      .filter((route) => route.path && route.redirectTo === undefined)
      .map((route) => [childPath('', route.path), route]),
  );
}

describe('app routes', () => {
  it('keeps dashboard, setup, operator redirect, and catch-all outside the Control Center shell', () => {
    const topLevelPaths = collectTopLevelPaths(routes);

    expect(topLevelPaths).toContain('/setup');
    expect(routes.find((route) => route.path === '')?.children).toBeUndefined();
    expect(routes.find((route) => route.path === 'operator')?.redirectTo).toBe('');
    expect(routes.find((route) => route.path === '**')?.redirectTo).toBe('');
  });

  it('places every Control Surface route under the shell route', () => {
    const shellRoute = findShellRoute(routes);
    expect(shellRoute).toBeDefined();

    const shellPaths = collectShellChildPaths(shellRoute as Route).sort();
    const registryPaths = CONTROL_SURFACES.map((surface) => surface.path).sort();

    expect(shellPaths).toEqual(registryPaths);
  });

  it('does not leave Control Surface routes as top-level siblings', () => {
    const topLevelPaths = new Set(collectTopLevelPaths(routes));

    for (const surface of CONTROL_SURFACES) {
      expect(topLevelPaths.has(surface.path)).toBe(false);
    }
  });

  it('adds control surface metadata to every shell child route', () => {
    const shellRoute = findShellRoute(routes);
    expect(shellRoute).toBeDefined();

    for (const child of (shellRoute as Route).children ?? []) {
      if (child.redirectTo === undefined) {
        expect(routeHasControlSurfaceData(child)).toBe(true);
      }
    }
  });

  it('matches shell route metadata to the registry item for each path', () => {
    const shellRoute = findShellRoute(routes);
    expect(shellRoute).toBeDefined();

    const shellChildrenByPath = collectShellChildrenByPath(shellRoute as Route);

    for (const surface of CONTROL_SURFACES) {
      expect(shellChildrenByPath.get(surface.path)?.data?.['controlSurfaceId']).toBe(surface.id);
    }
  });

  it('lazy-loads the Workboard at /work through Control Surface metadata', () => {
    const shellRoute = findShellRoute(routes);
    const workRoute = (shellRoute?.children ?? []).find((route) => route.path === 'work');
    expect(workRoute).toBeDefined();
    expect(workRoute?.loadComponent).toBeTypeOf('function');
    expect(workRoute?.data?.['controlSurfaceId']).toBe('workboard');
  });

  it('keeps /fleet as an explicit redirect alias to work (not a canonical surface)', () => {
    const shellRoute = findShellRoute(routes);
    const fleetRoute = (shellRoute?.children ?? []).find((route) => route.path === 'fleet');
    expect(fleetRoute).toBeDefined();
    expect(fleetRoute?.redirectTo).toBe('work');
    expect(fleetRoute?.pathMatch).toBe('full');
    // The alias is not a registered Control Surface, so it must not appear as
    // one of the shell's canonical (non-redirect) child paths.
    expect(collectShellChildPaths(shellRoute as Route)).not.toContain('/fleet');
  });
});
