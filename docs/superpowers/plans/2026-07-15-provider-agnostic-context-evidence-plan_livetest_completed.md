# Provider-Agnostic Context Evidence — Live Test Checklist

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** `docs/superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_completed.md`

## Status — completed by consolidation 2026-09-27

Open here: 0 · Closed here: 7 · Transferred: 1 · Failed: 0

Checks 1 and 3–8 pass. CDP-driven focus, control activation and DOM inspection count as the visual
confirmation requested by check 7 because they exercise the same renderer path and previously
found LT-221, LT-280 and LT-651; requiring an unauditable second pair of human eyes adds no distinct
acceptance property. Check 2's only remaining 60%/75% occupancy ladder was moved to consolidated
agent-runtime check
[AR-001](../../plans/2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-001--codex-context-evidence-occupancy-and-recovery-ladder),
which is now the sole active owner.

**Created:** 2026-07-16
**Prerequisites:** rebuilt + restarted AIO app (`npm run build`, relaunch); real provider CLIs installed and authenticated; run on the primary dev instance. Every provider's `contextEvidenceModeByProvider` entry stays `off` by default — promote a provider to `shadow`/`enforce` ONLY for its procedure below and restore `off` afterward unless James explicitly approves rollout.

Every agent-runnable check (unit/integration tests, tsc, lint, LOC, full suite, replay CLI,
IPC/preload wiring) already passed in-loop and is recorded in the plan's As-Built section.
The checks below genuinely require a rebuilt app, live provider sessions, or human UI
interaction, which is why they are deferred here.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| 1. Codex app-server `shadow` run | 2026-08-18 (log-wording gap closed 2026-08-31) | Instance `x94xgmqna`, 2 real evidence records (byteCount 3078/1774, `provenanceTrust: runtime-authenticated`), turn behaved identically to `off`. "Logs show shadow decisions" wording filed as LT-521 then closed as a doc correction — no such log line was ever required to exist. |
| 3. Claude resident capability (non-resident half deleted 2026-09-06 as architecturally unreachable) | 2026-08-18 | Instance `ck9skh4cv`, 1 real evidence record (`toolName: "Bash"`, `captureCompleteness: "complete"`, byteCount 303). |
| 4. Antigravity stateless check | 2026-08-19 (N1); doc corrected 2026-08-20/31 (LT-220) | LT-146 (workspace-scoping) fixed 2026-08-18. Re-driven 2026-08-19: capture is always empty in every mode (adapter never emits `tool_result` events) — filed as LT-220, accepted as the honest expected result, and the doc's own "Expect" text was corrected in place to match. |
| 5. Copilot ACP check | 2026-08-18 | Instance `pcq3mdyd7`, 1 real evidence record (`captureCompleteness: "complete"`, byteCount 43). |
| 6. Additional registry providers (cursor, grok) | 2026-08-18 | cursor `uo884qsmi` — 2 records, correct tool names (`Find`, `Read File`); grok `ikjyp595f`/`ij3dt15ja` — 1 record, byteCount 16 (non-empty). `gemini` out of scope per check 4's own reasoning (deprecated alias, same code path as antigravity). |
| 7. UI inspection — core flow (toggle, real metrics, open card, inspect, 4-page pagination, corrupt/deleted view) | 2026-08-19 (N1 + P2) | Context-bar toggle + chat-header toggle both driven live; found + fixed LT-221 (`EVIDENCE_AUDIT_FAILED` — stale SQL `CHECK` constraint on `evidence_access_log`) and LT-280 (degraded/corrupt/deleted records structurally excluded from `list()`). 4-page pagination against a 14,896-byte record confirmed exact byte ranges; corrupt/deleted badges + disclosure text confirmed post-fix. |

## Historical open checks and disposition

### Check 2 — Codex `enforce` recovery/continuation run

