/**
 * Review prompt templates for cross-model verification.
 *
 * Design informed by:
 * - HuggingFace LLM-as-Judge Cookbook (reasoning-before-scoring, 1-4 scale)
 * - MT-Bench judge prompts (Zheng et al., LMSYS)
 * - Chain-of-Verification (Meta AI, ACL 2024)
 */

export function buildStructuredReviewPrompt(taskDescription: string, primaryOutput: string): string {
  return `You are a verification agent reviewing another AI's output. Your job is NOT to re-solve the problem, but to verify the solution's correctness.

## Task Context
${taskDescription}

## Output Under Review
${primaryOutput}

## Review Checklist
Evaluate each dimension independently. For each, provide a brief justification BEFORE your score.

1. **Correctness**: Does the code/plan achieve what was asked? Any bugs, logic errors, or wrong assumptions?
2. **Completeness**: Are there missing edge cases, error handling, or steps?
3. **Security**: Any injection vulnerabilities, auth issues, data exposure, or unsafe patterns?
4. **Consistency**: Does it contradict itself or the task requirements?

## Scoring
For each dimension:
- 4: No issues found
- 3: Minor issues (style, non-critical suggestions)
- 2: Notable issues that should be addressed
- 1: Critical issues that would cause failures

## Output Format
Respond ONLY with this JSON (no markdown fences, no preamble):
{
  "correctness": { "reasoning": "...", "score": N, "issues": [] },
  "completeness": { "reasoning": "...", "score": N, "issues": [] },
  "security": { "reasoning": "...", "score": N, "issues": [] },
  "consistency": { "reasoning": "...", "score": N, "issues": [] },
  "overall_verdict": "APPROVE | CONCERNS | REJECT",
  "summary": "One sentence overall assessment"
}

Be rigorous but fair. Only flag genuine issues, not stylistic preferences.`;
}

export function buildTieredReviewPrompt(taskDescription: string, primaryOutput: string): string {
  return `You are a senior verification agent performing a deep review of another AI's output on a complex task. This is high-stakes — be thorough.

## Task Context
${taskDescription}

## Output Under Review
${primaryOutput}

## Deep Verification Steps

### Step 1: Trace Through Execution
Pick 2-3 concrete scenarios (including an edge case) and mentally trace the code/plan through each. Show your work briefly.

### Step 2: Boundary Analysis
Check: empty inputs, single elements, maximum values, null/undefined, concurrent access, error paths. List what you checked.

### Step 3: Assumption Audit
What assumptions does this output make that are NOT guaranteed by the task description? List each with severity.

### Step 4: Dependency & Integration Check
Would this break anything upstream or downstream? Are imports/interfaces correct? Any missing migrations, config changes, or wiring?

### Step 5: Dimensional Scoring
Score each (1-4, with reasoning BEFORE score):
1. **Correctness** — logic, algorithms, data flow
2. **Completeness** — missing pieces, edge cases
3. **Security** — vulnerabilities, data handling
4. **Consistency** — internal contradictions, requirement mismatches
5. **Feasibility** — will this actually work in practice?

## Output Format
Respond ONLY with this JSON (no markdown fences, no preamble):
{
  "traces": [{ "scenario": "...", "result": "pass|fail", "detail": "..." }],
  "boundaries_checked": ["...", "..."],
  "assumptions": [{ "assumption": "...", "severity": "high|medium|low" }],
  "integration_risks": ["...", "..."],
  "scores": {
    "correctness": { "reasoning": "...", "score": N, "issues": [] },
    "completeness": { "reasoning": "...", "score": N, "issues": [] },
    "security": { "reasoning": "...", "score": N, "issues": [] },
    "consistency": { "reasoning": "...", "score": N, "issues": [] },
    "feasibility": { "reasoning": "...", "score": N, "issues": [] }
  },
  "overall_verdict": "APPROVE | CONCERNS | REJECT",
  "summary": "One sentence overall assessment",
  "critical_issues": ["Only issues that MUST be addressed"]
}

Do not nitpick style. Focus on things that would cause real failures.`;
}

/** Maximum characters to send as review payload (~8K tokens) */
export const MAX_REVIEW_PAYLOAD_CHARS = 32000;

export function truncateForReview(content: string): string {
  if (content.length <= MAX_REVIEW_PAYLOAD_CHARS) return content;
  const totalChars = content.length;
  return content.slice(0, MAX_REVIEW_PAYLOAD_CHARS) +
    `\n\n[... truncated, showing first ~8000 tokens of ~${Math.round(totalChars / 4)} total ...]`;
}
