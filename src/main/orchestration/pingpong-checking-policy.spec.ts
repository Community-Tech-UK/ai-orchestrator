import { describe, expect, it, vi } from 'vitest';

/**
 * Ping-pong's own reviewer resolver only enforces "reviewer CLI != builder CLI".
 * That is a PROVIDER rule, and it is not sufficient: Cursor and Copilot each
 * serve several vendors' models from one CLI, so a different provider can still
 * mean the same underlying model family — self-review wearing another badge.
 *
 * Gate pass 4 found this surface was the only one of four that discarded the
 * plan's family-diversity result on the non-enterprise path.
 */
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      // The operator has pointed the Cursor reviewer at a Claude-family model.
      crossModelReviewModelByProvider: { cursor: 'claude-opus-5-thinking-high', codex: 'gpt-5.5' },
      copilotAccountProfiles: [],
      copilotAccountRoutingRules: [],
    }),
  }),
}));

import { resolveOpenCheckerModel, resolvePingPongChecker } from './pingpong-checking-policy';

const WORKSPACE = '/not/an/enterprise/scope';

describe('resolveOpenCheckerModel', () => {
  it('re-models a Cursor reviewer that would run the builder\'s own family', () => {
    const model = resolveOpenCheckerModel('cursor', {
      builderModel: 'claude-sonnet-5',
      workspaceCwd: WORKSPACE,
    });

    // Not the configured Claude-family model — a different vendor from the
    // app's own Cursor catalog.
    expect(model).not.toBe('claude-opus-5-thinking-high');
    expect(model).toBe('gpt-5.3-codex');
  });

  it('leaves a non-colliding reviewer on its configured model', () => {
    const model = resolveOpenCheckerModel('codex', {
      builderModel: 'claude-sonnet-5',
      workspaceCwd: WORKSPACE,
    });

    expect(model).toBe('gpt-5.5');
  });

  it('constrains nothing when the builder model is unknown', () => {
    const model = resolveOpenCheckerModel('cursor', { workspaceCwd: WORKSPACE });

    expect(model).toBe('claude-opus-5-thinking-high');
  });

  it('falls back to the configured model for a provider with no catalog entry', () => {
    const model = resolveOpenCheckerModel('codex', {
      builderModel: 'gpt-5.6-terra',
      workspaceCwd: WORKSPACE,
    });

    // Codex is single-family, so there is nothing to re-model to. Keeping it
    // beats losing the checker entirely.
    expect(model).toBe('gpt-5.5');
  });
});

describe('resolvePingPongChecker', () => {
  it('reports open outside any protected enterprise scope', () => {
    expect(resolvePingPongChecker({
      builderProvider: 'claude',
      builderModel: 'claude-sonnet-5',
      workspaceCwd: WORKSPACE,
    })).toEqual({ kind: 'open' });
  });
});

describe('resolvePingPongChecker — automation policy', () => {
  it('blocks on a manual-only enterprise seat instead of silently using it', async () => {
    // Ping-pong spawns through InstanceManager.createInstance, which routes with
    // an 'interactive' origin, so copilot-account-resolver's manual-only branch
    // (gated on an automatic origin) never fires. The policy has to be enforced
    // in the plan, or the operator's explicit opt-out is ignored on this surface.
    vi.resetModules();
    vi.doMock('../providers/copilot/copilot-account-routing-service', () => ({
      getCopilotAccountRoutingService: () => ({
        classifyWorkspaceScope: () => ({
          kind: 'protected',
          profileId: 'work',
          profileLabel: 'Work',
          accountKind: 'enterprise',
          automationPolicy: 'manual-only',
        }),
      }),
    }));
    const { resolvePingPongChecker: pinned } = await import('./pingpong-checking-policy');

    const decision = pinned({
      builderProvider: 'copilot',
      builderModel: 'claude-opus-5',
      workspaceCwd: '/work/ebrd/repo',
    });

    expect(decision.kind).toBe('blocked');
    vi.doUnmock('../providers/copilot/copilot-account-routing-service');
  });
});
