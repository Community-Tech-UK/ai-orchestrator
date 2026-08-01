# YOLO-mode reconciler migration — live test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [`2026-07-17-yolo-mode-reconciler-migration-plan_completed.md`](2026-07-17-yolo-mode-reconciler-migration-plan_completed.md)
**Prerequisites:** rebuilt + restarted app (renderer and main both changed). Any local instance works; one Claude instance is needed for check 3.

All agent-runnable verification (integration spec `src/main/instance/__tests__/instance-manager.yolo-mode.spec.ts`, full quiet suite, tsc ×2, lint, LOC) already passed on 2026-07-17. The checks below are the renderer-visual behaviors that need the real UI.

## Checks

1. **Idle toggle round-trip.** On an idle instance, click the YOLO toggle in the header.
   - Expected: session respawns, transcript shows `[System: YOLO mode enabled - tool permissions are now pre-configured for this mode.]`, the YOLO indicator lights up, and NO "Provider · default model" pending chip ever appears.
2. **Busy queue + pending indicator.** Send a long-running prompt, then click the YOLO toggle while the instance is busy.
   - Expected: toggle shows the *pending* state immediately (no respawn yet); when the turn completes and the instance settles, the toggle auto-applies (respawn + system notice) and the pending state clears without a further click.
3. **Claude context survival on pure toggle.** On a Claude instance with a few turns of conversation, toggle YOLO while idle, then ask "what were we just talking about?".
   - Expected: the session native-resumes (no replay preamble in the transcript, same conversation recalled) — regression guard for the planContinuity replay rule not applying to yolo-only changes.
4. **Queued model change + queued yolo flip land together.** While busy, queue a yolo toggle AND pick a different model from the model picker.
   - Expected: the pending chip shows the model change (chip must NOT be shown for the yolo part alone), and on settle ONE respawn applies both — transcript shows the model-change notice AND the yolo notice.
5. **Chats-surface setYolo.** From the chats surface, flip yolo for a bound session (ChatService.setYolo path).
   - Expected: same behavior as before the migration (applies when idle; while busy the chat surface falls back to its local flag flip exactly as today).

Rename this file `_livetest_completed.md` only when every check passes with evidence.

---

## Evidence run — 2026-07-26 — **checks 1 and 3 FAIL, reproducibly. Root cause found.**

**Setup.** Dev app rebuilt from the working tree and launched with `--remote-debugging-port=9444`;
the renderer's real `window.electronAPI` IPC was driven over CDP. Real Claude instance
`cb7mppxzv` (`opus[1m]`) in the disposable workspace `/tmp/aio-lt-yolo`, created with
`yoloMode: false` and given two real turns of conversation
(`amber-lantern-742`, `violet-harbour-19`) before any toggle.

### Check 1 — idle toggle round-trip — ❌ FAIL (2 of 2 trials)

`toggleYoloMode({ instanceId, enabled: true })` on an **idle** instance returned:

```json
{ "success": false, "error": { "code": "TOGGLE_YOLO_MODE_FAILED",
                               "message": "Illegal transition: error → busy" } }
```

The instance did not respawn cleanly; it was SIGTERM'd into `error`, and was only rescued ~45 s
later by the generic `process_exited_unexpected` recovery recipe. No
`[System: YOLO mode enabled …]` notice ever appeared in the transcript. Toggling back **off**
reproduced it identically (trial 2).

Log chain (trial 2, unrelated lines removed):

```
11:28:53.201 RuntimeReconciler:  Applying runtime change { oldModel: opus[1m], newModel: opus[1m] }
11:28:54.722 ClaudeCliAdapter:   Skipping --resume: no transcript for session under current cwd
                                 { sessionId: "a7e39d2e-…", cwd: "/tmp/aio-lt-yolo" }
11:28:54.724 RuntimeReconciler:  Failed to spawn with resume, falling back to fresh session
                                 { error: "Native resume did not stabilize after model change" }
11:28:54.724 InstanceCommunication: Adapter exit event { signal: "SIGTERM" }
11:28:54.724 InstanceCommunication: Instance exited unexpectedly { newStatus: "error" }
11:28:54.948 InstanceLifecycle:  Illegal lifecycle transition blocked { from: "error", to: "busy" }
11:28:54.948 RuntimeReconciler:  Failed to apply runtime change
```

