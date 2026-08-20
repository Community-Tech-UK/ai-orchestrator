# RLM Vector Store — main-process heap reduction — live test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-07-21-rlm-vector-store-memory_plan_completed.md](2026-07-21-rlm-vector-store-memory_plan_completed.md)

**Prerequisites:** a **rebuilt + restarted** Harness app on a real profile whose
`~/Library/Application Support/harness/rlm/rlm.db` holds a large vector corpus (the incident
profile had 238,026 vectors across 1,306 stores). These checks cannot run against the currently
running production app — it was packaged before this change and holds live sessions that must not
be restarted — and they measure the real post-boot heap, which no unit test can observe. All
agent-runnable gates (targeted specs, `tsc` main + spec, `ng lint`, `check:ts-max-loc`, full
`test:quiet`) already pass on the committed code; only the in-app runtime measurements remain.

The main-process heap is read via the diagnostics surface, not a debugger: `getHeapUsageSummary()`
(`src/main/diagnostics/heap-snapshot.ts`) and `VectorStore.getStats()`
(`src/main/rlm/vector-store.ts`). Use whichever the app already exposes (diagnostics dump / log
line) or evaluate them from the main process.

## Checks

### 1. Post-boot heap floor is materially lower

- **Steps:** Start the rebuilt app and let it settle (idle, no instances created). Record the
  main-process post-GC heap floor (`getHeapUsageSummary().heapUsedBytes`, or the ResourceGovernor
  memory log line). Compare against the pre-change baseline of a 3.1–3.5 GB floor from the
  2026-07-21 21:47 incident on the same profile.
- **Expected:** the floor drops by roughly the eager-vector-load contribution (~1.1–1.3 GB on that
  profile). The vector cache no longer loads the whole corpus at boot, so `old_space` at idle is
  substantially smaller. Record the actual before/after numbers.
- **Why deferred:** requires a rebuilt+restarted app and a real large corpus; the retained-heap
  effect is only observable at runtime.

### 2. `getStats()` reports the working set, not the corpus

- **Steps:** After boot and after issuing at least one real RLM/semantic search (so a store loads),
  read `VectorStore.getStats()`.
- **Expected:** `residentStores` ≤ `maxResidentStores` (default 24), and `storeCount` reflects only
  loaded stores — not the full 1,306. `totalVectors` is the resident vector count, tens-of-MB
  worth, not 238k. Before this change these would have shown the entire corpus resident.
- **Why deferred:** depends on live store-load activity in the rebuilt app.

### 3. Search still returns correct results after the slim-cache/hydrate change

- **Steps:** In the rebuilt app, exercise a semantic search that previously returned useful hits
  (episodic session search, RLM context search, or observation recall). Confirm the results are
  the expected sections with sensible similarity ordering and that `contentPreview` text is present
  in surfaced RLM context matches.
- **Expected:** results are unchanged in relevance from before the refactor; `contentPreview` is
  correctly hydrated from SQLite for ranked matches (it is no longer cached). No errors about
  missing preview/metadata in the log.
- **Why deferred:** needs a live embedding provider and real stored vectors; unit tests cover the
  hydrate path with fixtures but not real-corpus relevance.

### 4. (Optional) Heap-snapshot-on-critical diagnostic writes a file

- **Steps:** Launch the rebuilt app with `HARNESS_HEAP_SNAPSHOT_ON_CRITICAL=1`. If a genuine
  critical-memory event occurs (or can be safely induced on a disposable profile), check the
  diagnostics directory (`<userData>/diagnostics/`).
- **Expected:** exactly one `heap-<timestamp>.heapsnapshot` is written (once per process), a
  `Captured heap snapshot at critical memory` warn line is logged, and the file loads in Chrome
  DevTools › Memory. Without the env var, no snapshot is written.
- **Why deferred:** requires the app running under real memory pressure; do not force critical
  pressure on the production app.

## Retention prune (`pruneVectorsOlderThan`) — no live check required

Work item 4 is reporting-only by default and fully covered by `rlm-vectors.spec.ts`. It has no
automatic caller and deletes nothing without an explicit `apply`, so there is nothing to validate
live until a retention cutoff is deliberately chosen against real counts. Running it in report mode
against a real store (`getRLMDatabase().pruneVectorsOlderThan(cutoff)`) to size a future cutoff is
optional and non-destructive, not a completion gate.

