import type { ControlSurfaceId, ControlSurfaceRouteData } from './control-surface.types';

export function controlSurfaceRouteData(id: ControlSurfaceId): ControlSurfaceRouteData {
  return { controlSurfaceId: id };
}
