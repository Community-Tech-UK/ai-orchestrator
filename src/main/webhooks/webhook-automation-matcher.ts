import type { Automation } from '../../shared/types/automation.types';
import type { WebhookRouteConfig } from '../../shared/types/webhook.types';

type AutomationReader = Pick<{ list(): Promise<Automation[]> }, 'list'>;

/**
 * Resolves the automations that an authenticated webhook delivery may start.
 * Route allow-lists are an explicit authorization boundary, so an empty list
 * intentionally matches nothing even when an automation references the route.
 */
export class WebhookAutomationMatcher {
  constructor(private readonly automations: AutomationReader) {}

  async match(route: WebhookRouteConfig, payload: Record<string, unknown>): Promise<Automation[]> {
    if (!route.enabled || route.allowedAutomationIds.length === 0) {
      return [];
    }

    const allowedIds = new Set(route.allowedAutomationIds);
    const automations = await this.automations.list();
    return automations.filter((automation) =>
      allowedIds.has(automation.id)
      && automation.enabled
      && automation.active
      && automation.trigger.kind === 'webhook'
      && automation.trigger.routeId === route.id
      && automation.trigger.filters.every((filter) => matchesFilter(payload, filter)),
    );
  }
}

function matchesFilter(
  payload: Record<string, unknown>,
  filter: { path: string; operator: 'equals' | 'contains'; value: string },
): boolean {
  const value = resolveDottedPath(payload, filter.path);
  if (value === undefined) {
    return false;
  }

  if (filter.operator === 'equals') {
    return isScalar(value) && String(value) === filter.value;
  }

  if (typeof value === 'string') {
    return value.includes(filter.value);
  }
  return Array.isArray(value) && value.some((item) => isScalar(item) && String(item).includes(filter.value));
}

function resolveDottedPath(payload: Record<string, unknown>, path: string): unknown {
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
