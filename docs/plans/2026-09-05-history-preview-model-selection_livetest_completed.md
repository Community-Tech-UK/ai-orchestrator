# Closed-session model selection live verification

## Status — 2026-09-24
Check 2 was re-run live against a rebuilt app (HEAD `f04f6748`) — see
[Evidence run — 2026-09-24 (resume batch)](#evidence-run--2026-09-24-resume-batch). **LT-595 is
CONFIRMED FIXED LIVE.** All six checks now pass. This document is a candidate for
`_livetest_completed` rename by the orchestrator.

### Status — 2026-09-21 (superseded)
Open: 0 · Closed: 5 · Failed: 1
All six checks were driven against a live dev app with real Claude and Codex turns on 2026-09-21
(evidence run below). Checks 1, 3, 4, 5 and 6 pass. **Check 2 fails on its last clause:** the
prompt does run on the chosen model, but once the restored session becomes the active view the
composer's model picker keeps naming the *old* model for the rest of that view. Filed as
[LT-595](livetest-remediation-register.md#lt-595-the-composer-picker-keeps-the-old-model-after-a-closed-session-continuation).
Do not rename this document `_livetest_completed.md` until LT-595 is fixed and check 2 is re-run.

The 2026-09-06 prerequisite about Gateway audit `3f2bbbc4-6842-448f-9fdf-d83a8affb7db` no longer
gates anything here: none of these checks needed a browser. They were driven through the dev app's
own renderer over CDP, which is the route the campaign runbook prescribes.

### Previous status — 2026-09-06
Open: 6 · Closed: 0 · Failed: 0
Needed a real-provider pass through the six UI checks in the already-rebuilt app; the doc's own prerequisite also gated any windows-pc/browser-routed step behind James re-verifying prior Gateway audit `3f2bbbc4-6842-448f-9fdf-d83a8affb7db`.

> If a check reproduces a defect, record a new LT-NNN item in
> `docs/plans/livetest-remediation-register.md` and a matching implementation-status
> section in `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`.
> Keep per-check evidence here. Read `docs/plans/livetest-campaign-runbook.md` first.

Plan: [history-preview-model-selection_plan.md](./2026-09-05-history-preview-model-selection_plan_completed.md).

## Prerequisites and reason for pending live checks

Use a rebuilt/restarted app containing this checkout's renderer, main and preload,
and disposable history entries with available authenticated providers. No new feature
flag is required. Route browser verification explicitly through `windows-pc` after
Gateway worker/channel preflight. The previous Gateway evaluation requires James's
verification before retry (audit `3f2bbbc4-6842-448f-9fdf-d83a8affb7db`); do not bypass
it with another tab or local browser. Agent-runnable rendered component and IPC-boundary
regressions cover selection, status, failure, retry, races and continuation ordering.
These remaining checks confirm actual provider runtime behavior and the visible app.

## Checks

- [x] Open a disposable closed Codex history entry. Choose another available model.
  Expected: picker shows the choice and “Will use <model> when resumed”; no instance-not-found
  error and no “Switched” claim. Opening a different preview and returning preserves the choice.
  **PASS 2026-09-21.**
- [ ] Type a short prompt to trigger background restore, then change the model before sending.
  Send the prompt. Expected: one restored instance is reused, the requested model is confirmed
  before the first prompt runs, and the active session shows that model. Inspect runtime metadata
  rather than asking the model to identify itself.
  **FAIL 2026-09-21 — LT-595.** Reuse and ordering pass; the active session's *composer* picker
  shows the old model.
- [x] Repeat with a different available CLI provider and reasoning choice. Open the loop panel
  before continuing. Expected: its default provider follows the pending choice; an explicit
  advanced provider override remains intentional. In same-session mode, continuation uses the
  confirmed restored runtime. In fresh-child mode, the loop's explicit provider config applies.
  **PASS 2026-09-21.**
- [x] Repeat continuation through an edited resend. Expected: the fork preserves the confirmed
  runtime settings and receives the edited prompt once. **PASS 2026-09-21.**
- [x] On an active disposable session, change to an available model. Expected: Applying appears
  while waiting; Switched appears only after confirmation. If busy, feedback says queued until
  ready. A rejected/unavailable choice produces an error and no success pill.
  **PASS 2026-09-21.**
- [x] Record screenshots without sensitive transcript content, runtime model/provider evidence,
  app build identity and each result. Close only disposable test tabs/sessions created for this check.
  **PASS 2026-09-21.**

## Evidence

Five of six checks pass with real-provider evidence (below). Check 2 fails on its last clause.
Rename to `_livetest_completed.md` only after every check above passes.

## Evidence run — 2026-09-21

### Environment and build identity

| Item | Value |
| --- | --- |
| Checkout | `.worktrees/queue/2026-09-05-history-preview-mod-b54a87`, branch `queue/2026-09-05-history-preview-mod-b54a87`, HEAD `592ef432e5ddc841e55ccc008644612a9bc2ec90` |
| App | `harness` 0.1.0, `Harness(Dev)/0.1.0 Chrome/144.0.7559.236 Electron/40.10.6` |
| Main / preload build | `dist/main/index.js` 2026-09-21T02:10:10, `dist/preload/preload.js` 02:10:11 (`npm run build:main`, exit 0) |
| Renderer | `ng build --configuration development --output-path dist/renderer-dev`, exit 0, `browser/index.html` 02:10:13; `chunk-4YIZWWY4.js` contains the `when resumed` feedback string |
| Serving | `http-server dist/renderer-dev/browser -p 4571 -c-1 -P "http://127.0.0.1:4571?"` |
| Dev app | `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-82b54a87 PORT=4571 npx electron . --remote-debugging-port=9728` |
| Focus emulation | `Emulation.setFocusEmulationEnabled {enabled:true}` + `Page.setWebLifecycleState {state:'active'}` sent before every evaluate. `Emulation.setPageVisibilityOverride` was rejected by this build with `wasn't found` and was skipped; `document.hidden` was verified `false` and `visibilityState` `visible` on every run |
| Workspace | `/tmp/aio-lt-queue-82b54a87-ws` (disposable) |
| Providers | `claude` 2.1.278 and `codex` both authenticated and used for real turns. Quota at run time: Claude `seven_day` rate limit in `allowed_warning` (resets 2026-09-25T22:00Z), Codex `codex.weekly` 96/100 requests used (resets 2026-09-26T12:19Z) |
| Host load | `load averages: 6.40 5.78 5.26` at dispatch — well under the runbook's ~30 ceiling |

Everything was driven through the real renderer: real `Input.insertText` / `Input.dispatchKeyEvent`
keystrokes into the composer, real clicks on the picker rail and model rows, and real sidebar
clicks. No browser or `windows-pc` step was needed, so the Gateway audit prerequisite did not
apply.

Local artefacts (gitignored, in the worktree `_scratch/lt-queue-82b54a87/`):
`evidence/check2-app-log-slice.ndjson`, `evidence/check3-app-log-slice.ndjson` and the six
screenshots named below, plus the reusable CDP harnesses — `cdp.mjs` (evaluate with focus
emulation), `drive.mjs` (same, with a page-side `__cdp()` binding so one script can mix DOM work
with real `Input.*` events on one connection) and `shot.mjs`. All decisive text is quoted inline
here so the claims stay checkable after those files go.

### Disposable fixtures

Three disposable closed entries were created by running real turns and terminating them:

| Entry | Provider at close | First prompt |
| --- | --- | --- |
| `1d614a39-1f17-463e-b7d2-78b992b43506` | codex `gpt-5.6-sol` | "Reply with exactly the word ACORN and nothing else." |
| `2206e2b0-2213-4b3a-9edb-641010101cbe` | claude `opus[1m]` | "Reply with exactly the word BIRCH and nothing else." |
| `9fe36fb4-4b51-4120-a792-a037b8776dae` | claude `opus[1m]` | "Reply with exactly the word GORSE and nothing else." |

A fourth disposable session ("LT queue reject probe", no transcript) was created for check 5's
rejection probe. No real user data was touched: the profile is a fresh `/tmp` one and every
transcript is a one-word probe.

### Check 1 — pending choice in a closed preview — PASS

Opened entry `1d614a39…` (Codex), opened the compact picker, clicked the Codex rail and selected
**GPT-5.6 Terra**. Rendered result:

```
chip   : "Codex · GPT-5.6 Terra · Thinking: High ▾"
status : "Will use GPT-5.6 Terra when resumed"
toasts : []          (no instance-not-found error, no "Switched" claim)
```

Screenshot `check1-pending-choice.png` shows the green `Will use GPT-5.6 Terra when resumed` pill
beside the picker, with the composer still reading `Type to restore and continue...`.

No live IPC was issued for the pick. `InstanceIpcService.changeModel` was wrapped on the live
root singleton (`__ltPatched` verified `true` on the same object the composer toolbar and
`HistoryPreviewSessionService` both inject) and recorded **0 calls**. `listInstances()` returned
**0 instances**. The main-process log contains **zero** occurrences of the string
`history-preview:` across the whole file — re-checked at the end of the run, 5096 lines, still 0 —
so no synthetic preview id reached live IPC at any point.

Navigation: switching to the BIRCH preview showed that entry's own untouched runtime
(`Claude · Opus latest, 1M`, status `null`), and returning to ACORN restored
`Codex · GPT-5.6 Terra` / `Will use GPT-5.6 Terra when resumed` — the pick is entry-scoped and
survives navigation.

### Check 2 — type, change model, send — FAIL (LT-595)

Typing into the preview composer warmed a background restore without applying the draft pick:
instance `x9wgbk7ix` appeared as codex `gpt-5.6-sol` (the entry's own model) while the pending
choice was still Terra and `changeModel` call count was still 0. That is the correct behaviour —
a warm restore must not release a draft pick.

The model was then changed to **GPT-5.6 Luna** before sending (`Will use GPT-5.6 Luna when
resumed`), and `Reply with exactly the word CEDAR and nothing else.` was sent with a real Enter.

Main-process ordering, from `evidence/check2-app-log-slice.ndjson`:

```
1789953347477  HistoryRestoreCoordinator  History restore complete
               entryId=1d614a39-… restoreMode=native-resume instanceId=x9wgbk7ix
1789953404699  RuntimeReconciler          Applying runtime change
               instanceId=x9wgbk7ix oldModel=gpt-5.6-sol newModel=gpt-5.6-luna
1789953405298  RuntimeReconciler          Runtime change applied
               instanceId=x9wgbk7ix newModel=gpt-5.6-luna continuity=native-resume
1789953417490  InstanceHandlers           IPC INSTANCE_SEND_INPUT received
               instanceId=x9wgbk7ix messageLength=51
```

- **One restored instance, reused.** At this point `grep -c "History restore complete.*1d614a39"`
  over the whole log was **1** — typing warmed the restore and the send reused it rather than
  restoring again. `listInstances()` held exactly one instance before and after the send, same id.
  (Later checks restore the same entry again deliberately, so that count is only 1 as of check 2.)
- **Confirmed before the prompt ran.** The runtime change was applied at `…405298`; the prompt was
  delivered at `…417490`, 12.2 s later. The `changeModel` response carried
  `desiredRuntime: null`, i.e. confirmed rather than queued.
- **The turn ran on the requested model.** Final instance: `codex` / `gpt-5.6-luna` /
  reasoning `high`, assistant reply `CEDAR`.

**Failing clause — "the active session shows that model".** The session header shows
`Codex · GPT-5.6 Luna` but the **composer** picker shows `Codex · GPT-5.6 Sol`
(`check2-active-session-luna.png`). Backend truth and the composer's own `currentModel` input are
both `gpt-5.6-luna`; only `ComposerToolbarComponent.pendingSelection()` is stale, and it never
self-corrects.

Reproduced a second time, deliberately, on the Claude entry `9fe36fb4…`
(`claude-sonnet-5` → `Haiku 4.5`, prompt `HAZEL`). A 150 ms sampler caught the whole race:

```
t=  915ms  instanceId=history-preview:9fe36fb4…  currentModel=claude-sonnet-5            pending=claude-sonnet-5
t= 1069ms  instanceId=cdvxgskwi                  currentModel=claude-sonnet-5            pending=claude-sonnet-5
t= 1220ms  instanceId=cdvxgskwi                  currentModel=claude-haiku-4-5-20251001  pending=claude-sonnet-5
…
(settled, ~8s)  header chip "Claude · Haiku 4.5"  composer chip "Claude · Sonnet 5"  instance.currentModel=claude-haiku-4-5-20251001
```

Screenshot `lt595-stale-composer-picker.png` shows both pickers disagreeing in one frame, with the
`HAZEL` reply on screen. Navigating to another thread and back repairs the label, which also rules
out the occluded-window artefact the runbook warns about: the component's own signal genuinely
holds the old model.

Filed as **LT-595** with root cause and acceptance in the remediation register.

### Check 3 — different provider and reasoning, loop panel — PASS

On the Claude entry `2206e2b0…`, the Codex rail was opened and **GPT-5.6 Terra** selected with the
row's reasoning `<select>` set to **Low**:

```
chip    : "Codex · GPT-5.6 Terra · Thinking: Low ▾"
status  : "Will use GPT-5.6 Terra when resumed"
pending : {"provider":"codex","model":"gpt-5.6-terra","reasoning":"low"}
historyPreviewComposerProvider() : "codex"      (entry's own provider is claude)
```

**Loop default follows the pending choice.** Arming the loop on this *Claude* entry gave
`LoopConfigPanelComponent.defaultProvider() === 'codex'` and `provider() === 'codex'`.

**An explicit advanced override stays intentional.** Setting the Advanced ▸ Provider select to
`claude` and then changing the pending pick to GPT-5.6 Luna left
`defaultProvider() === 'codex'` but `provider() === 'claude'` and the select still reading
`claude` — the manual override wins and is not re-defaulted.

**Same-session continuation uses the confirmed restored runtime.** Loop
`loop-1789954048863-2cb2a97e`, `contextStrategy: "same-session"`, `provider: "codex"`,
`caps.maxIterations: 1`:

```
1789954044805  HistoryRestoreCoordinator      History restore complete  entryId=2206e2b0-… instanceId=chlffzuir
1789954044807  RuntimeReconciler              Applying runtime change   oldProvider=claude oldModel=opus[1m]
                                              targetProvider=codex newModel=gpt-5.6-luna
1789954045687  RuntimeReconciler              Runtime change applied    newModel=gpt-5.6-luna provider=codex
1789954048862  LoopExistingSessionContext     Attached existing session context to loop start  chatId=chlffzuir
```

The restored instance's transcript shows the confirmed swap and then the loop's first user
message, in that order:

```
system    : [System: Provider changed from claude (model opus[1m]) to codex (model gpt-5.6-luna). …]
user      : Reply with exactly the word DELTA and stop.
```

That first iteration then parked: `LoopProviderLimitHandler — Loop parked on provider limit`,
`resumeAt 1790425140000`, `source quota`. That resumeAt is byte-identical to the live Codex
snapshot's `codex.weekly` `resetsAt` (96/100 requests used), so the park is a genuine quota
condition of this machine, **not** a defect of this feature. The run was cancelled
(`Loop terminated … user cancelled`).

**Fresh-child mode uses the loop's explicit provider config.** On entry `1d614a39…` with pending
`codex/gpt-5.6-terra`, the loop was configured `contextStrategy: fresh-child`, Advanced ▸ Provider
`claude`, 1 iteration, verify `true`:

```
1789954211620  RuntimeReconciler   Applying runtime change  instanceId=x0w29sl0v oldModel=gpt-5.6-luna newModel=gpt-5.6-terra
1789954211850  RuntimeReconciler   Runtime change applied   newModel=gpt-5.6-terra provider=codex
1789954218873  LoopExistingSessionContext  Attached existing session context  chatId=x0w29sl0v
1789954218946  DefaultInvokers     Routed invocation model  intent=loop provider=claude model=sonnet
1789954219021  ClaudeCliAdapter    YOLO mode enabled for Claude CLI instance  model=sonnet
1789954229684  DefaultInvokers     Routed invocation model  intent=loop provider=claude model=sonnet
1789954248779  LoopCoordinator     Loop terminated  status=cap-reached  after 1 iteration(s)
```

So the restored session carried the pending codex/terra runtime while every loop iteration ran on
the loop's explicitly configured `claude` — the two are correctly independent.

### Check 4 — edited resend — PASS

Entry `9fe36fb4…` (claude `opus[1m]`), pending choice set to **Sonnet 5**
(`Will use Sonnet 5 when resumed`). The last user message's *Edit and resend* control was used and
the text edited to include `Reply with exactly the word FOXTROT and nothing else.`, then **Resend**
clicked.

```
source (superseded) ci9lrq101 : provider=claude  model=claude-sonnet-5  reasoning=high
fork                cwax4tb8f : provider=claude  model=claude-sonnet-5  reasoning=high
fork transcript:
  user      : "…GORSE…Reply with exactly the word FOXTROT and nothing else."   (1 user message)
  assistant : "FOXTROT"
```

- **Runtime settings preserved.** The entry closed on `opus[1m]`; the pending pick was Sonnet 5;
  both the restored source and the fork carry `claude-sonnet-5` with reasoning `high`.
- **Edited prompt received exactly once.** One user message in the fork; one occurrence of the
  edited text; no duplicate delivery.

Harness note, not a product finding: the `Cmd+A` select-all sent into the inline-edit textarea did
not replace the existing text, so the edited prompt was the old text plus the new sentence. That
changes nothing about the assertions — it is still a single edited prompt delivered once.

### Check 5 — live-session model change feedback — PASS

**Applying, then Switched only after confirmation.** On idle session `cwax4tb8f`
(`claude-sonnet-5`), selecting **Haiku 4.5** in the composer picker; status text sampled every
100 ms:

```
t=   0ms  status=null                      chip="Claude · Sonnet 5 …"
t= 100ms  status="Applying model change…"  chip="Claude · Haiku 4.5 · Thinking: High"
t=1100ms  status="Switched to Haiku 4.5"   chip="Claude · Haiku 4.5 · Thinking: Provider default"
```

Backend after: `claude` / `claude-haiku-4-5-20251001`, `desiredRuntime: null`.

**Queued while busy.** A long generation was started so the session was genuinely `busy`, then
**Sonnet 4.5** was selected:

```
t= 100ms  status="Model change queued until the session is ready"
queued chip: "⏳ Claude · claude-sonnet-4-5-20250929 ✕"
             title "Will switch to Claude · claude-sonnet-4-5-20250929 when the current turn finishes. Click to cancel."
instance   : model still claude-haiku-4-5-20251001, status busy,
             desiredRuntime {model: claude-sonnet-4-5-20250929, provider: claude, reasoningEffort: high}
```

No false "Switched" appeared. Screenshot `check5-queued-while-busy.png`.

**Rejected choice errors with no success pill.** On a fresh idle session `cuswy3z38`
(`claude` / `opus[1m]`), an unavailable provider was emitted through the picker's real
`(selectionChange)` handler — `gemini` is a valid `CliType` deliberately excluded from
`SUPPORTED_CLIS`, which the campaign runbook names as the guaranteed local refusal, and the picker
rail does not offer it, so the component's own output handler is the faithful entry point:

```
toast (.toast-stack .toast-item, toast-error):
  "Cannot switch provider: the Google Gemini (legacy) CLI is not installed or not available."
status pill        : null   (no "Switched"/"accepted" observed at any sample)
chip after rollback: "Claude · Opus latest, 1M · Thinking: Provider default"
instance           : claude / opus[1m] / desiredRuntime null  (unchanged)
```

Screenshot `check5-rejected-choice.png`.

Side observation, out of scope and not filed: selecting a **Copilot** model on this machine is
accepted and queued rather than refused, and the session then sits in `initializing`
indefinitely because no Copilot account is signed in here (the app's own startup banner says so).
That is Copilot auth behaviour, not closed-session model selection.

### Check 6 — recording and cleanup — PASS

Build identity is in the table at the top of this run. Runtime model/provider evidence was taken
from `listInstances()` payloads and `RuntimeReconciler` log lines rather than by asking a model to
identify itself, as the checks require. Screenshots contain only one-word probe transcripts
(`ACORN`, `BIRCH`, `CEDAR`, `DELTA`, `ECHO`, `GORSE`, `FOXTROT`, `HAZEL`) and no sensitive content.

Cleanup performed: every instance created by this run was terminated, the parked loop was
cancelled, no settings were changed, the dev app was stopped, and `/tmp/aio-lt-queue-82b54a87` and
`/tmp/aio-lt-queue-82b54a87-ws` were removed. Nothing outside the disposable profile was touched —
in particular the packaged app and James's real sessions were never driven.

### Residual

Check 2 stays open behind **LT-595**. Re-run check 2 only (open a closed entry, pick a different
model, type, send, then read the composer picker against `instance.currentModel`) once that is
fixed; the other five checks are evidenced above and do not need repeating unless the feature
changes.

The feature's own focused specs are green on this checkout and do **not** catch LT-595 —
`npm run test:quiet -- history-preview-session.service.spec.ts
instance-detail-history-preview-restore.spec.ts composer-toolbar-model-feedback.spec.ts`
→ 3 files / 34 tests passed in 5.7s. The missing coverage is the preview-to-live handoff with a
one-tick-stale store, which is what LT-595's acceptance asks for. No source file was changed by
this run.

## Earlier evidence

## Evidence run — 2026-09-24 (resume batch)

**Result: check 2 PASS. LT-595 CONFIRMED FIXED LIVE.**

### Environment

| Item | Value |
| --- | --- |
| Checkout | root checkout, HEAD `f04f6748` (campaign's shared pre-built `dist/main`/renderer) |
| Dev app | `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-0924-resume npx electron . --remote-debugging-port=9711` |
| Renderer | shared campaign renderer on `:4567` |
| Provider | `claude`, real turns, workspace `/tmp/aio-lt-0924-resume-work/lt595-ws` |
| Disposable fixture | one closed entry created and archived for this run: `6966c78a-305d-4a2c-b2c3-03f521f5643b` (`claude` / `claude-sonnet-5`, first prompt "Reply with exactly the word MAPLE and nothing else.") |

### Check 2 — type, change model, send — **PASS**

Opened the closed entry's preview via `InstanceListComponent.onPreviewHistory(entryId)` (the real
method the History rail's preview click invokes), then drove the actual application methods rather
than raw DOM events, since they are the real code path under test:

1. `InstanceDetailComponent.onHistoryPreviewDraftStarted()` — the method the composer calls on the
   first keystroke — warmed a background restore. `listInstances()` showed exactly one new instance
   (`cqp1ru96g`) on `claude-sonnet-5`, the entry's own model, with the draft pick not yet applied —
   correct per the check ("a warm restore must not release a draft pick").
2. `ComposerToolbarComponent.onPickerSelectionChange({provider:'claude', model:'claude-haiku-4-5-20251001', reasoning:null})`
   — the exact handler the picker's `(selectionChange)` output invokes — set the pending pick.
   `selectionStatus()` read `"Will use Haiku 4.5 when resumed"`.
3. `InstanceDetailComponent.onHistoryPreviewSendMessage('Reply with exactly the word CEDAR2 and nothing else.')`
   sent the prompt through the real preview-send path (`ensureHistoryPreviewRestored(true)` →
   `HistoryPreviewSessionService.prepare()` → `applySelection()` → `sendInput`).

Backend ordering, from the settled instance's own `outputBuffer`:

```
"Reply with exactly the word MAPLE and nothing else."   (original entry's first message, replayed)
"MAPLE"
[System: Model changed from claude-sonnet-5 to claude-haiku-4-5-20251001. Thinking changed from
 high to provider default. Conversation context has been preserved.]
"MAPLE"                                                  (native-resume replay)
"Reply with exactly the word CEDAR2 and nothing else."   (the new prompt)
"CEDAR2"
```

The model-change system message is recorded and settled **before** the new prompt runs, and the
reply confirms the swapped model executed it.

**Both pickers agree with backend truth after settling** (read well after `status: 'idle'`, not a
race sample):

```json
{
  "selectedId": "cqp1ru96g",
  "instance.currentModel": "claude-haiku-4-5-20251001",
  "composer ComposerToolbarComponent.currentModel() input": "claude-haiku-4-5-20251001",
  "composer pickerSelection()": { "provider": "claude", "model": "claude-haiku-4-5-20251001", "reasoning": "high" },
  "every .compact-picker__chip on the page": ["Claude · Haiku 4.5 · Thinking: High ▾", "Claude · Haiku 4.5 · Thinking: High ▾"]
}
```

Both rendered chips (composer and header — same `CompactModelPickerComponent`, two mount points) read
**Claude · Haiku 4.5**, matching `instance.currentModel`. This directly reverses the 2026-09-21
finding (`header chip "Claude · Haiku 4.5" composer chip "Claude · Sonnet 5"`).

The fix is `HistoryPreviewSessionService.confirmedByInstance`
(`history-preview-session.service.ts:34-38, 44-60, 204-208`): `applySelection()` records the
validated before/after runtime keyed by `instanceId` the moment the backend confirms a model change,
and `ComposerToolbarComponent`'s hydration effect
(`composer-toolbar.component.ts:284-285`) consults `confirmedSelectionForInstance(instanceId,
provider, currentModel)` ahead of the plain `currentModel` input, so a one-tick-stale intermediate
render during the preview→live handoff can no longer win.

### Cleanup

Instance `cqp1ru96g` was terminated; the History sidebar was closed. No settings were changed. The
disposable workspace is removed with the rest of this batch's `/tmp` state.

### Residual

None. All six checks pass with current evidence. This document is a candidate for
`_livetest_completed` rename.

---

### Rebuilt-app follow-up — 2026-09-05 evening

- James reports rebuilding and restarting. Filesystem check found renderer output updated at
  21:19:22 local time and `dist/main/index.js` at 21:19:43; the compiled renderer contains
  the pending “when resumed” feedback. This establishes build presence, not a successful provider turn.
- Previously failing provider-swap/settings tests now pass: 2 files / 36 tests, exit 0,
  `_scratch/test-run.pid-45738.log`.
- Browser Gateway health reports `windows-pc` ready. Its refreshed shared-tab inventory has no
  Harness test page; the old test target is currently marked secret-filled. No evaluation, navigation,
  or retry against that target was attempted, and no local fallback was used.
- James's Computer Use instructions prohibit controlling Harness itself. Requested confirmation
  that a closed-session pick displays pending feedback without an error and that the next message
  resumes using the chosen model. Awaiting that result; the live checklist remains unchecked.

> Plan Queue parked work: `queue/2026-09-05-history-preview-mod-b54a87` — 2 commit(s), reason: land-blocked.
