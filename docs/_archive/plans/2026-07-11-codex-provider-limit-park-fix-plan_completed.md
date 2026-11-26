# Codex Provider-Limit Park Fix — Implementation Plan

**Date:** 2026-07-11
**Status:** COMPLETED 2026-07-11
**Owner:** offloaded implementation agent (Sonnet/Opus)

## Completion summary

All 6 phases implemented, independently code-reviewed (fresh-eyes pass surfaced 3
warnings + 2 suggestions, all fixed), and verified:

- `tsc --noEmit` (main + spec configs): clean
- `npm run lint`: all files pass
- `npm run check:ts-max-loc`: ratchet passed (within tolerance; `instance-communication.ts`
  logic was split into `instance-communication-provider-limit.ts` to stay under ceiling)
- `npm run test:quiet` (full suite): 12771/12783 pass — the 12 failures are all in
  `local-review-tool-runner.spec.ts` (untouched by this work), failing on a pre-existing
  `which rg` shell-wrapper artifact of the sandbox this was built in, not a regression
- **Live runtime verification** (dev app via `?bench=1` renderer harness + `ng.getComponent`
  store seeding): confirmed the quota-park countdown chip renders, `sendInput()` queues
  instead of hitting IPC while parked, the queue survives a full watchdog tick without
  draining, and drains normally via the real IPC path once the park clears

Post-review fixes beyond the original phase scope: the relative-duration parser
(`parseRelativeDuration` in `instance-provider-limit-detection.ts`) now scans every `"in "`
anchor instead of only the first, so a spurious earlier "in " no longer shadows a real
duration later in the text; added a documented mutual-exclusivity invariant comment at both
`tryParkOnProviderLimit` call sites; added a regression test proving a non-limit thrown error
(auth) never invokes `onProviderLimitTurn`.

---

## 1. Context and incident

AIO has an opt-in "quota-park" mechanism for regular (non-loop) chat sessions: when a turn
stops on a provider rate/usage limit, the instance is parked with a countdown chip
(`waitReason.kind === 'quota-park'`), a durable resume is scheduled, and the throttled turn
is re-sent automatically when the provider window resets. The gating setting
`instanceProviderLimitResumeEnabled` is **already `true`** in James's live settings.