### Root cause — the fork-resume path resumes an id that has never existed

`src/main/instance/lifecycle/runtime-reconciler.ts`:

1. **194-206.** A yolo-only change on a conversation-bearing Claude session resolves to
   `continuity = 'native-resume-fork'` (Claude reports `supportsForkSession`), so
   `shouldResume = true` **and** `shouldForkSession = true`.
2. **238-241.** For the fork branch the reconciler mints the target id *itself* and overwrites the
   instance with it **before** spawning:
   ```ts
   const newSessionId = shouldResume && shouldForkSession
     ? generateId()                                  // ← brand-new id
     : (shouldResume ? instance.sessionId : generateId());
   instance.sessionId = newSessionId;
   ```
3. **265.** That new id is passed as `spawnOptions.sessionId`, with `resume: true, forkSession: true`.
4. `claude-cli-adapter.ts:1064-1069` builds `--resume <this.sessionId> --fork-session`, i.e. it
   treats `spawnOptions.sessionId` as the **source** to resume from. There is no separate
   source-id field — `UnifiedSpawnOptions` carries only `forkSession?: boolean`.
5. So the adapter is asked to resume an id the CLI has never minted. `shouldUseNativeResume()`
   finds no transcript for it under the cwd, logs `Skipping --resume: no transcript…`, and spawns
   **without** `--resume`.
6. With no resume attempted, no session-id echo arrives, so `waitForResumeHealth` is false →
   `runtime-reconciler.ts:301` throws → `adapter.terminate(true)` → `error` → the toggle IPC fails
   → a *third* fresh session replays the history.

**Direction of fix:** pass the **existing** `instance.sessionId` as the resume source for the fork
case and let the CLI mint the forked id — the adapter already "adopts the authoritative one from
the init message" (`claude-cli-adapter.ts:1080-1084`). The reconciler should not pre-generate the
target id for a fork.

**Secondary hazard, same file, worth fixing together.** The runtime-change path uses the boolean
`waitForResumeHealth` (line 301), where an `inconclusive` verdict collapses to `false` and destroys
the session. The recovery path deliberately does **not** do that —
`resolveRecoveryResumeHealth` (line 488) retries once and then *keeps* the live session, with the
comment "Tearing it down is exactly what previously lost the live thread and in-flight background
agents on 'resume failed'." The runtime-change path is still exposed to the hazard the recovery
path was hardened against.

### Check 3 — Claude context survival on a pure toggle — ❌ FAIL

This is the check written as the "regression guard for the planContinuity replay rule not applying
to yolo-only changes", and that regression is exactly what happens. The provider session id changed
on **every** toggle — `0fd999dd… → a9d33453… → 3d359928… → 12e02cae…` — i.e. replay fallback, never
native resume. The user-visible symptom is worse than a silent replay: the replayed preamble made
the model volunteer an unprompted turn, twice, e.g.

> "the recovery packet says the previous provider session couldn't be resumed, so any background
> work from before no longer exists…"

(Conversation *content* did survive, via replay — both markers were still recalled — but that is the
fallback the check is designed to detect, not a pass.)

### Check 2 — busy queue + pending indicator — ◐ the queueing half PASSES, the apply inherits the bug

With the instance **busy** on a long generation, `toggleYoloMode` returned `success: true`, did
**not** respawn (`status: busy`, `yoloMode: false`, pid unchanged `10821`), and recorded the pending
state on the instance:

```json
"desiredRuntime": { "provider": "claude", "yoloMode": true }
```

On settle the change **did** auto-apply with no further click — `desiredRuntime` cleared to `null`
and `yoloMode` became `true`. So the queue/apply-on-settle mechanism works. But the apply ran the
same broken fork path (`adapterGeneration` 7 → 9, session `3d359928… → 12e02cae…`), so it was a
replay fallback again rather than the clean respawn + system notice the check expects.

