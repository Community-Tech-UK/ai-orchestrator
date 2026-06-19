import { describe, it, expect } from 'vitest';
import {
  routeRole,
  classifyScope,
  decideDelegation,
  isMultiFileEditBatch,
  DEFAULT_BROAD_PARALLEL,
  DEFAULT_MULTIFILE_EDIT_DELEGATION_THRESHOLD,
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

describe('delegation-policy / isMultiFileEditBatch (Part C)', () => {
  it('detects an edit verb + multi-file phrase as a batch', () => {
    expect(isMultiFileEditBatch('Rename the logger import across all the files')).toBe(true);
    expect(isMultiFileEditBatch('Update the copyright header in every file')).toBe(true);
    expect(isMultiFileEditBatch('Migrate multiple files to the new API')).toBe(true);
  });

  it('detects an edit verb + explicit file count at/above the threshold', () => {
    expect(isMultiFileEditBatch('Replace the deprecated call in 12 files')).toBe(true);
    expect(isMultiFileEditBatch(`Update ${DEFAULT_MULTIFILE_EDIT_DELEGATION_THRESHOLD} files`)).toBe(true);
  });

  it('is false for a small explicit count below the threshold', () => {
    expect(isMultiFileEditBatch('Update 2 files')).toBe(false);
  });

  it('is false without an edit verb, even with a wide-surface phrase', () => {
    expect(isMultiFileEditBatch('Find all the files that import the logger')).toBe(false);
  });

  it('is false for a single-file edit', () => {
    expect(isMultiFileEditBatch('Fix the typo in this one file')).toBe(false);
  });

  it('honors a caller-supplied editFileCount over text', () => {
    expect(isMultiFileEditBatch('apply the change', 8)).toBe(true);
    expect(isMultiFileEditBatch('apply the change', 1)).toBe(false);
  });

  it('respects a custom threshold', () => {
    expect(isMultiFileEditBatch('update 3 files', undefined, 3)).toBe(true);
    expect(isMultiFileEditBatch('update 3 files', undefined, 10)).toBe(false);
  });

  it('handles empty / nullish input safely', () => {
    expect(isMultiFileEditBatch('')).toBe(false);
    // @ts-expect-error exercising runtime robustness
    expect(isMultiFileEditBatch(undefined)).toBe(false);
  });
});

describe('delegation-policy / decideDelegation — multi-file edit batch (Part C)', () => {
  it('forces broad scope and recommends delegation for a multi-file edit batch', () => {
    const d = decideDelegation('Rename the deprecated helper across all the call sites');
    expect(d.multiFileEditBatch).toBe(true);
    expect(d.scope).toBe('broad');
    expect(d.recommendDelegation).toBe(true);
    expect(d.maxParallel).toBe(DEFAULT_BROAD_PARALLEL);
    expect(d.reason).toMatch(/multi-file edit batch/);
  });

  it('recommends delegation for a batch even when the phrasing would otherwise read trivial', () => {
    // Short text that would normally be "trivial narrow", but an explicit large
    // count promotes it to a delegated batch.
    const d = decideDelegation('fix 9 files', { editFileCount: 9 });
    expect(d.multiFileEditBatch).toBe(true);
    expect(d.recommendDelegation).toBe(true);
    expect(d.scope).toBe('broad');
  });

  it('leaves a normal task untouched (multiFileEditBatch=false)', () => {
    const d = decideDelegation('Add a login button to the settings page');
    expect(d.multiFileEditBatch).toBe(false);
  });
});