**Live incident (2026-07-11 15:42, verified in `~/Library/Application Support/Harness/logs/app.log`):**
a Codex instance hit `usageLimitExceeded` ("You've hit your usage limit. … try again at
5:01 PM."). Instead of parking, the instance dropped to `error` status, the adapter was
cleaned up, and the renderer cleared the message queue with "Your message was restored to
the input — restart the instance to send it." The park never ran: the log contains the
adapter error at 15:42:39 and 15:46:38 but **zero** `Parked regular session` lines.

## 2. Verified root cause

The park logic hooks exactly two adapter signals in
`src/main/instance/instance-communication.ts`:

1. `adapter.on('error')` → `detectErrorProviderLimit` → `onProviderLimitTurn` (line ~1872).
2. `adapter.on('complete')` with a limit-notice as content → `detectCompletionProviderLimit`
   → `onProviderLimitTurn` (line ~1621).

A failed **Codex app-server turn produces neither signal**:

- The app-server `error` notification only stores `state.error`
  (`src/main/cli/adapters/codex-cli-adapter.ts` ~line 1981–2003).
- The turn then fails by **throwing from `sendInput()`**. In `sendInputImpl`'s catch
  (`codex-cli-adapter.ts` ~543–562) the adapter emits an error-type `output` message
  ("Codex error: …") and — because `isRecoverableTurnError()` (~566–581) does **not**
  match "usage limit" — emits `status: 'error'`, then rethrows.
- The thrown error lands in `InstanceCommunicationManager.sendMessage`'s catch
  (`instance-communication.ts` ~791–917), which handles **context overflow inline** but
  has **no provider-limit handling** — it rethrows (line ~916). There's even a comment at
  ~824 acknowledging the `on('error')` hook doesn't fire for thrown errors.
- The `status: 'error'` emit reaches the renderer, `isTerminalStatus` → 
  `clearQueueWithNotification` (`src/renderer/app/core/state/instance/instance.store.ts`
  ~358–361 and ~462–465) → queue cleared, "restart the instance" notice.

Secondary gaps (also in scope):

- **No reset-time parsing from Codex error text.** `detectErrorProviderLimit`
  (`src/main/instance/instance-provider-limit-detection.ts`) takes structured
  `rateLimit`/`quota` fields (Codex errors have none — see
  `instance-communication.diagnostics.ts`), adapter telemetry
  (`getLastRateLimitInfo()` — **Claude-only**), or falls back to the provider quota
  snapshot inside `maybePark` (Codex snapshot is passive and may be stale/absent).
  Codex tells us the reset time in plain text ("try again at 5:01 PM") and we ignore it.
  The loop classifier's `parseResetTimestampFromText`
  (`src/main/core/loop-error-classification.ts` ~273) only matches ISO timestamps.
- **Renderer would leak sends into a parked instance.** A parked instance sits at
  `idle`; `processMessageQueue` (`instance-messaging.store.ts` ~542) and the 2 s
  `drainAllReadyQueues` watchdog (~57, ~65) drain queues on `idle` with **no
  `waitReason` check**, and `sendInput` (~210) only queues on
  busy/transitional/paused — so queued or new messages would be fired straight into the
  throttled provider. (This latent bug affects Claude parks too; it just hasn't bitten
  because parks are rare and queues usually empty.)

Non-goals confirmed during investigation: `FailoverManager`
(`src/main/providers/failover-manager.ts`) is instantiated at boot but wired to nothing —
provider→provider failover is out of scope here (see §10).

## 3. Design decision

**Centralize thrown-turn-error limit handling at the `sendMessage` catch choke point,
keep the park state machine unchanged, make the Codex adapter stop hard-erroring the
session on provider limits, add text-based reset-time parsing, and gate the renderer
queue on `quota-park`.**

Rationale / alternatives rejected:

- *Alternative A — make the Codex adapter emit an `'error'` event for limit turns so the
  existing hook fires.* Rejected: `sendInput` callers await the promise; emitting the
  event **and** rejecting produces double error handling (two classification runs, two UI
  messages, racy status transitions). The existing dedupe (`hasRecentMatchingErrorOutput`)
  only masks the UI symptom.
- *Alternative B — special-case inside the Codex adapter (park from the adapter).* 
  Rejected: adapters must stay provider-plumbing; park policy lives in
  `InstanceProviderLimitHandler` behind `onProviderLimitTurn`. Also the same thrown-path
  hole exists for any adapter that rejects `sendInput` — fixing at the choke point covers
  all providers, not just Codex.
- *Chosen — third detection choke point.* The manager then has all three turn outcomes
  covered: `'complete'` (exit-0 notice), `'error'` event, and thrown `sendInput`
  rejection. Detection stays in pure functions in
  `instance-provider-limit-detection.ts`; park/resume state stays in the handler
  singleton. This matches the existing extraction pattern (that file exists precisely to
  keep `instance-communication.ts` under the LOC ceiling — keep it that way).

## 4. Implementation phases

Work through the phases in order; each has its own verification. Read every file fully
before editing (project rule). Keep `instance-communication.ts` within
`npm run check:ts-max-loc` — put new logic in `instance-provider-limit-detection.ts` or
small new modules, not inline.

### Phase 1 — Reset-time text parsing (pure, testable foundation)

**File:** `src/main/instance/instance-provider-limit-detection.ts` (+ its spec)

1. Add an exported pure function:
   ```ts
   export function parseResetHintFromText(text: string, now: number): number | null
   ```
   Returns epoch-ms or null. `now` is injected — **never** call `Date.now()` inside the
   parse logic (testability; project convention).
2. Patterns to support (case-insensitive, first match wins; all interpreted in the
   machine's local timezone):
   - Clock times: `try again at 5:01 PM`, `try again at 5 PM`, `resets 6:30pm`,
     `resets at 11am`, `try again at 17:01` (24 h). If the resolved time-of-day is
     `<= now`, roll forward 24 h. Guard against absurd results (> 8 days out → null).
   - Relative durations: `try again in 3 hours 25 minutes`, `in 45 minutes`,
     `in 2 hours`, `retry in 90 seconds`.
   - ISO timestamps: `resets at 2026-07-11T17:01:00Z` (subsumes the loop classifier's
     pattern).
3. Wire it into **both** detectors as a fallback hint, keeping the existing precedence
   and adding text-parse between structured fields and telemetry:
   `structured resetAt` → `parseResetHintFromText` → `telemetryResetAtMs` (the quota
   snapshot remains the final fallback inside `maybePark`, unchanged).
4. Spec (`instance-provider-limit-detection.spec.ts`, extend the existing file): table
   test every pattern above; AM/PM rollover across midnight; `5:01 PM` when now is
   4:00 PM (today) vs 6:00 PM (tomorrow); 24 h format; noon/midnight (`12:00 PM`,
   `12:00 AM`); garbage input → null; the exact live incident string:
   `"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:01 PM. - [codex_error_info: usageLimitExceeded]"`.

### Phase 2 — Handle thrown provider-limit errors in `sendMessage`

**File:** `src/main/instance/instance-communication.ts` (+ `instance-communication.spec.ts`)

1. Extract the park attempt currently inlined in the `adapter.on('error')` handler
   (~1872–1898: detect → `onProviderLimitTurn` → park system message → transition to
   idle) into a private method, e.g.
   `private tryParkOnProviderLimit(instanceId, instance, adapter, errorText): boolean`
   (returns true when handled). Reuse it from the `on('error')` handler unchanged.
2. In the `sendMessage` catch (~794–917), **after** the context-overflow branch and
   **before** `throw sendError` (~916): call `tryParkOnProviderLimit`. If it returns
   true, set tool state idle, `queueUpdate` idle + contextUsage, and **return instead of
   rethrowing** (the turn is handled; propagating an error would surface a spurious IPC
   failure in the renderer).
3. **Already-parked suppression.** Change `maybePark`'s return type in
   `instance-provider-limit-handler.ts` from `'parked' | 'skipped'` to
   `'parked' | 'already-parked' | 'skipped'` (`already-parked` when
   `this.parked.has(instanceId)`). Update the passthrough in `instance-manager.ts`
   (~338–348) and both call sites. In `tryParkOnProviderLimit`: treat `'parked'` and
   `'already-parked'` as handled, but only emit the "session is parked…" system message
   and (re)set status on a fresh `'parked'` — for `'already-parked'`, emit a quieter
   system note ("Still parked until the quota window resets; this message was not sent.")
   and do not touch status. This covers sends arriving from paths that bypass the
   renderer gate (mobile gateway, MCP, remote nodes) while an instance is parked.
4. Note the ordering hazard for the implementer: by the time the catch runs, the Codex
   adapter has already emitted `status` (Phase 3 makes that `idle`, not `error`) — the
   park's `setWaitReason` lands via `queueInstanceUpdate` in the same flush window, so
   the renderer sees `idle` + `waitReason` together. Do not add sleeps; just keep the
   park call synchronous within the catch.
5. Spec additions (`instance-communication.spec.ts`): fake adapter whose `sendInput`
   rejects with the live incident message →
   - `onProviderLimitTurn` invoked with a non-null `resetAtHint` (from Phase 1 parsing);
   - no rethrow out of `sendMessage`; instance ends `idle`, not `error`;
   - park system message in the output buffer;
   - second rejected send while parked → `'already-parked'` branch: no duplicate park
     message, no status regression;
   - park disabled (`onProviderLimitTurn` returns `'skipped'`) → error propagates
     exactly as today (regression guard).

### Phase 3 — Codex adapter: provider limits are not session-fatal

**File:** `src/main/cli/adapters/codex-cli-adapter.ts` (+ its spec)

1. In `sendInputImpl`'s catch (~543–562), compute
   `isProviderLimit = isProviderNotice(errText)` (import from
   `src/main/cli/provider-notice.ts` — it already matches "You've hit your usage limit",
   "too many requests", "quota exceeded", etc.). Treat provider-limit turns as
   recoverable for **status purposes**: emit `status: 'idle'` instead of `'error'`
   (app-server mode included — the thread is alive; the account is throttled, the
   session is not broken). Keep the rethrow so Phase 2 sees the error.
2. Do **not** fold this into `isRecoverableTurnError()`'s regex soup blindly — add the
   `isProviderNotice` check as its own named condition so the semantics stay legible
   (`recoverable-because-provider-limit` vs `recoverable-because-transient`).
3. Keep the existing error-type `output` emit — the red bubble plus the park system
   message is acceptable, transparent UX.
4. Spec: usage-limit rejection in app-server mode emits `status: 'idle'` (not
   `'error'`); non-limit fatal errors (auth, unknown model) still emit `'error'`;
   exec-mode behavior unchanged.

### Phase 4 — Renderer: don't leak sends into a parked instance

**Files:** `src/renderer/app/core/state/instance/instance-messaging.store.ts`
(+ spec), possibly a tiny helper in the instance model/types.

1. Add a predicate (local helper or on the model): instance is *quota-parked* ⇔
   `instance.waitReason?.kind === 'quota-park'`.
2. Gate all three leak points:
   - `processMessageQueue` (~542): after the existing status check, return early when
     quota-parked (leave the queue intact — main's `resumeNow` re-sends the throttled
     turn; the queue then drains naturally on the following idle transition).
   - `drainAllReadyQueues` (~65): skip quota-parked instances in the idle branch.
   - `sendInput` (~210): when quota-parked, `enqueueMessage` instead of
     `sendInputImmediate` (same treatment as `isTransientQueueStatus`). The composer
     already shows the countdown chip (`input-panel-formatters.ts`), so queued-while-
     parked is discoverable UX.
3. Do **not** gate `sendInputImmediate` calls made by the resume path — resume happens
   main-side (`resumeNow` → `deps.resendInput` → `InstanceManager.sendInput`), it never
   passes through this store; and `resumeNow` clears the park **before** re-sending, so
   the waitReason is already null by the time the queue drains.
4. Spec (`instance-messaging.store` spec or nearest existing renderer spec): parked +
   idle + non-empty queue → no drain; parked `sendInput` → enqueued, not sent; park
   cleared → next idle transition drains normally.

### Phase 5 — Loop-controlled instances must not double-park

**Files:** `src/main/instance/instance-manager.ts`, possibly
`instance-provider-limit-handler.ts` (+ specs)

Loops have their own park/resume (`loop-provider-limit-handler.ts`); if a loop-driven
turn error also parks the *instance*, both machineries would re-send at reset →
duplicate turn.

1. Investigate first (do not assume): trace whether loop-driven turns can reach either
   the `on('error')` park branch or the new Phase 2 branch. Loops invoke via
   `default-invokers` / orchestration, but some flows do call
   `InstanceManager.sendInput`.
2. If reachable: in the `onProviderLimitTurn` dep wiring in `instance-manager.ts`
   (~338–348), return `'skipped'` when the orchestration manager reports active loop
   work for the instance (`this.orchestrationMgr.hasActiveWork(id)` — the dep already
   exists at ~250 for the idle monitor; add a parallel dep or reuse). Add a spec proving
   a loop-controlled instance is not parked by the regular handler.
3. If not reachable, document why in a code comment at the wiring site and add a
   regression spec if practical.

### Phase 6 — Optional hardening (do these last; skip if time-boxed, but say so)

1. **Loop classifier parity:** extend `parseServerRetryAfterMs` /
   `parseResetTimestampFromText` in `src/main/core/loop-error-classification.ts` to
   reuse Phase 1's `parseResetHintFromText` (import direction: loop-error-classification
   → instance-provider-limit-detection is fine; if it creates a cycle, lift the parser
   into a shared module under `src/main/core/`). Codex loop parks then get exact reset
   times instead of snapshot guesses.
2. **Snapshot refresh on park-miss:** in `maybePark`, when every hint source fails,
   fire-and-forget `getProviderQuotaService().refresh(provider)` and log — so the *next*
   limit error has a fresh snapshot. Do not await it in the park path.

## 5. What must NOT change

- `InstanceProviderLimitHandler`'s park/resume/dedupe/cancel semantics and the durable
  automation (`instance-provider-limit-resume-scheduler.ts`) — reuse as-is.
- The `instanceProviderLimitResumeEnabled` gate: everything stays behind it
  (`isEnabled()` is read live at park time; no migration needed — it is already `true`).
- The exit-0 completion-notice path and the Claude telemetry path — regression-guard
  them; do not refactor while adding the third choke point.
- Error handling for non-limit errors (auth, unknown model, session-not-found,
  overflow): byte-for-byte behavior preserved. The overflow branch runs **before** the
  new limit branch in the catch, as it does today.

## 6. Test matrix (summary)

| Layer | Case | Expected |
|---|---|---|
| detection | live incident string, now=15:42 | resetAt ≈ today 17:01 local |
| detection | "resets 6:30pm", now=7pm | tomorrow 06:30pm |
| detection | "in 45 minutes" | now+45m |
| detection | garbage / empty | null |
| handler | maybePark on already-parked id | `'already-parked'` |
| communication | thrown usage-limit, feature ON | parked, idle, no rethrow |
| communication | thrown usage-limit, feature OFF | rethrow, error status (today's behavior) |
| communication | thrown auth error | untouched error path |
| communication | thrown overflow error | untouched compaction path |
| codex adapter | usage-limit reject (app-server) | status `idle`, rethrow |
| codex adapter | auth reject (app-server) | status `error` (unchanged) |
| renderer | idle + quota-park + queued msgs | no drain |
| renderer | sendInput while quota-parked | enqueued |
| loop | loop-controlled instance limit error | regular park skipped |

## 7. Verification checklist (canonical gates — all required before `_completed`)

```bash
npm run test:quiet -- src/main/instance/instance-provider-limit-detection.spec.ts
npm run test:quiet -- src/main/instance/instance-provider-limit-handler.spec.ts
npm run test:quiet -- src/main/instance/instance-communication.spec.ts
# + codex adapter and renderer messaging specs
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet          # full suite, final gate
```

**Runtime verification (required — code-present is not code-wired):** simulate the
incident in the dev app without burning real quota: temporarily point a codex instance at
a stub, or drive `InstanceCommunicationManager` directly in an integration-style spec
that uses a real handler + fake timers and asserts the full park → clock-advance → resume
→ re-send sequence. Additionally, seed the renderer store
(`ng.getComponent` / InstanceStore seeding technique — see repo memory
"renderer-ui-verify-via-ng-store-seeding") with an instance whose
`waitReason = { kind: 'quota-park', provider: 'codex', resumeAt: now+5m }` and confirm:
countdown chip renders, composer send queues, queue does not drain, no "restart the
instance" notice. Capture what was actually verified vs. asserted in the completion
report.

## 8. Risks and edge cases the implementer must handle

- **Timezone/DST:** clock-time parsing uses machine-local time (same locale as the
  provider message). Rollover math must use date arithmetic, not `+24*3600*1000` blindly
  across DST boundaries — acceptable to keep simple ms math but say so in a comment.
- **Weekly limits:** "try again at…" may be days out. Decision: park anyway (durable
  automation survives restarts) but cap text-parsed hints at 8 days as sanity. The park
  message must include the resume time so James can cancel (cancel path exists).
- **Batch flush race (renderer):** `idle` and `waitReason` should land in the same
  update batch (both queued in the same tick main-side). The renderer gates make the
  race harmless even if they split.
- **Resume into a still-throttled provider:** provider clocks skew; the re-sent turn can
  fail again. The flow self-heals: the failure re-enters the new catch branch → fresh
  park with a new reset (the handler clears `parked` before resend, and
  `lastResumeAt` dedupe only blocks *resumes*, not fresh parks — verify with a spec:
  park → resume → immediate second limit error → parked again, `lastResumeAt` cleared by
  `maybePark`'s existing `this.lastResumeAt.delete`).
- **`resumePrompt` correctness:** `lastSentMessages` is set before `adapter.sendInput`
  (~653), so the catch path has the right prompt. Do not capture the mutated
  `finalMessage` (which may embed context blocks) — use the same
  `this.lastSentMessages.get(instanceId)?.message` the other call sites use.

## 9. Deliverables / completion report format

Per project standards: list every phase with actual status, cite the test output for each
gate, state explicitly what was verified at runtime vs. by unit test, and call out any
deviation from this plan with rationale. Do not claim completion without current command
output. Rename this file `_completed` only after all of §7 passes. Do not commit unless
James asks.

## 10. Out of scope (explicitly)

- Wiring `FailoverManager` / provider→provider or account→account failover. It is an
  unwired orphan primitive (instantiated in `infrastructure-bootstrap.ts` only); wiring
  it is a separate design decision for James (see memory
  "orphan-primitives-are-design-decisions").
- Multi-account Codex support (James has one account today).
- Claude adapter changes — its telemetry + notice paths already work.
- UI redesign of the park chip/countdown (already exists).
