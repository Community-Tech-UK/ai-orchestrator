# Live tests — LT-196 correction miner

## Final status — 2026-09-27

Open: 0 · Closed here: 2 · Transferred: 1 · Failed: 0

Checks 1 and 3 pass. Check 2's governing ACP acceptance criterion passes live on Cursor and Grok;
the only unobserved sub-branch is a current provider emitting a terminal failure with no renderable
output. That one provider-shape probe is now
[AR-007](../../plans/2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-007--acp-no-output-terminal-failure-fallback), with an explicit bounded retirement rule if no supported current provider can emit the legacy shape. Nothing else remains open in this source.

## Current status — 2026-09-24 (after verify-loops)
Open: 1 (check 2's exit-code-only, no-output failure clause) · Closed: 2 · Failed: 0

Checks 1 and 3 passed on 2026-09-21. Check 2's primary ACP fail-then-fix
criterion now passes live on Cursor and Grok in the current working tree; the
Grok rerun below closes the LT-612 failure recorded in the earlier resume batch.
The check also asks for a terminal failure that renders no output to produce a
hidden `tool_outcome`. The 2026-09-21 run observed a no-output success and a
failure whose exit code rendered visibly, but not that exact combination. Its
fallback is unit-tested, yet the live clause remains unverified. Keep this
`_livetest.md` active until that clause is exercised or its acceptance wording
is explicitly reconciled. The register's older “live check pending” wording
does not supersede the later Grok evidence here.

## Status — 2026-09-24 (resume batch; superseded)
Check 2 and the incidental LT-613 finding were re-run live against a rebuilt app (HEAD `f04f6748`)
— see [Evidence run — 2026-09-24 (resume batch)](#evidence-run--2026-09-24-resume-batch). **LT-613
is CONFIRMED FIXED LIVE** (History entries now expand in place; the sidebar no longer closes).
**LT-612 is still REOPENED, but only partly**: Cursor now records a nonzero shell exit as
`is_error: true` and its correction was mined (`patternsFound: 1`). Grok still records one as
`is_error: false`, so check 2's primary acceptance criterion still fails for Grok on this build.
(Corrected by the orchestrator on 2026-09-24. This line first said both providers still failed,
which contradicts the evidence section below.)

## Status — 2026-09-24 (verify-loops)

Re-ran check 2's Grok half against the **working tree** (uncommitted `acpExitCode()` fix, not HEAD
`f04f6748`) — **CONFIRMED FIXED LIVE**: a bare failing command now records `is_error: true`, the fix
records `is_error: false`, and `learningScanRun` finds the pattern (`patternsFound: 1`). See
[Evidence run — 2026-09-24 (verify-loops)](#evidence-run--2026-09-24-verify-loops).

### Status — 2026-09-21 (superseded)
Open: 1 · Closed: 2 · Failed: 1
Checks 1 and 3 passed live on 2026-09-21 — see `## Evidence run — 2026-09-21`. Check 2 failed:
every ACP provider records a failed shell command as `is_error: false`, so no ACP session can be
mined and spec acceptance criterion 2 is unmet. Filed as LT-612. Check 2 stays open until that
fix lands and is re-run.

### Status — 2026-09-13
Open: 3 · Closed: 0 · Failed: 0
Needs a rebuilt/restarted app and real provider traffic. Everything else in the plan is
verified in-loop by unit and integration tests, including mutation checks on both adapter
emits; only a genuine end-to-end scan against real archived sessions is deferred here.

> **Found a defect while running these checks?** Record it in the remediation register —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item (index row, then
> observed behaviour, root cause, required behaviour and acceptance), and add the matching
> implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence stays here.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-09-06-lt196-correction-miner_plan_completed.md](./2026-09-06-lt196-correction-miner_plan_completed.md)

## Prerequisites

- `npm run build:main` and a renderer build, then an Electron relaunch. The record is written
  by the CLI adapters at spawn time, so a session started by the *old* main process will not
  contain it — the transcript must be produced by the rebuilt code.
- An authenticated Claude session and an authenticated ACP session (Copilot, Cursor or Grok).
- A disposable workspace. The failure-then-correction pattern must be genuine, not synthesised
  into a transcript by hand — the point is to prove the real adapter path writes the record.

## Why these are deferred

The record's shape, both adapter emit sites, the miner's consumption of it, the renderer
suppression and the LT-062 hygiene guarantee are all covered by tests that fail when the
behaviour is removed (mutation-checked). What cannot be proved without a live run is that a
real provider's real NDJSON/ACP traffic produces the record in a real archived session, and
that `runScan()` then surfaces a proposal from it.

---

## 1. Claude: a real failure-then-correction is mined (spec acceptance 1)

1. Start a Claude session in a disposable workspace on the rebuilt app.
2. Run a command that genuinely fails, e.g. `grep --bogus-flag needle haystack.txt`.
3. Run the corrected form, e.g. `grep -F needle haystack.txt`, and let it succeed.
4. End the session so it archives.
5. Open Memory Review → **Scan for corrections**.

**Expected:** `patternsFound >= 1` and a governed rule proposal appears for the `grep`
base command. Inspect the archived transcript and confirm it contains `tool_outcome` records
with `is_error: true` on the failing call and `false` on the fix — and **no** visible
`tool_result` message for Claude (LT-062 must still hold).

## 2. ACP: the same, on Copilot, Cursor or Grok (spec acceptance 2)

Repeat check 1 on an ACP-backed provider. This is the half the original register entry missed
entirely — it recorded LT-196 as Claude-only, when Copilot, Cursor and Grok were equally dead.

**Expected:** `patternsFound >= 1`.

ACP does **not** use the invisible record for an ordinary call — that changed during
implementation. Confirm instead that the archived transcript's visible `tool_result` messages
carry `is_error` in their metadata, and that the paired `tool_use` messages carry
`metadata.input.command`. Without the command the miner never opens an invocation at all, which
is how this path stayed broken through the first review round.

**Also confirm, in the same run, while a session is open — all three are unit-tested, but each
is cheap to eyeball live:**

- A **cancelled** tool call carries no `is_error` at all and produces no fallback record. Setting
  it to `false` would hand the miner a false confirmed fix worth +0.15 confidence.
- A terminal failure that renders **no output** (an exit-code-only failure, e.g. `false`) does
  produce a `tool_outcome` record — that is the one ACP case that still uses it, because no
  visible `tool_result` is written when there is nothing to show.
- Nothing typed `tool_outcome` appears in the chat transcript, in a shared/replayed bundle, or
  on a connected mobile client. The mobile check matters specifically: the record previously
  reached devices relabelled as an `assistant` message with the raw error text inline.

## 3. Archive → live paths keep the record hidden and keep the signal (rounds 6–7)

Use the archived Claude session from check 1, which holds a failing `tool_outcome`.

1. Open **History**, expand that entry. **Expected:** no message labelled `tool_outcome` and no
   raw grep invalid-option failure text shown as its own message (`HISTORY_LOAD` strips
   the record before the renderer).
2. Restore the entry from History (either rung: native resume or replay fallback). **Expected:**
   the restored transcript shows no `tool_outcome`; the restore succeeds normally.
3. In the restored session, send one short message, then end it so the thread re-archives.
   Run **Scan for corrections** again. **Expected:** the `grep` correction is still found
   (`patternsFound >= 1`, deduplicated against the existing proposal is fine). The re-archive
   overwrites the original entry, so this proves the records were carried through restore.
4. If a crash-recovery candidate is offered for a session with a tool failure (force-quit the app
   mid-session, relaunch), recover it. **Expected:** recovery succeeds — before round 7 it threw
   a validation error for any archive holding a `tool_outcome` — and shows no `tool_outcome`.

Why deferred: each step needs real archived sessions produced by the rebuilt app and real UI
interaction; every underlying guard is unit-tested and mutation-checked.

## Evidence

The 2026-09-21 run below passed checks 1 and 3 but failed check 2 (LT-612).
Later 2026-09-24 Cursor and Grok runs passed check 2's primary ACP criterion;
the no-output failure clause remains open as described in Current status.
Rename to `_livetest_completed.md` only after all three checks pass with recorded evidence.

---

## Evidence run — 2026-09-21

Run as a Plan Queue item from worktree
`.worktrees/queue/2026-09-06-lt196-correction-mi-b4d3fd`. Dev app built from that worktree
(`npm run build:main`, `npm run build:renderer`, both exit 0), launched with
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-d3b4d3fd` and `--remote-debugging-port=9648`, driven
over CDP with focus emulation and `Emulation.setPageVisibilityOverride` enabled before every DOM
assertion.

`ng serve` could not be used: it fails in this repo with
`The injectable '_PlatformLocation' needs to be compiled using the JIT compiler` and `app-root`
never bootstraps. The production renderer bundle was served on `:4567` instead, which is why no
`window.ng` was available — every assertion below is either an IPC result, an on-disk archive, or
a real DOM read.

**Result: 1 of the 3 checks fails.** Check 1 and check 3 pass in full. Check 2 fails on its
primary acceptance criterion; filed as **LT-612**.

### Check 1 — Claude: a real failure-then-correction is mined — **PASS**

Live Claude session `cwljhx4aq` in `/tmp/aio-ltq-ws`, `yoloMode: true`, created and driven via
`createInstance` / `sendInput`. It ran, verbatim and as two separate Bash calls:

1. `/usr/bin/grep --bogus-flag needle haystack.txt` → exit 2
2. `/usr/bin/grep -F needle haystack.txt` → exit 0

Archived on terminate as `74c94d9e-3807-4fb2-8d6a-aaab25431766.json.gz`. Read straight off disk,
the transcript holds 8 messages including both records and **no** visible `tool_result` — LT-062
still holds:

```
tool_use      {"name":"Bash","id":"toolu_01P7ukhD41rr9pGCZ7PCqs6q",
               "input":{"command":"/usr/bin/grep --bogus-flag needle haystack.txt", ...}}
tool_outcome  {"tool_use_id":"toolu_01P7ukhD41rr9pGCZ7PCqs6q","is_error":true,"name":"Bash"}
              content: "Exit code 2\ngrep: unrecognized option `--bogus-flag'\nusage: grep ..."
tool_use      {"name":"Bash","id":"toolu_018fe9Lun3QZYpeKT4qZ8ATe",
               "input":{"command":"/usr/bin/grep -F needle haystack.txt", ...}}
tool_outcome  {"tool_use_id":"toolu_018fe9Lun3QZYpeKT4qZ8ATe","is_error":false,"name":"Bash"}
              content: ""
```

The live `outputBuffer` for that session never contained either record (6 messages: user,
assistant, tool_use, system, tool_use, assistant) — the side store is doing its job.

`learningScanRun({})`:

```json
{"scopeKey":"__global__","sessionsScanned":1,"sessionsSkipped":0,
 "proposalsCreated":1,"proposalsReinforced":0,"patternsFound":1,"error":null}
```

`governedProposalList({kind:'rule',status:'pending'})` returned one `pending`, `agent-derived`
rule proposal `261312ad-4a18-4be8-8f5f-cb05d778a15f`, title `grep::unknownflag`:

```json
{"baseCommand":"grep","errorClass":"UnknownFlag",
 "pattern":"/usr/bin/grep --bogus-flag needle haystack.txt",
 "correction":"/usr/bin/grep -F needle haystack.txt",
 "occurrences":1,"confidence":0.842391304347826,
 "evidence":[{"sessionId":"74c94d9e-3807-4fb2-8d6a-aaab25431766", ...}]}
```

The 0.842 confidence includes the `+0.15` for `fixIsError === false`, which is only reachable
because the success record really carried `is_error: false`. Spec acceptance criterion 1 met.

### Check 2 — ACP: the same, on Copilot, Cursor or Grok — **FAIL (LT-612)**

Copilot could not be used: the dev app reports *"No Copilot account is signed in on this device"*.
Cursor and Grok were both exercised.

**Primary criterion fails.** Cursor session `udrlnsjh1` (`/tmp/aio-ltq-ws2`) ran the identical
two commands. The failing call came back:

```json
{"type":"tool_result","content":"--- stderr ---\ngrep: unrecognized option `--bogus-flag'\n...\n\n(exit code 2)",
 "metadata":{"toolCallId":"tool_b7eeac36-...","status":"completed","transport":"acp","is_error":false}}
```

`status: "completed"` and `is_error: false` for a command that exited 2. `findCorrectionPairs`
requires `failInv.isError === true`, so nothing is mined:

```json
{"scopeKey":"/tmp/aio-ltq-ws2","sessionsScanned":1,"patternsFound":0,"proposalsCreated":0}
```

Grok session `i991e00l2` (`/tmp/aio-ltq-ws3`) reproduces it exactly — failing `grep` →
`status: "completed"`, `is_error: false` — and also scans to `patternsFound: 0`. So this is the
ACP adapter's `status`-only derivation, not one provider's quirk. Filed as **LT-612**.

**The two structural sub-claims this check makes about ACP both hold.** In the archived Cursor
transcript every `tool_use` carries `metadata.input.command` (`/usr/bin/grep --bogus-flag ...`,
`/usr/bin/false`, `/bin/sleep 90`, …) and every visible `tool_result` carries an `is_error` key.
The round-1 fix is present and wired; it is the *value* that is wrong.

**Cancelled call — confirmed, no false record.** `/bin/sleep 300` was interrupted mid-call
(`interruptInstance` → `{interrupted: true}`, instance went `busy` → `idle` with
`Interrupt requested: unresolved`). Tool call `tool_ff35a6f0-dcfb-4dff-8394-a029439ecc2` produced
**no** `tool_result` and **no** `tool_outcome` in the archive — no `is_error` anywhere, so the
miner gets no false confirmed fix. This is the behaviour the check asks for. Honest caveat: the
archive alone cannot distinguish "the provider reported `cancelled`, which the helper deliberately
skips" from "the provider never sent a terminal update at all". Both land on the same safe
outcome, and it is the outcome that is being asserted here.

**Exit-code-only failure — the fallback is exercised, but not by a failure.** `/usr/bin/false`
did **not** produce a `tool_outcome`: `cursor-agent` returns `rawOutput.exitCode`, so
`renderAcpRawOutput` renders `(exit code 1)` and the visible `tool_result` is written after all
(with `is_error: false`, same defect). The fallback record *was* observed live, on `/bin/sleep 90`,
which settled terminal with genuinely no renderable output:

```
tool_use      input.command = "/bin/sleep 90"   toolCallId = tool_5574540f-...
tool_outcome  {"tool_use_id":"tool_5574540f-...","is_error":false,"name":"`/bin/sleep 90`"}
```

So `buildAcpToolOutcomeFallback` works. Every settled call observed produced exactly one closing
message and never two, and the interrupted call produced none, which is the deliberate exception.
But with Cursor the *failure* variant of the no-output case does not arise at all, because Cursor
always renders the exit code — so that specific branch stayed unexercised live. Noted, not filed:
the design is intact and the branch is unit-tested across all six status × output combinations.

**Nothing typed `tool_outcome` reaches a consumer.** Three surfaces checked live:

- *Chat transcript.* The rendered `app-instance-detail` for a session restored from the Claude
  archive shows role labels `Claude, System, Claude, Claude, System` and no `tool_outcome`. The
  only `unrecognized option` in the DOM is inside Claude's own assistant reply.
- *Share / replay bundle.* `sessionSharePreview` and `sessionShareSave` for the 8-message Claude
  archive produce a 6-message bundle; the string `tool_outcome` does not occur anywhere in the
  serialised JSON. `sessionShareLoad` and `sessionShareReplay` round-trip the same 6 types, and
  the replayed instance `ic2genx69` has no record in its buffer.
- *Mobile client.* The dev app's mobile gateway was started on an isolated port and a synthetic
  client (`_scratch/lt196-queue/mobile-client.mjs`) paired over `/pair` and held `/ws` open while
  Claude session `cwp3ykd6e` ran the failing-then-fixed `grep` pair. 17 frames captured; 6
  `instance-output` frames, typed `user, assistant, tool_use, system, tool_use, assistant`. No
  frame contains `tool_outcome`; the single frame containing `unrecognized option` is Claude's own
  summary message. The archived mobile path agrees: `GET /api/history/inst:0ed99ceb-.../messages`
  returns 6 messages with no record, against 8 with two records on disk. The LT-196 round-2
  failure mode — the record arriving relabelled `assistant` with the raw error inline — does not
  occur.

  *Note for a future run:* the dev Electron binary is set to **Block incoming connections** in the
  macOS application firewall, so its gateway accepts and immediately drops connections on the
  Tailscale IP. Setting `mobileGatewayBindInterface: 'all'` in the dev profile makes it reachable
  over loopback, which the firewall does not filter. Both that and `mobileGatewayPort` were
  restored afterwards; James's packaged gateway on `:4879` was never touched and answered
  `200 /health` at the end of the run.

### Check 3 — archive → live paths keep the record hidden and keep the signal — **PASS**

**3.1 History view.** `loadHistoryEntry('74c94d9e-...')` returns 6 of the 8 archived messages,
with `anyToolOutcome: false`. Expanding that entry in the real **History** sidebar (real
`Input.dispatchKeyEvent` Enter on the focused `.item-header`, with focus emulation on) renders
`User, Assistant, Tool Use, System, Tool Use, Assistant` — no message labelled `tool_outcome`, and
the only `unrecognized option` in the expanded DOM is inside Claude's own assistant reply.
`HISTORY_LOAD` is stripping the record before the renderer sees it.

**3.2 Restore.** `restoreHistory('74c94d9e-...')` → instance `c7oy96tc6`, `restoreOk: true`. The
restored buffer holds the 6 visible messages, `hasOutcome: false`, and no raw failure text in any
non-assistant message. Restoring the Cursor archive later gave the same shape: 21 archived → 20
restored, record filtered.

**3.3 Re-archive and rescan.** One short message sent to the restored session, then terminated.
The re-archive overwrote the same entry id (`74c94d9e-...`, now 11 messages) and **both records
survived**:

```
tool_outcome {"tool_use_id":"toolu_01P7ukhD41rr9pGCZ7PCqs6q","is_error":true,"name":"Bash"}
tool_outcome {"tool_use_id":"toolu_018fe9Lun3QZYpeKT4qZ8ATe","is_error":false,"name":"Bash"}
```

Rescan: `{"sessionsScanned":2,"proposalsCreated":0,"proposalsReinforced":1,"patternsFound":1}` —
found again and deduplicated into a reinforcement, which is what the check allows.
`reseedToolOutcomes()` is working on the restore path.

**3.4 Crash recovery.** Two attempts; the first is worth recording because it explains why the
check is conditional.

*First attempt (Claude thread).* Force-quit (`kill -9` on the dev app main process) with a live
restored Claude session, then relaunch. **No recovery candidate was offered** — correctly. On
relaunch the native Claude transcript importer rewrote entry `74c94d9e-...` from
`~/.claude/projects/`, which bumped the thread's history coverage past the continuity state's
`lastActivityAt` and suppressed the candidate. That rewrite is also a useful datapoint for the
plan's note on `native-claude-archive-repair.ts`: the repaired archive replaces both
`tool_outcome` records with visible `tool_result` messages that **keep** `is_error`
(`{"tool_use_id":"toolu_01P7...","is_error":true}` / `..."is_error":false`), and a rescan of the
repaired archive still returns `patternsFound: 1`. No miner signal is lost by repair.

*Second attempt (Cursor thread, not natively re-imported).* Restored archive `99e4844f-...` —
which holds a real `tool_outcome` — as instance `uki6sej08`, sent one turn, waited for the
continuity state to persist (~60 s), then `kill -9` and relaunch. A candidate was offered:

```json
{"src":"uki6sej08","key":"history:cursor:ed24c8b1-dc1d-4f01-b5e9-089fd24929b1",
 "provider":"cursor","msgs":1,"nativeResumeAvailable":true}
```

`recoverSession` on it **succeeded** —
`{"instanceId":"u5rkczlo2","recoveredMessageCount":2,"usedNativeResume":false}`, no
`Recovery candidate validation failed`, which is exactly the round-7 failure this step exists to
catch. The recovered buffer holds 22 messages and **no** `tool_outcome`. Terminating it
re-archived the thread with the record intact
(`{"tool_use_id":"tool_5574540f-...","is_error":false,"name":"`/bin/sleep 90`"}`), so the
crash-recovery re-seed works too.

### Defects filed

- **LT-612** (P2) — every ACP provider records a failed shell command as `is_error: false`, so no
  ACP session can ever be mined. Blocks spec acceptance criterion 2.
- **LT-613** (P3) — incidental, found while driving check 3.1: clicking a History entry closes the
  whole History sidebar instead of expanding the entry.

### Residual

Check 2 stays open. Checks 1 and 3 pass with the evidence above and need no re-run unless the
LT-612 fix touches them; re-running check 2 after LT-612 is the remaining work. This document must
not be renamed `_livetest_completed.md` until then.

> Plan Queue parked work: `queue/2026-09-06-lt196-correction-mi-b4d3fd` — 2 commit(s), reason: land-blocked.

---

## Evidence run — 2026-09-24 (resume batch)

**Result: LT-613 is CONFIRMED FIXED LIVE. LT-612 is REOPENED — partially fixed: Cursor now passes,
Grok still reproduces the original defect.**

### Environment

| Item | Value |
| --- | --- |
| Checkout | root checkout, HEAD `f04f6748` (campaign's shared pre-built `dist/main`/renderer, not a queue worktree) |
| Dev app | `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-0924-resume npx electron . --remote-debugging-port=9711` |
| Renderer | shared campaign renderer on `:4567` |
| ACP CLIs available | `cursor-agent`, `grok`, `opencode` all on `PATH`; `copilot` also on `PATH` but (as in the 2026-09-21 run) the dev app reports "No Copilot account is signed in on this device" — not re-attempted here, same known auth blocker |
| Disposable workspaces | `/tmp/aio-lt-0924-resume-work/lt612-ws` (Cursor), `/tmp/aio-lt-0924-resume-work/lt612-ws-grok2` (Grok) |

### Check 2 — ACP correction mining — Cursor now passes, Grok still fails (LT-612 REOPENED)

**Cursor — PASS.** Real instance `ucn8i3a8m` ran, as two separate bare tool calls exactly as typed:
`/usr/bin/grep --bogus-flag needle haystack.txt` then `/usr/bin/grep -F needle haystack.txt`. Live
`outputBuffer` showed the failing call as `status:"completed", is_error:true` and the fix as
`status:"completed", is_error:false` — a direct reversal of the 2026-09-21 finding
(`is_error:false` on the failing call). After terminate + `learningScanRun({})`:
`{"sessionsScanned":2,"proposalsCreated":1,"patternsFound":1}`, and
`governedProposalList` returned the `grep::unknownflag` rule proposal
(`sourceSessionId:"99b20fd5-..."`, `confidence:0.842391304347826` — the same confidence value as the
Claude check, which only arises when `fixIsError === false` is genuinely true). Cursor's half of
LT-612 is fixed.

**Grok — still FAILS the primary criterion.** First attempt (instance `it80db2gs`) was invalid
evidence: Grok's own agent chose to wrap the command as `cmd; echo "EXIT_CODE:$?"`, which always
exits 0 regardless of `grep`'s own status, so `is_error:false` there is correct behaviour for that
compound command, not the defect — discarded and not scanned.

Re-run with explicit instructions to run the two commands bare, unwrapped, as separate tool calls
(instance `ixju0scof`, workspace `lt612-ws-grok2`). Grok obeyed and ran the exact bare commands.
Live `outputBuffer`:

```json
{ "title": "Execute `/usr/bin/grep --bogus-flag needle haystack.txt`", "status": "completed", "is_error": false }
{ "title": "Execute `/usr/bin/grep -F needle haystack.txt`",          "status": "completed", "is_error": false }
```

`is_error:false` on a call whose own rendered stderr shows `grep: unrecognized option
'--bogus-flag'`. After terminate + `learningScanRun({})`: `{"patternsFound":0,"proposalsCreated":0}`
— exactly the pre-fix LT-612 shape, reproduced again on this build.

**Root cause of the residual gap**, read at `src/main/cli/adapters/acp-tool-call-material.ts:91-93`:

```ts
function acpToolFailed(status: string, rawOutput?: Record<string, unknown>): boolean {
  return status === 'failed' ||
    (status === 'completed' && typeof rawOutput?.['exitCode'] === 'number' && rawOutput['exitCode'] !== 0);
}
```

The LT-612 fix made `is_error` depend on a numeric `rawOutput.exitCode` from the ACP `session/update`
payload. `rawOutput` is whatever the provider's own ACP server sends (comment at
`acp-cli-adapter.ts:1597`: "Cursor never populates `content`; its results arrive in `rawOutput`
only"). This differential test (same AIO code path, same shell command, two providers) shows Cursor's
`cursor-agent` populates `rawOutput.exitCode` for its execute tool and Grok's agent-server does not —
so `acpToolFailed()` silently falls through to `false` for every Grok tool call, exactly reproducing
the original defect for that one provider. No raw ACP wire capture was taken (no debug-level dump of
`session/update` exists in `app.log`), so the "Grok omits `rawOutput.exitCode`" claim is a high-confidence
inference from the code path plus the differential live behaviour, not a captured wire payload — flagged
as such rather than asserted as fully verified.

This reopens **LT-612**: its acceptance ("Fail-then-fix correction mining finds the pair on ACP as it
does on Claude") is still unmet in general, because "ACP" spans multiple providers and one of the
three named in the spec (Copilot, Cursor, Grok) still fails. Required behaviour going forward: either
extend `acpToolFailed()` with a provider-agnostic fallback (e.g. derive failure from stderr content
or an ACP `error`/`success` field when `rawOutput.exitCode` is absent), or confirm from Grok's ACP
protocol docs whether it emits failure by another field and read that instead.

Copilot was not re-attempted (same "no account signed in" blocker as 2026-09-21); this run does not
change that provider's status.

### Check LT-613 — History entry click closes the sidebar — **CONFIRMED FIXED LIVE**

Reproduced via `src/renderer/app/features/history/history-item.component.ts` (`.item-header`
`(click)="toggleExpand()"`, no `stopPropagation()`) and
`history-sidebar.component.ts` (`onBackdropClick` gates on `event.target === event.currentTarget`).
With a synthetic entry seeded directly into `HistoryStore`'s signal
(`store['state'].update(...)`, same technique as the session-recovery checks) inside a freshly
opened sidebar:

| Interaction | Result |
| --- | --- |
| Native `.click()` on `.item-header` | entry expanded (`aria-expanded="true"`, `.item-content` rendered), sidebar (`app-history-sidebar`) stayed in the DOM |
| Second click on the same header | entry collapsed, sidebar still present |
| Real `Input.dispatchKeyEvent` Enter while the header held focus | entry expanded again (`aria-expanded="true"`, `.item-content` present), sidebar still present |
| Real click directly on `.history-backdrop` (not a child) | sidebar closed, as designed |

The sidebar never closed on an entry click or keyboard activation in any of the three interaction
attempts, and backdrop-click-to-close still works. This directly reverses the LT-613 finding.
(One harness note: on the very first click of a freshly-seeded, freshly-created row, a single
`.click()` call intermittently needed a second click to register the expand — a CDP/paint-timing
artefact of the harness driving a node the instant after it mounts, not a reproducible product
defect; every subsequent interaction in this run and the control re-test both behaved correctly on
the first try, and the sidebar-stays-open behaviour — the actual defect under test — was never
affected by it.)

### Cleanup

Both Cursor instances and both Grok instances were terminated; disposable workspaces
`/tmp/aio-lt-0924-resume-work/lt612-ws*` are removed with the rest of this batch's `/tmp` state at
the end of the run. No settings were changed.

### Residual

Check 2 stays open, now for a narrower reason: Cursor is fixed, Grok is not. LT-613 is fully
confirmed and needs no further live check. This document is not a candidate for
`_livetest_completed` yet.

## Evidence run — 2026-09-24 (verify-loops)

Batch `verify-loops`, driven against the **working tree** (`src/main/cli/adapters/
acp-tool-call-material.ts`'s `acpExitCode()` fallback to `rawOutput.exit_code`, not HEAD `f04f6748`).
Disposable workspace `/tmp/aio-lt-0924-verify-loops-work/lt612-grok-ws` (a fresh scratch git repo).

### Check 2 — Grok half — CONFIRMED FIXED LIVE

Real Grok instance (`i4gh6kryk`), told to run two bare, unwrapped, separate shell tool calls:
`/usr/bin/grep --bogus-flag needle haystack.txt` then `/usr/bin/grep -F needle haystack.txt`. It
obeyed. Live `outputBuffer`:

```json
{ "title": "Execute `/usr/bin/grep --bogus-flag needle haystack.txt`", "status": "completed", "is_error": true }
{ "title": "Execute `/usr/bin/grep -F needle haystack.txt`",          "status": "completed", "is_error": false }
```

This is the exact reversal of the resume batch's pre-fix Grok finding (`is_error: false` on the failing
call) — the fix reads Grok's `rawOutput.exit_code` (snake_case) correctly this time. After
`terminateInstance` + `learningScanRun({})`:

```json
{ "scopeKey": "__global__", "sessionsScanned": 4, "proposalsCreated": 1, "patternsFound": 1 }
```

`patternsFound: 1` confirms the fail-then-fix pair was mined on Grok, matching the check's primary
acceptance criterion. **This closes the residual gap left by the 2026-09-24 resume batch: LT-612 is
now fixed for both Cursor and Grok on the working tree.** Copilot remains unverified (no signed-in
account on this box, unchanged from earlier runs) — the acceptance text says "Copilot, Cursor or
Grok", so two of three confirmed is sufficient to satisfy it, but a Copilot-signed-in box would still
be worth a follow-up pass.

### Cleanup

The one Grok instance was terminated before the learning scan (required for the scan to see the
session as closed). The scratch repo and dev profile were removed with the rest of this batch's
`/tmp` state. No settings were changed.

## Final reconciliation — 2026-09-27

- Check 1 passed end to end on a real Claude failure/correction pair, including hidden records and
  a governed proposal.
- Check 3 passed history expansion, restore, re-archive/rescan and a real Cursor crash-recovery
  candidate without exposing `tool_outcome`.
- Check 2's original LT-612 failure is confirmed fixed live on both Cursor and Grok. The cancelled
  call safely emitted neither a false success nor a fallback record, and mobile/replay hiding passed.
- `/usr/bin/false` is no longer a no-output failure fixture on current ACP providers because their
  raw exit code is rendered. The remaining fallback branch is unit-tested but cannot honestly be
  called live-passed from a no-output success. AR-007 preserves exactly that narrow current-wire
  probe and permits retirement only after bounded evidence shows no supported provider emits the
  protocol shape.

With that single sub-clause transferred, this source is ready for `_livetest_completed.md`.
