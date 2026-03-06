/**
 * PR Review Workflow Template
 * Structured approach for reviewing pull requests with specialized review agents
 * Based on validated patterns from Claude Code pr-review-toolkit
 */

import { WorkflowTemplate } from '../../../shared/types/workflow.types';

export const prReviewTemplate: WorkflowTemplate = {
  id: 'pr-review',
  name: 'PR Review',
  description:
    'Comprehensive pull request review with security, quality, test coverage, and optional browser evidence analysis',
  icon: 'git-pull-request',
  category: 'review',
  triggerPatterns: [
    'review pr',
    'review pull request',
    'pr review',
    'code review',
    'review changes',
  ],
  autoTrigger: false,
  estimatedDuration: '15-30 minutes',
  requiredAgents: ['security-analyzer', 'code-reviewer', 'test-coverage-analyzer'],

  phases: [
    {
      id: 'context',
      name: 'Context Gathering',
      description: 'Understand the PR purpose and scope',
      order: 0,
      gateType: 'none',
      systemPromptAddition: `
## Current Phase: CONTEXT GATHERING

Analyze the pull request to understand its purpose:

1. **PR Description**: What does the PR claim to do?
2. **Changed Files**: What files are modified/added/deleted?
3. **Scope**: Is this a feature, bugfix, refactor, or something else?
4. **Risk Assessment**: Initial assessment of change risk (low/medium/high)

Use git diff to see the changes. Provide a summary of:
- What the PR is trying to accomplish
- List of all files changed with brief description of each change
- Initial risk assessment with reasoning

When complete, advance to the Security Review phase.
`,
    },
    {
      id: 'security',
      name: 'Security Review',
      description: 'Identify security vulnerabilities and unsafe patterns',
      order: 1,
      gateType: 'completion',
      agents: {
        count: 1,
        agentType: 'security-analyzer',
        parallel: false,
        prompts: [
          `Review the PR changes for security vulnerabilities:

1. **Injection Risks**: SQL, XSS, command injection, etc.
2. **Authentication/Authorization**: Missing or weak checks
3. **Secrets**: Hardcoded credentials or API keys
4. **Input Validation**: Missing or insufficient validation
5. **Cryptography**: Weak algorithms or improper usage
6. **Dependencies**: Known vulnerable packages

For each issue found, report:
- Severity (CRITICAL/HIGH/MEDIUM/LOW)
- Confidence (0-100)
- File and line number
- Description and fix suggestion

Only report issues with confidence ≥85.`,
        ],
      },
      systemPromptAddition: `
## Current Phase: SECURITY REVIEW

A security analyzer agent is reviewing the changes for vulnerabilities.

After it completes:
1. Review the security findings
2. Add any additional security concerns you identify
3. Prioritize issues by severity

Present all security issues clearly with file locations and suggested fixes.
`,
    },
    {
      id: 'quality',
      name: 'Code Quality Review',
      description: 'Review code quality, patterns, and potential bugs',
      order: 2,
      gateType: 'completion',
      agents: {
        count: 2,
        agentType: 'code-reviewer',
        parallel: true,
        prompts: [
          `Review for code quality and maintainability:
- DRY violations
- Complex or hard-to-read code
- Missing or unclear documentation
- Inconsistent naming
- Code smells

Report issues with confidence 0-100.`,
          `Review for bugs and correctness:
- Logic errors
- Edge case handling
- Null/undefined handling
- Error handling
- Race conditions
- Type safety issues

Report issues with confidence 0-100.`,
        ],
      },
      systemPromptAddition: `
## Current Phase: CODE QUALITY REVIEW

Two review agents are analyzing the code:
1. Code quality and maintainability
2. Bugs and correctness

After they complete:
1. Consolidate findings
2. Filter to issues with confidence ≥80
3. Identify any patterns in the issues

Present findings organized by file.
`,
    },
    {
      id: 'tests',
      name: 'Test Coverage Review',
      description: 'Identify missing tests and test quality issues',
      order: 3,
      gateType: 'completion',
      agents: {
        count: 1,
        agentType: 'test-coverage-analyzer',
        parallel: false,
        prompts: [
          `Analyze test coverage for the changed code:

1. **New Code**: Is new functionality tested?
2. **Edge Cases**: Are edge cases covered?
3. **Error Paths**: Are error scenarios tested?
4. **Test Quality**: Do tests actually verify behavior?

For each gap found, report:
- Severity (1-10)
- What's missing
- Risk if not tested
- Suggested test outline`,
        ],
      },
      systemPromptAddition: `
## Current Phase: TEST COVERAGE REVIEW

A test coverage analyzer is reviewing the changes.

After it completes:
1. Review the test gaps identified
2. Prioritize by risk (focus on severity ≥7)
3. Consider if any are blockers for merge

Present test coverage findings with specific test suggestions.
`,
    },
    {
      id: 'browser-evidence',
      name: 'Browser Evidence Review',
      description: 'Capture screenshots, console logs, and network evidence when the change affects a runnable UI',
      order: 4,
      gateType: 'none',
      systemPromptAddition: `
## Current Phase: BROWSER EVIDENCE REVIEW

If the repository exposes a browser-based flow relevant to this PR:
1. Run the smallest useful browser validation path.
2. Capture screenshots for visual regressions when applicable.
3. Record console errors, failed requests, HAR files, or trace references when available.
4. Keep heavyweight artifacts as file references and summarize the evidence in prose.

If the change is not meaningfully testable in a browser, say so explicitly and continue.
`,
    },
    {
      id: 'summary',
      name: 'Review Summary',
      description: 'Consolidate findings and provide recommendation',
      order: 5,
      gateType: 'user_selection',
      gatePrompt: 'What action would you like to take on this PR?',
      gateOptions: [
        'Approve (no issues or all resolved)',
        'Request Changes (blocking issues found)',
        'Comment Only (suggestions, no blockers)',
      ],
      systemPromptAddition: `
## Current Phase: REVIEW SUMMARY

Consolidate all review findings into a comprehensive summary:

1. **Overall Assessment**:
   - Is this PR ready to merge?
   - Risk level (Low/Medium/High)
   - Confidence in assessment

2. **Blocking Issues** (must fix before merge):
   - Security vulnerabilities
   - Bugs with high confidence
   - Critical test gaps

3. **Suggestions** (should fix but not blocking):
   - Code quality improvements
   - Additional tests
   - Documentation

4. **Positive Notes**:
   - What was done well
   - Good patterns followed

5. **Recommendation**:
   - APPROVE / REQUEST CHANGES / COMMENT

Ask: "What action would you like to take on this PR?"
`,
    },
  ],
};