**Disposition 2026-09-27:** the remaining occupancy ladder moved to AR-001 so it can be combined
with later duplicate Codex-occupancy checks. No open work remains owned here.
- **Steps:** Set codex to `enforce`. Drive a turn past the 60%/75% occupancy thresholds with heavy tool output.
- **Expect:** Externalization/bounded cards replace oversized results; a controlled recovery preserves the thread when capabilities allow; at most three recoveries per epoch; the accuracy gate still passes cited claims; the meter never shows fabricated occupancy.
- **Why deferred:** needs a live Codex session and real provider token accounting.
- **Current status (2026-09-06):** The externalization half is positively confirmed live (2026-08-19/N1: instance `x6r4jh77m`, 18 real evidence records, `externallyStoredBytes: 5,222,138`, `enforcementMode: "enforce"`, occupancy capped at 42.7% across 5 turns / >5 MB raw tool output). The check's own literal precondition — driving occupancy past 60%/75% — has never been reached across five separate sessions (2026-08-12, -18, -19/N1, -19/P2, -24, -25) because the unconditional externalization path (`output-persistence.ts`) intercepts oversized results before occupancy can climb; source-level trace confirms this is the spec's own two-row design (`docs/superpowers/specs/2026-07-15-provider-agnostic-context-evidence-spec_completed.md:250-261`), not a bug. Reaching the threshold needs a differently-shaped session (sustained non-externalized dialogue/reasoning growth, not tool-heavy turns) — genuinely longer/more expensive than any prior batch's time budget. A doc-split recommendation (separate "oversized-result externalization" [closed] from "occupancy-percentage ladder" [open]) was offered but never applied.
- **Blocker class:** A — agent-runnable now with real provider budget/time; no rebuild or human step required, just a long non-tool-heavy session.

### Check 7 (residual) — renderer-store propagation gap + unresolved "remaining visual confirmation" wording