### Checks 4 and 5 — NOT RUN

Both were blocked behind the above: check 4 (queued model change + queued yolo landing together in
one respawn) cannot be judged while every yolo apply already destroys the session, and check 5
(chats-surface `setYolo`) needs the chats surface driven, which was not reached this session.

**Status: checks 1 and 3 FAIL with a root cause; check 2 partial; 4 and 5 not run. NOT renamed.**
This doc is now blocked on a **code fix**, not on more testing.

---

## Evidence run — 2026-07-27 — **checks 1 and 3 now PASS after the LT-008 fix**

**Setup.** Dev app rebuilt from the working tree (`npm run build:main`, which itself had to be
repaired first — see LT-012) and relaunched with `--remote-debugging-port=9444`. Real Claude
instance `cgne99dlp` (`opus[1m]`) in the disposable workspace `/tmp/aio-lt27-yolo`, created with
`yoloMode: false` and given one real turn of conversation ("BANANA") before any toggle.

### What was actually wrong (three defects, not one)

The 2026-07-26 root cause was correct but incomplete. Fixing only the resume *source* id was not
enough — the first re-run reproduced the failure identically. Driving it again with the fix in
place isolated two further causes:

1. **Resume source id** (`runtime-reconciler.ts`) — the fork's target id was minted locally and
   passed as the resume source. Fixed: pass `instance.sessionId`, let the CLI mint the fork.
2. **A fork can never be proven healthy.** `claude-cli-adapter.ts` set
   `confirmed = (session_id === requestedSessionId)`, and `runtime-readiness.ts:getResumeProof`
   returned `false` on any id mismatch. A `--fork-session` resume returns a **different** id *by
   definition*, so the proof was guaranteed to fail → `unrecoverable` → teardown. Fixed with a
   `forked` flag on `ResumeAttemptResult`: a fork is confirmed by receiving any authoritative
   `session_id`, and the mismatch rule is skipped for forks.
3. **Fresh-fallback did not strip listeners before terminating.** The doomed resume adapter's
   SIGTERM exit (code 143) was handled as a real instance exit → `error`, and the follow-up
   `sendInput` then died on `Illegal transition: error → busy`. `applyRecoveryRespawn` has always
   removed listeners first; `applyRuntimeChange` and `changeAgentMode` never did.

### Check 1 — idle toggle round-trip — ✅ PASS

```json
{ "toggleSuccess": true, "toggleError": null, "toggleMs": 2039,
  "beforeStatus": "idle",  "beforeSession": "b9bcc015-3000-4d47-95d6-4133ffe44d1d",
  "afterStatus":  "busy",  "afterSession":  "8ce46d32-665d-4c89-ab84-d6c4cc010519",
  "afterYolo": true, "afterBufLen": 2 }
```

The instance never entered `error`, the conversation buffer was preserved, and the session id
advanced to the CLI-minted forked id. Main-process record:

```
[RuntimeReconciler] Runtime change applied
  { instanceId: 'cgne99dlp', pid: 629, newModel: 'opus[1m]',
    provider: 'claude', reasoningEffort: 'high', continuity: 'native-resume-fork' }
```

Across the whole run the destructive markers occur **0 times each**:
`Failed to spawn with resume` = 0, `not stabilize` = 0, `Illegal transition` = 0,
and `ERROR` lines mentioning `cgne99dlp` = 0.

### Check 3 — Claude context survival on pure toggle — ✅ PASS

After the toggle, asking *"What single word did you reply with earlier? Answer with just that
word."* returned:

```json
{ "status": "idle", "sessionId": "3500972c-59a1-46ba-95f8-4688289848df",
  "newAssistant": ["BANANA"] }
```

The pre-toggle conversation is recalled from the provider side, with `continuity:
'native-resume-fork'` and no fallback path taken — which is precisely what check 3 asks for.

### Checks 2, 4, 5 — not run this session

