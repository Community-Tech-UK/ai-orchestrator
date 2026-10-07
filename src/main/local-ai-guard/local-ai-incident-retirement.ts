import type { LocalAiHealthRepository } from './local-ai-health-repository';
import type { LocalAiTargetRepository } from './local-ai-target-repository';

type IncidentStore = Pick<LocalAiHealthRepository, 'listIncidents' | 'upsertIncident'>;

/**
 * A retired target is no longer probed, so probe recovery can never close its
 * incidents. Resolve them with the lifecycle change (and again on startup for
 * targets that were already retired) so status stops listing a warning for a
 * target that no longer exists (LT-664).
 */
export function closeIncidentsForRetiredTarget(
  health: IncidentStore,
  targetId: string,
  at: number,
): void {
  const incidents = [
    ...health.listIncidents({ targetId, state: 'open', limit: 100 }),
    ...health.listIncidents({ targetId, state: 'acknowledged', limit: 100 }),
  ];
  for (const incident of incidents) {
    health.upsertIncident({
      kind: 'resolve',
      incidentId: incident.id,
      at: Math.max(at, incident.updatedAt, incident.openedAt),
    });
  }
}

export function closeIncidentsForRetiredTargets(
  targets: Pick<LocalAiTargetRepository, 'list'>,
  health: IncidentStore,
  at: number,
): void {
  for (const target of targets.list({ includeRetired: true })) {
    if (target.lifecycle !== 'retired') continue;
    closeIncidentsForRetiredTarget(health, target.id, at);
  }
}
