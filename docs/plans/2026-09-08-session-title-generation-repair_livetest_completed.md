# Session Title Generation Repair — Live Test

## Current status — 2026-09-27 (closure run)
Open: 0 · Closed: 5 · Partial: 0 · Failed: 0

The rebuilt 2026-09-27 dev runtime closed LT-B, LT-C and LT-E. The historical
2026-09-08 run remains below as the original reproduction evidence; the closure
evidence is recorded after LT-E.

## Status — 2026-09-08 (run; superseded as current status)
Open: 0 · Closed: 2 · Partial: 2 · Failed: 1

**Run against the live packaged app**, not a dev build. `/Applications/Harness.app`
was packaged at 09:12 from this shared working tree and started at 09:16, so it
already contains every production change here. Verified by extracting from
`app.asar` before running anything: `auxiliary-routing-diagnostics.js` present
with the new log string, `finalizeGeneratedTitle` and `deriveRailTitle` present,
`migrateTitleGenerationFrontierFallbackReenable` present, and the shipped
`titleGeneration` default reading `maxOutputTokens: 1536, allowFrontierFallback:
true`. No restart was needed and none was performed — restarting would have
killed live sessions.

**Two defects found. See LT-C and LT-E.**

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. A pending or unrun check is
> not automatically a defect, but a *reproduced* one belongs there, not only here.
> Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-08-session-title-generation-repair_plan_completed.md](2026-09-08-session-title-generation-repair_plan_completed.md)

**Prerequisites:** the coordinator app **rebuilt and restarted** (`npm run build`). The
running instance predates this change: it holds the old `titleGeneration` slot config in
memory, has no reason-recording in its routing path, and cannot emit the new log lines.
windows-pc connected with its Ollama serving models.

**Why these cannot run in-loop:** every one of them is about what the *routing runtime*
does against the real worker. The unit tests prove the new code paths behave correctly given
an input; they cannot tell us which gate the live health engine is actually closing, because
until this change nothing recorded it.

---

## LT-A — the real reason auxiliary routing falls back

**This is the open question the plan could not close.** On 2026-09-07, 94% of all auxiliary
decisions fell back with green health probes, and the code discarded the reason. A1 now
records it.

Steps:

1. Rebuild and restart the app. Start a new session with a first message over 10 characters.
2. Wait ~30s, then:
   ```bash
   grep '"message":"Auxiliary slot fell back to no local model"' \
     ~/Library/Application\ Support/harness/logs/app.log | tail -20
   ```

Expected: either no such lines (routing now succeeds), or lines whose `detail` names the
specific gate — one of `health-<state>`, `freshness-check-failed`, `role-not-routable`,
`lifecycle-<state>`, `model-inventory-probe-failed`, `required-models-missing`,
`endpoint-advertises-no-models`, `no-model-for-tier-quick`, or the
"nothing was even a candidate" message.

### RESULT — CLOSED. The answer is `health-unavailable`, not the reasoning model.

Observed, verbatim from `harness/logs/app.log`:

```
09:16:38 warn AuxiliaryRouting  slot=compression
  detail="No auxiliary endpoint was even a candidate (none configured, discovered, or enabled)"
09:16:38 warn AuxiliaryRouting  slot=titleGeneration
  detail="No auxiliary endpoint was even a candidate (none configured, discovered, or enabled)"
09:17:07 warn AuxiliaryRouting  slot=titleGeneration
  detail="No healthy auxiliary endpoint/model available —
    worker:bb62e3ee-…:ollama:127.0.0.1:11434: health-unavailable;
    worker:bb62e3ee-…:openai-compatible:127.0.0.1:1234: endpoint-heartbeat-unhealthy"
```

Two distinct causes, in order:

1. **At app start, before the worker connects**, there are no candidate endpoints
   at all — auxiliary work dispatched in that window can never route locally. This
   is what the startup history backfill hits (all 20 of its attempts, see LT-D).
2. **After the worker connects**, the enrolled ollama target is
   `health-unavailable` — the health engine's own verdict — while its lightweight
   probes are green. That is the gate that closed on ~94% of decisions.

**A3's second half is confirmed unnecessary.** The reasoning-model hypothesis was
wrong: `pickModelForTier` never got the chance to pick anything, because the
target was ineligible before model selection. Do not implement it.

**Where to look next** (not investigated here): `local-ai-health-engine.ts:186-209`
latches `candidateState='unavailable'` with `routableRoles=[]` while
`previousCopy.flapping` is set and `recovered` is false, and this target's config
has `recovery: { automatic: false }`. That combination can hold a target
unavailable indefinitely regardless of probe results. **Unverified** — stated as
the next place to look, not as a diagnosis.