2 (busy queue + pending indicator), 4 (queued model change + queued yolo flip landing together)
and 5 (chats-surface `setYolo`) all assert on **renderer** state (pending chip, toggle pending
style, transcript rendering). The `ng serve` backing this dev app dates from 2026-07-25, so
renderer-side conclusions would be provisional; and the pending-chip assertions are UI-only, with
no main-process signal to read. They need a run with a current renderer bundle.

**Status: 2 of 5 checks pass (the two that were failing). Not renamed** — checks 2, 4 and 5 remain
unevidenced.

---

## Evidence run — 2026-07-27 (session 2) — **checks 2, 4, 5 driven against a current renderer**

The previous run deferred these three because its `ng serve` was two days old. That server was
restarted first (36 renderer files had changed since it started), so the renderer assertions below
are against a bundle rebuilt this session. Dev app rebuilt from the working tree, driven over
`--remote-debugging-port=9444`; the header's real computed signals were read via
`ng.getComponent(document.querySelector('app-instance-header'))`, and the transcript via
`app-output-stream`'s own `messages()` — not the main-process buffer.

Instance `c5o9hpdx5` (`claude`, `opus[1m]`) in `/tmp/aio-lt28-yolo`, created with `yoloMode: false`.

### Check 2 — busy queue + pending indicator — ◐ every mechanism passes; the transcript notice does not

Toggled YOLO **while busy** on a long generation:

```json
{ "toggleOk": true, "status": "busy", "pid": 74966, "yoloMode": false,
  "desiredRuntime": { "provider": "claude", "yoloMode": true },
  "headerYoloPending": true, "headerChipLabel": null }
```

- The toggle showed the **pending state immediately** — `yoloPending()` true — with **no respawn**
  (pid unchanged, still `busy`, `yoloMode` still false). ✅
- `desiredRuntimeLabel()` was correctly `null`: a yolo-only queued change must not render a
  misleading "Provider · default model" chip. ✅
- On settle it **auto-applied with no further click**: `yoloMode: true`, `desiredRuntime: null`,
  pid `74966 → 88429` (one respawn), and the pending state cleared (`yoloPending()` false). ✅

The one failing assertion is the system notice — see **LT-015**. It is not in the rendered
transcript, though the session confirmed receiving it. Everything this check exists to prove about
queueing, the pending indicator and apply-on-settle holds.

### Check 4 — queued model change + queued yolo flip land together — ◐ same shape

While busy, queued **both** a yolo flip (on → off) and a model change (`opus[1m] → sonnet`):

```json
{ "status": "busy", "pid": 88429, "yoloMode": true, "model": "opus[1m]",
  "desiredRuntime": { "model": "sonnet", "provider": "claude", "yoloMode": false },
  "headerYoloPending": true, "headerChipLabel": "Claude · sonnet" }
```

- The pending chip **does** show the model change (`"Claude · sonnet"`), where the yolo-only case
  above correctly showed none — exactly the distinction this check is written to catch. ✅
- On settle, **one** respawn applied both: `adapterGeneration` `2 → 3` (a single increment),
  pid `88429 → 40849`, ending `yoloMode: false`, `model: "sonnet"`, `desiredRuntime: null`,
  pending cleared. ✅
- Both notices reached the model — it volunteered *"model switched to Sonnet and YOLO mode is off,
  so tool calls will need your approval going forward"* — but neither is rendered (**LT-015**).

### Check 5 — chats-surface `setYolo` — ✅ PASS

Chat `2bccf292-…` in the same cwd, bound to instance `csgqj02v3` by a real `chatSendMessage`.

**Idle half** — `chatSetYolo({ yolo: true })` on an idle bound session applied through the normal
path: pid `99539 → 313` (respawn), instance `yoloMode: true`, chat record `yolo: true`, status back
to `idle`, no error.

**Busy half** — started a long turn, then `chatSetYolo({ yolo: false })`:

```json
{ "ok": true, "duringStatus": "busy", "duringPid": 313, "duringYolo": false,
  "duringDesiredRuntime": null, "chatYolo": false }
```