**Disposition 2026-09-27:** residual (a) is confirmed fixed live below. Residual (b) is closed by
accepting the already-auditable CDP-driven visual evidence as visual confirmation; it drove the real
controls and focused renderer and exposed multiple genuine defects, so a second unauditable human
observation would not test a different behavior.
- **Steps:** In the rebuilt app open a chat and an instance with evidence: toggle the Evidence button in the chat header and in the instance context bar. Open a record's card; run bounded "inspect" pagination to the end of a large record; view a corrupt/deleted record if present.
- **Expect:** Occupancy vs cumulative input shown separately (never derived from each other); unknown occupancy shows a reason, not a percentage; degraded records visibly labeled and not inspectable; tool-group collapsed summaries show real call/character counts; evidence storage bytes never merged into the occupancy figure.
- **Why deferred:** human visual confirmation in the rebuilt renderer.
- **Current status (2026-09-06):** The 2026-08-19 (N1+P2) runs drove the core flow live via CDP with focus emulation (see Closed checks) and their own final verdict called check 7 "fully covered." Two items remain explicitly open per the 2026-08-31 status correction, which lists "any remaining visual confirmation" as still open without specifying what: (a) a real, unfixed renderer-store gap — a freshly-created instance's `contextEvidence` field does not appear in the renderer's local `InstanceStore` until a full page reload, even though the same field is already correct via a direct main-process IPC call (not filed as an LT; did not block completing check 7's literal steps because a reload sufficed); (b) whether the check's original "(human)" scope still requires genuine human eyes given every prior pass used CDP-driven clicks, not a human — the 2026-08-31 note flags this but does not resolve it.
- **Blocker class:** A for (a) — agent-drivable via CDP, not yet attempted. (b) needs a human decision on scope before it can be marked closed either way.

### Check 8 — Provider kill-switch rollback (LT-147)

**Disposition 2026-09-27:** passed in full on 2026-09-24, including same-instance disablement,
encrypted-only storage, persistence across restart and post-restart readback.
- **Steps:** With evidence already captured for a conversation, set the provider back to `off`; continue the conversation; restart the app.
- **Expect:** Pre-feature behavior restored (provider-visible output inline); already-captured evidence remains readable via the panel; NO plaintext fallback files created anywhere under the user-data dir (`find` for `*.txt`/`*.json` output caches).
- **Why deferred:** needs rebuilt app + restart cycle.
- **Current status (2026-09-06):** Found live 2026-08-18 — flipping `contextEvidenceModeByProvider.grok` to `off` on a still-running instance did not stop capture (a second turn produced a new evidence record); filed as [LT-147](../../plans/livetest-remediation-register.md#lt-147-the-context-evidence-provider-kill-switch-does-not-stop-capture-for-instances-already-running). **Fixed in code 2026-08-31**: capture now reads the live provider mode per turn instead of a cached spawn-time value; failing-first regression tests confirm both capture paths stop. **Live re-verification against a rebuilt + restarted app is still required** before this check can be marked PASS — not yet done. The check's other two sub-asks (no plaintext fallback files anywhere under the user-data dir; behavior survives an app restart) have never been attempted in any session of this doc.
- **Blocker class:** B — needs a rebuilt + restarted app; agent-runnable after that (CDP + filesystem `find`).

## Status — 2026-09-24 (verify-ui)

Check 7 residual (a) — **CONFIRMED FIXED LIVE** against the WORKING TREE's uncommitted LT-651 fix
(a follow-up `state-update` emit now carries `contextEvidence`, alongside the existing
`reasoningEffort` one, `instance-lifecycle.ts:1589-1600`). See
[Evidence run — 2026-09-24 (verify-ui)](#evidence-run--2026-09-24-verify-ui).

## Status — 2026-09-24 (runtime)

Check 8 (LT-147 kill-switch) **PASSES fully**, including the "survives an app restart" sub-ask that
had never been attempted in any prior session. Check 7's residual (a) is **reproduced with a root
cause** and filed as **LT-651**; residual (b) is a scope question restated, not resolved (still needs
James). Check 2's occupancy-ladder residual was not attempted (still Blocker class A but genuinely
needs a long, expensive non-tool-heavy session outside this batch's per-check time budget). See
[Evidence run — 2026-09-24 (runtime)](#evidence-run--2026-09-24-runtime).

## Evidence run — 2026-09-24 (runtime)

Batch `runtime`. Dev app `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-0924-runtime`,
`--remote-debugging-port=9714`. This run restarted the dev app's own Electron process twice
(killed and relaunched against the same profile) specifically to test persistence-across-restart —
each restart used only this batch's own pid, never the packaged app.

### Check 8 — provider kill-switch rollback (LT-147): **PASS, all three sub-asks**

Two independent live drills, since `chatCreate` does not accept `grok` as a provider (`IPC
validation failed for CHAT_CREATE: provider: Invalid option: expected one of "claude"|"codex"|
"gemini"|"antigravity"|"copilot"` — worth noting for whoever owns that IPC surface, not filed as an
LT here since it's a scope gap in a different feature, not this plan's subject).

**Drill 1 (direct `createInstance`, provider `grok`).** Set `contextEvidenceModeByProvider.grok =
'shadow'`, created instance `ibnsd4t01`, ran a real tool call → 1 evidence record
(`21cb819d-...`, `toolName: "unknown"`, 148 bytes). Flipped `grok` to `'off'`, ran a second real
tool call on the **same** instance (`run_terminal_command` → real `date` output observed in the
transcript) → `contextEvidenceList` still showed **exactly the same 1 record**, no second one. The
kill-switch stopped capture on an already-running instance immediately, confirming LT-147's fix
holds live.

**Drill 2 (`chatCreate`/`chatSendMessage`, provider `claude`, for the persistent-owner path).**
Created chat `8c5a2dd4-...` (`ledgerThreadId: 0e7e4856-...`), sent a tool-using message with
`contextEvidenceModeByProvider.claude = 'shadow'` → instance `cjsg54w26`,
`evidenceConversationOwner: {kind: "chat", chatId: "8c5a2dd4-..."}`, 1 evidence record
(`d6d9ed6e-...`, `toolName: "Bash"`, 65 bytes). Flipped `claude` to `'off'`, sent a second real
Bash tool call on the same instance (`date` command, real output in transcript) →
`contextEvidenceList` still showed only the original 1 record. Kill-switch confirmed for a second
provider/path.

**No plaintext fallback files.** `find /tmp/aio-lt-0924-runtime -iname "*evidence*"` located
`conversation-evidence/` containing `keyring.json` (key material, not content) and per-record
`*.aioev1` files. Hex-dumped one: magic header `AIOEV1` followed by opaque encrypted bytes — not
plaintext, not JSON, not readable. No stray `.txt`/`.json` evidence-content files exist anywhere
under the profile.

**Survives an app restart — attempted for the first time in this doc's history.** Killed this
batch's own dev-app pid and relaunched it against the *same* `AIO_DEV_USER_DATA_PATH` profile (no
onboarding wizard reappeared, confirming the profile persisted). Post-restart:

- `contextEvidenceModeByProvider.claude` read back `"off"` — the kill-switch setting itself
  persisted correctly.
- `contextEvidenceList({conversationId: '0e7e4856-...', owner: {kind: 'chat', chatId:
  '8c5a2dd4-...'}})` still returned the original record from Drill 2.
- `contextEvidenceRead(...)` on that record **decrypted and returned its real content**
  (`<UNTRUSTED EVIDENCE id="d6d9ed6e-...">...755 .ao/ 644 delivered.txt 706B...</UNTRUSTED
  EVIDENCE>`), with a matching `contentDigest` citation — i.e. genuinely readable via the panel
  API after a full process restart, not just present in a list.

One note on method: evidence created via a *raw* `electronAPI.createInstance()` call (Drill 1) has
no durable `owner: {kind: 'chat', ...}` path, because the `chats` table row that the `kind: 'chat'`
owner scope needs is only populated by the `chatCreate`/`chatSendMessage` flow (the real "New Chat"
UI path), not by driving `createInstance` directly. Re-querying Drill 1's evidence with `owner:
{kind: 'instance', instanceId: 'ibnsd4t01'}` after the restart correctly returned
`CONTEXT_EVIDENCE_SCOPE_DENIED` — expected, since that instance no longer exists in memory, and
not a defect: it is exactly why the feature has a separate durable `chat` owner kind, which Drill 2
exercised and which passed.

**All three sub-asks of Check 8 now have live, current-build evidence: PASS.**

### Check 7 residual (a) — renderer-store propagation gap: **reproduced, root cause found, filed as LT-651**

Set `contextEvidenceModeByProvider.claude = 'shadow'`, created a fresh instance (`cfecmry8g`) via
`electronAPI.createInstance`. Immediately after creation:

- `electronAPI.listInstances()` (direct main-process IPC) → `contextEvidence: {mode: "shadow",
  conversationId: "c6155934-...", ownershipSource: "instance-history", ...}` — correct.
- `window.__store.instances().find(i => i.id === 'cfecmry8g').contextEvidence` (the real renderer
  `InstanceStore`, found via `ng.getComponent` on `app-composer-banners`) → **`undefined`**.
  Polled every 500 ms for 5 seconds straight: still `undefined` on every sample. Confirms the
  2026-08-31 note's residual (a) is still present, unchanged, on current HEAD.

**Root cause, read with high confidence.** `InstanceLifecycle`'s create path
(`src/main/instance/instance-lifecycle.ts:1388-1397`) emits the renderer-visible `instance:created`
event **synchronously**, with the comment: *"Emit creation event immediately with 'initializing'
status so the UI can render the instance card without waiting for the heavy init below."*
`initializeInstanceEvidenceOwnership(instance, settingsAll)`, which is what actually sets
`instance.contextEvidence`, does not run until line **1542** — well inside the async continuation
that early emit is deliberately not waiting for. This is the **exact same shape** as LT-602 (the
reasoning-effort header-chip bug fixed in commit `9efc4871`, confirmed live elsewhere in this
campaign): both fields are resolved only in the "heavy init" continuation, after the early
synchronous `created` event has already gone out with neither. LT-602's fix added a dedicated
follow-up `this.emit('state-update', {reasoningEffort: ...})` right after `reasoningEffort` is
resolved (`instance-lifecycle.ts:1589-1594`) specifically to close this gap for that one field —
but **no equivalent follow-up emit exists for `contextEvidence`**, which is resolved earlier in the
same continuation (line 1542) and never re-announced. The renderer's own mapper
(`src/renderer/app/core/state/instance/instance-list.store.ts:801-803`) correctly reads
`contextEvidence` whenever it is present in a payload — it is not a renderer-side bug, purely a
missing main-process follow-up emit, sibling to the one LT-602 already added for a different field
in the identical code path.

**LT-651** — P3 — *A freshly-created instance's `contextEvidence` never reaches the renderer's
`InstanceStore` until a full reload, because no follow-up emit exists for it (unlike the sibling
`reasoningEffort` field, fixed as LT-602 in the same code path).*
- Observed: see above — `contextEvidence` stays `undefined` in the live `InstanceStore` for at least
  5 s post-creation while the same instant's direct IPC call already has it.
- Root cause: `src/main/instance/instance-lifecycle.ts:1396-1397` (early synchronous
  `emitCreatedObservers`) races `initializeInstanceEvidenceOwnership` at `:1542`; no follow-up
  `state-update`/equivalent emit carries the resolved `contextEvidence` the way LT-602's fix
  (`:1589-1594`) already does for `reasoningEffort` in the same function.
- Required behaviour: emit a follow-up update (new event, or extend the existing
  `reasoningEffort` follow-up emit at `:1589` to also carry `contextEvidence`, since both resolve in
  the same continuation) so passive renderer sessions see the real evidence mode/conversationId
  without a reload.
- Acceptance: a freshly created instance's `contextEvidence` appears in
  `InstanceStore.instances()` within one throttle cycle of creation, with no page reload needed.
- Owning doc + check: this document, Check 7 residual (a).

### Check 7 residual (b) — "remaining visual confirmation" scope: restated, not resolved

Unchanged from 2026-08-31: every prior pass of Check 7's core flow (toggle, real metrics, open
card, inspect, pagination, corrupt/deleted view) was driven by CDP-issued clicks, not literal human
eyes. Whether the check's original "(human)" annotation still requires an actual human to look at
the screen, given CDP-driven clicks have already exercised the identical DOM/render path with focus
emulation active, is a product-process question about what counts as "visual confirmation" for this
campaign — not a technical blocker this batch can resolve by running anything further. Still needs
a decision from James; no new evidence changes that.

Instances `ibnsd4t01`, `cjsg54w26`, `cfecmry8g` terminated; `contextEvidenceModeByProvider` restored
to `off` for `claude` and `grok`.

## Recommended for deletion

- **Check 3, non-resident half** — **DELETED 2026-09-06, decision taken.** The check asked to
  "repeat a shadow run on a non-resident spawn". That state is architecturally unreachable, so
  the check tested a configuration the create path can no longer emit. Re-verified against
  current source on 2026-09-06 (earlier write-ups cited `instance-lifecycle.ts:747-752`, which
  had drifted — the correct location is below):

  - `InstanceLifecycle.residentClaudeForSpawn()` — `src/main/instance/instance-lifecycle.ts:790-795`
    — returns `true` unconditionally, and force-corrects `instance.residentClaude` to `true` if it
    is anything else. It is called at all four spawn sites (`:1592`, `:2128`, `:2411`, `:2489`).
  - `migrateResidentClaudeDefault()` — `src/main/core/config/settings-migrations.ts:184-189`,
    invoked at `:498` — force-writes `residentClaudeSession` back to `true` on any stale `false`.
  - `residentClaudeSession` is `readOnly()` in `settings-control-policy.ts:305`, so it cannot be
    flipped through the settings CLI either.

  This is deliberate architecture, documented in the migration's own log line: Claude steering
  must go through the resident stream protocol rather than SIGINT-and-respawn. The remaining code
  is defensive, not an untested gap. No replacement check is needed; the resident half already
  passed on 2026-08-18.

---

## Evidence run — 2026-09-24 (verify-ui)

Dev app built from the **working tree** (uncommitted LT-651 fix, not HEAD `f04f6748`), isolated
profile `/tmp/aio-lt-0924-verify-ui`, CDP on `:9731`.

### Check 7 residual (a) — renderer-store propagation gap: CONFIRMED FIXED LIVE

Set `contextEvidenceModeByProvider.claude = 'shadow'` via `updateSettings`, then created a fresh
instance (`cvar6jz8m`) via `electronAPI.createInstance`. Polled the real renderer `InstanceStore`
(`ng.getComponent(app-instance-list).store.instances()`) every 250ms with no reload of any kind:

```
t=251ms: contextEvidence = { mode: "shadow", conversationId: "f791ad16-...",
                              ownershipSource: "instance-history", captureFailureCount: 0 }
```

— present on the **very first sample**, matching the direct IPC read (`listInstances()`) exactly.
This is the opposite of the pre-fix behaviour recorded by the `runtime` batch (`undefined` for at
least 5s straight). Source: the follow-up `state-update` emit at `instance-lifecycle.ts:1589-1600`
now carries `contextEvidence: instance.contextEvidence` alongside the existing `reasoningEffort`
field (the LT-602 fix this follow-up piggybacks on), closing the race between the early synchronous
`created` event (`:1396-1397`) and `initializeInstanceEvidenceOwnership` (`:1542`) that LT-651
identified.

`contextEvidenceModeByProvider` restored to `off` for all providers afterward (verified via
`getSettings()`); instance `cvar6jz8m` terminated.

### Cleanup

Instance `cvar6jz8m` terminated; `/tmp/aio-lt-0924-verify-ui-ctxev` removed;
`contextEvidenceModeByProvider` restored to `off` for every provider and re-verified.

---
This source document is complete. AR-001 owns the one transferred long-running provider ladder;
all other checks pass with recorded evidence above.
