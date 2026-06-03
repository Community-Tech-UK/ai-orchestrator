import { describe, it, expect } from 'vitest';
import { applyProviderResolution, resolveRoutedModel } from './route-task';
import { DEFAULT_ROUTING_CONFIG, type RoutingDecision } from './model-router';
import { resolveModelForTier } from '../../shared/types/provider.types';

/**
 * Intent-routing Phase 1 — shared routing helper.
 *
 * These cover the cross-provider resolution + base-decision legs that the
 * Loop-Mode invoker now shares with the child-spawn path. The existing
 * child-spawn routing behaviour is covered by instance-orchestration specs;
 * here we assert the extracted helper in isolation.
 */
describe('resolveRoutedModel (intent-routing Phase 1)', () => {
  it('passes an explicit concrete model through for the claude provider', () => {
    const decision = resolveRoutedModel('refactor the auth module', {
      explicitModel: 'opus',
      provider: 'claude',
    });
    expect(decision.model).toBe('opus');
  });

  it('maps an explicit tier name to the target provider concrete model', () => {
    const decision = resolveRoutedModel('do the thing', {
      explicitModel: 'powerful',
      provider: 'gemini',
    });
    const expected = resolveModelForTier('powerful', 'gemini');
    expect(expected).toBeTruthy();
    expect(decision.model).toBe(expected);
    expect(decision.tier).toBe('powerful');
  });

  it('auto-routes a clearly-simple task to the fast tier (claude-centric)', () => {
    const decision = resolveRoutedModel('list', {});
    expect(decision.tier).toBe('fast');
    expect(decision.model).toBe(DEFAULT_ROUTING_CONFIG.fastModel);
  });

  it('auto-routes a clearly-complex task and cross-maps to the target provider', () => {
    const task =
      'Architect and redesign the entire authentication system, audit the security ' +
      'posture, and optimize performance across the whole platform.';
    const decision = resolveRoutedModel(task, { provider: 'gemini' });
    expect(decision.tier).toBe('powerful');
    expect(decision.model).toBe(resolveModelForTier('powerful', 'gemini'));
  });

  it('passes through unchanged when the target provider has no model for the tier', () => {
    const decision = resolveRoutedModel('list', { provider: 'no-such-provider' });
    // Stays claude-centric (the fast-tier default) and is not annotated as resolved.
    expect(decision.model).toBe(DEFAULT_ROUTING_CONFIG.fastModel);
    expect(decision.reason).not.toContain('resolved to');
  });
});

describe('applyProviderResolution (intent-routing Phase 1)', () => {
  const base: RoutingDecision = {
    model: 'opus',
    complexity: 'complex',
    tier: 'powerful',
    confidence: 0.9,
    reason: 'base reason',
  };

  it('returns the decision unchanged for claude/auto/undefined providers', () => {
    expect(applyProviderResolution(base, undefined, 'claude')).toEqual(base);
    expect(applyProviderResolution(base, undefined, 'auto')).toEqual(base);
    expect(applyProviderResolution(base, undefined, undefined)).toEqual(base);
  });

  it('honours an explicit concrete model for a non-claude provider', () => {
    const result = applyProviderResolution(base, 'gpt-5.2-codex', 'codex');
    expect(result.model).toBe('gpt-5.2-codex');
    expect(result.reason).toContain('for codex');
  });

  it('maps the tier to the provider concrete model when no explicit model is given', () => {
    const result = applyProviderResolution(base, undefined, 'gemini');
    expect(result.model).toBe(resolveModelForTier('powerful', 'gemini'));
    expect(result.reason).toContain('resolved to');
  });
});