No respawn (pid unchanged), no queued `desiredRuntime` — the flag was flipped in place, which is the
documented chat-surface fallback, confirmed by the one and only log line it emits:

```
ChatService | Could not respawn instance for chat YOLO change; updated flag in place
  { chatId: '2bccf292-…', instanceId: 'csgqj02v3', yolo: false,
    error: 'Model changes are only available while the instance is waiting for user input.
            Current status: busy.' }
```

That is "applies when idle; while busy the chat surface falls back to its local flag flip exactly as
today" — what the check asks for.

### Correction to check 1's 2026-07-27 (session 1) result

Session 1 marked check 1 PASS on its session-continuity evidence, which genuinely holds. It did not
evidence check 1's other assertion — that the transcript shows the `[System: YOLO mode enabled …]`
notice. That assertion does **not** hold (LT-015), so check 1 is **partial**, not clean.

**Status: check 5 passes; checks 2 and 4 pass every mechanism assertion and fail only the shared
LT-015 transcript-notice assertion; checks 1 and 3 unchanged from session 1 (1 now partial).
NOT renamed** — 4 of 5 checks depend on the LT-015 decision.

## Triage — 2026-07-29

Not run this session. Classified during the campaign sweep and recorded here so the next runner does
not re-derive it. Full context: `docs/plans/2026-07-29-livetest-backlog-status-report.md`.

Checks 1, 3, 5 PASS; checks 2 and 4 pass every mechanism assertion but fail on the transcript notice. Those two are **blocked on the LT-015 decision**, not on testing. Nothing further to run until that is settled.

## 2026-07-30 — LT-015 is FIXED; checks 1, 2 and 4 are unblocked

The blocker on these checks was never the feature — it was that the notices went out via
`adapter.sendInput`, which reaches the CLI but renders nothing, so the transcript assertion could
not pass against working code.

Runtime-change notices are now **delivered to the CLI and recorded as `system` transcript entries**
(`src/main/instance/lifecycle/runtime-change-notices.ts` → `announceRuntimeChange`). The transcript
write is best-effort and happens after delivery, so a render failure can never reverse a runtime
change that has already been applied.

**These checks can now be run as originally written.** Expect
`[System: YOLO mode enabled - tool permissions are now pre-configured for this mode.]` (or the
`disabled` variant) to appear as a `system` entry in the instance's `outputBuffer` and in the
rendered transcript.

Two things for whoever runs them:

- **Requires a rebuild.** `npm run build:main` was run at 2026-07-30 00:32 and the new module is
  confirmed present in `dist/main/instance/lifecycle/runtime-change-notices.js`, but the packaged
  app James is running predates it.
- **Match the full notice text, and check `type === 'system'`.** The 2026-07-27 session recorded the
  trap: searching the transcript for "YOLO mode enabled" matches the *probe question* containing
  that phrase. Notices now carry `metadata.kind = 'yolo-mode-changed'`, which is the unambiguous
  thing to assert on.

Check 1's session-continuity substance already passed on 2026-07-27; only its notice sub-assertion
was outstanding, so this should move it from partial to clean.

## Evidence run — 2026-07-31 — **all five checks PASS; doc closed**

**Setup.** `npm run build:main` exit 0 at 19:22, renderer served on :4567, dev app launched with
`--remote-debugging-port=9444`, real `window.electronAPI` driven over CDP. Real Claude instance
`co56971gw` in `/tmp/aio-lt31-yolo`, created `yoloMode: false`, model `opus[1m]`, given a real turn
first (marker `ZINNIA31`). Check 5 used a separate chat-bound instance `ci1ib229l`.

### Check 1 — idle toggle round-trip — ✅ PASS

`toggleYoloMode({ enabled: true })` on the idle, conversation-bearing instance returned
`success: true` — no `Illegal transition: error → busy`, which is what failed on 2026-07-26.

| | Before | After |
| --- | --- | --- |
| `yoloMode` | `false` | `true` |
| `adapterGeneration` | 1 | 2 (one respawn) |
| `providerSessionId` | `3bd95454-…` | `73c3291f-…` (fork, by design) |
| status | `idle` | `busy` → `idle` in 5 s |

