# Session Title Generation Repair

**Status:** completed 2026-09-08, with live checks deferred
**Created:** 2026-09-08
**Owner:** implementing agent (this loop)

**As-built summary.** All code-level work is implemented and verified. Every
agent-runnable gate is green on the final state (full suite: 2,025 files /
22,401 tests / exit 0). The independent completion gate failed pass 1 on missing
test coverage for A1's wiring, which was closed and mutation-verified, and
passed pass 2 with no actionable findings.

**What is NOT verified:** that titles now generate locally. The gate closing ~94%
of auxiliary routing decisions is still unidentified — the observability that
would name it is what this change adds, and reading it needs a rebuilt app
against the real worker. Five deferred live checks are recorded in
[2026-09-08-session-title-generation-repair_livetest.md](2026-09-08-session-title-generation-repair_livetest.md);
LT-A is the one that closes the open question. Do not treat this plan's
completion as evidence that the local model path works.

Reported by James on 2026-09-07: session titles in the rail are "fucked up", and a
session's title can change when it comes back from hibernation/termination.

Two separate faults, with one shared amplifier.

---

## Evidence gathered (2026-09-07 / 2026-09-08)

All figures measured from the live app's own data, not inferred.

### Fault 1 — the AI title upgrade almost never lands

`AutoTitleService` (`src/main/instance/auto-title-service.ts:156`) is two-phase:
an instant deterministic title, then an AI upgrade. The rail is showing phase 1
only.

```
app.log    instant=124  ai=32
app.log.1  instant=130  ai=14
app.log.2  instant=152  ai=29
```

Cost-attribution for 2026-09-07 (`cost-attribution-2026-09-07.jsonl`):

```
('aux:titleGeneration', 'local-fallback', None)          558
('aux:titleGeneration', 'ollama', 'deepseek-r1:7b')       35
('aux:compression',     'local-fallback', None)          254
('aux:compression',     'ollama', 'deepseek-r1:32b')       5
```

**94% of every auxiliary routing decision — not just titles — ends in
`local-fallback`.** The routing ledger agrees (`rlm.db`):

```
slot             intended  actual    disposition  reason  count  last
titleGeneration  local     blocked   blocked      policy   4564  2026-09-07 22:51
titleGeneration  local     frontier  allowed      policy    124  2026-08-25 16:04
```

Four distinct defects combine here:

**1a. Auxiliary routing bails before it ever lists models.**
On 2026-09-07 there were 852 auxiliary decisions but only **116**
`auxiliaryModel.list` RPCs. So ~736 bailed at
`tryEndpointForSlot`'s first line — `evaluateManagedAuxiliaryEndpoint` returned
`null`, meaning `LocalAiRoutingGuard.evaluateLocalTarget` judged the enrolled
target ineligible. Meanwhile the health probes were green all day:

```
lightweight ok=1  3942
functional  ok=1   460
lightweight ok=0     6  (worker-offline)
```

`evaluateLocalTarget` (`local-ai-routing-guard.ts:89`) has five distinct
ineligibility exits (`health-<state>`, `freshness-check-failed`,
`role-not-routable`, lifecycle, flapping latch) and **none of them are logged or
persisted**. `local_ai_routing_events` has no reason column for the local leg,
and the `reason` string built in `AuxiliaryLlmService.generate` is discarded.
The exact exit therefore cannot be determined from existing data — the
observability has to be added before the last step of this diagnosis can be
closed. See "Open question" below.

**1b. `listModels` converts a probe failure into "endpoint has no models".**
`AuxiliaryLlmService.listModels` (`auxiliary-llm-service.ts:511-534`) wraps
everything in `catch { return []; }`. For a managed worker target this runs a
live `auxiliaryModel.list` RPC with a 5s `PROBE_TIMEOUT_MS` on **every**
generate. A timeout is indistinguishable from an empty inventory, so
`managedAuxiliaryModelsAvailable` returns false, the target is invalidated, and
the slot falls back — silently.

**1c. The 'quick' tier auto-picks a reasoning model that cannot fit its budget.**
`pickModelForTier` chooses the smallest chat model on the worker, which is
`deepseek-r1:7b`. Output-token distribution for the 35 title generations that
actually reached it:

```
min 138  median 463  max 715      (21 of 35 at >= 400)
slot maxOutputTokens: 512
```

