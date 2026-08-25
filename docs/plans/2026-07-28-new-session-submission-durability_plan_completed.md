# New-session submission durability — implementation plan

Spec: [2026-07-28-new-session-submission-durability_spec_completed.md](../superpowers/specs/2026-07-28-new-session-submission-durability_spec_completed.md)

Status: COMPLETED — 2026-08-19 (fresh-eyes completion gate, pass 3, ran clean)

---

## 1. Design

A **submission journal** owns the composition from the moment the user hits Send until the main
process returns an instance id. The composer becomes a view over the journal rather than the sole
holder of the content.

```
onSend()  ──▶ journal.begin()          durable record written FIRST (IndexedDB, attachments included)
          ──▶ newSessionSubmit.emit({ submissionId, text, files, folders, onResolved, onTimeout })
          ──▶ composer stays populated, send disabled, "Sending…" state
                    │
   welcome coordinator ──▶ createInstanceWithMessage(idempotencyKey = submissionId)
                    │
          ◀── onResolved(true,  instanceId)  ──▶ journal.markAccepted() ──▶ composer cleared
          ◀── onResolved(false, message)     ──▶ journal.markFailed()   ──▶ composer restored + banner + Retry
          ◀── (no answer in 60 s)            ──▶ onTimeout() + journal.markFailed('timed out')
          ◀── (success AFTER the timeout)     ──▶ journal.markAccepted(), composer left alone
```

