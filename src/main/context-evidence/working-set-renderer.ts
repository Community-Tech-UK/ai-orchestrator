import { ContextTokenEstimator } from './context-token-estimator';
import {
  buildWorkingSetRepresentation,
  type WorkingSetPlan,
} from './working-set-planner';

export interface RenderedWorkingSet {
  content: string;
  totalTokens: number;
  structuralOverheadTokens: number;
  sectionTokens: {
    requiredControl: number;
    recentDialogue: number;
    evidenceCards: number;
    exactExcerpts: number;
  };
}

export class WorkingSetRenderer {
  constructor(private readonly estimator = new ContextTokenEstimator()) {}

  render(plan: WorkingSetPlan): RenderedWorkingSet {
    if (plan.status === 'paused') throw new Error('WORKING_SET_PAUSED');

    const representation = buildWorkingSetRepresentation(plan.requiredControl, plan.selected);
    const estimate = this.estimator.estimate(representation.content);
    if (
      estimate.tokens !== plan.renderAccounting.totalTokens
      || estimate.estimateKind !== plan.renderAccounting.estimateKind
    ) {
      throw new Error('WORKING_SET_ESTIMATOR_MISMATCH');
    }

    return {
      content: representation.content,
      totalTokens: plan.renderAccounting.totalTokens,
      structuralOverheadTokens: plan.renderAccounting.structuralOverheadTokens,
      sectionTokens: { ...plan.renderAccounting.sectionTokens },
    };
  }
}
