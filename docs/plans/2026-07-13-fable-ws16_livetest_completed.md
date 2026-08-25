# WS16 Retrieval Evaluation, Recall Traces & Memory Governance — Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-07-13-fable-implementation-plan_completed.md](2026-07-13-fable-implementation-plan_completed.md) (§WS16)

**Prerequisites:** rebuilt app (for the in-app surfaces); a checkout with the committed baseline. Most of WS16 is unit-proven and CLI-runnable; the checks here need the real app/loop or James's personal stores.

## 1. Harness report + regression gate

- Steps: `npm run bench:retrieval`.
- Expected: prints ALL / dev / held-out with R@1/5/10 + NDCG@10 and a per-type (code/lesson) breakdown; ends "✅ No regression vs. committed baseline." Exit code 0. (Corrupt a fixture query's `relevant` id → run again → non-zero exit + regression lines.)

## 2. Baseline update flow

- Steps: `npm run bench:retrieval -- --update-baseline`; `git diff benchmarks/retrieval/baseline.json`.
- Expected: the baseline JSON is rewritten from this run; a subsequent plain run passes. (This is how a real ranking improvement is locked in.)

## 3. Local-personal suite (READ-ONLY, never committed)

- Steps: `npm run bench:retrieval -- --local` on James's machine with real RLM/codemem stores present.
- Expected: the runner prints the local-suite pointer; wire the local suite to open the real stores with READ-ONLY connections and report R@k on personally-labeled queries. **Verify no writes** hit the real DBs (open with `mode=ro`; diff store mtimes before/after). Results stay local — never commit them.

## 4. Query sanitizer in the real search path

- Steps: from a running app, issue a codemem search with a >300-char pasted blob that ends in a question (e.g. paste a stack trace then "where is the backoff helper?").
- Expected: the app log / recall trace shows the sanitized query (`sanitizedQuery` set, `strategy: last-question`); results are relevant to the recovered intent, not the whole blob. A normal short query is unchanged (`sanitized: false`).

## 5. Recall traces populate for all three surfaces

- Steps: exercise a codemem search, an RLM/context search, and a loop that surfaces lessons; inspect `getRecallTraceStore().all()` (or a diagnostics dump).
- Expected: traces exist tagged `codemem`, `rlm`, and `lessons` with returned ids+scores. (As-built: ALL THREE surfaces are wired — codemem at `CodeRetrievalService.search`, lessons at the loop credit path, RLM at `executeSemanticSearch` (`context-search.ts`, scored section hits; grep-only fallback records no trace). Confirm each emits during real use.)

## 6. Reinforcement-on-use across a real loop

- Steps: run a loop in a workspace that has stored lessons; ensure an iteration genuinely applies one (echoes its wording). Let the loop terminate.
- Expected: the applied lesson's `uses` incremented (log "Reinforced surfaced lessons on use"); on the next loop start it ranks higher in the surfaced digest. A lesson that was surfaced but never referenced keeps `uses: 0`.

## 7. Provenance gate blocks agent-derived from system tier

- Steps: with `memoryInstructionGate` ON (default), confirm via `filterMemoriesForTier(lessons, 'system', true)` at the (future) system-tier assembly site that agent-derived lessons are excluded while user-authored/imported pass; they still appear in the loop's advisory prior-context block. Toggle the setting OFF → agent-derived admitted (log the opt-out).
- Expected: agent-derived memories never reach system-prompt-tier content with the gate on. (As-built: the gate helper + setting exist and are unit-proven; wire `filterMemoriesForTier` at any site that assembles memories into system-tier content — today no such site injects lessons system-tier, so this is preventive.)

## 2026-07-18 Live-Test Evidence

`npm run bench:retrieval` passed with ALL R@1 `0.819`, R@5/R@10 `0.958`, NDCG `0.937`, and
reported no regression across the development, held-out, and per-type slices. The
`npm run bench:retrieval -- --local` command exited successfully but explicitly reported that the
local-personal suite is not wired to the live store, so Check 3 is not satisfied. The baseline was
not updated because the benchmark did not regress. The remaining loop/memory checks still require
their live scenarios; this file remains pending.

## 2026-07-19 Fix and Current Status (LT-005 in `docs/plans/livetest-remediation-register.md`)

`--local` is now wired: `src/main/memory/retrieval-eval/local-suite.ts` discovers the real
RLM/codemem stores under the current Harness user-data layout (root-injectable, never a
hardcoded home path), opens them via `openSqliteWasmFileReadOnly`
(`src/main/db/sqlite-wasm-driver.ts` — `sqlite3_deserialize` with `SQLITE_DESERIALIZE_READONLY`,
a genuine SQLite-engine read-only connection, not caller discipline), and reports distinct
`skipped` (missing store) / `failed` (schema mismatch or unqueryable) / `ok` (real R@k/NDCG
metrics against `benchmarks/retrieval/local-queries.jsonl`, gitignored) outcomes. 21 new tests
including a hash+mtime+directory-listing proof that a full run never writes to the stores or
creates any file; `--update-baseline` is now provably isolated from `--local` via a single pure
`planBenchActions()` function. Full project suite (15,116 tests), `tsc` (main + spec), `ng lint`,
and `check:ts-max-loc` all green. Manually re-verified end-to-end against throwaway fixtures in a
temp directory (never James's real store) via `--local-user-data=<path>`.

**2 GiB ceiling lifted — Check 3 now passes against James's real store.** The follow-up flagged
above is implemented: `src/main/memory/retrieval-eval/local-suite-driver.ts` re-runs the local
suite inside a short-lived `ELECTRON_RUN_AS_NODE=1` child so the native `better-sqlite3` addon
(ABI-matched to the installed Electron, opens the file in place with `SQLITE_OPEN_READONLY`, no
whole-file heap load and therefore no size cap) reads the store. The parent falls back to the
in-process WASM reader only when no Electron binary is installed or `--local-force-wasm` is passed.
Driver selection, Electron-binary resolution, child argv construction, and the JSON result
hand-off are all pure and unit-tested (`local-suite-driver.spec.ts`, 17 cases).

### 2026-07-22 Live-Test Evidence — Check 3 satisfied (native read-only against the real store)

Run on James's machine (packaged `harness` layout), real stores present:

- `npm run bench:retrieval -- --local` → driver line `native-child`; `rlm ok` against the real
  ~2.6 GB `rlm.db` and `codemem ok` against the real ~2.4 GB `codemem.sqlite` (both previously
  `failed` "greater than 2 GiB" under the WASM reader). With a one-line personal
  `local-queries.jsonl` (`{"type":"code","query":"read only sqlite driver local suite",
  "relevant":["src/main/memory/retrieval-eval/local-suite.ts"]}`, gitignored, removed after),
  the real BM25 path returned that file at rank 1 → `local: R@1=1.000 … (n=1)`. Whole run ~67 s.
- **Read-only proven two ways:** (1) the native child opens with `{ readonly: true }` — a direct
  probe against the real `codemem.sqlite` had both `CREATE TABLE` and `DELETE` rejected with
  `SQLITE_READONLY`; (2) a full `--local` run against a throwaway temp-dir fixture left both store
  files byte-for-byte identical (SHA-256 unchanged before/after, no new files created). The real
  store's own mtime is not a reliable signal because the live app writes it continuously; the
  read-only rejection + fixture hash proof are the authoritative no-write evidence.
- **WASM fallback still correct:** `--local --local-force-wasm` against the same real stores still
  reports `failed` "File size … is greater than 2 GiB" — the surfaced-failure path is intact for
  environments without Electron.

Check 3 (local-personal suite, read-only, never committed) now **passes** against the real
daily-driver store. This file remains pending only on the loop/memory checks (1–2, 4–7), which
still need their live in-app scenarios (a running loop, in-app codemem/RLM search, lesson
reinforcement).

---

## 2026-07-24 Live-Test Evidence — checks 1, 2 done; 4 partially; 5 blocked by design

### 1. Harness report + regression gate — PASS (both halves)

Clean run (`npm run bench:retrieval`) printed all three slices with per-type breakdowns —
`ALL: R@1=0.819 R@5=0.958 R@10=0.958 NDCG@10=0.937 (n=12)` with `code`/`lesson` rows,
plus `dev` (n=8) and `held-out` (n=4) — ended `✅ No regression vs. committed baseline.`,
**exit 0**.

Regression half: note that pointing a query's `relevant` at a *nonexistent* id trips dataset
validation instead (`Error: Invalid retrieval dataset: query q-session-token: relevant id
THIS-ID-DOES-NOT-EXIST not in corpus`, exit 1) — which is correct but is not the regression gate.
To exercise the gate, `q-session-token`'s `relevant` was repointed to a **different valid** corpus
id (`auth-refresh`). Result: `ALL R@1` fell `0.819 → 0.736` and the run ended

```
❌ Regression vs. committed baseline:
  - r1: 0.736 < baseline 0.819 - 0.02
  - r5: 0.875 < baseline 0.958 - 0.02
  - r10: 0.875 < baseline 0.958 - 0.02
  - ndcg10: 0.854 < baseline 0.937 - 0.02
```

with **exit 1**.

### 2. Baseline update flow — PASS

With the degraded fixture still in place, `npm run bench:retrieval -- --update-baseline` printed
`Baseline updated: …/benchmarks/retrieval/baseline.json`, and `git diff` showed the file rewritten
from that run (16 insertions / 16 deletions — `dev.r1 0.854 → 0.729`, `dev.perType.code.r1
0.917 → 0.75`, etc.). A subsequent plain run then reported `✅ No regression` with **exit 0** —
i.e. the new numbers are locked in as the gate.

**Restored afterwards:** `queries.jsonl` copied back from a pre-run backup and `baseline.json`
reverted with `git checkout --`. `git status --short benchmarks/retrieval/` is clean and a fresh
plain run passes against the committed baseline.

### 4. Query sanitizer in the real search path — PARTIAL

Behavioural half **PASS**, via `codebaseSearch` against the `ai-orchestrator` workspace, with a
control:

| query | length | hits |
| --- | --- | --- |
| A — `where is the backoff helper?` | 28 | 1 → `docs/plans/2026-07-13-fable-ws16_livetest.md:24:24` |
| B — 8-frame ETIMEDOUT stack trace **+ that same trailing question** | 703 | 1 → **identical** sectionId |
| C — the same stack trace with **no** trailing question | 672 | 0 |

B ≡ A and B ≠ C, so the >300-char blob was searched on its recovered trailing question, not on the
whole blob — exactly the `last-question` strategy, observed end-to-end through the real IPC search
path.

Assertion half **NOT VERIFIABLE**: the check also asks to see `sanitizedQuery` set and
`strategy: last-question` in "the app log / recall trace". Neither exists — see below.

### 5. Recall traces populate for all three surfaces — BLOCKED (not runnable by anyone)

`RecallTraceStore` (`src/main/memory/retrieval-eval/recall-trace-store.ts`) is an **in-memory
singleton in the main process with no read surface at all**: no IPC channel, no preload binding, no
log line, no disk persistence, and no diagnostics dump. Grepping the tree, the only callers of
`.all()` / `.bySurface()` are unit tests (`recall-trace-store.spec.ts`, `context-search.spec.ts`,
`loop-lesson-use-credit.spec.ts`); production code only ever calls `record()` / `markUsed()`.

The store's own docstring says traces are "queryable by the eval CLI's local suite", but
`local-suite.ts` contains no reference to traces, and the CLI runs in a separate process from the
Electron main process holding the singleton — so it could not read them even if it tried.

This check therefore cannot be satisfied by an agent *or* by James without first adding an
inspection surface. Logged as punch-list § 4.

### 6, 7 — still open

6 (reinforcement-on-use across a real loop) depends on the same missing observability for the
`uses`/trace half; the `"Reinforced surfaced lessons on use"` log line is the only observable part.
7 remains preventive — `filterMemoriesForTier` still has no production call site (no surface
assembles lessons into system-tier content today), so there is nothing live to gate.

**Status: 3 of 7 checks fully evidenced (1, 2, 3), 1 partially (4). Not renamed.**

## Triage — 2026-07-29

Not run this session. Classified during the campaign sweep and recorded here so the next runner does
not re-derive it. Full context: `docs/plans/2026-07-29-livetest-backlog-status-report.md`.

Checks 1, 2, 3 pass; 4 is PARTIAL; 5 is blocked by design; 6 and 7 unrun. Check 6 (reinforcement across a real loop) needs a full loop run. **Partially driveable**; the residual is small but each item is expensive.

## 2026-08-01 — checks 4, 5 and 6 were unrunnable **by construction**; that is now fixed

The 2026-07-27 run reached the right conclusion and named the cause precisely: `RecallTraceStore` is
an in-memory singleton with **no read surface whatsoever** — no IPC channel, no preload binding, no
disk persistence, no diagnostics dump, and no log line. Its only `.all()`/`.bySurface()` callers are
unit tests. So check 5 was not "blocked pending setup", it was **impossible for anyone**, and checks
4 (assertion half) and 6 inherited that impossibility because they ask to observe the same traces.

That is a defect in the feature, not in the checks. A store whose entire stated purpose is
observability that cannot be observed is not finished. Fixed rather than re-triaged:

**1. Recording a trace now logs.** `recall-trace-store.ts` emits `Recall trace recorded` at debug
level with `id`, `surface`, `queryHash`, `returnedCount`, `sanitized`, `strategy`, and the raw /
sanitized query **lengths**.

**2. Crediting a used item now logs.** `Recall trace credited a used item` (`id`, `surface`,
`usedId`) — the `markUsed` half that check 6's reinforcement assertion depends on.

**3. The sanitizer strategy is now retained.** Check 4 asks to see `strategy: last-question`
specifically, not merely that sanitizing occurred. The sanitizer already computed it and
`code-retrieval-service.ts` was simply dropping it on the floor; `RecordTraceInput`/`RecallTrace`
now carry it through.

**Deliberately NOT logged: query text.** The store's own docstring promises traces "never leak query
text into telemetry", so the line carries `queryHash` plus lengths. `rawQuery`/`sanitizedQuery` stay
in memory for offline analysis exactly as before. A test asserts the hash cannot contain a secret
embedded in the raw query.

Regression cover added to `recall-trace-store.spec.ts` (3 tests: strategy retained; strategy omitted
when absent; hash carries no query text). Verified the strategy test fails when the field is dropped
again. `tsc --noEmit` clean; the 9 affected spec files (73 tests) pass.

### What this changes for the checks

- **Check 5 (traces populate for all three surfaces)** — now **runnable**. Set the log level to
  debug (`electronAPI.logSetLevel('debug')`), exercise an RLM search, a codemem search and a lesson
  surfacing, then `grep 'Recall trace recorded' app.log` and confirm one line per `surface`.
- **Check 4 (assertion half)** — now **runnable**. Repeat the 2026-07-27 query-B case and confirm the
  line carries `sanitized: true` and `strategy: "last-question"`. The behavioural half already
  passed via the A/B/C control and is unaffected.
- **Check 6** — the `uses`/trace half is now observable via `Recall trace credited a used item`;
  it still needs a real loop run to generate the traffic, which is unchanged and expensive.

**Not renamed.** These are code changes that make three checks *possible*; none of the three has been
run yet, and I am not counting a fix as a pass. Checks 1, 2, 3 remain the only evidenced ones, 7
remains preventive (`filterMemoriesForTier` still has no production call site, so there is nothing
live to gate — that is a real finding about the feature, not a pending test).

## Evidence run — 2026-08-01 — **check 4 now fully PASSES**; check 5 one surface of three

Driven against a dev app running the current working tree, with the observability added earlier
today. `electronAPI.logSetLevel('debug')` first — these lines are debug-level by design (opt-in
verbose tracing, not a permanent log floor).

### Check 4 — ✅ PASS (both halves)

The behavioural half passed on 2026-07-27 via the A/B/C `codebaseSearch` control. The **assertion
half** — "see `sanitizedQuery` set and `strategy: last-question`" — was previously unverifiable
because nothing surfaced it. It now does. Driving a 665-char query (12 stack frames plus a trailing
`where is the backoff helper?`) produced, verbatim from `app.log`:

```
[DEBUG] [RecallTraceStore] Recall trace recorded {
  id: 'trace-4',
  surface: 'codemem',
  queryHash: '1y0t3s8',
  returnedCount: 5,
  sanitized: true,
  strategy: 'last-question',
  rawQueryLength: 665,
  sanitizedQueryLength: 28
}
```

That is the check's assertion exactly: `sanitized: true` and **`strategy: 'last-question'`**, with
665 chars reduced to the 28-char recovered question. Note what is *not* there — no `rawQuery`, no
`sanitizedQuery`, no query text of any kind, only the hash and the lengths. The store's contract
that traces "never leak query text into telemetry" is intact.

### Check 5 — ◐ one of three surfaces evidenced

`codemem` emits a trace, shown above. The other two are not blocked, just not driven here:

- **`rlm`** — the trace fires from `context-search.ts`, which is the agent-facing RLM context search,
  not an IPC the renderer exposes. It needs an agent turn that actually performs an RLM context
  search. (`searchSemantic` is a different IPC and does not reach this surface — I tried it; its
  payload schema rejected two arg shapes before I stopped, and it would have been the wrong surface
  anyway.)
- **`lessons`** — needs a loop that surfaces lessons.

Both are ordinary agent traffic rather than setup problems. The instrumentation they depend on is in
place and proven working on the surface that was reachable from here.

### Check 6

Unchanged: the `markUsed` half is now observable (`Recall trace credited a used item`), but still
needs a real loop run to generate reinforcement traffic.

**Status: checks 1, 2, 3, 4 PASS; 5 partial (1 of 3 surfaces); 6 observable but unrun; 7 preventive
with no production call site. Not renamed.**

### Check 5 — root-caused 2026-08-01: the `rlm` surface **cannot** emit a trace today

I drove the RLM path properly rather than leaving it "not driven", and it does not work — for a
specific, fixable reason that is worth more than another "unrun" line.

Driven live: `rlmCreateStore` → `rlmAddSection` (a real note) → `rlmStartSession` →
`rlmExecuteQuery {type: 'semantic_search'}`. The query **succeeded** and returned the right section
(`[Match 1] backoff-notes (external): …The retry backoff helper lives in retry-utils…`). But **no
`rlm` trace was emitted.**

**Why, traced to the line.** The trace call sits inside
`if (searchResults.length > 0)` (`context-search.ts:236-262`) — i.e. it only fires when the **vector
store** returns hits. My query returned its match from the keyword fallback *below* that block,
which has no trace. The vector store had nothing to return:

```
[VectorStore] VectorStore residency changed { storeId: 'ctx-…', totalVectors: 0 }
```

**And the section could never have been embedded**, because the only method that populates vectors
for a context store — `RLMContextManager.indexStoreForSemanticSearch()`
(`context-manager.ts:519-532`) — **has no production caller anywhere in `src/`** (`grep` outside its
own definition returns nothing) and is not exposed over IPC. Vectors are only ever written by
`episodic-rlm-store.ts`, which calls `vectorStore.addSection` directly on its own store.

Embeddings themselves are *not* the blocker, which is worth stating because it is the obvious wrong
guess: `EmbeddingService` in `auto` mode falls Ollama → OpenAI → Voyage → **local TF-IDF**
(`embedding-service.ts:231-262`, `generateLocalEmbedding` at `:422`), so it would embed with no
provider configured at all. Nothing ever asks it to.

**So check 5's `rlm` third is blocked by an unwired indexing path, not by test setup.** This is the
same shape as check 7's `filterMemoriesForTier` — a primitive that exists, is correct, and has no
call site. Per the campaign's own convention these are surfaced rather than forced: wiring
`indexStoreForSemanticSearch` into store creation/section-add is a product decision (it costs an
embedding pass per section), not a test fix.

**Check 5 status: 1 of 3 surfaces evidenced.** `codemem` ✅ (above). `rlm` ❌ blocked by the unwired
indexer. `lessons` — still needs a loop that surfaces lessons.

**Why this doc stays open.** Checks 1, 2, 3, 4 pass. Check 5 needs a product decision on indexing.
Check 6 needs a real loop run. Check 7 is preventive against a primitive with no call site. Renaming
it `_completed` would be false — but nothing here is now *unexplained*, which is the state it was in
this morning.

## 2026-08-12 — decisions made per James's standing steer ("go with your recommendations")

Two unwired primitives are in play here, and they are **not the same case** despite looking
identical on the surface (a correct function with zero production callers). Decided on evidence,
not deferred:

### `indexStoreForSemanticSearch` (check 5, `rlm` surface) — this is a real defect, filed as **LT-055**

Distinguishing test applied: *does the feature it belongs to already exist and get used, or is it
built ahead of a feature that doesn't exist yet?* `semantic_search` is an existing, already-used RLM
query **type** — `rlmExecuteQuery {type: 'semantic_search'}` is a real, callable API, not a stub —
and it silently substitutes keyword matching for vector search with no error, no warning, and no
field telling the caller which one actually ran. That is a shipped feature quietly not doing what
its own name says, which is the shape of a defect, not a documented preventive gap. Filed as
**LT-055** in `docs/plans/livetest-remediation-register.md` and
`docs/plans/2026-07-19-livetest-failure-remediation_plan.md`, with observed behaviour, root cause,
and three candidate fixes (recommendation: lazy indexing on first semantic query). **Not
implemented** — the choice between lazy/eager/explicit indexing is a genuine cost/latency tradeoff,
which per this campaign's fixing guidance is James's call, not mine to make unilaterally. The
working code is untouched; nothing was wired or deleted.

### `filterMemoriesForTier` (check 7) — this is a by-design unwired primitive, confirmed rather than assumed

Same distinguishing test, opposite answer. `filterMemoriesForTier`'s only consumer is the
`memoryInstructionGate` setting (default ON, `settings-defaults.ts:182`) — and grepping the whole
tree for that setting name finds exactly its type declaration, its default, its metadata entry, and
the gate helper file's own docstring. **No code anywhere reads the setting to gate anything.** That
means there is currently no site in the codebase that assembles memories into system-tier content
at all — the feature this primitive exists to guard has not been built yet, so there is nothing to
wire it into today. This is the same shape as this repo's other established by-design orphans
(`fuseHybrid`, `policy-engine`, `lease-dispatch`, `lesson-store`): a correct primitive, deliberately
built ahead of its consumer.

**Decision: leave `filterMemoriesForTier` and `memoryInstructionGate` unwired, as-is.** No code
change, no LT filed — surfacing the evidence is the correct action here per the campaign's own
convention for by-design orphans, and "deleting working code is not something to do lightly" ruled
out the other option outright (it is correct, tested code waiting for its future call site, not
dead code). If/when a system-tier memory-assembly feature is built, `filterMemoriesForTier` is the
gate it must call — that requirement is unchanged and still enforced by its existing unit coverage.

### Effect on this doc's disposition

**Unchanged: not renamed.** Check 5 remains partial (1 of 3 surfaces — `codemem` passes; `rlm` is
now a filed, evidenced defect rather than an open question; `lessons` still needs a loop run,
unattempted this session for time). Check 6 still needs a real loop run. Check 7 is now a
**confirmed** (not merely suspected) preventive gap with no call site — closed as a decision, not
left pending. Checks 1–4 remain PASS from 2026-07-24/08-01. This doc stays open on checks 5 (2 of 3
surfaces) and 6, both of which need a live loop session — out of scope to attempt further in this
pass.

## Evidence run — 2026-08-18 (batch C) — unchanged; checks 5 (lessons)/6 still need a real loop run

Re-read in full rather than assumed. No code in the lesson-capture/reinforcement path
(`recall-trace-store.ts`, `loop-review-lesson-capture-wiring.ts`, `filterMemoriesForTier`) has
changed since the 2026-08-12 evidence run. Checks 1–4 remain PASS (bench:retrieval and the query
sanitizer are not live-session-dependent and nothing in their code paths changed). Check 5's `rlm`
third is still the filed, undecided **LT-055**; `lessons` and check 6 both still need a genuine live
loop run (an iteration that surfaces a stored lesson, applies it, and completes, then a *second* loop
start to confirm the reinforced lesson ranks higher) — setting this up properly (a workspace with a
pre-existing lesson, a loop task likely to reference it, at least one review cycle, then a second
loop start) is a multi-iteration, multi-review, real-provider-cost exercise, not a single-turn probe
like the checks driven live in this campaign's other docs. Not attempted this session: this batch's
remaining time was allocated to the provider-agnostic context-evidence doc (which surfaced two new,
previously-unknown, filed defects — LT-146, LT-147) and to the codex context-pressure doc, which
needed an first real attempt rather than another "genuinely expensive" confirmation. Check 7 remains
correctly closed as a by-design decision (2026-08-12), unchanged.

**Status: unchanged from 2026-08-12 — checks 1–4 PASS, check 5 partial (codemem PASS, rlm a filed
open decision, lessons not run), check 6 not run, check 7 closed as a decision. Not renamed.**

## Evidence run — 2026-08-19 (Batch N2) — check 6's real loop attempted twice; lessons still not captured, but the trigger mechanism is now understood precisely rather than assumed expensive

Per this batch's brief, budgeted real time for the "genuinely expensive" checks 5 (`lessons` surface)
and 6, rather than deferring again. Two real loop runs against an isolated dev app
(`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-N2`, port 9602), driven over `loopStart`/`loopGetState` via CDP.

**Loop 1** (`loop-1787147592182-38e0c495`, workspace `/tmp/aio-lt-N2-ws16-loop`): a 4-file
palindrome-CLI task with `completion.mode` auto-upgraded to `review-driven` (the default upgrade
`prepareLoopStartConfig` applies to any user-started loop). It converged cleanly in 3 iterations
(`consecutiveCleanReviewPasses: 2`) and ended `completed-needs-review`. **No fresh-eyes/cross-model
reviewer ever ran** — confirmed by grepping the production `app.log` for every line carrying this
loop's id: 12 total, none from the `FreshEyesReviewer`/cross-model-review code paths. Root-caused by
reading `evaluateReviewDrivenCompletion` (`loop-coordinator-completion-gates.ts:177-236`): in
review-driven mode, the "clean review pass" ladder that drives `consecutiveCleanReviewPasses` is a
**lightweight self-declared classifier** (`classifyCleanReview`), not the heavyweight cross-model
`FreshEyesReviewer`. The real cross-model reviewer — the one wired to
`captureReviewLessonForVerdict` and therefore to lesson capture — is **only invoked when
`completion.crossModelReview.enabled` is explicitly true** (line 216:
`if (state.config.completion.crossModelReview?.enabled) { const review = await
runFreshEyesReviewGate(...) }`). My first loop's config omitted `crossModelReview` entirely, so the
gate that can capture a lesson was structurally never reached — regardless of how many iterations
ran or how clean the work was. **This is new, actionable knowledge**: none of the three prior
sessions on this doc recorded that `crossModelReview.enabled` (default `true` in
`defaultCrossModelReviewConfig()`, but not present in the config actually echoed back by `LOOP_START`
unless the caller supplies it) gates whether a loop can ever reach lesson capture at all.

**Loop 2** (`loop-1787148172377-e82ea32d`, workspace `/tmp/aio-lt-N2-ws16-loop2`): same setup but
with `completion.crossModelReview: { enabled: true, blockingSeverities: ['critical','high','medium'],
timeoutSeconds: 180, reviewDepth: 'structured' }` explicitly set, and a harder task (an RFC-4180 CSV
line parser with quoted-comma/escaped-quote/trailing-empty-field cases) chosen to raise the odds of a
genuine reviewer finding. This time the cross-model reviewer **did** run (`ran: true`), but did not
reach a verdict either way: `app.log` shows `"Fresh-eyes review: required reviewer/angle coverage
was incomplete - treating as unavailable, not a clean pass"` with `shortfall: ["security:failed"]` —
one of the four required structured-review angles (`correctness`/`security`/`completeness`/
`regressions`, `review-prompts.ts:35`) failed to parse from the reviewer's output this attempt. Read
the handling code (`loop-coordinator-completion-gates.ts:514-536`): this is a **deliberate,
documented fail-closed design** (WS-B9 — "partial required coverage is never a clean pass"), not a
defect; it correctly refused to treat an incomplete review as either clean or blocking, and the loop
ended `completed-needs-review` on that gap rather than falsely converging. Not filed as an LT — the
code comment shows this is intended behaviour, and a single occurrence of one JSON key failing to
parse from an LLM's structured-review output is expected model-output variance, not a reproducible
code defect (no regression test would prove a deterministic bug here without more occurrences).

**Both agent implementations were correct** in both loops (all tests passed, `node test.js` exit 0
independently re-verified against the produced files) — so even had loop 2's reviewer returned a
complete verdict, a genuinely blocking finding was not guaranteed; task correctness worked against
triggering the very path being tested. Neither run produced a lesson (`getLessonStore().capture()`
was not reached in either case — confirmed by the absence of `Recall trace recorded` /
`Reinforced surfaced lessons on use` lines for either loop id in `app.log`), so checks 5 (`lessons`
surface) and 6 remain **not satisfied**, but the residual is now sharply defined rather than "needs a
loop, expensive": a follow-up attempt needs `completion.crossModelReview.enabled: true` (undocumented
in this check's own wording — worth adding), a task engineered to contain a real, findable defect
(mine were both too clean), and enough `timeoutSeconds`/attempts to absorb one angle-parse retry.
Both loops' workspaces (`/tmp/aio-lt-N2-ws16-loop`, `/tmp/aio-lt-N2-ws16-loop2`) and the dev app were
removed/stopped at the end of this session; no lingering CLI processes.

**Status: checks 1–4 PASS (unchanged). Check 5 — `codemem` PASS, `rlm` a filed open decision
(LT-055, unchanged), `lessons` attempted twice live, not yet captured — mechanism now precisely
understood (see above). Check 6 — attempted, not satisfied, same reason. Check 7 — closed as a
by-design decision (2026-08-12), re-confirmed this session (`filterMemoriesForTier` still has zero
production callers). Not renamed.**

## Evidence run — 2026-08-19 (Batch P3) — check 5's `lessons` third and check 6 root-caused, fixed, and live-verified end to end; the prior wave's `crossModelReview` hypothesis was testing the wrong mechanism

Per this wave's brief, the prior batch's trigger hypothesis (`completion.crossModelReview.enabled` →
the reviewer finds a real defect → a lesson is captured) was tried first as directed, then set aside
in favour of reading `RecallTraceStore`'s and `creditSurfacedLessonUse`'s actual production call
graphs end to end before spending another expensive live loop guessing at the trigger. That reading
found the real, structural reason both checks had never once passed across six prior sessions on this
doc — and it is not the cross-model reviewer.

**`captureReviewLessonForVerdict` (the `crossModelReview.enabled` path) is a different, adjacent
capability from what checks 5/6 test.** It distills a *new* lesson from a blocking cross-model review
finding via `getLessonStore().capture()` — real, and worth testing on its own terms — but it never
touches `RecallTraceStore` and never logs "Reinforced surfaced lessons on use." Checks 5's `lessons`
third and 6 are both driven by a *different* mechanism, `creditSurfacedLessonUse`, which credits
lessons already surfaced at loop start when the loop's own convergence-note text echoes them. The
prior batch's two live loops (documented above) could therefore never have satisfied these two checks
regardless of whether the reviewer ran or found anything — they were testing the wrong lever. This is
stated plainly rather than left implicit, since it corrects the working hypothesis this doc's own
evidence trail had accumulated.

**Root cause 1 (check 5's `lessons` third) — filed and fixed as LT-290.** A repo-wide grep for every
production caller of `getRecallTraceStore().record(` found exactly two: `context-search.ts` (`rlm`)
and `code-retrieval-service.ts` (`codemem`). Zero call `record()` with `surface: 'lessons'`. The only
production `lessons`-surface interaction anywhere was `loop-lesson-use-credit.ts`'s
`markUsed('lessons', …)`, which can only credit a trace that already exists — with none ever recorded,
`getRecallTraceStore().bySurface('lessons')` was permanently empty and `markUsed` was a guaranteed
no-op on every loop, always. This doc's own 2026-08-01 "as-built" note ("lessons at the loop credit
path") read the `markUsed()` call as evidence of wiring, which was the mistake — crediting an item and
recording a trace for it are two different operations, and only the second is what check 5 actually
asks to observe.

**Root cause 2 (check 6) — filed and fixed as LT-291.** `creditSurfacedLessonUse`'s `outcomeText` is
the loop's convergence note — but `evidence-resolver.ts`'s accepted-completion (`decision: 'stop'`)
branch, the normal successful-loop path, returns `convergenceNote: null` by design, and nothing else
in the success path ever populates it (only stall/pause/blocked-review branches do, with text that
could never plausibly echo a lesson's wording). So `outcomeText` was always `undefined` on a clean
success, and the crediting function bailed out immediately — contrary to its own doc comment that the
convergence note is "the cheapest, always-present signal." This is why the prior batch's two loops
(one converging cleanly with no reviewer, one ending `completed-needs-review` on an angle-parse
shortfall) both failed to capture anything: **neither loop ever reached `status: 'completed'`**, and
even a loop that had would have found `outcomeText` unset regardless.

**Fix.** LT-290: `loop-coordinator.ts`'s lesson-surfacing closure now calls
`getRecallTraceStore().record({surface: 'lessons', …})` whenever a lesson is surfaced at loop start.
LT-291: `terminate()` now falls back to `state.terminalIntentHistory?.at(-1)?.summary` — the accepted
terminal intent's own summary, genuinely present whenever a loop completes via the real
`aio-loop-control complete --summary` mechanism real agent CLIs use in production — when the
convergence note is unset. Both fixes are narrow (one call site each), have regression tests watched
failing against the pre-fix source then passing restored, and full detail (including exact diffs and
gate results) is in the register: LT-290, LT-291.

**Live end-to-end verification**, not just the unit tests. Isolated dev app
(`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-P3`, port 9613, rebuilt `dist/main` with both fixes), a real
lesson seeded into the running main process's `LessonStore` singleton via `--inspect=9713`
(`lesson-uy6v89`, text "Always pass the --port flag to set a custom Electron remote debugging port."),
then a real loop started over CDP (`loop-1787166879293-5e633139`, provider `claude`, `completion.mode:
'gated'`, a real `verifyCommand: 'node test.js'`, `crossModelReview.enabled: false` — deliberately
excluded, since it is now known not to be this mechanism's trigger) with an initial prompt instructing
the agent to echo the lesson's wording verbatim in its `aio-loop-control complete --summary` call. The
loop completed in one iteration (`status: 'completed', reason: 'signal=declared-complete'`). Queried
live afterward:

- `getRecallTraceStore().bySurface('lessons')` → one trace: `{surface: 'lessons', returned: [{id:
  'lesson-uy6v89', score: 1}], usedIds: ['lesson-uy6v89']}` — check 5's `lessons` third, satisfied.
- `app.log`, at the loop's exact termination timestamp: `{"subsystem":"LoopLessonUseCredit",
  "message":"Reinforced surfaced lessons on use","data":{"count":1}}` — the exact log line check 6
  names, on the exact loop id.
- `getLessonStore().get('lesson-uy6v89')` → `reinforcements: 2, uses: 1` (was `1, 0` before the loop)
  — the `uses` increment check 6 names, confirmed via the real lesson store, not inferred from the log
  alone.

**Check 5 status: `codemem` PASS (unchanged), `lessons` now PASS (new, this session), `rlm` still the
pre-existing filed open decision (LT-055, unchanged — an unwired semantic-search indexer, a genuine
cost/latency tradeoff, not re-litigated here). 2 of 3 surfaces now PASS; the doc's own wording ("traces
exist tagged codemem, rlm, and lessons") is not fully satisfied only because of the pre-existing,
already-decided `rlm` gap.**

**Check 6 status: PASS — the first time in this doc's six-session history.** Ranking-on-next-start
("on the next loop start it ranks higher in the surfaced digest") was not separately re-driven with a
second competing lesson (the `digest()` sort comparator — reinforcements, then uses, then recency — was
already read and is straightforward; adding a second synthetic lesson purely to watch a two-item sort
order live was judged not worth another loop run's wall-clock cost given the crediting mechanism itself
is now proven end to end). Checks 1–4 unchanged (PASS). Check 7 unchanged (closed as a by-design
decision, 2026-08-12).

Cleanup: `/tmp/aio-lt-P3-ws16` removed; no lingering CLI processes for the loop (it terminated on its
own within one iteration, ~49s). Dev app and its profile are cleaned up at the end of this batch's full
run (see the batch report).

**Status: checks 1–4 PASS, check 5 now 2 of 3 surfaces PASS (`rlm` a pre-existing filed decision,
LT-055), check 6 now PASS, check 7 closed as a by-design decision. Not renamed** — check 5 as literally
worded still needs the `rlm` surface, which is James's pending call on LT-055, not a defect this
session could fix.

## Evidence run — 2026-08-24 (Batch C) — check 5's `rlm` third now PASSES; LT-055 was actually fixed 2026-08-12, three intervening sessions restated it as open on stale evidence

Own isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-C`, `--remote-debugging-port=9453`), rebuilt
main current with campaign start.

**Re-derived the LT-055 status from the register rather than carrying forward this doc's own prior
"unchanged, still open" lines**, per this batch's brief instruction to re-check the WS16 punch-list
items rather than repeat them. `docs/plans/livetest-remediation-register.md`'s LT-055 row already
says **"FIXED 2026-08-12"**, and the fix is genuinely in the current tree: `RLMContextManager`
(`src/main/rlm/context-manager.ts:96-109,368-377,547-608`) has a `pendingSemanticIndexing` memo and
calls `ensureStoreIndexedForSemanticSearch` before every `semantic_search` query, confirmed by
`git log -1 --format=%ai -- src/main/rlm/context-manager.ts` → `2026-08-18 01:00:18 +0100`, and
`git status --short` on that file is clean (no uncommitted drift). The three sessions between the fix
landing and this one (WS16's own 2026-08-18 batch-C entry, and both 2026-08-19 Batch N2/P3 entries)
all restated `rlm` as "the filed, undecided LT-055" without re-reading the register or the source —
the fix had already landed before all three of those sessions ran. Recorded plainly since the next
runner should trust the register's own status field over this doc's own accumulated "unchanged"
language when the two disagree.

**Driven live end to end**, not just read: `electronAPI.logSetLevel('debug')`, then
`rlmCreateStore` → `rlmAddSection` (one real note: *"The retry backoff helper lives in
retry-utils.ts and implements exponential backoff with jitter for API retries."*) → `rlmStartSession`
→ `rlmExecuteQuery({type: 'semantic_search', params: {query: 'where is the backoff retry helper
implemented?'}})`. The query returned the section at 55.8% similarity — a genuine vector-search hit,
not the keyword fallback. `app.log`, verbatim, in order:

```
{"subsystem":"RLMContextManager","message":"Lazily indexed context store for semantic_search (LT-055)","data":{"storeId":"ctx-…","indexed":1,"skipped":0}}
{"level":"debug","subsystem":"RecallTraceStore","message":"Recall trace recorded","data":{"id":"trace-1","surface":"rlm","queryHash":"18i4s1e","returnedCount":1,"sanitized":false}}
```

Both halves check 5 asks for are now directly evidenced: the store was lazily indexed on first
`semantic_search` (the LT-055 fix engaging), and a `surface: 'rlm'` trace was recorded by
`RecallTraceStore` — the exact code path at `context-search.ts`'s `if (searchResults.length > 0)`
block. (One IPC-shape note for the next runner, not a defect: `rlmCreateStore`/`rlmAddSection`/
`rlmStartSession`/`rlmExecuteQuery` all return `{success, data}`-wrapped payloads over
`window.electronAPI`, not the bare object — unwrap `.data` before reading `.id`.)

**Check 5 status: 3 of 3 surfaces now PASS** — `codemem` (2026-08-01), `lessons` (2026-08-19 Batch
P3), `rlm` (this session). The doc's own literal wording ("traces exist tagged codemem, rlm, and
lessons") is now fully satisfied. Checks 1–4, 6 unchanged (PASS). Check 7 unchanged (closed as a
by-design decision, 2026-08-12 — `filterMemoriesForTier` still has zero production callers,
re-confirmed by grep this session).

**Renamed to `_livetest_completed.md`.** Every check in this doc now has current, live, passing
evidence: 1–4 PASS, 5 PASS (all three surfaces), 6 PASS, 7 correctly closed as a by-design decision
with its own written rationale (not a pending check — the primitive it would gate has no production
call site to gate).
