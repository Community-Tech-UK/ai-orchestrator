# History-restore ladder — live test (spec item 4)

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [`2026-07-17-history-restore-reconciler-migration-plan_completed.md`](2026-07-17-history-restore-reconciler-migration-plan_completed.md)
**Prerequisites:** rebuilt + restarted app; at least one archived conversation per scenario.

All agent-runnable verification passed 2026-07-17 (coordinator spec 10/10 incl. the three new
ladder regression locks, history suite 85 green, tsc ×2, lint, LOC, full quiet suite). These
are the spec item-4 mandated live scenarios.

## Checks

1. **Restore with a resumable session.** Archive a Claude conversation (a few turns), restart
   the app, restore it from history.
   - Expected: `restoreMode: native-resume` (no fallback notice in the transcript); asking
     "what were we talking about?" recalls the conversation from the provider side.
2. **Restore with a dead session.** Restore an entry whose provider session no longer
   exists (e.g. delete the provider session file first, or use an old pre-cleanup entry).
   - Expected: the transcript shows the "could not be restored natively" notice, prior messages
     render above it, the condensed-transcript preamble attaches to the next message, and the
     history entry records `nativeResumeFailedAt`.
   - Expected `restoreMode`: **`resume-unconfirmed`, not `replay-fallback`.** When the provider
     spawns a fresh session under the same id (Claude's B7 behaviour) the process is alive and
     usable, so the ladder does not kill it to respawn an identical one — the archived transcript
     is already in its buffer and the preamble carries the context. `replay-fallback` is reachable
     only via a dead process or `forceFallback`. This is the LT-014 contract, decided by James on
     2026-07-27; the earlier wording of this check asserted `replay-fallback` and was wrong about
     which rung a live-but-unresumed session lands on.
   - Then restore the **same entry a second time**: the native rung is skipped entirely (the handle
     is blacklisted), so this one lands on `replay-fallback`.
3. **Restore of a provider-swapped instance.** Swap an instance's provider (e.g. claude→codex),
   have one more turn, archive it, then restore.
   - Expected: the restore targets the NEW provider with the post-swap session id (never the
     old provider); if the post-swap session had no persisted turn, the ladder falls back
     cleanly per check 2 rather than wedging.
4. **browserToolsMode continuity.** Create an instance with browser tools set to `off`
   (create IPC or a scripted spawn), archive, restore.
   - Expected: the restored instance spawns with NO browser-gateway MCP server (check the app
     log for "Browser gateway MCP disabled for instance"), proving the override survived
     archive → restore.

Rename this file `_livetest_completed.md` only when every check passes with evidence.

---

## Evidence run — 2026-07-26 — corroboration for check 1; 2–4 not run; **the checks are not log-observable as written**

Packaged app (asar 2026-07-25 15:07, up since 15:22).

### Tooling note for the next runner (worth reading first)

None of the four checks can be judged from the app log: `restoreMode`, `native-resume`,
`replay-fallback`, `could not be restored natively`, `nativeResumeFailedAt`, and
`Browser gateway MCP disabled for instance` each appear **0 times** in the whole log. The restore
ladder's outcome is only visible in the transcript/UI, so these checks require either the renderer or
a new log line. Check 4 in particular says "check the app log for 'Browser gateway MCP disabled for
instance'" — **that string is never logged**, so the check cannot be completed as written even with
UI access.

### Check 1 — restore with a resumable session — ◐ corroborated by a real restore, but the documented marker is unverifiable

A genuine History restore of a Codex conversation happened in this app at **2026-07-26T01:54:25Z**:

```
InstanceLifecycle | Creating instance
  { displayName: "Meeting Search Not Working", historyThreadId: "45002a56-…",
    sessionId: "019f9aeb-42ca-7792-a963-db30bd2aff55", resume: true,
    initialOutputBuffer: { count: 322 }, provider: "codex" }
CodexCliAdapter   | App-server thread resumed from persisted cursor
  { threadId: "019f9aeb-42ca-7792-a963-db30bd2aff55" }
InstanceLifecycle | Skipping warm-start replacement spawn { reason: "resumed session" }
```

The provider-side thread resumed on the **same** id as the persisted `sessionId`, and the instance
then accepted a user turn and stayed healthy for ~7.5 min with zero error lines — i.e. behaviourally
this is the `native-resume` rung, with no fallback path taken. What cannot be confirmed without the
UI is the *absence of a fallback notice in the transcript* and the recall question in check 1's
second bullet. It is also a Codex conversation, not the Claude one the check specifies.

### Checks 2, 3, 4 — NOT RUN

2 and 3 need History-panel restores (and, for 3, a provider swap) driven from the UI. 4 additionally
needs an instance created with `browserToolsMode: off`, which no agent-reachable creation path
(automations, `run_on_node`) exposes — and, as noted above, its assertion string is never logged.

**Status: no check passes. NOT renamed.**

---

## Evidence run — 2026-07-27 — **check 4 PASSES; the "not log-observable" conclusion was wrong**

Dev app rebuilt from the working tree and driven over `--remote-debugging-port=9444`.

### Correction to the 2026-07-26 tooling note

That note said `Browser gateway MCP disabled for instance` "is never logged" and concluded check 4
"cannot be completed as written". **Both statements were wrong.** The line has existed since commit
`c3d3714a` (2026-07-17) at `src/main/instance/lifecycle/spawn-config-builder.ts:322`. It matched 0
times on 2026-07-26 because **no instance in that app had `browserToolsMode: 'off'`** — an absence
of the precondition, not of the signal. A search returning nothing is not a negative result until
the thing being searched for has been made to happen.

`restoreMode` genuinely was unlogged. It now is — `HistoryRestoreCoordinator.restore` logs
`History restore complete { entryId, restoreMode, instanceId, sessionId, historyThreadId }` at a
single exit point covering all three rungs (LT-011).

### Check 4 — browserToolsMode continuity — ✅ PASS

1. Created instance `cska2uq1k` with `browserToolsMode: 'off'` via the `createInstance` IPC. At
   spawn:

   ```
   [SpawnConfigBuilder] Browser gateway MCP disabled for instance (browserToolsMode=off)
     { instanceId: 'cska2uq1k' }
   ```

2. Gave it a real turn (replied `KIWI`), then terminated it. The archived history entry retains the
   override:

   ```json
   { "id": "7807ec33-710b-4393-b3a0-22a05a471e98",
     "name": "Reply with exactly the word KIWI and nothing else.",
     "browserToolsMode": "off" }
   ```

3. Restored it — `restoreHistory(entryId)` → `success: true`, new instance `cqn3g4h8j`,
   `restoreMode: "resume-unconfirmed"`. The restored instance spawned with **no** browser-gateway
   MCP server:

   ```
   [SpawnConfigBuilder] Browser gateway MCP disabled for instance (browserToolsMode=off)
     { instanceId: 'cqn3g4h8j' }
   [HistoryRestoreCoordinator] History restore complete
     { entryId: '7807ec33-…', restoreMode: 'resume-unconfirmed',
       instanceId: 'cqn3g4h8j', sessionId: '2c32ea4e-…', historyThreadId: '332958c2-…' }
   ```

The override survived archive → restore, which is exactly what check 4 asks for.

### Checks 1–3 — not run this session

Check 1 needs a Claude conversation whose provider session is still resumable at restore time (this
run's landed on the `resume-unconfirmed` rung, not `native-resume`, so it does not evidence check 1).
Checks 2 and 3 need a deliberately-dead provider session and a provider-swapped instance
respectively. All three are now log-observable via the `History restore complete` line, so they are
straightforward to evidence in a run that sets up those preconditions.

**Status: 1 of 4 checks passes. Not renamed.**

### Incidental note for check 1's runner

`listHistory({})` returns **0** entries — an empty filter object excludes everything. Call
`listHistory()` with no arguments (returned 22 entries here). This cost time in this run.

---

## Evidence run — 2026-07-27 (session 2) — **check 1 PASSES after LT-013; check 2 blocked on a contract conflict (LT-014)**

Dev app rebuilt from the working tree and driven over `--remote-debugging-port=9444`, against a
renderer bundle rebuilt this session (the previous run's `ng serve` was two days old).

### Check 1 — restore with a resumable session — ✅ PASS (after fixing LT-013)

The first attempt reproduced the previous session's `resume-unconfirmed` result, and driving it to
ground found a **new P0 defect, LT-013**: a deliberate terminate was being classified as an
*unexpected* exit, so an auto-respawn overwrote `instance.sessionId` with a freshly minted fork id
milliseconds before `archiveInstance` read it. The archived entry therefore pointed at a provider
session that had never existed.

Measured before the fix — **4 of 4** archived Claude entries, across this session and 2026-07-27
session 1, recorded a `sessionId` with no `.jsonl` on disk:

```
/tmp/aio-lt28-hist  cfcd8dcf-6963-4aa2-ae7c-dfbe1622d0b0  transcriptExists=false
/tmp/aio-lt27-yolo  29081535-9c8e-4cde-8c0e-322e66b8db31  transcriptExists=false
/tmp/aio-lt27-yolo  493e8442-47d4-4bec-909b-a246ed042158  transcriptExists=false
/tmp/aio-lt27-yolo  e5e90bee-a676-4edf-b5f0-578cce6f9b24  transcriptExists=false
```

Full root cause and log chain: LT-013 in `docs/plans/livetest-remediation-register.md`.

After the fix, re-run end to end (instance `cnx0wan5u`, `/tmp/aio-lt28-hist2`, two real turns —
`MANGO`, `ORCHID` — then terminate, **app restart**, restore):

- Archived `sessionId` = `a6cb9f40-f7b5-409e-bc03-bd1688ed6617`, and
  `~/.claude/projects/-private-tmp-aio-lt28-hist2/a6cb9f40-….jsonl` exists. Session id and
  transcript agree, which they never did before.
- Restore returned `restoreMode: "native-resume"` with 4 restored messages.
- **No fallback notice**: the restored transcript contained zero `system` messages before the next
  send.
- Provider-side recall: *"What two words did I ask you to reply with earlier?"* → **"MANGO, ORCHID"**.

```
[HistoryRestoreCoordinator] History restore complete
  { entryId: '31609473-…', restoreMode: 'native-resume',
    instanceId: 'cork3okjq', sessionId: 'a6cb9f40-…' }
```

Re-archiving the restored instance also kept the correct id (6 messages, same `a6cb9f40-…`), so the
fix holds for a restored session's own terminate too.

### Check 2 — restore with a dead session (replay) — ⛔ BLOCKED, not failed (LT-014)

Deleted `a6cb9f40-….jsonl` to kill the provider session, then restored the same entry. The adapter
correctly detected the dead session:

```
ClaudeCliAdapter | Skipping --resume: no transcript for session under current cwd
  { sessionId: 'a6cb9f40-…', cwd: '/tmp/aio-lt28-hist2' }
```

But the restore reported `restoreMode: "resume-unconfirmed"`, emitted no "could not be restored
natively" notice, and left `nativeResumeFailedAt: null` — none of what this check asks for. Prior
messages did render, and a continuity preamble was queued.

**This is a deliberate design decision, not a defect.** When Claude finds no transcript it spawns
fresh under the same id, so the process is alive, and the coordinator only demotes to
`replay-fallback` for a *dead* instance. Two tests in
`history-restore-coordinator.spec.ts` lock that on purpose ("the instance is up and usable even
without native resume confirmation … `markNativeResumeFailed` is NOT called"), and the migration
plan records "no change to ladder semantics".

Changing it to satisfy this check was attempted this session and **reverted** — it would have
silently overturned a documented design lock. The conflict is recorded as **LT-014** for James to
settle: either rewrite check 2 to assert `resume-unconfirmed`, or change the semantics and update
the locks and the plan together. Check 2 stays open either way.

One improvement was kept: the post-spawn probe now stops as soon as the adapter reports a
definitive answer instead of burning the full window, so this restore no longer stalls 5 s. The rung
is unchanged.

#### Resolution — 2026-07-27, James's decision on LT-014

Neither listed option as written. The rung stays `resume-unconfirmed` (option 1), but the two
things this evidence run flagged as missing — the notice and `nativeResumeFailedAt` — are now
produced whenever the adapter *disproves* the resume. Rationale: `fresh-fallback` is a
filesystem-authoritative negative for Claude (`nativeTranscriptExists` fails open on any
uncertainty), the respawn path at `instance-lifecycle.ts:1059-1064` already treats it as a definite
non-resume, and demoting the rung outright would terminate a healthy process and respawn an
identical one for no functional gain.

Implemented in `history-restore-coordinator.ts` (`ResumeWaitState.disproven` → notice +
`recordNativeResumeFailure`); the B1/B2 locks were updated to assert the new bookkeeping while
still asserting the unchanged rung, and a lock was added so a *merely unproven* resume stays
silent. Check 2 above is rewritten to match.

**Check 2 is still NOT verified live** — it needs a rebuilt app. What changed is that it is no
longer blocked on a contract question.

### Check 3 — restore of a provider-swapped instance — ✅ PASS

Instance `cplj3fpg3` in `/tmp/aio-lt28-swap`: created on **claude** (session
`de8f0a04-…`), one real turn (`PELICAN`), then `changeModel({ provider: 'codex' })` — swap completed
in 11.5 s to `gpt-5.6-sol`, new session `019fa28c-4d3b-7a52-8152-592c29f488f7` — then a post-swap
turn (`WALRUS`), then terminate.

The archived entry targets the **new** provider only:

```json
{ "provider": "codex", "sessionId": "019fa28c-4d3b-7a52-8152-592c29f488f7",
  "currentModel": "gpt-5.6-sol", "messageCount": 7 }
```

Restoring it:

```
[HistoryRestoreCoordinator] History restore complete
  { entryId: '994ff51a-…', restoreMode: 'native-resume',
    instanceId: 'xss72cu0l', sessionId: '019fa28c-…' }
```

The live instance came up as `codex` / `gpt-5.6-sol` on `019fa28c-…` — the old claude session id
appears nowhere — and provider-side recall returned **WALRUS**. No wedge.

**Status: checks 1, 3 and 4 pass; check 2 is unblocked (LT-014 decided and implemented
2026-07-27) but still needs a live re-run against a rebuilt app. NOT renamed.**

## Evidence run — 2026-07-29 — **check 2 PASSES; all four checks are now green**

This closes the last open check. Check 2 was left BLOCKED on 2026-07-27 pending James's LT-014
decision; that decision was made and implemented the same day, and this run is its live
verification.

Environment: dev app built from the working tree at `0e6d8bd4` (`npm run build:main` exit 0),
fully relaunched. The dead session was staged from a disposable Claude conversation created earlier
today in `/tmp/aio-lt-handoff` (history entry `5f955ce3-3d4f-4de3-a960-8a5968582f19`, provider
session `10878e08-b0f7-4f71-a51d-37be127e8983`) by moving its transcript aside:

```
~/.claude/projects/-private-tmp-aio-lt-handoff/10878e08-….jsonl   → /tmp (90 257 bytes)
```

### Check 2, first restore — every expectation met

| Expectation | Observed |
| --- | --- |
| `restoreMode: **resume-unconfirmed**`, not `replay-fallback` | **`resume-unconfirmed`** |
| "could not be restored natively" notice in the transcript | present (quoted below) |
| prior messages render above it | 25 messages in the restored buffer |
| history entry records `nativeResumeFailedAt` | **`1785339213499`** |

The notice, verbatim from the restored instance's buffer:

```
system  Previous Claude CLI session could not be restored natively. Your conversation history is
        displayed above, and a condensed transcript will be attached automatically to your next
        message.
```

The instance came up `idle` on the same session id (`10878e08-…`) — the LT-014 contract exactly:
Claude spawns fresh under the same id, the process is alive and usable, so the ladder does not kill
it to respawn an identical one.

### Check 2, second restore — the blacklist rung

Restoring the **same entry** again, after terminating the first restored instance:

- `restoreMode: **replay-fallback**` — the native rung was skipped entirely, as specified, because
  `nativeResumeFailedAt` is now set (`history-restore-coordinator.ts:297` computes
  `sessionResumeBlacklisted` from it).
- A fresh provider session id was minted (`dcdd8bea-0fe5-47ec-b512-d6f9de72ff34`), and all 25
  messages still rendered.

Both rungs of the ladder behave as the LT-014 decision describes.

**A trap for the next runner:** filtering the output buffer for `/fallback|restored natively/`
matched two of *this campaign's own earlier probe questions* stored in the same conversation
("does the phrase \"Resume mode: replay fallback\" appear?"). Only the `system`-typed entry is app
output. Match on `type === 'system'`, not on the text alone.

### Status of all four checks

| Check | Result | Evidenced |
| --- | --- | --- |
| 1 — restore with a resumable session | ✅ PASS | 2026-07-27 session 2 (after LT-013) |
| 2 — restore with a dead session | ✅ PASS | **2026-07-29 (this run), both halves** |
| 3 — restore of a provider-swapped instance | ✅ PASS | 2026-07-27 session 2 |
| 4 — `browserToolsMode` continuity | ✅ PASS | 2026-07-27 |

Checks 1, 3 and 4 were evidenced two days ago. Both fixes they depend on were re-confirmed present
in the current tree before closing this file — `removeAllListeners()` at
`instance-termination.ts:117` (LT-013) and the `nativeResumeFailedAt` write/read at
`history-restore-coordinator.ts:179,297` (LT-014) — and the restore ladder itself was exercised
end-to-end on today's build three separate times during this campaign (twice here, once for
`2026-07-14-codex-runtime-resilience-plan_livetest.md` section 3, which reported
`restoreMode: native-resume`).

**All checks pass with current evidence. This file is renamed `_livetest_completed.md`.**