deepseek-r1 opens with `<think>`. At a 512-token budget it is routinely cut off
mid-reasoning, so `sanitizeGeneratedTitle` sees an unterminated thinking tag and
correctly returns `null` — and `generateTitle` then gives up entirely. The few
that do emit an answer leak the reasoning with it (see 1d).

Note `settings-migrations.ts:513` already raised this budget once (128 -> 512)
for exactly this reason. 512 is still not enough for this model.

**1d. The auxiliary success branch skips every sanity gate the CLI branch applies.**
`auto-title-service.ts:290-295` returns raw model output — no `frontLoadTitle`,
no `truncateForRail`, no `length > 80` rejection, no `isProviderNotice`. Two real
titles that reached the rail through this hole:

```
"1. Node Proxy Server 2. Chrome DevTools Login 3. Screenshot Capture 4. File
 Save to aio-transfers 5. Screenshot Analysis"                      (119 chars)

"The tab title should summarize importing modules into a context worker with an
 error. It needs to be concise (3-6 words) and start with the most distinctive
 word. **Title:** Module Import Issue"                              (193 chars)
```

The CLI branch below it would have rejected both on length.

**1e. Escalation is policy-blocked, so every failure above is terminal.**
`titleGeneration` ships `allowFrontierFallback: false`
(`settings-defaults.ts:409`), and `migrateTitleGenerationFrontierFallbackDefault`
(`settings-migrations.ts:287`) flipped James's persisted value `true -> false` on
2026-08-25 — exactly where the `frontier/allowed` rows stop. So
`generateTitle` hits `if (!auxDecision.allowFrontierFallback) return null;`
(`auto-title-service.ts:296`) and the whole CLI one-shot path below it — the
antigravity/claude/codex fast-tier call — is unreachable.

**1f. Failure is completely silent.** 4,564 blocked attempts, zero log lines.

**1g. The history backfill retries blocked entries forever.**
`backfillMissingAiTitles` (`history-manager.ts:596`) takes up to 10 untitled
entries per history-list refresh, never records that generation failed, and so
re-attempts the same entries indefinitely. This is the bulk of the volume — 280
blocked events in the 10:00 hour alone on 2026-09-07.

### Fault 2 — the title changes when a session stops being live

Two resolvers in `src/shared/types/history.types.ts` disagree:

| resolver | used by | priority |
|---|---|---|
| `resolveEffectiveInstanceTitle` (:427) | live rail items (`project-rail-builder.service.ts:647`), detail header | **`instance.displayName` wins** |
| `getConversationHistoryTitle` (:394) | history rail (`history-rail.service.ts:207`), **and restore** (`history-restore-coordinator.ts:257`) | `aiTitle` -> `frontLoadTitle(firstUserMessage)` -> `frontLoadTitle(lastUserMessage)` -> **`entry.displayName` last** |

The stored title is the *lowest*-priority candidate in the second resolver, so a
freshly re-derived one beats it. `history-restore-coordinator.ts:257` then writes
that re-derived string onto the revived instance, so the rename sticks.

Measured by running the real resolver over the live 2,000-entry history index:

```
entries=2000  renamed=64  unchanged=1479  DRIFT=457  (23%)
  deterministicOverride: 222   <- re-derivation beats the stored title
  aiTitleArrivedLate:    235   <- aiTitle set after displayName was persisted
  renderedOverRailLimit: 188   <- longer than the 60-char rail budget
  longest rendered title: 193 chars
```

Examples, stored -> rendered:

```
"Pasted-image-9.png fix"   -> "Fix"
"Clrsoftware.co.uk"        -> "Clrsoftware.co.uk Anything here we can steal for our website, it seems…"
"Read-only diagnostic."    -> "Read-only diagnostic. Run these and reply with ONLY the raw output in one code block, under 35 lines…"
```

Two causes:

**2a.** `getConversationHistoryTitle` ranks `entry.displayName` below a fresh
re-derivation from the raw message. The stored title was computed with strictly
more information — the attachment file names, and only the *first line* of the
message. That is why `Pasted-image-9.png fix` collapses to `Fix`.

**2b.** `getConversationHistoryTitle` never calls `truncateForRail`, so it can
render 193 characters into a 60-character rail. `AutoTitleService` caps; this
path does not.

