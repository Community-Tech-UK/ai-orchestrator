# Selective Consensus Self-Healing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Status:** Completed and verified

**Goal:** Restore selective multi-model fact-checking in long-running Harness sessions and make consensus results drive evidence-based course correction.

**Architecture:** Add a pure later-turn consensus-intent detector and a concise reconciliation reminder beside the existing scheduling detector. Compose all relevant later-turn reminders in the orchestration layer, then route that general reminder through `InstanceOrchestrationManager` into the existing `InstanceManager` context-block injection point.

**Tech Stack:** TypeScript, Electron main process, Vitest

**Specification:** [2026-07-25-selective-consensus-self-healing_spec_completed.md](../specs/2026-07-25-selective-consensus-self-healing_spec_completed.md)

## Global Constraints

- Consensus is selective: direct requests, uncertain high-impact decisions, credible conflict, and repeated failed fixes.
- Routine lookups, edits, formatting, tests, and status checks must not trigger consensus guidance.
- Negated requests such as “do not run consensus” must not trigger guidance.
- Consensus is advisory evidence; authoritative and reproducible evidence outranks unsupported majority opinion.
- Existing scheduling reminders must continue to work and must compose with consensus reminders.
- The completion fresh-eyes gate remains the mandatory final coding-task authority.
- Do not add settings, persistence, feature flags, migrations, or renderer changes.
- Preserve unrelated dirty-tree work.
- Keep this plan and its linked specification untracked until fully implemented and verified.

---

### Task 1: Define selective consensus intent and self-healing guidance

**Files:**

- Modify: `src/main/orchestration/orchestration-protocol.prompts.ts`
- Modify: `src/main/orchestration/orchestration-protocol.ts`
- Test: `src/main/orchestration/orchestration-protocol.spec.ts`

**Interfaces:**

- Produces: `detectsConsensusIntent(text: string | undefined | null): boolean`
- Produces: `CONSENSUS_INTENT_REMINDER: string`
- Preserves: `detectsSchedulingIntent()` and `SCHEDULING_INTENT_REMINDER`

- [x] **Step 1: Read the protocol prompt, protocol facade, and protocol tests in full**

Read:

```bash
rtk sed -n '1,420p' src/main/orchestration/orchestration-protocol.prompts.ts
rtk sed -n '1,430p' src/main/orchestration/orchestration-protocol.ts
rtk sed -n '1,520p' src/main/orchestration/orchestration-protocol.spec.ts
```

- [x] **Step 2: Write failing detector tests**

Add imports for `CONSENSUS_INTENT_REMINDER` and `detectsConsensusIntent`, then add table-driven tests equivalent to:

```ts
it.each([
  'get a multi-model consensus on this',
  'fact-check this with the other providers',
  'I want a second opinion before we proceed',
  'is this production migration safe or too risky?',
  'the security reviewers disagree about the correct approach',
  'the same fix failed again',
])('detects high-value consensus intent in: %s', (text) => {
  expect(detectsConsensusIntent(text)).toBe(true);
});

it.each([
  'fix the failing test',
  'verify the import resolves',
  'format this file',
  'show git status',
  'do not run consensus for this',
  'no second opinion needed',
  '',
])('does not trigger consensus guidance for: %s', (text) => {
  expect(detectsConsensusIntent(text)).toBe(false);
});

it('handles null and undefined consensus input', () => {
  expect(detectsConsensusIntent(undefined)).toBe(false);
  expect(detectsConsensusIntent(null)).toBe(false);
});
```

Name the production change that makes these tests pass: adding the exported pure detector with explicit negation handling and bounded category patterns.

- [x] **Step 3: Write failing prompt and reminder contract tests**

Add assertions equivalent to:

```ts
it('requires selective consensus and evidence-based reconciliation', () => {
  expect(prompt).toMatch(/must use `consensus_query`/i);
  expect(prompt).toMatch(/failed at least twice/i);
  expect(prompt).toMatch(/authoritative evidence/i);
  expect(prompt).toMatch(/revise|change course/i);
  expect(prompt).toMatch(/tell the user whether consensus changed/i);
});

it('provides a marker-wrapped conditional consensus reminder', () => {
  expect(CONSENSUS_INTENT_REMINDER).toContain(ORCHESTRATION_MARKER_START);
  expect(CONSENSUS_INTENT_REMINDER).toContain('"action":"consensus_query"');
  expect(CONSENSUS_INTENT_REMINDER).toMatch(/direct authoritative evidence/i);
  expect(CONSENSUS_INTENT_REMINDER).toMatch(/dissent/i);
  expect(CONSENSUS_INTENT_REMINDER).toMatch(/revise|change course/i);
});
```