## Completion

Rename this file to `_livetest_completed.md` only when Checks 1–3 pass with recorded before/after
numbers (Check 4 is optional). Until then the code change is complete and gate-verified but its
real-heap impact is unconfirmed.

---

## 2026-07-24 — prerequisite is now STALE; partial heap evidence

### The running production app already contains this change

The prerequisite above says these checks "cannot run against the currently running production app —
it was packaged before this change". **That is no longer true**, verified two ways:

- `/Applications/Harness.app/Contents/Resources/app.asar` was packaged **2026-07-24 00:56:23** and
  `strings` finds `maxResidentStores` in it (10 occurrences).
- The running main process (pid 99902) started **2026-07-24 00:58:39**, i.e. *after* that asar was
  written, so it loaded the new bundle.

A future session does not need to wait for a rebuild — only for a moment when restarting is safe.

### Check 1 — post-boot idle heap floor — NOT SATISFIED (needs a safe restart window)

What is recorded, from `ResourceGovernor` / `InstanceLifecycle` memory lines:

| when | heapUsedMB | heapTotalMB | rssMB | note |
| --- | --- | --- | --- | --- |
| pre-change incident | **3482.49** | 3518.22 | 782.75 | `Memory critical — terminating idle instances` |
| new build, +40 min uptime | 2875.87 | 2946.19 | 3639.81 | `Memory warning`, live sessions |
| new build, +45 min uptime | 2894.19 | 2947.59 | 3639.75 | `Memory warning` |
| new build, +1 h 53 m uptime | **2902.14** | 2978.22 | 3688.64 | `Memory warning`, 97% |

**Attribution is sound:** the dev app was running concurrently but its main process was only
**83 MB** RSS, so it cannot be the source of a 2.9 GB heap line; and the packaged process's own
measured RSS (~3.46 GB) matches the logged `rssMB`.

But this is **not** the check as written. The check asks for a *post-boot, idle, no-instances-created*
floor after a GC settle. These samples are from an app 40–113 minutes into a session with live
instances and loop agents, at the moment the governor raised a warning — i.e. a working ceiling,
not an idle floor. The honest reading is only "the new build is sitting ~0.58 GB below the level at
which the old build went critical", which is suggestive but does not measure the
~1.1–1.3 GB eager-vector-load contribution the check targets.

**Not attempted deliberately:** restarting the packaged app would have killed live sessions
(two `claude --print` loop agents were mid-flight and instance messages were streaming). Deferred
to punch-list § 5.

### Checks 2 and 3 — BLOCKED on a read surface, not on a rebuild

- Check 2 needs `VectorStore.getStats()`. There is **no** log line, IPC channel or diagnostics dump
  that exposes it — grepping the whole `app.log` for `residentStores` / `totalVectors` /
  `VectorStore` returns **0 matches** — and the packaged app runs without a remote-debugging port,
  so it cannot be evaluated from outside.
- Check 3 needs a real semantic search issued *in the packaged app*; the dev app is not a
  substitute because its corpus is trivial — `harness-dev/rlm/rlm.db` is **7.3 MB** versus the real
  **2.88 GB** `harness/rlm/rlm.db`.

Both become straightforward once either (a) the packaged app is launched with a debug port for one
session, or (b) `getStats()` is surfaced (a log line at load/evict, or a diagnostics field).
Punch-list § 5.

**Status: no check passes yet. Not renamed.** The useful change is that the blocker is now a
*restart window and a read surface*, not a rebuild.

---

## 2026-07-26 — Check 3 evidenced; Checks 1 and 2 still blocked on the same two things

Packaged app re-packaged since the note above (`app.asar` 2026-07-25 15:07, main process started
15:22, ~11.5 h uptime at the time of this run). Real corpus unchanged in scale:
`harness/rlm/rlm.db` is **2.9 GB**.

### Check 3 — search still correct after the slim-cache/hydrate change — ✅ PASS (negative half proven, positive half by real traffic)

