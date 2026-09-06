/**
 * S4.2 — the routing policy as a task × tier matrix.
 *
 * `orchestrationRoutingPolicyJson` decides which model tier each orchestration
 * gate runs on, and it had **no UI at all** (`surfacing: 'internal'`): the only
 * way to move an expensive gate onto a cheaper model was to hand-edit JSON
 * through the settings CLI. That is a setting with real money attached — the
 * claude-fanout audit measured debate synthesis on the powerful tier at 38.3%
 * of that run's spend — hidden behind the least discoverable surface there is.
 *
 * Pure: turns the stored blob into rows a table can render, and rows back into
 * a blob. The parsing rules stay in `routing-tier-policy.ts`, which is the
 * main-process authority; this only shapes it for display.
 */

import { DEFAULT_ORCHESTRATION_ROUTING_POLICY } from './settings-defaults';
import type {
  OrchestrationRoutingPolicyKey,
  OrchestrationRoutingPolicyValue,
} from './settings-primitives.types';

export const ROUTING_MATRIX_TIERS: readonly OrchestrationRoutingPolicyValue[] = [
  'auto',
  'fast',
  'balanced',
  'powerful',
];

export interface RoutingMatrixRow {
  key: OrchestrationRoutingPolicyKey;
  /** What this gate IS, in the operator's terms. */
  label: string;
  /** When it runs, so the cost implication is obvious. */
  description: string;
  value: OrchestrationRoutingPolicyValue;
  defaultValue: OrchestrationRoutingPolicyValue;
  /** True when the operator has moved this gate off its shipped default. */
  overridden: boolean;
}

/**
 * Row copy. Each says when the gate fires, because "review" alone does not tell
 * anyone whether moving it to `fast` will save pennies or break their workflow.
 */
const ROW_COPY: Readonly<Record<OrchestrationRoutingPolicyKey, { label: string; description: string }>> = {
  loop: {
    label: 'Loop iterations',
    description: 'Every iteration of a Loop Mode run. The highest-volume gate here.',
  },
  workflow: {
    label: 'Workflow tasks',
    description: 'Caller-authored workflow prompts. Defaults to auto because the prompt varies.',
  },
  verify: {
    label: 'Verify',
    description: 'The completion check that decides whether a loop is actually done.',
  },
  review: {
    label: 'Review',
    description: 'Cross-model review of a completion claim.',
  },
  debate: {
    label: 'Debate rounds',
    description: 'Each participant turn when several models argue a question.',
  },
  debateSynthesis: {
    label: 'Debate synthesis',
    description:
      'The single call that merges a debate. Historically the most expensive one — an audit '
      + 'measured it at 38.3% of a run\'s spend on the powerful tier.',
  },
};

/** Human wording for a tier, so a dropdown is not four bare words. */
export function tierLabel(value: OrchestrationRoutingPolicyValue): string {
  switch (value) {
    case 'auto':
      return 'Auto (router decides from the prompt)';
    case 'fast':
      return 'Fast (cheapest)';
    case 'balanced':
      return 'Balanced';
    case 'powerful':
      return 'Powerful (most expensive)';
    default:
      return String(value);
  }
}

function isPolicyValue(value: unknown): value is OrchestrationRoutingPolicyValue {
  return typeof value === 'string' && (ROUTING_MATRIX_TIERS as readonly string[]).includes(value);
}

/**
 * Parse the stored blob into rows.
 *
 * Fail-soft per key, matching `routing-tier-policy.ts`: a malformed blob or a
 * bad value falls back to that key's default rather than throwing. A settings
 * typo must not blank the table, and it must not take orchestration down.
 */
export function routingMatrixRows(rawJson: unknown): RoutingMatrixRow[] {
  let parsed: Record<string, unknown> = {};
  if (typeof rawJson === 'string' && rawJson.trim() !== '') {
    try {
      const candidate = JSON.parse(rawJson);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      // Keep defaults; the doctor (S5) reports the malformed JSON separately.
    }
  }

  return (Object.keys(ROW_COPY) as OrchestrationRoutingPolicyKey[]).map((key) => {
    const defaultValue = DEFAULT_ORCHESTRATION_ROUTING_POLICY[key];
    const raw = parsed[key];
    const value = isPolicyValue(raw) ? raw : defaultValue;
    return {
      key,
      label: ROW_COPY[key].label,
      description: ROW_COPY[key].description,
      value,
      defaultValue,
      overridden: value !== defaultValue,
    };
  });
}

/**
 * Serialise rows back to the stored form.
 *
 * Always writes every key rather than only the overrides. The main-process
 * parser fills missing keys from defaults either way, but a complete blob means
 * the stored value says exactly what is in force — a partial one silently
 * changes meaning if a default ever moves.
 */
export function routingMatrixToJson(rows: readonly RoutingMatrixRow[]): string {
  const out: Record<string, OrchestrationRoutingPolicyValue> = {};
  for (const row of rows) out[row.key] = row.value;
  return JSON.stringify(out);
}

/** Apply one change, returning new rows. */
export function withRoutingValue(
  rows: readonly RoutingMatrixRow[],
  key: OrchestrationRoutingPolicyKey,
  value: OrchestrationRoutingPolicyValue,
): RoutingMatrixRow[] {
  return rows.map((row) => (row.key === key
    ? { ...row, value, overridden: value !== row.defaultValue }
    : row));
}