- [x] **Step 4: Run the focused test and confirm RED**

Run:

```bash
rtk npm run test:quiet -- src/main/orchestration/orchestration-protocol.spec.ts
```

Expected: FAIL because the detector and reminder exports do not exist and the prompt lacks the required reconciliation contract.

- [x] **Step 5: Implement the minimal detector**

In `orchestration-protocol.prompts.ts`, add:

```ts
const CONSENSUS_NEGATION_PATTERN =
  /\b(?:do\s+not|don't|dont|no|skip|without)\b[^.!?\n]{0,40}\b(?:consensus|second opinion|cross-check|fact-check)\b/i;

const DIRECT_CONSENSUS_PATTERN =
  /\b(?:consensus|second opinion|cross-check|cross check|fact-check|fact check)\b/i;

const CROSS_MODEL_VERIFICATION_PATTERN =
  /\b(?:verify|validate|check)\b[^.!?\n]{0,60}\b(?:other|multiple|independent)\s+(?:models?|providers?|agents?|reviewers?)\b/i;

const HIGH_IMPACT_PATTERN =
  /\b(?:architecture|architectural|migration|production|release|deploy(?:ment)?|security|permissions?|destructive|data loss)\b/i;

const DECISION_OR_UNCERTAINTY_PATTERN =
  /\b(?:choose|decide|decision|recommend|risk|risky|uncertain|uncertainty|safe|safety|should we|which approach)\b/i;

const CONFLICT_PATTERN =
  /\b(?:evidence|reviewers?|tools?|agents?|models?|providers?)\b[^.!?\n]{0,80}\b(?:disagree|conflict|contradict|inconsistent)\b/i;

const REPEATED_FAILURE_PATTERN =
  /\b(?:(?:same\s+)?(?:fix|approach|strategy)\b[^.!?\n]{0,60}\b(?:failed|fails|failing)\b[^.!?\n]{0,30}\b(?:again|twice|second|third)|(?:failed|fails|failing)\b[^.!?\n]{0,40}\b(?:again|after (?:another|two|2|three|3) attempts?))\b/i;

export function detectsConsensusIntent(text: string | undefined | null): boolean {
  if (!text || CONSENSUS_NEGATION_PATTERN.test(text)) {
    return false;
  }
  return DIRECT_CONSENSUS_PATTERN.test(text)
    || CROSS_MODEL_VERIFICATION_PATTERN.test(text)
    || (HIGH_IMPACT_PATTERN.test(text) && DECISION_OR_UNCERTAINTY_PATTERN.test(text))
    || CONFLICT_PATTERN.test(text)
    || REPEATED_FAILURE_PATTERN.test(text);
}
```

Adjust only where RED tests prove a pattern mismatch. Keep the patterns bounded so they do not scan arbitrary amounts of text between cues.

- [x] **Step 6: Add the self-healing prompt and reminder**

Strengthen the existing Multi-Model Consensus section with the specification's trigger, skip, and reconciliation rules. Add a `CONSENSUS_INTENT_REMINDER` containing a compact valid command skeleton:

```text
:::ORCHESTRATOR_COMMAND:::
{"action":"consensus_query","question":"State the decision or disputed claim precisely","context":"Summarize the evidence, constraints, failed attempts, and current hypothesis"}
:::END_COMMAND:::
```

The reminder must explicitly remain conditional and must require evidence-based reconciliation after the injected result.

- [x] **Step 7: Export the new protocol symbols**

Re-export `CONSENSUS_INTENT_REMINDER` and `detectsConsensusIntent` from `orchestration-protocol.ts`.

- [x] **Step 8: Run the focused test and confirm GREEN**

Run:

```bash
rtk npm run test:quiet -- src/main/orchestration/orchestration-protocol.spec.ts
```

Expected: PASS.

---

### Task 2: Compose and inject later-turn reminders

**Files:**