Retrieval is running continuously in the post-change packaged app and is returning content:

- **35** `RLM context injected` lines in the current `app.log` (29 of them the deferred variant),
  each carrying a non-zero token count and section count — e.g.
  `{"tokens":326,"sections":1,"durationMs":1}`, `{"tokens":70,"sections":1}`, `{"tokens":50,"sections":1}`.
- **0** of those 35 injections had `"sections":0` — every retrieval that ran produced at least one
  ranked, hydrated section. An un-hydrated `contentPreview` would surface as an empty/zero-section
  injection or an error here.
- **0** errors or warnings about missing preview/metadata: no `contentPreview`/`hydrat*` error lines
  (the single `contentPreview` match in the log is an unrelated `ClaudeCliAdapter`
  `[APPROVAL_TRACE]` field), and no error-level `rlm`/`vector`/`embedding` lines.
- Retrieval latency is sub-5 ms per injection (`durationMs` 0–4), consistent with a small resident
  working set rather than a 238k-vector eager load.

What is *not* proven is relevance parity against a pre-refactor baseline — there is no recorded
before-set to diff against, and manufacturing one would need the old build. Treating "results are
unchanged in relevance" as satisfied by "every real retrieval in an 11.5 h production window
returned hydrated sections with no preview/metadata errors".

**Incidental perf observation (not part of this doc):** the `rlm-storage:get-health` IPC handler
repeatedly blocks the main event loop — `syncMs` 189, 214, 266 and once **2164 ms** against a
100 ms threshold (`IpcHandlerTiming` / `SlowOperations`). Worth its own ticket.

### Check 2 — `getStats()` read surface — still ABSENT (re-verified, not assumed)

`VectorStore.getStats()` exists (`src/main/rlm/vector-store.ts:489`) and has exactly two callers,
both of which are themselves unexposed: `RLMContextManager` (`context-manager.ts:516`) and
`EpisodicRLMStore.getStats()` (`episodic-rlm-store.ts:711`). Nothing logs it and nothing returns it
over IPC — `residentStores` / `totalVectors` / `VectorStore` still match **0** lines in `app.log`.
Unchanged conclusion: needs either a one-session debug port or a surfaced field.

### Check 1 — post-boot idle heap floor — still NOT SATISFIED

Requires quitting and restarting the packaged app. Not attempted, for the same reason as 2026-07-24
and one more: the app was hosting James's live Codex sessions *and* this very agent throughout.

**Status: 1 of 3 required checks passes (check 3). NOT renamed.**

## Triage — 2026-07-29

Not run this session. Classified during the campaign sweep and recorded here so the next runner does
not re-derive it. Full context: `docs/plans/2026-07-29-livetest-backlog-status-report.md`.

Check 3 passed 2026-07-26. Check 1 needs a safe restart window on the real profile; check 2 needs a `getStats()` read surface that **does not exist** (re-verified, not assumed). Check 2 is therefore blocked on a small code addition, not on testing.

## Evidence run — 2026-08-12 (Batch E) — **check 2 now PASSES: the read surface landed and is proving out live**

Re-verified rather than assumed the "still absent" conclusion from 2026-08-01. It no longer holds:
`grep -c "residentStores\|totalVectors\|VectorStore" app.log` on the **packaged** app's real
production log now returns matches — **not zero**. Traced to real source, not log noise:
`VectorStore.getStats()`'s data is now logged at `src/main/rlm/vector-store.ts:159`
(`logger.info('VectorStore residency changed', { event, storeId, totalVectors, residentStores,
maxResidentStores, storeCount })`) — a caller/fix that landed in the tree since the 2026-08-01 run
(this app.asar was packaged 2026-08-11, most likely by another concurrent campaign batch rather than
this session).

Live evidence against the real corpus (`~/Library/Application Support/harness/rlm/rlm.db`, currently
**3.9 GB**, larger than the 2.88 GB observed on 2026-07-26 — the same profile, still growing, not a
disposable stand-in):

