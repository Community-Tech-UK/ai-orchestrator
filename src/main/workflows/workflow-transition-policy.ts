import type {
  WorkflowStartSource,
  WorkflowTemplate,
  WorkflowTransitionInputs,
  WorkflowTransitionPolicy,
} from '../../shared/types/workflow.types';

export type WorkflowOverlapCategory =
  | 'no-overlap'
  | 'compatible'
  | 'incompatible'
  | 'superseding'
  | 'blocked';

type TemplateCategory = WorkflowTemplate['category'];

const COMPATIBLE_OVERLAP: Record<TemplateCategory, ReadonlySet<TemplateCategory>> = {
  development: new Set<TemplateCategory>(['review', 'debugging', 'custom']),
  review: new Set<TemplateCategory>(['development', 'debugging', 'custom']),
  debugging: new Set<TemplateCategory>(['development', 'review', 'custom']),
  custom: new Set<TemplateCategory>(['development', 'review', 'debugging']),
};

export function evaluateTransition(inputs: WorkflowTransitionInputs): WorkflowTransitionPolicy {
  if (inputs.source === 'restore') {
    return { kind: 'allow' };
  }

  if (!inputs.current) {
    return { kind: 'allow' };
  }

  const currentExecution = inputs.current.execution;
  const currentTemplate = inputs.current.template;
  const requestedTemplate = inputs.requested.template;

  if (currentExecution.completedAt) {
    return { kind: 'allow' };
  }

  if (currentExecution.templateId === requestedTemplate.id) {
    return {
      kind: 'deny',
      reason: `Workflow ${currentTemplate.name} is already active.`,
      suggestedAction: currentExecution.pendingGate ? 'open-active-gate' : 'cancel-current',
    };
  }

  if (currentExecution.pendingGate && inputs.source === 'nl-suggestion') {
    return {
      kind: 'deny',
      reason: `Active workflow is awaiting your input on phase ${currentExecution.pendingGate.phaseId}. Resolve it first.`,
      suggestedAction: 'open-active-gate',
    };
  }

  if (currentTemplate.category === requestedTemplate.category) {
    if (inputs.source === 'automation') {
      return {
        kind: 'deny',
        reason: `Cannot supersede ${currentTemplate.name} from a background automation.`,
        suggestedAction: 'cancel-current',
      };
    }

    return { kind: 'autoCompleteCurrent' };
  }

  if (COMPATIBLE_OVERLAP[currentTemplate.category]?.has(requestedTemplate.category)) {
    return { kind: 'allowWithOverlap', maxConcurrent: 2 };
  }

  return {
    kind: 'deny',
    reason: `Cannot run ${requestedTemplate.name} while ${currentTemplate.name} (${currentTemplate.category}) is active.`,
    suggestedAction: 'cancel-current',
  };
}

export function classifyOverlap(inputs: WorkflowTransitionInputs): WorkflowOverlapCategory {
  if (!inputs.current || inputs.current.execution.completedAt) {
    return 'no-overlap';
  }

  if (inputs.current.execution.templateId === inputs.requested.template.id) {
    return 'blocked';
  }

  if (inputs.current.template.category === inputs.requested.template.category) {
    return 'superseding';
  }

  return COMPATIBLE_OVERLAP[inputs.current.template.category]?.has(inputs.requested.template.category)
    ? 'compatible'
    : 'incompatible';
}

export function describeWorkflowStartSource(source: WorkflowStartSource): string {
  switch (source) {
    case 'slash-command':
      return 'slash command';
    case 'nl-suggestion':
      return 'natural-language suggestion';
    case 'automation':
      return 'automation';
    case 'manual-ui':
      return 'manual UI';
    case 'restore':
      return 'restore';
  }
}
