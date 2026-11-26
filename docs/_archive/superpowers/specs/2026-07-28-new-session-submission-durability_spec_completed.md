# New-session submission durability — spec

Status: COMPLETED — implemented, tested, and gated 2026-08-19 (fresh-eyes completion gate pass 3
clean; see the plan's as-built §5 for full verification). Implementation plan:
[2026-07-28-new-session-submission-durability_plan_completed.md](../../plans/2026-07-28-new-session-submission-durability_plan_completed.md)

Date: 2026-07-28
Trigger: data-loss incident, 28 July 2026, Community Tech folder — a long prompt with 5+ screenshots
was composed into the new-session composer, appeared to submit, and vanished with no session, no
prompt-history entry and no main-process record of any kind.

---

## 1. Incident forensics

Evidence read (all under `~/Library/Application Support/harness/`):

| Source | Finding |
|---|---|
| `logs/app.log` 09:30–11:20 UTC | Four `InstanceLifecycle \| Creating instance` events only: `xpg8rs8wg` (10:54:54, 115-char prompt), `xborqa7ot` (11:00:00, automation), `x61ttax7m` (11:10:40, the recovery session), `xh9my3y53` (11:14:00, automation). **No creation with a long prompt or a batch of attachments.** |
| `logs/app.log`, error level, 09:30–11:20 UTC | Only `RendererHeartbeat` stall/recover pairs, all `senderId: 1`, 51 stalls and 51 recoveries on an exact 60 s cadence — a monitor artefact, not a freeze. **No renderer reload or crash** (a reload would produce a new `senderId`). |
| `logs/traces.ndjson` 10:30–11:20 UTC | 520 spans, all `provider.runtime_event`. **No IPC or submission spans exist at all** — the submission path is entirely untraced. |
| `Local Storage/leveldb` | `new-session-drafts:v1` → `project:/Users/suas/work/communitytech` has `prompt: ""`, `updatedAt: 1785237041262` = 12:10:41 BST, i.e. 0.8 s after the recovery session was created. The draft was wiped by the recovery launch. Attachments are **not present in any persisted form** — `pendingFilesByKey` is in-memory only. |
| `logs/app.log` `NlWorkflowClassifier` events | Composer typing is observable as debounced classifier calls. Bursts at 10:32:14–10:32:33, 10:54:26–10:54:48, 11:01:36–11:06:19, 11:09:56–11:10:39. |

The recovery session was created at 11:10:40.461 UTC = **12:10:40 BST**, matching the report exactly.

The Fable process that exited with code 143 at 11:09:35 UTC is instance `c2jhcle0u` — an idle session
with 168 archived messages. It is unrelated and is not conflated with the missing composition.

### 1.1 What the absence of records actually proves

Three of the "missing record" observations are **expected behaviour, not evidence of a cause**, and
must not be read as symptoms:

- **No `IPC INSTANCE_SEND_INPUT received`.** The new-session path does not use `INSTANCE_SEND_INPUT`.
  It uses `INSTANCE_CREATE_WITH_MESSAGE`, which carries the first message inline.
- **No `prompt-history:record` entry.** `InputPanelComponent.recordPromptHistory` returns early when
  `isDraftComposer()` is true (`input-panel.component.ts:1742`). New-session prompts are *never*
  recorded in prompt history, successful or not.
- **No `Creating instance` log.** `INSTANCE_CREATE_WITH_MESSAGE` has **no entry log whatsoever**
  (`instance-handlers.ts:116-167`). The first log on that path comes from inside
  `instanceManager.createInstance`. Anything that fails before that point is invisible.

So the forensic signature "nothing at all in the main process" is exactly what a *renderer-side or
validation-side* failure looks like. It does not narrow the cause on its own — the instrumentation
simply cannot distinguish "never sent" from "sent and rejected".

---

## 2. Root cause

### 2.1 Primary defect — the composer is cleared before anything is acknowledged

`InputPanelComponent.onSend()` (`input-panel.component.ts:1288-1308`):

```ts
this.recordPromptHistory(text, false);
this.sendMessage.emit(text);
this.clearSubmittedMessage();   // <-- synchronous
```

Angular's `output().emit()` invokes subscribers synchronously. The subscriber chain is
`instance-welcome.component.ts:157` → `instance-detail.component.ts:1247 onWelcomeSendMessage` →
`welcome-coordinator.service.ts:174 onWelcomeSendMessage`. That coordinator runs
`prepareWelcomeLaunch` (synchronous) and then `await this.store.createInstanceWithMessage(...)`,
which suspends at its own first `await`. Control returns to `onSend`, which immediately runs
`clearSubmittedMessage()`:

```ts
private clearSubmittedMessage(): void {
  this.message.set('');
  ...
  this.clearComposerDraft();   // -> NewSessionDraftService.clearActiveComposer()
}
```

`clearActiveComposer()` (`new-session-draft.service.ts:450-467`) wipes `prompt`, `pendingFolders`,
`agentId` **and `pendingFilesByKey[activeKey]`** — the `File` objects.

The result: **by the time any failure is known, the text and every attachment are already gone.**
There is no snapshot, no journal, no retry. The only surviving copy of the text is the `finalMessage`
captured inside the in-flight promise, which is discarded when that promise resolves to a failure.

Every one of these paths therefore destroys the composition:

| Failure | Where | Reaches main? | Logged in main? |
|---|---|---|---|
| Remote node offline / working dir not on node | `welcome-coordinator.service.ts:341-365` returns `null` | No | No |
| Non-image attachment > 30 MB | `instance-attachments.ts:18` via `validateFiles` | No | No |
| Image still > 5 MB after compression, or image decode failure | `instance-attachments.ts:38-49` throws inside `Promise.all` | No | No |
| **Payload rejected by Zod** | `validateIpcPayload` throws (`common.schemas.ts:25-37`) | Yes | **No** |
| `instanceManager.createInstance` throws | `instance-handlers.ts:156` | Yes | Partially |

### 2.2 Contributing defect — every failure is silent

The renderer reports all of these through `InstanceStore.setError(...)`
(`instance-state.service.ts:56`, exposed at `instance.store.ts:86`).

**No template in the renderer renders `InstanceStore.error`.** A repo-wide search for `error()` in
`src/renderer/**/*.html` returns zero bindings to the instance store's error signal. The user is
shown nothing at all.

Meanwhile `instance-detail.component.html:420` swaps the welcome view out for a
"Starting conversation…" spinner while `isCreatingInstance()` is true, which **destroys the
`InputPanelComponent`**. When creation fails and the flag flips back, the composer remounts and its
`message` signal is re-seeded from `newSessionDraft.prompt()` — now `''`.

From the user's seat: prompt disappears, spinner, welcome screen, empty composer, no error, no
session. Exactly the reported experience.

### 2.3 Contributing defect — the main process cannot rule itself out

`INSTANCE_CREATE_WITH_MESSAGE` logs nothing on entry, and `validateIpcPayload` throws a descriptive
error that the handler converts to `{ success: false }` **without logging it**. A payload rejection
is therefore indistinguishable from a submission that never happened. This is why the forensic
investigation could not identify the failure.

### 2.4 Contributing defect — renderer/main attachment limits disagree

- Main enforces `attachments: z.array(FileAttachmentSchema).max(10)`
  (`instance.schemas.ts:196`) — a hard cap, silently rejected.
- Renderer `validateFiles` (`instance-attachments.ts:12-24`) checks **no count at all**, and checks
  size **only for non-images** (`if (!isImage && file.size > maxSize)`), so the 5 MB image limit is
  never enforced up front.
- `fileToAttachments` **multiplies** attachments: any image with a dimension above 2000 px is split
  into tiles (`instance-attachments.ts:133-176`), so N images can expand past 10.

A user can therefore stage a set of images the renderer accepts, watch it expand past the cap during
serialization, and have the whole payload rejected with no message.

### 2.5 Honest confidence statement

- **Verified by reading the executing code path:** §2.1, §2.2, §2.3, §2.4. Each is a real defect
  present on the new-session submission path today.
- **Not proven for the 28 July event specifically:** which of the §2.1 triggers fired. The
  instrumentation gap in §2.3 destroyed that evidence, and it cannot be recovered after the fact.
  The composer-typing bursts in the classifier log do not show a long composition in the reported
  window, but that log only samples debounced input ≥ 12 characters and would record a single event
  for a pasted block, so it cannot exclude one either.

That uncertainty is exactly why the remediation must make loss impossible rather than fix one
trigger: the invariant below holds regardless of which branch failed.

---

## 3. Required invariant

> A composer containing text or attachments must not be cleared or lost until the main process
> durably accepts it and returns a usable session/instance identifier.

## 4. Requirements

| # | Requirement |
|---|---|
| R1 | The new-session composer must not clear text, folders or attachments until an acceptance carrying an instance id is received. |
| R2 | A failed submission must restore the composer exactly as it was, including attachments. |
| R3 | Submission state must be durable across renderer reload and application restart, attachments included. |
| R4 | A failure must be visible, with the reason and a retry control. |
| R5 | Retrying must not create a duplicate session if a slow acknowledgement arrives late. |
| R6 | Attachment staging must be cleaned up only on confirmed acceptance or explicit user discard. |
| R7 | A resolution belonging to an older submission must never clear a newer draft. |
| R8 | Every submission attempt must carry a correlation id, logged per stage in both processes. |
| R9 | The renderer must reject attachment sets the main process would reject, before submitting, with a specific message. |
| R10 | A component unmount mid-submission must not lose the composition. |
| R11 | A submission that never acknowledges must fail closed after a bounded timeout, not hang. |

## 5. Out of scope (explicitly, with reasons)

- **The existing-session send path** (`InputPanelComponent.onSend` → `sendMessage` →
  `instance-detail.onSendMessage` → `InstanceStore.sendInput`). It shares the clear-before-ack shape,
  but `sendInput` returns `Promise<void>` with no success signal and deliberately queues while busy;
  giving it an acknowledgement contract means reworking the renderer-owned queue/steer/interrupt
  machinery. That is a materially larger and riskier change than the incident justifies, and unlike
  the new-session path its text is recoverable from prompt history (`Ctrl+R`). Tracked separately;
  see §6 of the plan.
- Making `InstanceStore.error` render globally. The new-session surface gets a targeted, actionable
  banner instead; a global error surface is a separate UX decision.

## 6. As-built notes

All eleven requirements are implemented. Full file list, deviations and verification results are in
the plan's as-built section (§5).

Three independent completion-gate passes ran against the finished work. Passes 1 and 2 returned
FAIL; every finding was fixed and re-verified rather than argued away. The two that mattered most:

- **Pass 1** found that the retry path read attachments from the *live* draft. Since
  `pendingFilesByKey` is in-memory only, a retry of a composition recovered after a restart would
  have sent a text-only message and then deleted the images as "accepted" — reproducing the original
  loss through the very mechanism meant to prevent it. The submission request now carries its own
  attachments.
- **Pass 2** found the first correction over-applied: the draft *prompt* IS persisted to
  localStorage while the files are not, so after a restart the composer has text and no attachments,
  and an all-or-nothing "live content wins" rule amended the images away. Each field now falls back
  independently.

Both are a reminder that the draft store's two halves have different durability, which is the root
asymmetry behind the whole incident.

### Residual gap, deliberately not closed

The existing-session send/steer path still clears the composer before acknowledgement (spec §5). Its
text is recoverable from prompt history (`Ctrl+R`); its attachments are not. Closing it means giving
`InstanceStore.sendInput` an acknowledgement contract without disturbing the renderer-owned
queue/steer/interrupt machinery, which is a materially larger change than this incident justifies.
The over-cap attachment rejection on that path *was* fixed here, since it was the same silent Zod
failure.