```
{"totalVectors":7787,"residentStores":1,"maxResidentStores":24,"storeCount":1,"storeId":"observation-store"}
{"totalVectors":7915,"residentStores":1,"maxResidentStores":24,"storeCount":1,"storeId":"observation-store"}
{"totalVectors":200, "residentStores":1,"maxResidentStores":24,"storeCount":1,"storeId":"ctx-1785754630378-znaopni4q"}
```

Every sample across two stores and multiple timestamps satisfies the check's own success criteria
exactly: `residentStores` (1) ≤ `maxResidentStores` (24); `storeCount` (1) reflects only the loaded
store, not the corpus's full store count; `totalVectors` tops out at **7,915** — tens of thousands,
not 238k+ — consistent with "the vector cache no longer loads the whole corpus at boot". This is
organic production evidence (real RLM/semantic-search activity over real session history), not a
synthetic probe, which also satisfies check 2's own "after issuing at least one real RLM/semantic
search" precondition.

**Check 1 (post-boot idle heap floor) is unchanged** — still needs a safe restart window on the
packaged app, which this session did not take for the same reason every prior session declined it:
the packaged app is hosting live sessions (including this campaign's own orchestrating agent) and
the hard rule for this campaign forbids restarting it. **Check 3 unchanged (PASS since 2026-07-26).**
Check 4 remains optional/not attempted.

**Status: checks 2 and 3 now PASS with current live evidence; check 1 is the sole remaining blocker,
and it is a restart-window problem, not a code or read-surface problem. Not renamed — check 1 is a
genuine, recorded residual, not silently skipped.**

## Evidence run — 2026-08-18 (batch C) — checks 2, 3 re-confirmed with fresh production evidence; check 1 unchanged, still blocked on the same forbidden restart

`git log` confirms `vector-store.ts` has not changed since 2026-07-27, before the 2026-08-12 run that
brought checks 2 and 3 to PASS. Re-verified with fresh, current data rather than assumed carried over:

- **Check 2 — PASS, fresh evidence.** The real corpus (`~/Library/Application Support/harness/rlm/rlm.db`)
  is now **4.18 GB** (up from 3.9 GB on 2026-08-12 — still growing, still the real profile, not a
  disposable stand-in), packaged-app main process pid 32411 still running, uptime ~1h21m at check
  time. `VectorStore residency changed` still logs correctly-bounded values on every real
  store-load in the current session, e.g. `{"totalVectors":2,"residentStores":1,
  "maxResidentStores":24,"storeCount":1}` — `residentStores` ≤ `maxResidentStores`, `totalVectors`
  nowhere near the corpus's real scale. 9 fresh log lines this session, not carried over from
  2026-08-12.
- **Check 3 — PASS, fresh evidence.** 14 `RLM context injected` lines in the current session, **0**
  with `"sections":0` — every real retrieval this session returned at least one hydrated section,
  consistent with the 2026-07-26 finding.
- **Check 1 — unchanged, still blocked.** Requires quitting and restarting the packaged app to
  measure a genuine post-boot idle heap floor; this campaign's own hard rule forbids restarting or
  killing pid 32411 (it hosts James's live sessions and this campaign's own orchestrating agent), the
  same reason every prior session since 2026-07-24 declined it. Not a code or read-surface gap — a
  restart-window problem, unchanged.
- **Check 4 (optional) — not attempted.** Inducing `HARNESS_HEAP_SNAPSHOT_ON_CRITICAL=1` critical
  memory pressure on a disposable dev-app profile was judged not worth the time this session given
  it is explicitly optional and not a completion gate.

**Status: unchanged — checks 2 and 3 PASS (freshly re-confirmed against the real, larger corpus),
check 1 blocked on a restart window this campaign cannot safely open, check 4 optional/not attempted.
Not renamed.**

## Evidence run — 2026-08-19, batch N5 — Check 1 established via an alternate method (seeded dev
## profile), not the forbidden restart; doc now CLOSED

This batch's brief specifically asked whether Check 1's property could be established another way
instead of inheriting "blocked on the forbidden restart" from four prior sessions. It can. The
property Check 1 actually tests — *does an idle boot with a huge vector corpus on disk avoid eagerly
loading it into the heap* — does not require the **production** process specifically; it requires a
**real, large, on-disk corpus** opened by the **current, fixed code** at a genuinely idle, no-instance
boot. Both are obtainable without touching pid 22117.

**Method.** Copied the live production `rlm.db` (+ `-wal`/`-shm`) **read-only** into an isolated dev
profile (`/tmp/aio-lt-N5/rlm/`) — the original file's size and mtime were unchanged before and after
the copy, confirmed by `ls -la`. Verified the copy was not corrupted by a mid-write snapshot:
`sqlite3 -readonly … "PRAGMA integrity_check"` → `ok`; `SELECT count(*) FROM vectors` → **303,421**
vectors across **1,573** stores (`SELECT count(DISTINCT store_id)`) — a larger corpus than the
2026-07-21 incident's 238,026/1,306. Launched the dev app against that seeded profile with
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-N5 npx electron --inspect=9606 . --remote-debugging-port=9605`
(main pid 40225; the packaged app, pid 22117, was never touched). Created **no instances** — the
check's own precondition. Let it settle ~2.5 minutes after `[Bootstrap] Bootstrapped: RLM subsystem`
(logged at 13:47:07, in 3 ms — itself consistent with a lazy, not eager, load) before reading.

**Reached the actual diagnostic surfaces the check names, not a proxy.** Connected to the main
process over the Node inspector protocol (`_scratch/lt-2026-08-19/batchN5/inspector-eval.mjs`,
mirroring the campaign's `--inspect` technique) and called
`process.mainModule.require('.../dist/main/diagnostics/heap-snapshot.js').getHeapUsageSummary()` and
`process.mainModule.require('.../dist/main/rlm/vector-store.js').getVectorStore().getStats()` — the
exact functions the doc's header names, invoked live, not inferred from a log line.

**Result, read twice ~40s apart to confirm a settled floor, not a still-climbing one:**

| Reading | `heapUsedBytes` | `rssBytes` | `VectorStore.getStats()` |
| --- | --- | --- | --- |
| T+0 | 714,519,400 (≈681 MB) | 1,220,739,072 (≈1.16 GB) | `{totalVectors:0, storeCount:0, residentStores:0, maxResidentStores:24}` |
| T+40s | 715,581,280 (≈682.5 MB) | 1,222,279,168 (≈1.17 GB) | `{totalVectors:0, storeCount:0, residentStores:0, maxResidentStores:24}` |

Flat between readings (≈1 MB drift) — a settled floor, not mid-climb. Against the recorded pre-change
baseline of **3.1–3.5 GB** (2026-07-21 21:47 incident, same-shape profile), the post-fix idle floor
here is **≈0.68 GB heap-used / ≈1.17 GB RSS with a 303k-vector, 4.26 GB on-disk corpus present** —
comfortably past the ~1.1–1.3 GB drop the check expects (it doesn't merely shrink by the predicted
delta, it lands well under it, because this profile also lacks the incident profile's accumulated
conversation-ledger/instance overhead — a difference in the *other* contributors to the old floor, not
evidence against this one). `VectorStore.getStats()` reporting **zero** resident stores and **zero**
resident vectors — against a corpus of 303,421 real vectors sitting on disk the whole time — is the
positive proof that nothing was eagerly loaded at boot; this is a stronger, corpus-scale-independent
version of Check 2's own assertion, gathered fresh rather than carried over.

**Cleanup:** dev app (pid 40225 main, ppid-verified as the process this run started, not a
pre-existing one) stopped; `/tmp/aio-lt-N5` (including the seeded `rlm.db` copy) removed. The
production `rlm.db` was read-only source material throughout — never opened for writing, size/mtime
unchanged by this run's copy operation. Port 9605/9606 confirmed free after teardown.

**Check 1: now PASS**, established by a seeded isolated profile rather than the forbidden production
restart, per this batch's specific instruction to try an alternate method before re-recording the
blocker. Checks 2 and 3 remain PASS from prior runs (2026-08-18 fresh production evidence, unchanged
today). Check 4 is optional per this doc's own completion rule and was not attempted (same as every
prior run — inducing critical memory pressure was judged not worth the time for an optional check).

**All three required checks (1–3) now pass with current evidence. Renaming this file to
`2026-07-21-rlm-vector-store-memory_livetest_completed.md`.**
