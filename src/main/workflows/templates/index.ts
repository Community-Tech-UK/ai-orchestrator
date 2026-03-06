/**
 * Built-in Workflow Templates
 * Export all built-in workflow templates
 */

import { WorkflowTemplate } from '../../../shared/types/workflow.types';
import { featureDevelopmentTemplate } from './feature-development';
import { issueImplementationTemplate } from './issue-implementation';
import { prReviewTemplate } from './pr-review';
import { repoHealthAuditTemplate } from './repo-health-audit';

export const builtInTemplates: WorkflowTemplate[] = [
  featureDevelopmentTemplate,
  issueImplementationTemplate,
  prReviewTemplate,
  repoHealthAuditTemplate,
];

export {
  featureDevelopmentTemplate,
  issueImplementationTemplate,
  prReviewTemplate,
  repoHealthAuditTemplate,
};
