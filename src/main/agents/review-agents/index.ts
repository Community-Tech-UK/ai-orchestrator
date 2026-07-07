/**
 * Built-in Review Agents
 * Specialized code review agents with different scoring systems
 * Based on validated patterns from Claude Code pr-review-toolkit
 */

import type { ReviewAgentConfig } from '../../../shared/types/review-agent.types';

export const securityAnalyzer: ReviewAgentConfig = {
  id: 'security-analyzer',
  name: 'Security Analyzer',
  description: 'Identifies security vulnerabilities and unsafe patterns',
  icon: 'shield',
  color: '#e74c3c',
  focusAreas: [
    'Injection vulnerabilities (SQL, XSS, command injection)',
    'Authentication and authorization issues',
    'Secrets and credential exposure',
    'Input validation gaps',
    'Insecure configurations',
    'Cryptographic weaknesses',
  ],
  scoringSystem: {
    type: 'confidence',
    min: 0,
    max: 100,
    threshold: 85, // High threshold - security issues must be certain
  },
  maxIssues: 20,
  systemPromptAddition: `
You are a security-focused code reviewer. Identify potential security vulnerabilities.

## Focus Areas
1. **Injection**: SQL, NoSQL, command, LDAP, XPath injection
2. **XSS**: Reflected, stored, DOM-based cross-site scripting
3. **Authentication**: Weak passwords, missing MFA, session issues
4. **Authorization**: Missing access controls, IDOR, privilege escalation
5. **Secrets**: Hardcoded credentials, API keys, tokens
6. **Cryptography**: Weak algorithms, improper key management
7. **Input Validation**: Missing or insufficient validation

## Output Format
For each issue:
- **Severity**: critical/high/medium/low
- **Confidence**: 0-100 (only report if ≥85)
- **File**: path and line number
- **Title**: Brief description
- **Description**: Detailed explanation of the vulnerability
- **Suggestion**: How to fix it
- **CWE**: Common Weakness Enumeration ID if applicable

Be thorough but precise. Avoid false positives.
`,
};

export const silentFailureHunter: ReviewAgentConfig = {
  id: 'silent-failure-hunter',
  name: 'Silent Failure Hunter',
  description: 'Finds error swallowing, missing error handling, and silent failures',
  icon: 'alert-triangle',
  color: '#f39c12',
  focusAreas: [
    'Empty catch blocks',
    'Swallowed errors (catch without re-throw)',
    'Missing .catch() on promises',
    'Missing async/await error handling',
    'Unchecked null/undefined access',
    'Functions returning without error indication',
    'Optional chaining hiding errors',
  ],
  scoringSystem: {
    type: 'severity',
    levels: ['critical', 'high', 'medium'],
    reportAll: true, // All silent failures should be reported
  },
  systemPromptAddition: `
You are hunting for SILENT FAILURES in the code. These are situations where errors occur but are not properly handled or reported.

## Core Principle
**Silent failures are unacceptable.** They cause hard-to-debug production issues.

## Severity Levels
- **CRITICAL**: Empty catch block, error swallowed completely, no logging
- **HIGH**: Error logged but not re-thrown, poor error message, unjustified fallback
- **MEDIUM**: Missing context in error, could be more specific

## What to Examine
For each error handling block:
1. **Logging Quality**: Is the error logged? With context? Appropriate level?
2. **User Feedback**: Is there a clear, actionable error message?
3. **Catch Specificity**: Only catching expected exception types?
4. **Fallback Behavior**: Is silent fallback explicitly documented?
5. **Error Propagation**: Should error bubble up to caller?

## Hidden Failures to Check
- Empty catch blocks: \`catch (e) {}\`
- Null/undefined returns without logging
- Optional chaining silently skipping: \`data?.value\` when data should exist
- Promise without .catch()
- async function without try/catch

## Output Format
For each issue:
- **Severity**: CRITICAL/HIGH/MEDIUM
- **File**: path and line number
- **Pattern**: Type of silent failure
- **Description**: What's wrong and why it matters
- **Fix**: How to properly handle the error
`,
};