Transcript entry, read from the instance's `outputBuffer`:

```json
{ "type": "system", "metadata": { "kind": "yolo-mode-changed" },
  "content": "[System: YOLO mode enabled - tool permissions are now pre-configured for this mode.]" }
```

Exact text, `type === 'system'`, unambiguous `metadata.kind` — the LT-015 assertion that could not
pass before. **No pending chip appeared**: `desiredRuntime` was never populated (the change applied
straight away at idle), and `desiredRuntimeLabel` returns `null` for a yolo-only queued change by
construction (`instance-header.component.ts:370-376`).

### Check 2 — busy queue + pending indicator — ✅ PASS

Sent a 900-word essay prompt, confirmed `status: 'busy'`, then toggled YOLO off mid-turn.

| Moment | `yoloMode` | `adapterGeneration` | `desiredRuntime` |
| --- | --- | --- | --- |
| during the turn, just after the toggle | `true` (unchanged) | 2 (no respawn) | `{provider:'claude', yoloMode:false}` |
| held for 6 consecutive polls while busy | `true` | 2 | unchanged |
| after settle | `false` | 3 | `null` (cleared) |

So: pending state immediately, no respawn while busy, then a single auto-apply on settle with **no
further click**, and the `[System: YOLO mode disabled - tool permissions will now require approval.]`
notice recorded with `kind: 'yolo-mode-changed'`. `yoloPending()` is true in that window while
`desiredRuntimeLabel()` is null — the pending affordance without the misleading model chip.

### Check 3 — Claude context survival on pure toggle — ✅ PASS (re-verified on this build)

Toggled YOLO at idle (gen 4 → 5), then asked which word was requested at the very start.

- Answer: **`ZINNIA31`** — the marker from before four separate respawns.
- **No replay preamble**: no "previous conversation" / "carried over" / "replay" text anywhere in the
  new messages; the only system entry is the yolo notice itself.
- `providerSessionId` changes (`e14e53f8-…` → `f631de8b-…`) — expected for a fork-resume, not a
  replay; see the LT-008 fork-resume note.

### Check 4 — queued model change + queued yolo flip land together — ✅ PASS

While busy on a second essay, queued `toggleYoloMode({enabled:true})` **and**
`changeModel({model:'sonnet'})`.

- Queued state: `desiredRuntime = {model:'sonnet', provider:'claude', yoloMode:true}` while the live
  instance still read `yoloMode:false`, `currentModel:'opus[1m]'`, gen 3. Because `model` is defined,
  `desiredRuntimeLabel` renders the **model** change (`Claude · sonnet`) rather than the
  "default model" chip — which is exactly what the check requires.
- **One respawn, not two**: generations observed across the whole settle window were `[3, 4]`.
- Both notices landed, in order:

```
system  kind=model-changed      [System: Model changed from opus[1m] to sonnet. Thinking changed
                                 from high to high. Conversation context has been preserved.]
system  kind=yolo-mode-changed  [System: YOLO mode enabled - tool permissions are now
                                 pre-configured for this mode.]
```

- Final state: `yoloMode:true`, `currentModel:'sonnet'`, gen 4, `desiredRuntime: null`.

### Check 5 — chats-surface setYolo — ✅ PASS (re-verified on this build)

Created chat `8475b3b9-…` (`currentCwd: /tmp/aio-lt31-yolo`, provider claude), sent a real message
(marker `HALYARD5`), which bound instance `ci1ib229l`. `chatSetYolo({yolo:true})` on the now-idle
instance returned `success: true` and applied: `yoloMode` `false → true`, `adapterGeneration` 1 → 2,
with the `yolo-mode-changed` system notice recorded. Same behaviour as before the migration
(`chat-service.ts:337-370` still routes through `instanceManager.setYoloMode` and keeps its
flag-flip fallback for the busy case).

**Status: 5 of 5 checks PASS. Renamed `_livetest_completed.md`.**
