import type {
  ChildDerivedState,
  ChildStateCategory,
} from '../utils/child-state-deriver';

export interface HudChildEntry {
  instanceId: string;
  displayName: string;
  role?: string;
  spawnPromptHash?: string;
  derived: ChildDerivedState;
  activity?: string;
}

export interface OrchestrationHudSnapshot {
  parentInstanceId: string;
  totalChildren: number;
  countsByCategory: Record<ChildStateCategory, number>;
  churningCount: number;
  children: HudChildEntry[];
  attentionItems: HudChildEntry[];
  generatedAt: number;
}

export type HudQuickAction =
  | { kind: 'focus-child'; childInstanceId: string }
  | { kind: 'copy-prompt-hash'; childInstanceId: string; spawnPromptHash: string }
  | { kind: 'open-diagnostic-bundle'; childInstanceId: string }
  | { kind: 'summarize-children'; parentInstanceId: string };

export interface HudQuickActionResult {
  ok: boolean;
  reason?: string;
}