Status: **closed — question answered**

---

## LT-B — a new session actually gets an AI title

Steps:

1. Start a new session with a distinctive multi-word first message.
2. Watch the rail for ~30s.
3. ```bash
   grep '"subsystem":"AutoTitle"' ~/Library/Application\ Support/harness/logs/app.log | tail -5
   ```

Expected: an `Auto-titled instance (instant)` line followed within ~15s by an
`Auto-titled instance (AI)` line, and the rail title changing to the AI one. Before this
change roughly 20% of sessions reached the second line.

### RESULT — PARTIAL. Titles do now generate, but not reliably.

Four sessions since restart:

```
09:17:07 instant  'What is this, I am not quite sure I understtand?'
09:20:25 instant  "I think a lot of emails we're getting for android testers..."
09:24:19 instant  'Upgrade angular to the latest version of angular 22'
09:24:26 AI       'Upgrade Angular 22'          <- upgrade landed, 7s later
```

`Upgrade Angular 22` is a real AI title from the local model — the mechanism
works end to end. But only 1 of 4 sessions got one, and the 09:20 session is a
confirmed miss with a known cause (LT-C).

Status: **partial**

---

## LT-C — the escalation actually reaches a CLI, and is attributed

Confirms B2 works end to end and that the cost is visible rather than hidden.

Steps:

1. With the local worker deliberately unavailable (stop Ollama on windows-pc, or disconnect
   the worker), start a new session with a real first message.
2. ```bash
   grep aux:titleGeneration \
     ~/Library/Application\ Support/harness/cost-attribution/cost-attribution-$(date +%F).jsonl \
     | tail -5
   ```

Expected: at least one record with a real `provider` (`antigravity`, `claude` or `codex`) and
a fast-tier `model`, not `local-fallback`. The session gets an AI title.

### RESULT — FAILED. The escalation never fires, and cannot be seen.

Cost attribution since restart (`aux:titleGeneration`):

```
21  local-fallback  (none)
 2  ollama          deepseek-r1:7b   out=450, out=380
```

Across all of September there is **not one** CLI-provider title record —
only `local-fallback` (4224) and `ollama` (395). `claude` and `codex` are both on
PATH.

The decisive case is 09:20:31: the local model succeeded (450 output tokens,
inside the new 1536 budget), `finalizeGeneratedTitle` correctly rejected its
output, and the code then fell through to the CLI escalation — which produced no
attribution record and no title. Whether it bailed at `!cliType`, at
`!hasSendMessage`, or threw inside `send` **cannot be determined**: all three exits
are `logger.debug` or a bare `catch { return null; }`, and debug is not persisted
(`grep -c '"level":"debug"' app.log` = 0).

This is a defect in the B3 work: the abandonment logging added there covers only
the `!allowFrontierFallback` branch. The branch that actually runs now that
escalation is enabled is still silent — the same class of fault this whole change
set out to remove.

Status: **FAILED — see LT-533 in the remediation register**

---

## LT-D — the backfill retry storm is gone

Steps:

1. With title generation failing (worker unavailable, as LT-C step 1), open the history view
   and refresh it five times over a couple of minutes.
2. ```bash
   sqlite3 ~/Library/Application\ Support/harness/rlm/rlm.db \
     "select count(*) from local_ai_routing_events
      where slot='titleGeneration' and created_at > strftime('%s','now','-5 minutes')*1000;"
   ```

### RESULT — CLOSED, decisively.

`local_ai_routing_events` for `titleGeneration`, split at the 09:16 restart:

```
BEFORE restart (old code)   200 events   09:10:47 -> 09:10:49   (2 SECONDS)
AFTER  restart (new code)    21 events   09:16:38 -> 09:17:07   then silent 8+ min
```

The old code fired 200 attempts in two seconds on a history refresh. The new
code makes one bounded startup pass (20 entries) and then stops, because the
negative cache suppresses the retry. Exactly the intended behaviour.

Status: **closed — pass**

---

## LT-E — a session's title survives leaving and re-entering the live rail

The fault James reported directly. Unit tests cover the resolvers; this covers the real
round trip through persistence and restore.

Steps:

1. Start a session whose first message is multi-line, with a distinctive first line
   (e.g. `Read-only diagnostic.` then several more lines).
