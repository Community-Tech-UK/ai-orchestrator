import type { AuxiliaryLlmSlot } from '../../../../shared/types/auxiliary-llm.types';
import type { LocalAiRoutingEvent } from '../../../../shared/types/local-ai-guard.types';

export interface LocalAiFallbackNotificationGroup {
  key: string;
  slot: AuxiliaryLlmSlot;
  newestCreatedAt: number;
  events: LocalAiRoutingEvent[];
  eventIds: string[];
}

interface MutableNotificationGroup {
  slot: AuxiliaryLlmSlot;
  newestCreatedAt: number;
  events: LocalAiRoutingEvent[];
}

export function groupLocalAiFallbackNotifications(
  events: readonly LocalAiRoutingEvent[],
): LocalAiFallbackNotificationGroup[] {
  const ordered = [...events].sort((left, right) =>
    right.createdAt - left.createdAt || right.id.localeCompare(left.id));
  const groups: MutableNotificationGroup[] = [];
  const groupBySlot = new Map<AuxiliaryLlmSlot, MutableNotificationGroup>();

  // One row per slot. The banner has no timestamp, so a time window only
  // repeats the same "Compression · Cost unknown" notice for every later burst.
  for (const event of ordered) {
    const current = groupBySlot.get(event.slot);
    if (current) {
      current.events.push(event);
      continue;
    }
    const next = {
      slot: event.slot,
      newestCreatedAt: event.createdAt,
      events: [event],
    };
    groups.push(next);
    groupBySlot.set(event.slot, next);
  }

  return groups.map((group) => {
    const eventIds = group.events.map((event) => event.id);
    return {
      ...group,
      key: eventIds.join(':'),
      eventIds,
    };
  });
}

export function fallbackNotificationGroupCostLabel(
  events: readonly LocalAiRoutingEvent[],
): string {
  let pricedCostUsd = 0;
  let unknownCount = 0;
  let hasEstimatedCost = false;

  for (const event of events) {
    if (event.knownCostUsd !== undefined) {
      pricedCostUsd += event.knownCostUsd;
    } else if (event.estimatedCostUsd !== undefined) {
      pricedCostUsd += event.estimatedCostUsd;
      hasEstimatedCost = true;
    } else {
      unknownCount += 1;
    }
  }

  if (unknownCount === events.length) return 'Cost unknown';

  const confidence = hasEstimatedCost ? 'estimated' : 'measured';
  const pricedLabel = `$${pricedCostUsd.toFixed(4)} ${confidence}`;
  if (unknownCount === 0) return pricedLabel;

  return `${pricedLabel} + ${unknownCount} cost${unknownCount === 1 ? '' : 's'} unknown`;
}
