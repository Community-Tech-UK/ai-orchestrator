import { describe, expect, it } from 'vitest';
import { parseBuilderFindingReplies } from './pingpong-builder-replies';
import { resolveLoopReviewEffort } from './loop-review-effort';

describe('pingpong savings guards', () => {
  it('records the final fixed/rebutted claim for known ids only', () => {
    const result = parseBuilderFindingReplies('Finding pp-abc: fixed - reset counter\nFinding pp-unknown: fixed - ignored\nFinding pp-abc: rebutted — this counter is scoped per call', ['pp-abc']);
    expect(result).toEqual([{ id: 'pp-abc', claim: 'rebutted', response: 'this counter is scoped per call' }]);
  });
  it('bounds response text and accepts en dashes', () => {
    const result = parseBuilderFindingReplies(`Finding pp-abc: fixed – ${'x'.repeat(500)}`, ['pp-abc']);
    expect(result[0].response).toHaveLength(400);
  });
  it('light review needs small known changes and no sensitive path', () => {
    expect(resolveLoopReviewEffort({ files: ['src/ui.ts'], changedLines: 30 }).level).toBe('light');
    for (const file of ['src/auth.ts','src/security/x.ts','src/migrations/021.ts','src/preload/x.ts','packages/contracts/a.ts','.github/workflows/ci.yml','package.json','pnpm-lock.yaml','.env.local','src/credentials.ts']) expect(resolveLoopReviewEffort({ files: [file], changedLines: 1 }).level).toBe('standard');
    expect(resolveLoopReviewEffort({ files: ['src/ui.ts'], changedLines: 50 }).level).toBe('standard');
    expect(resolveLoopReviewEffort({ files: ['src/ui.ts'], changedLines: undefined }).level).toBe('standard');
  });
});
