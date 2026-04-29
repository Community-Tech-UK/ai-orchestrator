import type {
  ChildStateCategory,
  ChildStateDeriverOptions,
  ChildStateInput,
} from './child-state-deriver';
import { deriveChildState } from './child-state-deriver';
import type {
  HudChildEntry,
  OrchestrationHudSnapshot,
} from '../types/orchestration-hud.types';

export interface HudChildInput extends ChildStateInput {
  instanceId: string;
  displayName: string;
  role?: string;
  spawnPromptHash?: string;
  activity?: string;
}

const CATEGORY_ORDER: Record<ChildStateCategory, number> = {
  failed: 0,
  waiting: 1,
  active: 2,
  stale: 3,
  idle: 4,
};

export function buildHudSnapshot(
  parentInstanceId: string,
  children: HudChildInput[],
  options: ChildStateDeriverOptions = {},
): OrchestrationHudSnapshot {
  const now = options.now ?? Date.now();
  const countsByCategory = emptyCounts();
  const entries = children.map((child): HudChildEntry => {
    const derived = deriveChildState(child, { ...options, now });
    countsByCategory[derived.category] += 1;
    return {
      instanceId: child.instanceId,
      displayName: child.displayName,
      role: child.role,
      spawnPromptHash: child.spawnPromptHash,
      derived,
      activity: child.activity,
    };
  }).sort(compareHudEntries);

  return {
    parentInstanceId,
    totalChildren: entries.length,
    countsByCategory,
    churningCount: entries.filter((entry) => entry.derived.isChurning).length,
    children: entries,
    attentionItems: entries.filter((entry) =>
      entry.derived.category === 'failed'
      || entry.derived.category === 'waiting'
      || entry.derived.isChurning
    ),
    generatedAt: now,
  };
}

function emptyCounts(): Record<ChildStateCategory, number> {
  return {
    failed: 0,
    waiting: 0,
    active: 0,
    stale: 0,
    idle: 0,
  };
}

function compareHudEntries(a: HudChildEntry, b: HudChildEntry): number {
  const byCategory = CATEGORY_ORDER[a.derived.category] - CATEGORY_ORDER[b.derived.category];
  if (byCategory !== 0) {
    return byCategory;
  }
  if (a.derived.isChurning !== b.derived.isChurning) {
    return a.derived.isChurning ? -1 : 1;
  }
  return b.derived.lastActivityAt - a.derived.lastActivityAt;
}
