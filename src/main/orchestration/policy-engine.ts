/**
 * Declarative policy engine (claude2_todo #32).
 *
 * A small, generic, pure rule engine: `Rule { condition, action, priority }`
 * over a composable condition algebra (`and` / `or` / `not` + named leaves).
 * `evaluateWithEvents` returns both the chosen action **and** a human-readable
 * explanation + per-rule decision events for the activity log / UI — so loop /
 * merge / retry decisions become auditable data instead of scattered
 * imperative branches.
 *
 * Generic over a `Facts` type `F` (the inputs — e.g. `{ greenAt, staleBranch,
 * reviewPassed, retryAvailable }`) and an `Action` type `A`. Pure; existing
 * detectors plug in as leaf predicates.
 */

export interface Condition<F> {
  evaluate(facts: F): boolean;
  /** Human-readable form, used to explain why a rule fired. */
  describe(): string;
}

/** A named leaf condition wrapping a predicate over the facts. */
export function leaf<F>(name: string, predicate: (facts: F) => boolean): Condition<F> {
  return { evaluate: predicate, describe: () => name };
}

export function and<F>(...conditions: Condition<F>[]): Condition<F> {
  return {
    evaluate: (f) => conditions.every((c) => c.evaluate(f)),
    describe: () => (conditions.length ? `(${conditions.map((c) => c.describe()).join(' AND ')})` : 'true'),
  };
}

export function or<F>(...conditions: Condition<F>[]): Condition<F> {
  return {
    evaluate: (f) => conditions.some((c) => c.evaluate(f)),
    describe: () => (conditions.length ? `(${conditions.map((c) => c.describe()).join(' OR ')})` : 'false'),
  };
}

export function not<F>(condition: Condition<F>): Condition<F> {
  return { evaluate: (f) => !condition.evaluate(f), describe: () => `NOT ${condition.describe()}` };
}

export function always<F>(): Condition<F> {
  return { evaluate: () => true, describe: () => 'always' };
}

export interface Rule<F, A> {
  id: string;
  condition: Condition<F>;
  action: A;
  /** Higher priority wins when multiple rules match. Ties broken by registration order. */
  priority: number;
}

export interface PolicyDecisionEvent<A> {
  ruleId: string;
  action: A;
  priority: number;
  matched: boolean;
  explanation: string;
}

export interface PolicyResult<A> {
  /** The winning rule's action, or null when nothing matched. */
  action: A | null;
  ruleId: string | null;
  /** One-line explanation of the decision (or why nothing fired). */
  explanation: string;
  /** Per-rule evaluation trace (priority-ordered), for the activity log. */
  events: PolicyDecisionEvent<A>[];
}

export class PolicyEngine<F, A> {
  private readonly rules: Rule<F, A>[];

  constructor(rules: Rule<F, A>[] = []) {
    // Stable sort by descending priority (Array.prototype.sort is stable in V8),
    // so equal priorities keep registration order.
    this.rules = [...rules].sort((a, b) => b.priority - a.priority);
  }

  /** The highest-priority matching rule's action, or null. */
  evaluate(facts: F): A | null {
    for (const rule of this.rules) {
      if (rule.condition.evaluate(facts)) return rule.action;
    }
    return null;
  }

  /**
   * Evaluate every rule (priority order) and return the winning action plus a
   * full, explainable decision trace. The winner is the first matching rule.
   */
  evaluateWithEvents(facts: F): PolicyResult<A> {
    const events: PolicyDecisionEvent<A>[] = [];
    let winner: Rule<F, A> | null = null;

    for (const rule of this.rules) {
      const matched = rule.condition.evaluate(facts);
      events.push({
        ruleId: rule.id,
        action: rule.action,
        priority: rule.priority,
        matched,
        explanation: `${matched ? 'matched' : 'skipped'}: ${rule.id} when ${rule.condition.describe()}`,
      });
      if (matched && !winner) winner = rule;
    }

    if (!winner) {
      return { action: null, ruleId: null, explanation: 'no rule matched', events };
    }
    return {
      action: winner.action,
      ruleId: winner.id,
      explanation: `${winner.id} fired (priority ${winner.priority}) because ${winner.condition.describe()}`,
      events,
    };
  }

  /** The rules, in evaluation (priority) order. */
  listRules(): readonly Rule<F, A>[] {
    return this.rules;
  }
}
