import { describe, expect, it } from 'vitest';
import { classifyFreshEyesBlocking } from './fresh-eyes-blocking';
import type { FreshEyesFinding } from './loop-fresh-eyes-reviewer';
const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n unchanged\n+added';
function finding(quote: string, body = '[pre-existing] existing problem', severity: 'high' | 'critical' = 'high'): FreshEyesFinding {
  return { title: 'Problem', body, severity, confidence: 1, anchor: { file: 'a.ts', quote } };
}
describe('verified pre-existing reviewer findings', () => {
  it('files an unchanged tagged issue as a follow-up', () => {
    const result = classifyFreshEyesBlocking([finding('unchanged')], diff);
    expect(result.blocking).toHaveLength(0);
    expect(result.demoted[0].demotedReason).toContain('filed as a follow-up');
  });
  it.each([
    finding('added'), finding('unchanged', 'untagged issue'), finding('unchanged', '[pre-existing] issue', 'critical'),
  ])('keeps new, untagged and critical issues blocking', f => expect(classifyFreshEyesBlocking([f], diff).blocking).toHaveLength(1));
});

describe('untouched pre-existing file evidence', () => {
  it('files tagged untouched files as follow-ups', () => {
    const issue = { ...finding('not shown'), anchor: { file: 'other.ts', quote: 'not shown' } };
    expect(classifyFreshEyesBlocking([issue], diff).demoted[0].demotedReason).toContain('filed as a follow-up');
  });
  it('does not use an absent stated file to excuse a quote re-anchored on added code', () => {
    const issue = { ...finding('added'), anchor: { file: 'other.ts', quote: 'added' } };
    expect(classifyFreshEyesBlocking([issue], diff).blocking).toHaveLength(1);
  });
});
