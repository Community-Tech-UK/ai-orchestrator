import { describe, expect, it } from 'vitest';
import { resolveCheckerPlan, type CheckerPlanDeps } from './checker-plan';
import type { WorkspaceCopilotScope } from '../providers/copilot/copilot-account-routing-service';

const ENTERPRISE: WorkspaceCopilotScope = {
  kind: 'protected',
  profileId: 'lawrencj',
  profileLabel: 'LAWRENCJ',
  accountKind: 'enterprise',
  automationPolicy: 'allow-routed',
};

const PERSONAL_PROTECTED: WorkspaceCopilotScope = {
  kind: 'protected',
  profileId: 'legacy',
  profileLabel: 'Existing Copilot account',
  accountKind: 'personal',
  automationPolicy: 'allow-routed',
};

function deps(
  scope: WorkspaceCopilotScope,
  providerModels: Record<string, string> = {},
  unavailable: readonly string[] = [],
): CheckerPlanDeps {
  const unavailableSet = new Set(unavailable);
  return {
    classifyScope: () => scope,
    resolveProviderModel: (provider) => providerModels[provider],
    isModelUnavailable: (_profileId, model) => unavailableSet.has(model),
  };
}

describe('resolveCheckerPlan — licence containment', () => {
  it('pins every checker to the enterprise seat and away from the implementer family', () => {
    const plan = resolveCheckerPlan(['claude', 'codex'], {
      implementerProvider: 'copilot',
      implementerModel: 'claude-opus-5',
      workingDirectory: '/Users/suas/work/ebrd/MON.transition-web',
      context: 'test',
    }, deps(ENTERPRISE));

    expect(plan.candidates).toHaveLength(2);
    for (const candidate of plan.candidates) {
      expect(candidate.provider).toBe('copilot');
      expect(candidate.copilotProfileId).toBe('lawrencj');
      expect(candidate.rationale).toBe('licence-pinned');
    }
    // Implementer was Anthropic, so no Anthropic checker.
    expect(plan.candidates.map((c) => c.model)).toEqual(['gpt-5.6-terra', 'grok-4.6']);
  });

  it('checks OpenAI-built work with Anthropic — the codex/claude swap James asked for', () => {
    const plan = resolveCheckerPlan(['claude'], {
      implementerProvider: 'copilot',
      implementerModel: 'gpt-5.3-codex',
      workingDirectory: '/Users/suas/work/ebrd/repo',
      context: 'test',
    }, deps(ENTERPRISE));

    expect(plan.candidates[0]).toMatchObject({
      provider: 'copilot',
      model: 'claude-opus-5',
      rationale: 'licence-pinned',
    });
  });

  it('never hands employer code to another vendor CLI', () => {
    const plan = resolveCheckerPlan(['claude', 'codex', 'cursor'], {
      implementerModel: 'claude-opus-5',
      workingDirectory: '/Users/suas/work/ebrd/repo',
      context: 'test',
    }, deps(ENTERPRISE));

    expect(plan.candidates.every((c) => c.provider === 'copilot')).toBe(true);
  });

  it('produces a checker for an EXHAUSTED pool when the caller asks for a minimum', () => {
    const plan = resolveCheckerPlan([], {
      implementerModel: 'claude-opus-5',
      workingDirectory: '/Users/suas/work/ebrd/repo',
      context: 'test',
      minCheckers: 1,
    }, deps(ENTERPRISE));

    expect(plan.candidates).toHaveLength(1);
  });

  it('runs NOTHING when the caller explicitly asked for zero checkers', () => {
    // `aio review --reviewers none` and the loop's local-only advisory pass both
    // send an explicit empty list. Inferring "pool exhausted" from array length
    // spawned a real, billed Copilot review nobody asked for — and the loop's
    // cost cap never saw the spend, because the local-advisory result type has
    // no cost fields at all.
    const plan = resolveCheckerPlan([], {
      implementerModel: 'claude-opus-5',
      workingDirectory: '/Users/suas/work/ebrd/repo',
      context: 'test',
    }, deps(ENTERPRISE));

    expect(plan.candidates).toEqual([]);
    expect(plan.blockedReason).toBeUndefined();
  });

  it('skips models the seat has told us it will not serve', () => {
    const plan = resolveCheckerPlan(['claude'], {
      implementerModel: 'claude-opus-5',
      workingDirectory: '/Users/suas/work/ebrd/repo',
      context: 'test',
    }, deps(ENTERPRISE, {}, ['gpt-5.6-terra', 'gpt-5.5']));

    expect(plan.candidates[0]?.model).toBe('gpt-5.4');
  });

  it('blocks rather than leaking when the seat has no diverse model left', () => {
    const everything = [
      'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex',
      'grok-4.6', 'grok-4.5', 'gemini-3.7-flash', 'gemini-3.6-flash',
    ];
    const plan = resolveCheckerPlan(['claude'], {
      implementerModel: 'claude-opus-5',
      workingDirectory: '/Users/suas/work/ebrd/repo',
      context: 'test',
    }, deps(ENTERPRISE, {}, everything));

    expect(plan.candidates).toEqual([]);
    expect(plan.blockedReason).toContain('may not be checked off that seat');
  });

  it('spans all families when the implementer model is unknown', () => {
    const plan = resolveCheckerPlan(['a', 'b', 'c', 'd'], {
      implementerModel: undefined,
      workingDirectory: '/Users/suas/work/ebrd/repo',
      context: 'test',
    }, deps(ENTERPRISE));

    expect(plan.candidates.map((c) => c.model)).toEqual([
      'gpt-5.6-terra', 'claude-opus-5', 'grok-4.6', 'gemini-3.7-flash',
    ]);
  });

  it.each(['manual-only', 'disabled'] as const)(
    'blocks rather than auto-using a %s enterprise seat',
    (automationPolicy) => {
      // The operator said this account is not for automatic use. Checking is
      // automatic, and the code may not leave the seat, so there is no checker.
      // Ping-pong in particular cannot rely on the router to enforce this: it
      // spawns via createInstance, which routes with an 'interactive' origin.
      const plan = resolveCheckerPlan(['claude'], {
        implementerModel: 'claude-opus-5',
        workingDirectory: '/Users/suas/work/ebrd/repo',
        context: 'test',
      }, deps({ ...ENTERPRISE, automationPolicy }));

      expect(plan.candidates).toEqual([]);
      expect(plan.blockedReason).toContain(automationPolicy);
    },
  );

  it('does not pin a PERSONAL protected scope to Copilot', () => {
    const plan = resolveCheckerPlan(['claude', 'codex'], {
      implementerModel: 'gpt-5.5',
      workingDirectory: '/Users/suas/personal/thing',
      context: 'test',
    }, deps(PERSONAL_PROTECTED));

    expect(plan.candidates.map((c) => c.provider)).toEqual(['claude', 'codex']);
  });
});