**Not reproduced:** drift on a plain hibernate -> wake. That path restores
`displayName` from continuity state (`instance-lifecycle.ts:2037`) and looks
stable. If James sees it on a plain wake, that is a separate stale-continuity
fault and needs its own investigation.

### Shared amplifier

Because 1a-1e mean ~80% of sessions never get an `aiTitle`, fault 2's resolver
falls past its best candidate into the re-derivation nearly every time. Fixing
fault 1 makes fault 2 much rarer but does not fix it.

---

## Scope

James answered "Both" to: free/cheap CLI one-shot for titles when local is down,
**or** fix the windows-pc model routing. So both are in scope, plus the
unambiguous defects found alongside them.

Explicitly out of scope: the hibernate->wake continuity question (not
reproduced), and any change to the paid-frontier *cost* policy beyond the
titleGeneration slot.

---

## Work items

### A. Auxiliary routing observability and correctness

- [x] A1. Endpoint resolution now records **why** each candidate was passed over
      (`LocalAiResolutionContext.ineligibleReasons`), and
      `AuxiliaryLlmService.generate` puts that detail into the fallback's
      `reason` — which flows on into cost attribution — and emits a throttled
      warning (once per slot+reason per 5 min). Reasons captured:
      the health verdict's own reason, `endpoint-heartbeat-unhealthy`,
      `model-inventory-probe-failed`, `required-models-missing`,
      `endpoint-advertises-no-models`, `no-model-for-tier-<tier>`, and the
      distinct "nothing was even a candidate" case.
- [~] A2. `listAuxiliaryModelsForRouting` separates "probe failed" from "no
      models", so the recorded reason distinguishes an RPC timeout from an
      endpoint that genuinely advertises nothing — two very different faults.
      **Withdrawn during implementation:** the first attempt also stopped a
      failed probe from invalidating the managed target. That broke
      `local-ai-auxiliary-integration.spec.ts`'s
      "invalidates a guard-approved managed target when model listing throws",
      which encodes a deliberate contract: a listing that throws is itself
      evidence the endpoint may be unwell, and `invalidateTarget` (→
      `scheduler.targetChanged`) re-verifies rather than bans it. Decisive point:
      only 116 of 852 decisions on 2026-09-07 even reached the probe, so this
      path is **not** the cause of the 94% fallback — changing long-standing
      behaviour there, and rewriting the test that encodes it, would have been
      unjustified scope creep on an unproven hypothesis. Invalidation restored;
      the existing test passes unmodified.
- [~] A3. `titleGeneration.maxOutputTokens` raised 512 -> 1536, with a migration
      for existing installs. This is the half that the measured data justifies
      (median 463 / max 715 output tokens against a 512 cap).
      **Not done:** de-prioritising reasoning models in `pickModelForTier`. That
      rests on an unverified hypothesis and is deliberately left until A1's
      logging says what the real ineligibility reason is. See the open question.

### B. Title generation

- [x] B1. `finalizeGeneratedTitle` — one post-processing path shared by the
      auxiliary branch, the CLI branch, and `generateLocalTitle`. Applies the
      length bounds, `isProviderNotice`, `frontLoadTitle`, `truncateForRail` and
      the attachment-subject repair to all three.
- [x] B2. `titleGeneration.allowFrontierFallback` default `false` -> `true`,
      with `migrateTitleGenerationFrontierFallbackReenable` to flip existing
      installs back. The old disable migration is removed (leaving it would have
      re-disabled the new default on every fresh profile).
- [x] B3. The abandoned-upgrade path logs at info with the auxiliary source,
      reason and disposition, instead of returning null silently.
- [x] B4. `backfillMissingAiTitles` records failures (both empty results and
      throws) with a 1h cooldown and a bounded map, so a dead local model no
      longer produces a retry storm on every history-list refresh.

### C. Title stability

- [x] C1. New shared `deriveRailTitle` in `history.types.ts` — attachment-aware,
      first line only, front-loaded, rail-truncated. Both `AutoTitleService` and
      `getConversationHistoryTitle` now derive through it, so the live and
      history surfaces cannot compute different titles from the same message.
      The stored `displayName` is additionally preferred over a re-derivation
      that collapses to pure filler (the `Pasted-image-9.png fix` -> `Fix` case).
