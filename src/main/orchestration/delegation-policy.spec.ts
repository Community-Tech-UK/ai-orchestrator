import { describe, it, expect } from 'vitest';
import {
  routeRole,
  classifyScope,
  decideDelegation,
  DEFAULT_BROAD_PARALLEL,
  ROUTE_CONFIDENCE_THRESHOLD,
} from './delegation-policy';

describe('delegation-policy / routeRole', () => {
  it('routes retrieval tasks to the retriever role', () => {
    const r = routeRole('Find all references to the AuthService class');
    expect(r.role).toBe('retriever');
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('routes review/audit tasks to the review role', () => {
    expect(routeRole('Review this PR for security vulnerabilities').role).toBe('review');
    expect(routeRole('Audit the auth module for code smells').role).toBe('review');
  });

  it('routes planning tasks to the plan role', () => {
    expect(routeRole('Design the architecture for the new sync engine').role).toBe('plan');
    expect(routeRole('Break down this epic into a roadmap').role).toBe('plan');
  });

  it('defaults to build with zero confidence when no role keywords match', () => {
    const r = routeRole('Make the button blue');
    expect(r.role).toBe('build');
    expect(r.confidence).toBe(0);
    expect(r.reason).toMatch(/default build/);
  });

  it('uses word-boundary matching (does not match substrings)', () => {
    // "designation" contains "design" but should not trigger the plan role.
    const r = routeRole('Update the designation field label');
    expect(r.role).toBe('build');
  });

  it('produces a confidence that is the winning share of matched weight', () => {
    const r = routeRole('search for and locate the config loader'); // retriever-heavy
    expect(r.role).toBe('retriever');
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it('is deterministic across repeated calls', () => {
    const a = routeRole('review the security of this code');
    const b = routeRole('review the security of this code');
    expect(a).toEqual(b);
  });

  it('handles empty / nullish input safely', () => {
    expect(routeRole('').role).toBe('build');
    // @ts-expect-error exercising runtime robustness
    expect(routeRole(undefined).role).toBe('build');
  });
});

describe('delegation-policy / classifyScope', () => {
  it('classifies multi-surface tasks as broad', () => {
    expect(classifyScope('Refactor authentication across the entire codebase')).toBe('broad');
    expect(classifyScope('Migrate all the components to the new API')).toBe('broad');
  });

  it('classifies single-surface tasks as narrow', () => {
    expect(classifyScope('Fix the typo in this one file')).toBe('narrow');
    expect(classifyScope('What is the return type of getUser?')).toBe('narrow');
  });

  it('biases long tasks toward broad and very short ones toward narrow', () => {
    const long = 'x'.repeat(300);
    expect(classifyScope(long)).toBe('broad');
    expect(classifyScope('rename foo')).toBe('narrow');
  });
});

describe('delegation-policy / decideDelegation', () => {
  it('recommends no parallelism for narrow tasks', () => {
    const d = decideDelegation('What is the type of getUser?');
    expect(d.scope).toBe('narrow');
    expect(d.maxParallel).toBe(1);
  });

  it('caps broad fan-out at the default', () => {
    const d = decideDelegation('Refactor logging across the entire codebase and update all callers');
    expect(d.scope).toBe('broad');
    expect(d.maxParallel).toBe(DEFAULT_BROAD_PARALLEL);
  });

  it('honors a tighter maxParallelCap but never exceeds the broad default', () => {
    const tight = decideDelegation('audit every module across the codebase', { maxParallelCap: 2 });
    expect(tight.maxParallel).toBe(2);
    const loose = decideDelegation('audit every module across the codebase', { maxParallelCap: 50 });
    expect(loose.maxParallel).toBe(DEFAULT_BROAD_PARALLEL);
  });

  it('advises against delegating a trivial narrow task', () => {
    const d = decideDelegation('rename x to y');
    expect(d.recommendDelegation).toBe(false);
    expect(d.reason).toMatch(/inline/);
  });

  it('recommends delegating a substantive task', () => {
    const d = decideDelegation('Find all references to AuthService and list the files');
    expect(d.recommendDelegation).toBe(true);
    expect(d.suggestedRole).toBe('retriever');
  });

  it('surfaces a route confidence usable against the threshold', () => {
    const d = decideDelegation('Review this code for security vulnerabilities and audit the inputs');
    expect(d.suggestedRole).toBe('review');
    expect(d.routeConfidence).toBeGreaterThanOrEqual(ROUTE_CONFIDENCE_THRESHOLD);
  });
});
