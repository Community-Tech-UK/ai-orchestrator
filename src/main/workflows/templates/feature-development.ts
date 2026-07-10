/**
 * Feature Development Workflow Template
 * Structured 7-phase approach for implementing new features with parallel agent exploration
 * Based on validated patterns from Claude Code feature-dev plugin
 */

import { WorkflowTemplate } from '../../../shared/types/workflow.types';

const REVIEW_OUTPUT_CONTRACT =
  'Format each qualifying finding as `- [severity] [confidence NN/100] file:line — issue — evidence — suggested fix`. ' +
  'Use critical/high/medium/low severity. If no qualifying findings remain after genuine review, state `No qualifying findings`. ';

export const featureDevelopmentTemplate: WorkflowTemplate = {
  id: 'feature-development',
  name: 'Feature Development',
  description:
    'Structured 7-phase approach for implementing new features with parallel agent exploration',
  icon: 'rocket',
  category: 'development',
  triggerPatterns: [
    'implement feature',
    'add feature',
    'create feature',
    'build feature',
    'develop feature',
  ],
  autoTrigger: false,
  estimatedDuration: '30-60 minutes',
  requiredAgents: ['code-explorer', 'code-architect', 'code-reviewer'],

  phases: [
    {
      id: 'discovery',
      name: 'Discovery',
      description: 'Parse and understand the feature requirements',
      order: 0,
      gateType: 'none',
      systemPromptAddition: `
## Current Phase: DISCOVERY

Your task is to thoroughly understand the feature requirements:

1. **Parse the Request**: Identify the core functionality being requested
2. **Identify Scope**: What components, files, or systems will be affected?
3. **List Assumptions**: What assumptions are you making about the requirements?
4. **Note Ambiguities**: What aspects need clarification?

Track the seven workflow phases with your task or todo tooling, if available. The workflow engine owns phase advancement; your task list is only a working aid.

Output a clear summary of what you understand the feature to be.
When complete, the workflow will automatically advance to Codebase Exploration.
`,
    },
    {
      id: 'exploration',
      name: 'Codebase Exploration',
      description: 'Search and understand relevant existing code using parallel agents',
      order: 1,
      gateType: 'completion',
      requiredActions: ['files_identified', 'patterns_documented'],
      agents: {
        count: 3,
        agentType: 'code-explorer',
        parallel: true,
        prompts: [
          'Find similar features in this codebase. What patterns do they follow? List 5-10 key files to understand.',
          'Explore the architecture and data flow relevant to this feature. What are the integration points? List 5-10 key files.',
          'Look at the user experience and API patterns. How do similar features expose their functionality? List 5-10 key files.',
        ],
      },
      systemPromptAddition: `
## Current Phase: CODEBASE EXPLORATION

Three exploration agents are searching the codebase in parallel with different focuses:
1. Similar features and patterns
2. Architecture and data flow
3. User experience and APIs

After they complete:
1. Review their findings
2. Review and deduplicate the three file lists, then read the files most relevant to the chosen scope
3. Document the patterns you discovered
4. Present a comprehensive summary of the codebase understanding

Mark 'files_identified' and 'patterns_documented' complete when done.
`,
    },
    {
      id: 'clarification',
      name: 'Clarifying Questions',
      description: 'Ask targeted questions to fill gaps in understanding',
      order: 2,
      gateType: 'user_confirmation',
      gatePrompt:
        "Please answer all clarifying questions above. When you've provided answers, confirm to proceed to Architecture Design.",
      systemPromptAddition: `
## Current Phase: CLARIFYING QUESTIONS

This phase prevents expensive rework later — invest real effort here even when the feature seems clear.

Based on your codebase exploration, identify all underspecified aspects:

1. **Edge Cases**: What happens in error scenarios? Empty states?
2. **Error Handling**: How should failures be handled and reported?
3. **Integration Points**: Any specific requirements for integrating with existing code?
4. **Scope Boundaries**: What's explicitly out of scope?
5. **Design Preferences**: Any UI/UX or API design preferences?
6. **Backward Compatibility**: Any existing functionality that must not break?
7. **Performance Requirements**: Any specific performance constraints?

Present ALL questions in a clear, numbered list.

**WAIT for the user to answer before proceeding.**

If the user says "whatever you think is best":
- Provide your recommendation
- Get explicit confirmation before proceeding
`,
    },
    {
      id: 'architecture',
      name: 'Architecture Design',
      description: 'Design multiple implementation approaches with different trade-offs',
      order: 3,
      gateType: 'user_selection',
      gatePrompt: 'Please select which approach you prefer for the implementation.',
      gateOptions: [
        'Minimal Changes (smallest change, maximum reuse)',
        'Clean Architecture (maintainability, elegant abstractions)',
        'Pragmatic Balance (speed + quality)',
      ],
      agents: {
        count: 3,
        agentType: 'code-architect',
        parallel: true,
        prompts: [
          'Design an approach that minimizes changes. Maximize reuse of existing code. Focus on the smallest possible diff.',
          'Design a clean architecture approach. Focus on maintainability, proper abstractions, and elegant design patterns.',
          'Design a pragmatic approach balancing speed and quality. What can we ship quickly while maintaining good practices?',
        ],
      },
      systemPromptAddition: `
## Current Phase: ARCHITECTURE DESIGN

Three architecture agents are designing approaches in parallel:
1. **Minimal Changes**: Smallest diff, maximum reuse
2. **Clean Architecture**: Maintainability and elegance
3. **Pragmatic Balance**: Speed + quality

After they complete, present to the user:
1. Summary of each approach (key differences)
2. Trade-offs comparison table
3. **Your recommendation with reasoning**
4. Concrete implementation differences (files, patterns)

Ask the user: "Which approach do you prefer?"

**DO NOT proceed to implementation until user selects an approach.**
`,
    },
    {
      id: 'implementation',
      name: 'Implementation',
      description: 'Build the feature following the chosen architecture',
      order: 4,
      gateType: 'user_approval',
      gatePrompt:
        'Ready to begin implementation using the selected approach. Do you approve proceeding?',
      maxIterations: 25,
      systemPromptAddition: `
## Current Phase: IMPLEMENTATION

The approval gate has passed and the user selected an approach. Implement the feature:

1. **Read First**: Re-read all relevant files identified in exploration
2. **Follow Conventions**: Match existing codebase patterns exactly
3. **Incremental Progress**: Build incrementally, update todos as you go
4. **Clean Code**: Write well-documented, maintainable code
5. **Error Handling**: Include proper error handling throughout

Implementation guidelines:
- Follow the chosen architecture approach
- Keep changes focused and minimal
- Follow the repository's commenting conventions; comment only where the reasoning is not clear from the code
- Consider edge cases identified in clarification

Update your task tracking, if available, as you complete each component.
`,
    },
    {
      id: 'review',
      name: 'Quality Review',
      description: 'Self-review using parallel specialized review agents',
      order: 5,
      gateType: 'user_selection',
      gatePrompt: 'Review complete. What would you like to do with the findings?',
      gateOptions: [
        'Fix all issues now',
        'Fix critical issues only',
        'Proceed without fixes (acknowledge issues)',
      ],
      agents: {
        count: 3,
        agentType: 'code-reviewer',
        parallel: true,
        prompts: [
          `Review for simplicity, DRY principles, and maintainability. ${REVIEW_OUTPUT_CONTRACT}`,
          `Review for bugs, functional correctness, edge cases, and runtime failures. ${REVIEW_OUTPUT_CONTRACT}`,
          `Review for repository conventions, integration wiring, and appropriate abstractions. ${REVIEW_OUTPUT_CONTRACT}`,
        ],
      },
      systemPromptAddition: `
## Current Phase: QUALITY REVIEW

Three review agents are analyzing the implementation:
1. **Simplicity/DRY/Elegance**: Is the code clean and maintainable?
2. **Bugs/Correctness**: Are there logic errors or edge cases?
3. **Conventions/Abstractions**: Does it follow project patterns?

After reviews complete:
1. Consolidate all findings
2. Filter to issues with confidence ≥80
3. Prioritize by severity (Critical > High > Medium)
4. Present findings to user

Ask: "What would you like to do with these findings?"
- Fix all issues now
- Fix critical issues only
- Proceed without fixes

**Address issues based on user's decision.**
`,
    },
    {
      id: 'summary',
      name: 'Summary',
      description: 'Document the completed work and next steps',
      order: 6,
      gateType: 'none',
      systemPromptAddition: `
## Current Phase: SUMMARY

The feature is complete. Provide a comprehensive summary:

1. **What Was Built**: High-level description of the feature
2. **Key Decisions**: Important architectural or implementation choices made
3. **Files Modified**: List of all created/modified files
4. **Suggested Next Steps**: What should be done next (tests, documentation, etc.)
5. **Known Limitations**: Any limitations or future improvements

Close any remaining task-tracking items that are actually complete.

Present the summary clearly for the user's reference.
`,
    },
  ],
};