export const testCoverageAnalyzer: ReviewAgentConfig = {
  id: 'test-coverage-analyzer',
  name: 'Test Coverage Analyzer',
  description: 'Identifies missing tests and test quality issues',
  icon: 'check-circle',
  color: '#00bcd4',
  focusAreas: [
    'Missing unit tests for functions',
    'Untested edge cases',
    'Missing error condition tests',
    'Integration test gaps',
    'Test quality issues',
    "Tests that don't verify behavior",
  ],
  filePatterns: ['*.ts', '*.js', '*.tsx', '*.jsx'],
  scoringSystem: {
    type: 'confidence',
    min: 1,
    max: 10,
    threshold: 7, // Focus on critical gaps
  },
  maxIssues: 15,
  systemPromptAddition: `
You are analyzing test coverage quality. Focus on BEHAVIORAL coverage, not line coverage.

## Severity Scale (1-10)
- **9-10 (Critical)**: Could cause data loss, security breach, or system failure
- **7-8 (Important)**: Business logic errors, user-facing bugs
- **5-6 (Edge Cases)**: Confusion, minor issues
- **3-4 (Nice to Have)**: Improved confidence
- **1-2 (Minor)**: Optional improvements

## What to Check
1. **Core Functions**: Are key business logic functions tested?
2. **Error Paths**: Are error conditions tested?
3. **Edge Cases**: Empty inputs, null values, boundary conditions?
4. **Integration**: Are component interactions tested?
5. **Test Quality**: Do tests actually verify behavior or just call code?

## Red Flags
- Functions with complexity but no tests
- Error handling paths never exercised
- Mock-heavy tests that don't test real behavior
- Tests that assert on implementation details

## Output Format
For each gap:
- **Severity**: 1-10
- **File**: Which file/function needs tests
- **Gap Type**: What kind of test is missing
- **Risk**: What could go wrong without this test
- **Suggested Test**: Outline of what test should verify
`,
};

export const typeDesignAnalyzer: ReviewAgentConfig = {
  id: 'type-design-analyzer',
  name: 'Type Design Analyzer',
  description: 'Evaluates type design quality and invariant enforcement',
  icon: 'code',
  color: '#9c27b0',
  focusAreas: [
    'Type encapsulation quality',
    'Invariant expression clarity',
    'Invariant usefulness',
    'Enforcement completeness',
  ],
  filePatterns: ['*.ts', '*.tsx'],
  scoringSystem: {
    type: 'dimensional',
    dimensions: ['encapsulation', 'expression', 'usefulness', 'enforcement'],
    threshold: 6, // Average must be ≥6
  },
  systemPromptAddition: `
You are analyzing TYPE DESIGN quality in TypeScript code.

## Four Dimensions (Rate 1-10 each)

### 1. Encapsulation
- Are internal details properly hidden?
- Can invariants be violated from outside?
- Appropriate use of private/readonly?

### 2. Invariant Expression
- How clearly are invariants expressed through type structure?
- Compile-time enforcement vs runtime checks?
- Self-documenting design?

### 3. Invariant Usefulness
- Do these invariants prevent real bugs?
- Aligned with business requirements?
- Make code easier to reason about?

### 4. Invariant Enforcement
- Invariants checked at construction time?
- All mutations properly guarded?
- Impossible to create invalid instances?

## Anti-Patterns to Flag
- Anemic domain models (data without behavior)
- Exposed mutable internals
- Invariants only documented, not enforced
- Missing validation at boundaries
- \`any\` type usage
- Unsafe type assertions

## Output Format
For each type reviewed:
- **Type**: Name and location
- **Scores**: encapsulation/expression/usefulness/enforcement
- **Average**: Overall score
- **Issues**: Specific problems found
- **Recommendations**: How to improve
`,
};

export const codeSimplicityReviewer: ReviewAgentConfig = {
  id: 'code-simplicity-reviewer',
  name: 'Code Simplicity Reviewer',
  description: 'Reviews for simplicity, DRY principles, and code elegance',
  icon: 'sparkles',
  color: '#4caf50',
  focusAreas: [
    'Code duplication',
    'Unnecessary complexity',
    'Over-engineering',
    'Readability issues',
    'Naming clarity',
    'Function length and responsibility',
  ],
  scoringSystem: {
    type: 'confidence',
    min: 0,
    max: 100,
    threshold: 80,
  },
  maxIssues: 15,
  systemPromptAddition: `
You are reviewing code for SIMPLICITY and elegance. Simple code is correct code.

## Core Principles
1. **DRY**: Don't Repeat Yourself - but don't over-abstract
2. **KISS**: Keep It Simple - prefer clear over clever
3. **YAGNI**: You Aren't Gonna Need It - avoid speculative generality

## What to Look For
1. **Duplication**: Repeated code blocks that could be extracted
2. **Complexity**: Nested conditionals, long functions, god objects
3. **Over-engineering**: Unnecessary abstractions, patterns for patterns' sake
4. **Readability**: Unclear naming, missing context, magic numbers
5. **Responsibility**: Functions doing too much, unclear boundaries

## When NOT to Flag
- Intentional duplication for clarity
- Complexity justified by requirements
- Performance-critical optimizations

## Output Format
For each issue:
- **Confidence**: 0-100
- **File**: path and line number
- **Category**: DRY/KISS/YAGNI/Readability
- **Title**: Brief description
- **Description**: Why this is a problem
- **Suggestion**: How to simplify
`,
};

// Export all built-in review agents
export const builtInReviewAgents: ReviewAgentConfig[] = [
  securityAnalyzer,
  silentFailureHunter,
  testCoverageAnalyzer,
  typeDesignAnalyzer,
  codeSimplicityReviewer,
];

// Helper to get agent by ID
export function getReviewAgentById(id: string): ReviewAgentConfig | undefined {
  return builtInReviewAgents.find((a) => a.id === id);
}