Durability uses **IndexedDB**, which stores `File`/`Blob` natively — the only browser store that can
persist the attachments. `localStorage` (today's draft store) cannot.

Duplicate suppression needs its own cache. The existing `IdempotencyStore` (wired for
`INSTANCE_SEND_INPUT`) only answers "have I seen this key?", which is enough for a send but not for a
create: the retry has to come back with the *same instance id*, or the renderer either spawns a
duplicate or resolves with nothing usable. `InstanceCreateIdempotencyCache` therefore keeps the
in-flight/settled response per key and replays it. The journal's submission id is the key.

### 1.1 New files

| File | Purpose |
|---|---|
| `src/renderer/app/core/services/composer-submission.types.ts` | Record/status/stage types, ack timeout, retention caps |
| `src/renderer/app/core/services/composer-submission-store.ts` | IndexedDB journal (open/put/list/delete) + in-memory fallback |
| `src/renderer/app/core/services/composer-submission.service.ts` | Signals + lifecycle: `begin` / `retry` / `amend` / `markAccepted` / `acceptIfStillSettled` / `markFailed` / `discard` / `restore` |
| `src/renderer/app/features/instance-detail/input-panel-new-session-submit.ts` | `submitNewSession`, `retryNewSession`, `NewSessionSubmissionController` — where the keep-until-acknowledged rule lives |
| `src/renderer/app/features/instance-detail/composer-recovery-banner.component.ts` | Failure/recovery banner with Retry and Discard |

### 1.2 Changed files

| File | Change |
|---|---|
| `input-panel.component.ts` | `onSend` for the draft composer becomes ack-driven via a new `newSessionSubmit` output, delegating state to `NewSessionSubmissionController` |
| `input-panel.component.html` | Recovery banner rendered for the draft composer; the Send button is gated indirectly via `canSend()` |
| `instance-welcome.component.ts` | Forwards `newSessionSubmit` (replaces the fire-and-forget `sendMessage`) |
| `instance-detail.component.ts` / `.html` | Handles `newSessionSubmit`, resolves it from the coordinator's result |
| `welcome-coordinator.service.ts` | `submitWelcomeMessage` returns a discriminated result, threads the submission id and its attachments, and clears the draft only on acceptance |
| `instance-list.store.ts` | Threads `idempotencyKey`; returns a typed failure reason instead of only `null` |
| `instance-attachments.ts` | `validateFiles` gains a count check; new `validateAttachmentCount` for the post-expansion payload |
| `packages/contracts/src/schemas/instance.schemas.ts` | `idempotencyKey` on the create-with-message payload |
| `preload/domains/instance.preload.ts` | Passes `idempotencyKey` through |
| `src/main/ipc/handlers/instance-handlers.ts` | Entry log, validation-failure log, idempotency dedupe for create-with-message |

### 1.3 Stale-resolution guard (R7)

Three separate mechanisms, none of which write back into the composer:

1. **`settled` latch in `submitNewSession`.** A resolution arriving after the submission has already
   settled cannot clear the composer or flip the submitting flag. A late *success* is still passed to
   `accept()` — the session exists, so the journal entry is no longer unsent and must be removed or
   the user is shown a permanent "not sent" banner for a session that was created.
2. **Per-draft-key surfacing.** `recoverableFor(draftKey)` only ever *offers* a record through the
   banner; nothing is ever pushed into the composer behind the user's back.
3. **Supersede-on-`begin`, restore-aware.** A fresh Send for a draft key drops that key's earlier
   unsent records, because the composer was never cleared and the new record already contains that
   content. Records recovered from a *previous run* are exempt (`restoredIds`): the composer is empty
   for those, so the journal is their only copy.

---

## 2. Tasks

- [x] T1 — Types + shared attachment limits (`FILE_LIMITS.MAX_ATTACHMENTS`, pinned to the Zod cap by test)
- [x] T2 — `composer-submission-store.ts`: IndexedDB journal + in-memory fallback
- [x] T3 — `composer-submission.service.ts`: lifecycle, signals, startup restore, stale guard
- [x] T4 — `instance-attachments.ts`: pre-flight validation matching the main-process cap
- [x] T5 — Contract + preload + main handler: `idempotencyKey`, entry log, failure log, dedupe
- [x] T6 — `instance-list.store.ts`: typed failure result + idempotency key
- [x] T7 — `welcome-coordinator.service.ts`: typed result, clear only on acceptance
- [x] T8 — `input-panel.component.ts`: ack-driven draft send, submitting state, timeout
- [x] T9 — `composer-recovery-banner.component.ts` + wiring through welcome/detail
- [x] T10 — Regression tests (§3)
- [x] T11 — Canonical verification checklist
- [x] T12 — Fresh-agent completion gate

## 3. Regression coverage

| Case | Test |
|---|---|
| Long prompt + 6 realistic images succeeds end to end | `composer-submission.service.spec.ts`, `input-panel-new-session-submit.spec.ts` |
| Delayed acknowledgement — composer stays populated meanwhile | `input-panel-new-session-submit.spec.ts` |
| Rejected IPC promise | `input-panel-new-session-submit.spec.ts` |
| Main-process timeout / no acknowledgement | `input-panel-new-session-submit.spec.ts` |
| Attachment-processing failure | `instance-attachments.spec.ts`, store spec |
| Component unmount during submission | `input-panel-new-session-submit.spec.ts` |
| Retry without duplicate session creation | `instance-create-idempotency.spec.ts`, `input-panel-new-session-submit.spec.ts` |
| Draft restoration after reload | `composer-submission.service.spec.ts` |
| Cleanup after confirmed success | `composer-submission.service.spec.ts` |
| Newer draft preserved when an older submission resolves | `composer-submission.service.spec.ts` |
| Retry after a restart sends the journalled attachments | `input-panel-new-session-submit.spec.ts` |
| Retry prefers composer edits made after the failure | `input-panel-new-session-submit.spec.ts` |
| Recovered composition is never superseded by a new send | `composer-submission.service.spec.ts` |
| Double-submit window closed before the journal write | `input-panel-new-session-submit.spec.ts` |
| Late success after the ack timeout reconciles the journal | `input-panel-new-session-submit.spec.ts` |
| Remote node selection survives a failure | `welcome-coordinator.service.spec.ts` |
| Journal retention (age + count caps) | `composer-submission.service.spec.ts` |
| Retry keeps journalled files when only the text survived a restart | `input-panel-new-session-submit.spec.ts` |
| Retry double-click window | `input-panel-new-session-submit.spec.ts` |
| Late success does not delete a record an in-flight retry owns | `input-panel-new-session-submit.spec.ts` |
| Component wiring: draft send routes to `newSessionSubmit`, clears nothing early | `input-panel-new-session-wiring.spec.ts` |
| Swapped attachment of the same count is re-sent, not silently dropped | `input-panel-new-session-submit.spec.ts` |
| Over-cap attachments rejected on the existing-session send path too | `instance-attachments.spec.ts`, `instance-messaging-queue-utils.spec.ts` |

Image fixtures are real encoded PNG bytes at realistic screenshot dimensions, not placeholder
strings.

## 4. Verification

```
npm run test:quiet -- <focused specs>
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run test:quiet
```

## 5. As-built

### Files added

| File | Purpose |
|---|---|
| `src/renderer/app/core/services/composer-submission.types.ts` | Record/status/stage types, ack timeout |
| `src/renderer/app/core/services/composer-submission-store.ts` | IndexedDB + in-memory journal backends |
| `src/renderer/app/core/services/composer-submission.service.ts` | Journal lifecycle, signals, restore, supersede |
| `src/renderer/app/core/services/composer-submission.test-util.ts` | `makeService()` storage seam for specs |
| `src/renderer/app/features/instance-detail/input-panel-new-session-submit.ts` | `submitNewSession`, `retryNewSession`, `NewSessionSubmissionController` |
| `src/renderer/app/features/instance-detail/composer-recovery-banner.component.ts` | Visible sending/failure state + Retry / Discard |
| `src/renderer/app/features/instance-detail/input-panel-prompt-recall.ts` | Prompt-recall stepper extracted to stay inside the LOC ratchet |
| `src/renderer/app/core/state/instance/instance-create-payload.ts` | Create-with-message payload assembly |
| `src/main/ipc/handlers/instance-create-with-message.ts` | Handler body + pre-validation entry logging |
| `src/main/ipc/handlers/instance-create-idempotency.ts` | Per-submission create dedupe with response replay |

### Files changed

`input-panel.component.ts` / `.html`, `instance-welcome.component.ts`, `instance-detail.component.ts` / `.html`,
`welcome-coordinator.service.ts`, `instance-list.store.ts`, `instance.store.ts`, `instance-attachments.ts`,
`instance.types.ts`, `instance-ipc.service.ts`, `preload/domains/instance.preload.ts`,
`packages/contracts/src/schemas/instance.schemas.ts`, `src/main/ipc/handlers/instance-handlers.ts`.

### Deviations from the plan

0. **Post-review corrections (gate pass 1).** The first independent completion-gate pass returned
   FAIL. Fixed in response: the retry path now carries the journalled attachments instead of re-reading the live
   draft (which is empty after a restart, so a retry sent a text-only message and then deleted the
   images); `begin()` no longer supersedes a record recovered from a previous run; `setSubmitting`
   moved ahead of the journal write to close a double-submit window; the ack timeout now tells the
   handler to drop the "Starting conversation…" view so the recovery banner is reachable; a
   post-timeout success reconciles the journal; the remote-node selection survives a failure so a
   retry still targets the chosen node; `runRestore` merges rather than replaces and no longer
   orphans submissions started in the current session; journal retention caps were added; and the
   new image-size gate in `validateFiles` was reverted because `fileToAttachments` tiles large
   images without consulting `file.size`, so it rejected sets that work today.
0b. **Post-review corrections (gate pass 2).** The second pass returned FAIL on one blocker
   introduced by the pass-1 retry fix. `retryNewSession` treated "live composer content" as
   all-or-nothing, but the two stores do not survive a restart together: the draft *prompt* is
   persisted to localStorage while the staged `File[]` is in-memory only. After a restart the
   composer therefore has text and no attachments, so the rule amended the record's images away and
   sent a text-only message — losing exactly what the fix exists to protect. Each field now falls
   back independently. Also fixed: a Retry double-click window (`setSubmitting` now claimed before
   the awaited journal reopen), a late success deleting a record an in-flight retry owns
   (`acceptIfStillSettled`), the missing component-level test for the wiring the incident actually
   broke (`input-panel-new-session-wiring.spec.ts`), the same silent Zod-rejection gap on the
   existing-session send path (`inputFilesToAttachments` now runs `validateAttachmentCount`), and
   further plan drift.
1. **Storage is not constructor-injected.** Angular's JIT reflection cannot resolve an
   interface-typed constructor parameter (it emits `ctorParameters` referencing an identifier that
   does not exist at runtime), which broke every `InputPanelComponent` spec. The service builds its
   own backend and exposes `_setStorageForTesting`, matching the repo's `_resetForTesting` idiom.
2. **Stage logging lives on the record, not in `console`.** The lint rule allows only
   `console.warn`/`error`, and console output is not persisted anyway. Each record carries a
   `stages[]` trail keyed by the same correlation id the main process logs, so it survives a reload;
   failures additionally emit a `console.warn` carrying the whole trail.
3. **`begin()` supersedes an earlier unsent attempt on the same draft key** (except records
   recovered from a previous run). Found during self-review: because the composer is no longer
   cleared, a failure left both a recovery banner and the live text. Retry additionally prefers the
   live composer content when it is non-empty, so an edit made after the failure is not silently
   discarded in favour of the journalled copy.
4. **`InstanceStore.error` is still unrendered.** The new-session surface gets the targeted banner
   instead, per spec §5. Other `setError` callers remain invisible — unchanged, and out of scope.
5. **Retention is bounded.** Journal entries older than 30 days, and everything past the newest 20,
   are pruned at restore. Records hold full image blobs and one whose draft key the user never
   revisits is never surfaced, so the journal needed a ceiling.
6. **Idempotency TTL is 10 minutes** while the composer's ack timeout is 60 seconds. A retry more
   than 10 minutes after an unacknowledged-but-successful create can therefore still produce a
   second session. Accepted: it matches the existing `IdempotencyStore` TTL for `sendInput`, and the
   window requires the user to leave a failed banner untouched for ten minutes first.
7. **`record.workingDirectory` is stored but not read on retry.** The draft key encodes the working
   directory, so a retry cannot target a different one; provider, model, reasoning effort, YOLO,
   hardened and node are re-derived from live draft state at retry time, which is deliberate — the
   user may have changed them since. The field is retained for diagnostics.
8. **Two files extracted for the size ratchet.** `input-panel-prompt-recall.ts` and
   `instance-create-payload.ts` are mechanical extractions with no behaviour change; both target
   files were already over their recorded ceilings before this work.

### Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npx tsc --noEmit -p tsconfig.spec.json` | pass |
| `npm run lint` | pass — all files pass linting |
| `npm run check:ts-max-loc` | pass — ratchet satisfied without raising any ceiling |
| `npm run build:main` | pass — tsc + sync-dist + preload bundle |
| `npm run test:quiet` | pass — see the final figure in the completion summary |
| `npm run check:dead` | 9 pre-existing unbaselined helpers, none in files touched here |

New tests (72 across seven new spec files):

| Spec | Tests |
|---|---|
| `composer-submission.service.spec.ts` | 22 |
| `input-panel-new-session-submit.spec.ts` | 21 |
| `instance-attachments.spec.ts` | 8 |
| `instance-create-idempotency.spec.ts` | 8 |
| `instance-create-with-message.spec.ts` | 5 |
| `input-panel-new-session-wiring.spec.ts` | 3 |
| `instance-messaging-queue-utils.spec.ts` | 5 |

Plus additions to `welcome-coordinator.service.spec.ts` (submission content, node retention,
preparation-failure reason).

### Requirement coverage

| Req | Where |
|---|---|
| R1 | `submitNewSession` — `clearComposer()` runs only inside the `result.ok` branch |
| R2 | Journal retains text + `File[]`; composer/draft are never cleared on failure |
| R3 | IndexedDB backend; `restore()` reopens `pending` records as recoverable |
| R4 | `ComposerRecoveryBannerComponent` with reason, Retry and Discard |
| R5 | `idempotencyKey` = submission id; `InstanceCreateIdempotencyCache` replays the original response |
| R6 | `markAccepted` is the only path that deletes on success; `discard` is the explicit user path |
| R7 | `settled` guard in `submitNewSession`; per-draft-key `recoverableFor`; supersede on `begin` |
| R8 | `stages[]` on the record + `IPC INSTANCE_CREATE_WITH_MESSAGE received` / `failed` in main |
| R9 | `validateFiles` count check; `validateAttachmentCount` on the expanded payload, on both the create and the send path |
| R10 | Journal is service-scoped, not component-scoped; timers live in a detached closure |
| R11 | 60s `COMPOSER_SUBMISSION_ACK_TIMEOUT_MS` fails closed and keeps the composition |

### Gate pass 3 (2026-08-19) — fresh-eyes completion review

A fresh agent context (Plan Agent P2) that had not implemented this work read the whole plan and
spec, then independently traced every requirement through the executing source rather than trusting
the as-built notes: `onSend()` → `NewSessionSubmissionController.submit()` → `submitNewSession()` →
`ComposerSubmissionService` → `newSessionSubmit` output → `instance-detail.component.ts
onWelcomeSubmit` → `welcome-coordinator.service.ts` → `INSTANCE_CREATE_WITH_MESSAGE` IPC → the
`InstanceCreateIdempotencyCache` dedupe → `instance-create-with-message.ts` → back through
`onResolved`/`onTimeout` to the composer.

Findings:

- **Single-producer shape already matches LT-181's `dispatchSend` pattern.** `onSend()` is the only
  call site for `submission.submit()` (`input-panel.component.ts:1396`), gated by
  `submission.submitting()` inside `canSend()` (`input-panel.component.ts:878`). Retry and Discard
  each have exactly one call site too, in `composer-recovery-banner.component.ts`'s bindings
  (`input-panel.component.html:21-22`). No second, ungated producer was found — the mobile-gateway
  hole LT-181 found does not exist here.
- **R9 parity confirmed for both attachment paths.** `validateAttachmentCount` runs on the
  create-with-message path (`instance-list.store.ts:264`) and the existing-session send path
  (`instance-messaging-queue-utils.ts:180`), both against the same `FILE_LIMITS.MAX_ATTACHMENTS`,
  which a test pins directly against the Zod `.max(10)` by parsing payloads at the boundary
  (`instance-attachments.spec.ts:101-105`).
- **Main-process wiring confirmed, not just present.** `instance-handlers.ts:130` logs before
  validation, `:141-151` runs the idempotency cache keyed `create-with-message:<id>`, `:156-159`
  logs failures with the submission id recovered from the raw (possibly-invalid) payload.
- **Live UI check** (dev app, port 9482, isolated `/tmp/aio-lt-planP2` profile): seeded a
  `ComposerSubmissionService.begin()` + `markFailed()` record for the active draft key via
  `window.ng.getComponent()` on the real running `InputPanelComponent`, with focus/visibility CDP
  emulation active. `app-composer-recovery-banner` rendered "This message was not sent /
  Simulated failure... / 80 characters" with working Retry and Discard buttons; clicking Discard
  cleared the banner live. Dev app and its `/tmp` profile were torn down afterward.
- Ran the targeted spec files (7 files, 72 tests, matching the count recorded below) plus
  `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`,
  `npm run check:ts-max-loc`, and `npm run build:main` — all green, no LOC ceiling raised.

No actionable finding. **VERDICT: PASS.**

## 6. Follow-up not covered here

The existing-session send path keeps its clear-before-acknowledgement shape (spec §5). Closing it
requires giving `InstanceStore.sendInput` an acknowledgement contract without disturbing the
renderer-owned queue/steer/interrupt machinery. Raise as a separate spec if an existing-session
attachment loss is ever observed.