- [x] C2. Every non-rename candidate in both resolvers goes through
      `normalizeGeneratedHistoryTitlePart`, which now also applies
      `truncateForRail`. A 193-character title can no longer reach a 60-character
      rail, and the two resolvers no longer differ by a trailing full stop (a
      real drift the new parity test caught).
- [~] C3. **Dropped, not deferred.** The premise was wrong: `aiTitle` already
      ranks first in `getConversationHistoryTitle`, so a stale `displayName` on
      an entry that later gained an `aiTitle` is never the rendered string, and
      re-archiving already falls back to a previous entry's `aiTitle`. Syncing it
      would have been redundant work.

### D. Tests

- [x] D1/D5. Auxiliary-branch gating, using both real garbage titles verbatim
      (the 119-char numbered list and the 193-char narration), plus a test that
      the auxiliary branch front-loads exactly as the CLI branch does.
- [x] D2. Stored title preferred over a filler re-derivation; first-line parity
      with the live path; rail cap on both generated and first-message titles;
      an explicit live-vs-history parity assertion.
- [x] D3. Backfill does not re-attempt an entry after an empty result or a throw.
- [x] D4. Probe failure is distinguished from an empty inventory; warning
      throttle windows and per-slot/per-reason independence.
- [x] D6. **A1's reason-propagation wiring** end to end, added after the first
      completion-gate pass failed on exactly this: the multi-hop plumbing
      (`evaluateManagedAuxiliaryEndpoint`/`tryEndpointForSlot` ->
      `LocalAiResolutionContext` -> `describeAuxiliaryResolutionFailure` ->
      `generate`'s fallback decision) was correct by hand-trace but had no
      regression protection. Four cases in
      `local-ai-auxiliary-integration.spec.ts` run the real `LocalAiRoutingGuard`
      against a real target repository and assert the distinct reasons
      (`required-models-missing`, `model-inventory-probe-failed`,
      `health-unavailable`, and the no-candidate case) reach
      `decision.reason`. Mutation-verified: reverting
      `describeAuxiliaryResolutionFailure` to the old constant string fails
      exactly those 4 and no others.

---

## Open question (deferred to live test)

The exact `evaluateLocalTarget` exit driving the ~94% fallback rate is **still
not known**. A1 adds the logging that will say, but reading it requires the
rebuilt app running against the real worker. Until then:

- A3's second half (reasoning-model de-prioritisation) is deliberately not
  implemented.
- The claim "titles now generate locally" is **not** verified. What is verified
  is that when generation fails or returns junk, the failure is now visible,
  bounded, and non-terminal (escalation restored), and that the title cannot
  change when a session stops being live.

This goes into the livetest doc, not into a completion claim.

---

## Verification status

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npx tsc --noEmit -p tsconfig.spec.json` | pass |
| `npm run lint` | pass |
| `npm run check:ts-max-loc` | pass (required extracting `auxiliary-routing-diagnostics.ts`; the service was at 696/700 before this work) |
| `npm run build:main` | pass |
| `npm run build:renderer` | pass |
| `npm run test:quiet` (full) | see completion summary |

Fresh-eyes completion gate (`task-completion-gate`) required before this plan is
renamed `_completed`.

---

## Files changed

```
src/shared/types/history.types.ts                     deriveRailTitle, resolver ordering, rail cap
src/shared/types/history.types.spec.ts                C1/C2 tests
src/shared/types/settings-defaults.ts                 titleGeneration slot defaults
src/main/instance/auto-title-service.ts               finalizeGeneratedTitle, abandonment logging
src/main/instance/auto-title-service.spec.ts          B1 tests
src/main/core/config/settings-migrations.ts           re-enable + budget migrations
src/main/core/config/__tests__/settings-migrations.auxiliary.spec.ts
src/main/rlm/auxiliary-llm-service.ts                 reason capture, routing inventory, extraction
src/main/rlm/auxiliary-local-ai-guard.ts              ineligibility recording + description
src/main/rlm/auxiliary-routing-diagnostics.ts         NEW — probe/health/throttle
src/main/rlm/__tests__/auxiliary-routing-diagnostics.spec.ts  NEW
src/main/history/history-manager.ts                   backfill negative caching
src/main/history/history-manager.spec.ts              B4 tests
```
