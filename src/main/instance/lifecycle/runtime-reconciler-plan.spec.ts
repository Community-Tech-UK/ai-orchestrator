/**
 * Guard for the model-switch note table (A9, Step 12a) and for Step 14d's
 * ordering rule. The renderer's "what switching does" sentences assume that
 * `planContinuity` plans a Claude model change as `'replay'` (the live switch
 * runs BEFORE it and falls through to it) and that non-Claude native-resume
 * providers continue the conversation. If this table ever changes, these tests
 * fail loudly and the sentences must be updated with it.
 */
import { describe, expect, it } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';
import { computeRuntimeDiff, planContinuity } from './runtime-reconciler-plan';
import type { RuntimeDiff } from './runtime-reconciler.types';

function diff(overrides: Partial<RuntimeDiff> = {}): RuntimeDiff {
  return {
    providerChanged: false,
    modelChanged: false,
    reasoningChanged: false,
    runtimeTargetChanged: false,
    yoloModeChanged: false,
    copilotAccountChanged: false,
    accountProfileChanged: false,
    hasChanges: true,
    ...overrides,
  };
}

const resumable = { supportsResume: true, supportsForkSession: false };
const forkable = { supportsResume: true, supportsForkSession: true };

describe('planContinuity (model-switch note guard)', () => {
  it("plans 'replay' for a Claude model change", () => {
    expect(planContinuity({
      diff: diff({ modelChanged: true }),
      capabilities: resumable,
      hasConversation: true,
      cliType: 'claude',
      isLocalModelTarget: false,
    })).toBe('replay');
  });

  it("plans 'replay' for a Claude effort change, even when the adapter could fork", () => {
    expect(planContinuity({
      diff: diff({ reasoningChanged: true }),
      capabilities: forkable,
      hasConversation: true,
      cliType: 'claude',
      isLocalModelTarget: false,
    })).toBe('replay');
  });

  it('plans native resume for a native-resume provider model change, forking when supported', () => {
    expect(planContinuity({
      diff: diff({ modelChanged: true }),
      capabilities: resumable,
      hasConversation: true,
      cliType: 'codex',
      isLocalModelTarget: false,
    })).toBe('native-resume');
    expect(planContinuity({
      diff: diff({ modelChanged: true }),
      capabilities: forkable,
      hasConversation: true,
      cliType: 'codex',
      isLocalModelTarget: false,
    })).toBe('native-resume-fork');
  });

  it("replays when there is nothing to resume, the adapter cannot resume, or the target is a local model", () => {
    const base = { diff: diff({ modelChanged: true }), cliType: 'codex' as const };
    expect(planContinuity({ ...base, capabilities: resumable, hasConversation: false, isLocalModelTarget: false })).toBe('replay');
    expect(planContinuity({ ...base, capabilities: { supportsResume: false, supportsForkSession: false }, hasConversation: true, isLocalModelTarget: false })).toBe('replay');
    expect(planContinuity({ ...base, capabilities: resumable, hasConversation: true, isLocalModelTarget: true })).toBe('replay');
  });

  it('always replays on a provider change', () => {
    expect(planContinuity({
      diff: diff({ providerChanged: true }),
      capabilities: forkable,
      hasConversation: true,
      cliType: 'codex',
      isLocalModelTarget: false,
    })).toBe('replay');
  });

  it('always replays a Copilot account handoff', () => {
    expect(planContinuity({
      diff: diff({ copilotAccountChanged: true }),
      capabilities: forkable,
      hasConversation: true,
      cliType: 'copilot',
      isLocalModelTarget: false,
    })).toBe('replay');
  });

  describe('account-only handoff', () => {
    const accountOnly = diff({ accountProfileChanged: true });

    it('natively resumes in place on a shared session store, Claude included, never forking', () => {
      expect(planContinuity({
        diff: accountOnly, capabilities: resumable, hasConversation: true, cliType: 'claude', isLocalModelTarget: false,
      })).toBe('native-resume');
      expect(planContinuity({
        diff: accountOnly, capabilities: forkable, hasConversation: true, cliType: 'claude', isLocalModelTarget: false,
        accountContinuation: 'shared-store',
      })).toBe('native-resume');
    });

    it("replays when the pool says 'replay' or there is no conversation", () => {
      expect(planContinuity({
        diff: accountOnly, capabilities: resumable, hasConversation: true, cliType: 'claude', isLocalModelTarget: false,
        accountContinuation: 'replay',
      })).toBe('replay');
      expect(planContinuity({
        diff: accountOnly, capabilities: resumable, hasConversation: false, cliType: 'claude', isLocalModelTarget: false,
      })).toBe('replay');
    });

    it('is not an account-only handoff when the model changes too, so Claude replays', () => {
      expect(planContinuity({
        diff: diff({ accountProfileChanged: true, modelChanged: true }),
        capabilities: resumable, hasConversation: true, cliType: 'claude', isLocalModelTarget: false,
      })).toBe('replay');
    });
  });
});

describe('computeRuntimeDiff feeding planContinuity for a Claude model change', () => {
  const instance = {
    provider: 'claude',
    currentModel: 'claude-opus-4-6',
    reasoningEffort: 'high',
    yoloMode: false,
  } as unknown as Instance;

  it('reports only the model as changed and the plan is a replay', () => {
    const computed = computeRuntimeDiff(instance, { provider: 'claude', model: 'claude-sonnet-4-6' });
    expect(computed).toMatchObject({ modelChanged: true, providerChanged: false, reasoningChanged: false, hasChanges: true });
    expect(planContinuity({
      diff: computed, capabilities: forkable, hasConversation: true, cliType: 'claude', isLocalModelTarget: false,
    })).toBe('replay');
  });

  it('reports no change when the desired runtime equals the live one', () => {
    expect(computeRuntimeDiff(instance, { provider: 'claude', model: 'claude-opus-4-6', reasoningEffort: 'high' }).hasChanges).toBe(false);
  });
});