2. Note the exact rail title.
3. Terminate the session so it moves to the history rail. Note the title again.
4. Restore it from history. Note the title again.
5. Repeat with a session started from a file attachment plus a generic message
   (`please fix this` + a pasted image), which is the `Pasted-image-9.png fix` -> `Fix` case.

Expected: the title is byte-identical at all three points, in both scenarios.

### RESULT — PARTIAL. Large improvement, one self-inflicted bug remaining.

Measured by running the real shipped resolvers over the live 2,000-entry history
index (data check, not a UI walkthrough — see caveat below):

```
                                        before fix    after fix
rendered over the 60-char rail limit        188           0
genuine deterministic drift (aiTitle null)  222          47
```

The rail-overflow class is completely gone. Deterministic drift is down ~79% but
not zero, and the residue splits into two causes:

**(a) A real ordering bug I introduced — fixable.** The two resolvers apply
sanitize and truncate in opposite orders. `resolveEffectiveInstanceTitle`
sanitizes then truncates, so a long title keeps the `...` that `truncateForRail`
adds. `getConversationHistoryTitle` truncates inside `deriveRailTitle` then
sanitizes, and `sanitizeGeneratedTitle`'s `.replace(/[.!?]+$/, '')` strips that
same `...` off. Result:

```
live : "Daily health check of the Dingley Assessment servers and..."
hist : "Daily health check of the Dingley Assessment servers and"
```

A one-character disagreement, but it is exactly the reported fault and it is mine.

**(b) Structural, not fixable here.** `truncatePreview`
(`history-manager.ts:1739`) collapses all whitespace — `text.replace(/\s+/g, ' ')`
— before storing `firstUserMessage`. A history entry therefore has **no line
structure at all**, so `deriveRailTitle`'s "first line only" rule cannot be
reproduced from it for any multi-line prompt. Closing this would mean changing
what is archived, which is beyond this plan.

```
live : "Clrsoftware.co.uk"
hist : "Clrsoftware.co.uk Anything here we can steal for our"
```

**Caveat on method.** This is a data-level check over archived entries, not the
UI walkthrough the steps describe: it feeds each entry's archived `displayName`
into the live resolver. It is a fair test of the deterministic cases (which is
where the residue is) but it cannot exercise the live-instance path, so the
terminate -> restore round trip in the real UI is still unwalked. The 232
additional mismatches where `aiTitle` is set are an artefact of this method, not
a fault — the history side correctly shows the better AI name.

Status: **partial — see LT-534 in the remediation register**

---

## Closure evidence — 2026-09-27 rebuilt dev runtime

### LT-B and LT-C — closed

A new read-only Codex session (`xrewp0sr4`) began with the instant title
`Read-only title provider fallback check for nebula audit...`. The first installed fast-tier
provider, Antigravity, failed with `agy exited with code 1`. The rebuilt runtime persisted that
specific provider, model, error, working directory and elapsed time, continued to the next eligible
provider, and Claude/Haiku generated `Nebula audit fallback complete`. `listInstances` then returned
both `displayName` and `aiTitle` as exactly that value.

This run exposed one additional reliability defect: the escalation previously stopped after the
first installed CLI even when the provider failed before returning a response. That defect is
recorded and fixed as [LT-661](livetest-remediation-register.md#lt-661). The regression test failed
on the original selection loop and passes after the ordered failover fix. A returned response,
including unusable output, remains terminal so the fix does not multiply paid calls after a provider
has answered.

Status: **closed — live AI title, attributed fallback and specific failure evidence confirmed**

### LT-E — closed

The full persistence path was exercised twice for each of these live sessions:

| case | live title | history title after cycle 1 | restored title after cycle 2 |
|---|---|---|---|
| multiline first message | `Orion ledger complete` | `Orion ledger complete` | `Orion ledger complete` |
| attachment + `please fix this` | `Pasted image 9 fix` | `Pasted image 9 fix` | `Pasted image 9 fix` |
| filler safety valve (`work`) | `aio-lt-title-20260927` | `aio-lt-title-20260927` | `aio-lt-title-20260927` |

For each case the sequence was live instance → terminate/archive → history → restore → terminate
again → same history entry → restore again. The history IDs stayed fixed while `originalInstanceId`
advanced to the newly restored instance, proving re-archival updated the durable entry rather than
creating a parallel record. Titles were byte-identical at every measured boundary. The attachment
message and its PNG metadata also survived both restores, and the filler valve did not replace one
low-information title with another.

Status: **closed — two complete fixed-point round trips passed**