- Modify: `src/main/orchestration/orchestration-handler.ts`
- Modify: `src/main/instance/instance-orchestration.ts`
- Modify: `src/main/instance/instance-manager.ts`
- Test: `src/main/orchestration/orchestration-handler.spec.ts`
- Test: `src/main/instance/__tests__/instance-manager-context-deadline.spec.ts`
- Update test mocks that implement the renamed method under `src/main/instance/__tests__/`

**Interfaces:**

- Consumes: `detectsConsensusIntent()` and `CONSENSUS_INTENT_REMINDER`
- Produces: `OrchestrationHandler.getLaterTurnReminderIfRelevant(message: string): string | null`
- Produces: `InstanceOrchestrationManager.getLaterTurnReminderIfRelevant(message: string): string | null`

- [x] **Step 1: Read all affected production files and focused tests in full**

Read the complete files, including all caller and mock implementations:

```bash
rtk sed -n '1,1600p' src/main/orchestration/orchestration-handler.ts
rtk sed -n '1,380p' src/main/instance/instance-orchestration.ts
rtk sed -n '1,2400p' src/main/instance/instance-manager.ts
rtk sed -n '1,520p' src/main/orchestration/orchestration-handler.spec.ts
rtk sed -n '1,520p' src/main/instance/__tests__/instance-manager-context-deadline.spec.ts
rtk rg -l 'getSchedulingReminderIfRelevant' src/main/instance --glob '*.ts'
```

Continue past the listed ranges if `wc -l` shows additional lines. Do not edit until every file being changed has been read to EOF.

- [x] **Step 2: Write failing reminder-composition tests**

Add or extend focused handler tests:

```ts
expect(handler.getLaterTurnReminderIfRelevant('run this every morning'))
  .toBe(SCHEDULING_INTENT_REMINDER);
expect(handler.getLaterTurnReminderIfRelevant('get a second opinion on this'))
  .toBe(CONSENSUS_INTENT_REMINDER);

const combined = handler.getLaterTurnReminderIfRelevant(
  'schedule a daily production migration safety check with multiple models',
);
expect(combined).toContain(SCHEDULING_INTENT_REMINDER);
expect(combined).toContain(CONSENSUS_INTENT_REMINDER);
expect(handler.getLaterTurnReminderIfRelevant('rename this variable')).toBeNull();
```

Name the production change that makes these tests pass: a general composer that evaluates both detectors independently and joins all matching reminders.

- [x] **Step 3: Write a failing later-turn injection regression**

Rename the mock seam in `instance-manager-context-deadline.spec.ts` and assert that:

1. an instance with prior conversation history receives no full orchestration prompt;
2. a later high-risk message receives `[CONSENSUS REMINDER]` in its context block;
3. the original user message remains unchanged;
4. a routine later message receives no reminder.

- [x] **Step 4: Run focused tests and confirm RED**

Run:

```bash
rtk npm run test:quiet -- src/main/orchestration/orchestration-handler.spec.ts
rtk npm run test:quiet -- src/main/instance/__tests__/instance-manager-context-deadline.spec.ts
```

Expected: FAIL because `getLaterTurnReminderIfRelevant()` does not exist.

- [x] **Step 5: Implement the reminder composer**

Replace the scheduling-only method in `OrchestrationHandler`:

```ts
getLaterTurnReminderIfRelevant(message: string): string | null {
  const reminders: string[] = [];
  if (detectsSchedulingIntent(message)) {
    reminders.push(SCHEDULING_INTENT_REMINDER);
  }
  if (detectsConsensusIntent(message)) {
    reminders.push(CONSENSUS_INTENT_REMINDER);
  }
  return reminders.length > 0 ? reminders.join('\n\n---\n\n') : null;
}
```

Update imports, forward the renamed method through `InstanceOrchestrationManager`, and call it from `InstanceManager` at the existing later-turn injection point. Rename local variables and comments from scheduling-specific to general later-turn reinforcement.

- [x] **Step 6: Update focused test doubles mechanically**

Replace `getSchedulingReminderIfRelevant` with `getLaterTurnReminderIfRelevant` only in mocks that implement the production interface. Preserve each test's current behavior unless it is explicitly extended by Step 3.

- [x] **Step 7: Run focused tests and confirm GREEN**

Run:

```bash
rtk npm run test:quiet -- src/main/orchestration/orchestration-protocol.spec.ts
rtk npm run test:quiet -- src/main/orchestration/orchestration-handler.spec.ts
rtk npm run test:quiet -- src/main/instance/__tests__/instance-manager-context-deadline.spec.ts
```

