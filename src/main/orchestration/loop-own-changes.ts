import type { LoopIteration, LoopState } from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';
import { isReviewDrivenProductionChange } from './loop-review-reuse-anchor';
const logger = getLogger('LoopOwnChanges');

/** Attribution narrows only complete Claude/Codex capture in shared workspaces. */
export function ownProductionChanges(state: LoopState, iteration: LoopIteration): {
  productionChanges: LoopIteration['filesChanged']; foreignPaths: string[];
} {
  const production = iteration.filesChanged.filter(file => isReviewDrivenProductionChange(file.path));
  if (state.config.isolateLoopWorkspaces || !['claude', 'codex'].includes(state.config.provider)
    || iteration.ownWritesComplete !== true) return { productionChanges: production, foreignPaths: [] };
  const own = new Set(iteration.ownWritePaths ?? []);
  const productionChanges = production.filter(file => own.has(file.path));
  const foreignPaths = production.filter(file => !own.has(file.path)).map(file => file.path);
  if (foreignPaths.length > 0) logger.info('Shared workspace edits are outside this loop’s captured writes', {
    loopRunId: state.id, seq: iteration.seq, foreignPaths,
  });
  return { productionChanges, foreignPaths };
}
