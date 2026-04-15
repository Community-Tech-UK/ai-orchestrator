/**
 * Learning & Self-Improvement Domain Bootstrap
 *
 * Initializes A/B testing, outcome tracking, prompt enhancement,
 * and strategy learning singletons.
 */

import { registerBootstrapModule } from './index';

export function registerLearningBootstrap(): void {
  registerBootstrapModule({
    name: 'Learning singletons',
    domain: 'learning',
    failureMode: 'degraded',
    init: () => {
      const { getOutcomeTracker } = require('../learning/outcome-tracker') as typeof import('../learning/outcome-tracker');
      const { getStrategyLearner } = require('../learning/strategy-learner') as typeof import('../learning/strategy-learner');
      const { getPromptEnhancer } = require('../learning/prompt-enhancer') as typeof import('../learning/prompt-enhancer');
      const { getABTestingEngine } = require('../learning/ab-testing') as typeof import('../learning/ab-testing');

      getOutcomeTracker();
      getStrategyLearner();
      getPromptEnhancer();
      getABTestingEngine();
    },
  });
}
