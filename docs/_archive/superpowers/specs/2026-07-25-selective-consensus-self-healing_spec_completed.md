# Selective Consensus Self-Healing Specification

**Date:** 2026-07-25

**Status:** Completed and verified

**Implementation plan:** [2026-07-25-selective-consensus-self-healing_plan_completed.md](../plans/2026-07-25-selective-consensus-self-healing_plan_completed.md)

## 1. Purpose

Harness should actively remind parent agents to use multi-model consensus when independent fact-checking can materially improve a decision, then require the parent to reconcile the result with its current approach. Consensus must remain selective so routine work does not incur unnecessary latency and provider cost.

The existing completion fresh-eyes gate remains the final coding-task authority. Consensus supplements that gate for uncertainty, disagreement, high-impact decisions, and repeated failed fixes; it does not replace independent diff review.

## 2. Current failure

The full orchestration prompt advertises `consensus_query`, but Harness injects that prompt only on the first turn of a genuinely fresh conversation. Long-running and restored sessions receive a later-turn scheduling reminder when scheduling intent is detected, but no equivalent consensus reinforcement.

As a result:

1. the consensus engine, IPC path, permissions, and renderer presentation remain healthy;
2. parent agents are technically able to request consensus;
3. actual usage fades as the original prompt recedes or is absent from restored runtime context;
4. consensus results are not accompanied by a strong reconciliation contract, so a model can treat them as decorative rather than self-correcting evidence.

## 3. Goals

1. Re-surface consensus guidance on later turns when the user's message indicates a high-value consensus case.
2. Define a conservative, deterministic intent detector that avoids routine edits and lookups.
3. Make the full first-turn prompt state when consensus is required and how the parent must respond to its findings.
4. Preserve existing scheduling reinforcement, including when scheduling and consensus cues appear in the same turn.
5. Keep the existing consensus coordinator, command protocol, permissions, and UI unchanged.
6. Preserve the independent completion gate as the mandatory final coding review.

## 4. Non-goals

1. Automatically fan out every user message.
2. Run consensus before every routine coding-task completion.
3. Replace the completion fresh-eyes gate with majority voting.
4. Add a new settings screen, database table, feature flag, or provider configuration.
5. Infer confidence from private model reasoning.
6. Automatically accept a consensus result without checking its evidence and dissent.

## 5. Considered approaches

### A. Consensus before every completed coding task

This maximizes visible cross-model checking but duplicates the stronger completion-gate review, adds cost to straightforward work, and encourages shallow agreement.

### B. Selective prompt reinforcement and reconciliation

Harness detects explicit risk, uncertainty, disagreement, fact-checking, or repeated-failure language on later user turns. It injects concise consensus guidance and requires the parent to compare the result with its current approach, investigate material dissent, and change course when evidence warrants.

This is the selected approach. It restores self-checking where it is valuable without turning every session into a multi-provider fan-out.

### C. Main-process automatic interception of completion claims

Harness could inspect assistant output and launch consensus without an agent command. This would be more forceful but would require synthesizing a trustworthy question and context after the answer, coordinating a second response cycle, and avoiding false completion detection. It is too large and brittle for this repair.

## 6. Required behavior

### 6.1 First-turn policy

The parent orchestration prompt must say that consensus is required before committing to a conclusion when any of these conditions holds:

- an architecture, migration, production, release, security, permissions, data-loss, or similarly high-impact decision has meaningful uncertainty;
- credible evidence, reviewers, tools, or providers materially disagree;
- the same fix or strategy has failed at least twice;
- the parent is about to recommend a consequential action while explicitly uncertain;
- the user explicitly asks for consensus, cross-checking, fact-checking, validation, or a second opinion.

The policy must also say not to use consensus for routine lookups, mechanical edits, or conclusions already established by direct authoritative evidence.

### 6.2 Later-turn detection

Add a pure exported detector:

```ts
export function detectsConsensusIntent(text: string | undefined | null): boolean
```

It must return true for bounded, explicit language in these categories:

1. direct requests: consensus, second opinion, cross-check, fact-check, validate/verify with other models or providers;
2. high impact plus decision/uncertainty: architecture, migration, production, release/deploy, security, permissions, destructive/data-loss concerns paired with choose/decide/recommend/risk/uncertain/safe;
3. conflict: credible evidence, reviewers, tools, agents, models, or providers disagree or conflict;
4. repeated failure: the fix/approach/strategy failed again, still fails after another attempt, or an explicit second/third failed attempt.

It must return false for:

- empty input;
- ordinary uses of words such as “check” or “verify” without a cross-model or high-risk cue;
- routine file edits, tests, formatting, lookups, and status requests;
- negated instructions such as “do not run consensus” or “no second opinion needed.”

### 6.3 Later-turn reminder

Add a concise `CONSENSUS_INTENT_REMINDER` that:

1. tells the parent this turn may warrant `consensus_query`;
2. repeats the selective trigger conditions;
3. includes a valid marker-delimited command example;
4. says to skip the query if direct authoritative evidence already resolves the issue;
5. requires reconciliation after the result:
   - compare it with the current hypothesis or plan;
   - inspect dissent and provider failures;
   - gather direct evidence for material conflicts;
   - revise the approach when warranted;
   - tell the user whether consensus changed the conclusion.

### 6.4 Reminder composition

Replace the scheduling-only later-turn method with a general later-turn reminder method:

```ts
getLaterTurnReminderIfRelevant(message: string): string | null
```

It returns:

- scheduling reminder only when scheduling intent matches;
- consensus reminder only when consensus intent matches;
- both reminders, separated clearly, when both match;
- `null` when neither matches.

The method must be exposed through `InstanceOrchestration` and used by `InstanceManager` on every later turn, preserving the existing first-turn behavior.

### 6.5 Self-healing contract

Consensus is advisory evidence, not authority by vote count. The parent must:

1. identify agreements, dissent, and provider failures;
2. prefer reproducible or authoritative evidence over unsupported majority opinion;
3. update its hypothesis, plan, or implementation when the consensus evidence invalidates it;
4. continue investigation rather than claiming certainty when material disagreement remains;
5. surface a concise reconciliation outcome to the user.

## 7. Error and safety behavior

1. A detector false negative leaves existing behavior unchanged.
2. A detector false positive only injects guidance; the reminder explicitly allows the parent to skip consensus when evidence is already decisive.
3. Failed providers remain visible through the existing consensus result path.
4. Consensus does not authorize destructive actions, deployment, publishing, or other scope expansion.
5. No secrets, prompt contents, or provider credentials are logged.

## 8. Testing

Automated tests must cover:

1. every positive intent category;
2. routine and negated false-positive cases;
3. reminder content and valid command markers;
4. first-turn self-healing policy text;
5. scheduling-only, consensus-only, combined, and no-reminder composition;
6. `InstanceManager` injecting the general reminder only on later turns;
7. existing scheduling behavior remaining intact.

Run focused tests first, then the canonical project verification:

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run test:quiet
```

## 9. Acceptance criteria

1. A later message asking for cross-model fact-checking receives consensus guidance.
2. A later high-risk migration or production decision receives consensus guidance.
3. A later report that the same fix failed again receives consensus guidance.
4. A routine edit or lookup receives no consensus guidance.
5. A scheduling request continues to receive scheduling guidance.
6. A turn matching both categories receives both reminders.
7. The parent prompt requires evidence-based reconciliation rather than blind majority acceptance.
8. Existing consensus protocol, permission, coordinator, and display tests continue to pass.
9. All canonical verification gates pass.
10. A fresh independent completion-gate agent returns `VERDICT: PASS` with no actionable findings.

## 10. Documentation lifecycle

This specification and its implementation plan remain untracked and uncommitted while work is active. After implementation, canonical verification, and the independent completion gate pass, both documents receive as-built notes and are renamed with `_completed`.

## 11. As-built result

Implemented on 2026-07-25.

Production changes:

- `src/main/orchestration/orchestration-protocol.prompts.ts` now defines the selective detector, conditional later-turn reminder, bounded opt-out/conflict/failure patterns, and the full evidence-led reconciliation contract.
- `src/main/orchestration/orchestration-protocol.ts` exports the new protocol symbols.
- `src/main/orchestration/orchestration-handler.ts` composes scheduling and consensus reminders in a stable order.
- `src/main/instance/instance-orchestration.ts` exposes the general later-turn reminder seam.
- `src/main/instance/instance-manager.ts` injects that static conditional reminder on later turns without interpolating user text.

Test changes:

- `src/main/orchestration/orchestration-protocol.spec.ts` covers direct and imperative requests, high-impact uncertainty, credible and descriptive disagreement, repeated-failure counts, explicit opt-outs, routine false positives, reminder markers, and reconciliation requirements.
- `src/main/orchestration/orchestration-handler.spec.ts` covers scheduling-only, consensus-only, combined, and null composition.
- `src/main/instance/__tests__/instance-manager-context-deadline.spec.ts` covers later-turn injection, context preservation, unchanged user input, and routine-message behavior.
- `src/main/instance/__tests__/instance-context-port.spec.ts` and `src/main/instance/__tests__/instance-manager.send-input.spec.ts` keep test doubles aligned with the renamed seam and new exports.

Verification:

- Focused feature suite: 5 files, 195 tests passed.
- `npx tsc --noEmit`: passed.
- `npx tsc --noEmit -p tsconfig.spec.json`: passed.
- `npm run lint`: passed.
- `npm run check:ts-max-loc`: passed.
- Canonical full suite: 1,583 files, 15,722 tests passed.
- `git diff --check`: passed.
- Fifth fresh completion-gate review: `VERDICT: PASS`, with no findings.

No live checks are deferred. The behavior is main-process prompt selection and composition, fully covered by automated tests.
