import { describe, expect, it } from 'vitest';
import { ownProductionChanges } from './loop-own-changes';
import { defaultLoopConfig, type LoopState, type LoopIteration } from '../../shared/types/loop.types';
const config = defaultLoopConfig('/repo', 'implement'); config.isolateLoopWorkspaces = false; config.provider = 'claude';
const state = { id: 'run', config } as LoopState;
const iteration = { seq: 1, ownWritePaths: ['own.ts'], ownWritesComplete: true, filesChanged: [{ path: 'foreign.ts', additions: 1, deletions: 0, contentHash: 'h' }] } as LoopIteration;
describe('loop own changes', () => {
  it('ignores foreign changes only for complete shared-workspace capture', () => {
    expect(ownProductionChanges(state, iteration)).toEqual({ productionChanges: [], foreignPaths: ['foreign.ts'] });
  });
  it.each([
    { config: { ...config, isolateLoopWorkspaces: true }, complete: true },
    { config: { ...config, provider: 'copilot' as const }, complete: true },
    { config, complete: false },
    { config, complete: undefined },
  ])('preserves the whole-tree rule without trustworthy attribution', input => {
    expect(ownProductionChanges({ ...state, config: input.config }, { ...iteration, ownWritesComplete: input.complete }).productionChanges).toEqual(iteration.filesChanged);
  });
});