describe('resolveCheckerPlan — fail-closed scope', () => {
  it('blocks when two protected scopes claim the workspace', () => {
    const plan = resolveCheckerPlan(['claude'], {
      workingDirectory: '/somewhere',
      context: 'test',
    }, deps({ kind: 'ambiguous', profileIds: ['lawrencj', 'lawrencj-pe1'] }));

    expect(plan.candidates).toEqual([]);
    expect(plan.blockedReason).toContain('more than one protected Copilot scope');
  });

  it('blocks when scope cannot be determined at all', () => {
    const plan = resolveCheckerPlan(['claude'], {
      workingDirectory: '/somewhere',
      context: 'test',
    }, deps({ kind: 'indeterminate', reason: 'copilot-settings-unreadable' }));

    expect(plan.candidates).toEqual([]);
    expect(plan.blockedReason).toContain('could not be determined');
  });
});

describe('resolveCheckerPlan — family diversity outside enterprise scope', () => {
  const NONE: WorkspaceCopilotScope = { kind: 'none' };

  it('leaves a non-colliding checker exactly as configured', () => {
    const plan = resolveCheckerPlan(['codex'], {
      implementerModel: 'claude-opus-5',
      context: 'test',
    }, deps(NONE, { codex: 'gpt-5.6-terra' }));

    expect(plan.candidates).toEqual([
      { provider: 'codex', model: 'gpt-5.6-terra', rationale: 'unchanged' },
    ]);
  });

  it('re-models a colliding Copilot checker instead of dropping it', () => {
    const plan = resolveCheckerPlan(['copilot'], {
      implementerModel: 'gpt-5.3-codex',
      context: 'test',
    }, deps(NONE, { copilot: 'gpt-5.5' }));

    expect(plan.candidates).toEqual([
      { provider: 'copilot', model: 'claude-opus-5', rationale: 'family-diverse' },
    ]);
  });

  it('re-models a colliding CURSOR checker — cursor is genuinely multi-vendor', () => {
    // Cursor serves Claude, Codex/GPT and Composer models from one CLI, so
    // treating it as single-family would let it silently run the implementer's
    // own family. The replacement id comes from the app's own curated catalog,
    // so it is always one the picker actually offers.
    const plan = resolveCheckerPlan(['cursor'], {
      implementerModel: 'claude-opus-5',
      context: 'test',
    }, deps(NONE, { cursor: 'claude-opus-5-thinking-high' }));

    expect(plan.candidates[0]?.rationale).toBe('family-diverse');
    expect(plan.candidates[0]?.model).toBe('gpt-5.3-codex');
  });

  it('keeps a colliding single-family checker rather than losing it', () => {
    // The Claude CLI cannot run a non-Anthropic model, so there is nothing to
    // re-model to. Keeping it beats having no checker at all.
    const plan = resolveCheckerPlan(['claude'], {
      implementerModel: 'claude-opus-5',
      context: 'test',
    }, deps(NONE, { claude: 'sonnet' }));

    expect(plan.candidates).toEqual([
      { provider: 'claude', model: 'sonnet', rationale: 'unchanged' },
    ]);
  });

  it('never drops a provider the caller asked for', () => {
    const plan = resolveCheckerPlan(['claude', 'codex', 'cursor'], {
      implementerModel: 'claude-opus-5',
      context: 'test',
    }, deps(NONE, { claude: 'opus', codex: 'gpt-5.5', cursor: 'grok-4.5-xhigh' }));

    expect(plan.candidates.map((c) => c.provider)).toEqual(['claude', 'codex', 'cursor']);
  });

  it('constrains nothing when the implementer model is unknown', () => {
    const plan = resolveCheckerPlan(['copilot'], {
      implementerModel: undefined,
      context: 'test',
    }, deps(NONE, { copilot: 'claude-sonnet-5' }));

    expect(plan.candidates[0]).toMatchObject({ model: 'claude-sonnet-5', rationale: 'unchanged' });
  });

  it('leaves an unconfigured checker to the CLI\'s own model routing', () => {
    // `resolveReviewerModelOverride` returns undefined for a missing entry or a
    // literal 'auto', so an unconfigured reviewer carries no family information
    // and must not be treated as colliding with anything.
    const plan = resolveCheckerPlan(['copilot'], {
      implementerModel: 'claude-opus-5',
      context: 'test',
    }, deps(NONE, {}));

    expect(plan.candidates[0]).toMatchObject({ provider: 'copilot', rationale: 'unchanged' });
    expect(plan.candidates[0]?.model).toBeUndefined();
  });
});
