import { WorkflowTemplate } from '../../../shared/types/workflow.types';

export const issueImplementationTemplate: WorkflowTemplate = {
  id: 'issue-implementation',
  name: 'Issue Implementation',
  description: 'Structured issue implementation workflow with scoped investigation, coding, and verification',
  icon: 'ticket',
  category: 'development',
  triggerPatterns: [
    'implement issue',
    'implement ticket',
    'fix issue',
    'work on ticket',
  ],
  autoTrigger: false,
  estimatedDuration: '30-90 minutes',
  requiredAgents: ['code-explorer', 'code-reviewer'],

  phases: [
    {
      id: 'triage',
      name: 'Issue Triage',
      description: 'Understand the issue, boundaries, and risk',
      order: 0,
      gateType: 'none',
      systemPromptAddition: `
## Current Phase: ISSUE TRIAGE

Understand the issue or ticket before changing code:

1. Restate the requested behavior or fix.
2. Identify the likely files and systems involved.
3. Note assumptions and missing context.
4. Assess implementation risk and likely test impact.

When complete, advance to Targeted Investigation.
`,
    },
    {
      id: 'investigation',
      name: 'Targeted Investigation',
      description: 'Read the relevant code paths and confirm the change shape',
      order: 1,
      gateType: 'completion',
      requiredActions: ['files_identified', 'approach_selected'],
      systemPromptAddition: `
## Current Phase: TARGETED INVESTIGATION

Read the relevant implementation paths before editing:

1. Identify the exact files to change.
2. Confirm the minimal viable implementation.
3. Capture any constraints from adjacent systems.

Mark 'files_identified' and 'approach_selected' when ready.
`,
    },
    {
      id: 'implementation',
      name: 'Implementation',
      description: 'Make the focused code change',
      order: 2,
      gateType: 'none',
      systemPromptAddition: `
## Current Phase: IMPLEMENTATION

Implement the change with minimal scope:

1. Match existing conventions.
2. Keep the diff focused.
3. Include the necessary verification changes only.
4. Avoid unrelated cleanup.
`,
    },
    {
      id: 'verification',
      name: 'Verification',
      description: 'Run the most relevant checks and review the diff',
      order: 3,
      gateType: 'completion',
      requiredActions: ['verification_run'],
      systemPromptAddition: `
## Current Phase: VERIFICATION

Run the most relevant checks available for the affected area:

1. Typecheck, lint, and targeted tests where applicable.
2. Review the final diff for regressions or scope creep.
3. Call out any checks you could not run.

Mark 'verification_run' when complete.
`,
    },
    {
      id: 'summary',
      name: 'Summary',
      description: 'Summarize the implementation and next steps',
      order: 4,
      gateType: 'none',
      systemPromptAddition: `
## Current Phase: SUMMARY

Provide a concise summary:

1. What changed.
2. What was verified.
3. Any remaining risks or follow-ups.
`,
    },
  ],
};