Expected: PASS.

---

### Task 3: Verify integration and close the documentation lifecycle

**Files:**

- Modify: `docs/superpowers/specs/2026-07-25-selective-consensus-self-healing_spec_completed.md`
- Modify: `docs/superpowers/plans/2026-07-25-selective-consensus-self-healing_plan_completed.md`

**Interfaces:**

- Consumes: completed Tasks 1–2
- Produces: verified implementation and completed documentation state

- [x] **Step 1: Run adjacent orchestration tests**

```bash
rtk npm run test:quiet -- src/main/orchestration/__tests__/consensus-coordinator.spec.ts
rtk npm run test:quiet -- src/main/orchestration/orchestration-protocol.spec.ts
rtk npm run test:quiet -- src/main/orchestration/orchestration-handler.spec.ts
rtk npm run test:quiet -- src/main/orchestration/role-capability-policy.spec.ts
rtk npm run test:quiet -- src/main/instance/__tests__/instance-manager-context-deadline.spec.ts
```

- [x] **Step 2: Run canonical project verification**

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run test:quiet
```

All commands must exit zero. Fix implementation findings without weakening tests.

- [x] **Step 3: Inspect the final diff and requirement coverage**

```bash
rtk git diff --check
rtk git diff --stat
rtk git status --short
```

Check every acceptance criterion in the specification against code or test evidence. Confirm no unrelated dirty-tree work was overwritten.

- [x] **Step 4: Run the mandatory fresh completion gate**

Start a genuinely fresh agent context that did not implement the work. Require it to use `task-completion-gate` and review the merge-base-to-working-tree diff, specification, architecture, test integrity, security, async/state handling, performance, and prompt-injection surfaces.

If it reports any actionable finding:

1. keep the task active;
2. add or adjust a failing regression test where applicable;
3. implement the minimal correction;
4. rerun focused and canonical verification;
5. send the updated work to another genuinely fresh completion-gate agent.

Repeat until the verdict is exactly `VERDICT: PASS` with no unresolved actionable findings.

- [x] **Step 5: Add as-built notes and close filenames**

Update the specification and plan with:

- exact production files changed;
- exact tests added or updated;
- canonical verification results;
- the final completion-gate verdict;
- any genuinely deferred live checks, if present.

Update the specification's plan link to the completed filename, then rename:

```text
2026-07-25-selective-consensus-self-healing_plan.md
  -> 2026-07-25-selective-consensus-self-healing_plan_completed.md

2026-07-25-selective-consensus-self-healing_spec_planned.md
  -> 2026-07-25-selective-consensus-self-healing_spec_completed.md
```

Do not commit or push.

## As-built completion record

Completed on 2026-07-25 with the architecture described above. The implemented detector distinguishes direct validation requests, high-impact uncertainty, evidence conflicts, descriptive lack of consensus, and explicit repeated-failure counts from routine language and explicit opt-outs. The fixed later-turn reminder requires evidence-led reconciliation rather than blind provider voting.

Files changed:

- `src/main/orchestration/orchestration-protocol.prompts.ts`
- `src/main/orchestration/orchestration-protocol.ts`
- `src/main/orchestration/orchestration-handler.ts`
- `src/main/instance/instance-orchestration.ts`
- `src/main/instance/instance-manager.ts`
- `src/main/orchestration/orchestration-protocol.spec.ts`
- `src/main/orchestration/orchestration-handler.spec.ts`
- `src/main/instance/__tests__/instance-manager-context-deadline.spec.ts`
- `src/main/instance/__tests__/instance-context-port.spec.ts`
- `src/main/instance/__tests__/instance-manager.send-input.spec.ts`

Final evidence:

- Test-first RED cases were observed for each new detector and reconciliation boundary before its implementation.
- Focused feature suite: 5 files, 195 tests passed.
- Both TypeScript configurations passed.
- Lint and the TypeScript max-LOC ratchet passed.
- Canonical full suite: 1,583 files, 15,722 tests passed.
- Scoped `git diff --check` passed.
- Four fresh reviews returned actionable findings that were fixed test-first.
- The fifth fresh completion-gate review returned `VERDICT: PASS` with no findings.

No live checks are deferred. No settings, persistence, schema, renderer, dependency, or feature-flag changes were required.
