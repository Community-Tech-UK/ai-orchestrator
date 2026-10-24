# October Phase 3: calm screen — history

Moved verbatim from [2026-10-10-oct-phase3-calm-screen_plan.md](2026-10-10-oct-phase3-calm-screen_plan.md) during the
Oct-2 Phase B plan diet (Step 3). No text deleted.

## Verifier findings (preamble)

**Verifier round-5 findings (the coordinator's "verification round 2 of 3" resume pass) — both fixed (23 Oct;
receipts in the verification-round-5 remediation as-built entry):**
1. `src/renderer/app/features/cost/cost-page.component.ts` (per-model Costs table) — the table dropped Copilot
   AI credits and rendered Copilot spend as a dollar amount: `modelRows` discarded `byModel[model].aiCreditsNano`
   (which `buildCostSummary` already returns) and the template rendered `money(row.cost, 6)` for every model, so a
   Copilot model row read "gpt-5 ≈$0.000000 at API prices" with no 12.4 credits. Fixed by carrying
   `aiCreditsNano` through `CostSummaryData`, `ModelRow` and `modelRows`, and rendering credited rows as
   "12.4 AI credits" through the new `modelCostLabel` (no dollar amount for credited rows).
2. `src/renderer/app/features/cost/cost-page.component.ts` (session breakdown cache) — a failed
   "Models and helpers" request was cached as `null` (`loadBreakdown` cached `null` on an unsuccessful IPC
   response or exception, and `refreshAll` never invalidated it), so neither Refresh nor closing/reopening the
   row ever retried it and the fold stayed "Not available yet" until a new cost event or page reload. Fixed by
   caching only successful breakdowns and having `refreshAll` reload every expanded row that has no breakdown
   yet, so both Refresh and reopening the row retry.

**Verifier round-4 findings (the coordinator's "verification round 1 of 3" resume pass) — all four fixed (23 Oct;
receipts in the verification-round-4 remediation as-built entry):**
1. `src/main/cli/adapters/acp-permission-outcome.ts:17` — typed ACP replies could still grant persistent
   permission: the substring option-label match ("Allow") ran before the refusal/assent wording, so
   "no, do not allow", "please allow this once" and "yes, allow it" each selected `allow_always`. Fixed by reading
   the user's words first (word-bounded refusal and assent phrases plus "once"/"always" hints), then exact
   ids/names, then word-boundary label matches; a generic assent still prefers the once option.
2. `session-status-dock.component.html:20` — switching dock chips destroyed `InstanceReviewPanelComponent` and
   with it the review session, findings and selections. Fixed by mounting the review panel once started and
   hiding it (`display:none`) instead of unmounting it; it still resets with the session identity.
3. `notification-shell.service.ts:37` — the selection effect re-ran on every notification delta (the store's
   `markSeen` reads its records signal synchronously), marking brand-new records seen without a new user
   selection. Fixed with `untracked` around `markSessionSeen`: seen on selecting only.
4. `scripts/__tests__/dependency-compatibility.spec.ts:202` — the supplied worktree install contained
   `toml-eslint-parser@1.0.3` (plus nested `eslint-visitor-keys@5.0.1`) extraneous to this branch's manifests:
   the install was copied from the root checkout, whose dirty manifests (another session's in-flight work)
   declare that package. The extraneous package was removed from the worktree install; the root checkout's own
   install matches its own manifests and was left untouched. The gate is green again.

## Dated status block (original)

**Status:** implementation ready for the queue's independent verifier (round 6, "verification round 3 of 3"). The
round-5 verifier's two findings above are fixed in `queue/2026-10-10-oct-phase3-calm-scr-5d08d9`; see the 23 Oct
**verification-round-5 remediation** as-built entry for the per-finding receipts. The round-4 verifier's four
findings remain fixed; see the 23 Oct **verification-round-4 remediation** as-built entry. The round-3 verifier's
two findings (the multi-frame
Claude cache double-charge and the mobile 1000-message timeout) remain fixed; see the 23 Oct
**verification-round-3 remediation** as-built entry. The round-2 verifier's three findings — a cancelled
live-permission reply approving an unrelated held tool when the live broker had no pending
asks, answered ordinary Claude questions leaving unresolved notifications in the count, and retrieved context that
missed the send deadline being injected into a later machine-written message — remain fixed; see the 23 Oct
**verification-round-2 remediation** as-built entry for their receipts. The round-1 verifier's four findings (the
fourteen failing test files, the A0
historical-cost repair break under `078_copilot_credits`, the answered Claude question resurfacing in the next
waiting state, and the Copilot credit backfill on a truncated checkpoint tail) remain fixed; see the 23 Oct
**verification-round-1 remediation** entry. All 17 steps' code is implemented on that branch.
Provenance unchanged: the coordinator's second "merge main" — MERGE_HEAD `0c4b7de7a` over checkpoint `fefac96d7`,
base `1ee52cbd8` (23 Oct merge-of-main as-built entry; earlier that day the tree was validated on merged HEAD
`f79b9aad5` over checkpoint `39a56ce7dfb9`, base `542f1f690fae`), with this resume's earlier three merge-surface
faults still recorded in the 23 Oct post-merge notes. Current worker evidence (23 Oct round-5 remediation): the
verifier's two cost-page repros (a Copilot per-model row shows AI credits and no dollar amount; a failed session
breakdown is retried by Refresh and by closing/reopening the row) are pinned in `cost-page.component.spec.ts` and
pass the verifier's own `_scratch/phase3-independent-review/copilot-model-repro.spec.ts` unchanged; targeted cost
and session-status batches are green and TypeScript, spec typecheck, lint, LOC (no ceiling changed),
`check:ui-hints`, the strict wording audit and both production builds pass. Round-4 evidence (the previous batch):
the
verifier's three typed-reply repros are pinned in the new `acp-permission-outcome.spec.ts` and the extended
`acp-cli-adapter.permission-resolved.spec.ts` (all fail against the pre-fix resolver), review retention across
chip switches is pinned in `session-status-dock.component.spec.ts` through a real `InstanceReviewPanelComponent`,
and the seen-on-selecting rule is pinned in `notification-shell.service.spec.ts` through the real
`NotificationCenterStore` (that test fails against the pre-fix effect and passes after `untracked`). Targeted
batches: 2,817 main adapter tests, 914 instance-detail/review/notices tests, and the dependency-compatibility
gate 5/5 after removing the extraneous install residue. TypeScript, spec typecheck, lint, LOC (no ceiling
changed), both production builds, `check:ui-hints` and the strict wording audit pass. Round-3 evidence (the
previous batch): the multi-frame double-charge is reproduced and pinned in the new `claude-assistant-message.spec.ts` (4 tests, wired
through the real `recordInstanceContextCall` and `CacheAnalyticsService`) plus two `cache-analytics-priced.spec.ts`
cases; targeted consumer batches are green (238 tests across the Claude adapter/communication paths, 35 across
session-cost/context-attribution, 46 across the worker-resident cost paths, and the 16 analytics/assistant tests
themselves). The mobile suite passes 515/515 (the moved memoisation test 6.6s in its own file; the windowing suite
now ends at 9.9s per test where the last one took 29s in-file before), with mobile typecheck and lint clean.
TypeScript, spec typecheck, lint, LOC (no ceiling changed), both production builds, `check:ui-hints` and the
strict wording audit pass. Round-2 evidence (the verifier's compiled-runtime repro at 0/3 defects and its 18-file
547-test batch) and round-1 evidence (183-test reconcile batch, 52 consumer tests, the verifier's earlier two
headless repros, 3,386 targeted tests + 31 mobile, generators, IPC/contract checks, mobile typecheck/lint, the
Swift widget simulator-SDK typecheck) are unchanged. The only generated-source delta on this branch remains
`codex/generated/app-server-protocol.gen.ts`, refreshed by the repo's own prebuild snapshot step for installed
`codex-cli 0.164.0` — not hand-edited; this remediation regenerated nothing. These are
implementation checks, not the full-suite or independent completion verdict.
The full suite and fresh `task-completion-gate` PASS remain with the coordinator/verifier (the plan-queue worker
rules reserve the unfiltered suite for the verifier; every file that run flagged is green in isolation and combined).
Twenty-one unrun live checks are recorded in `2026-10-10-oct-phase3-calm-screen_livetest.md`.
`claudeLivePermissionPrompts` still ships **false**; no rollout default was advanced.
The coordinator owns commits, integration, cleanup and the completion rename. This worker did
not commit, stage, stash, create/switch branches, merge, or rename this document.

## As-built notes (dated remediation and implementation sections)

## As-built notes

### Queue worker verification-round-5 remediation, 23 Oct 2026 — current handoff

**Acceptance status:** all 17 implementation steps remain implemented. The queue's independent verifier returned
two findings against the round-4 tree (the coordinator labelled this pass "verification round 2 of 3"): two medium
Costs-page defects — the per-model table dropping Copilot AI credits while rendering Copilot spend as dollars, and
failed session-breakdown requests being cached so they could never be retried. This resume fixed both in the
worktree, re-ran the targeted checks and the repository's fast static gates, and left the branch ready for the
verifier's next pass. No commits, staging, stashing, branch/worktree changes, merges, rollout changes or completion
renames were made; the coordinator owns those. There is still no separate linked specification — the approved
October backlog remains the source.

**Finding 1 (medium) — the per-model Costs table dropped Copilot AI credits and rendered Copilot spend as a
dollar amount.** `buildCostSummary` (`src/main/core/system/cost-summary-builder.ts`) already totals
`aiCreditsNano` per model (`CostSummary.byModel[model].aiCreditsNano` for the credited entry's own model), but the
renderer's `CostSummaryData.byModel` and `ModelRow` omitted the field, `modelRows` (`cost-page.component.ts`)
dropped it, and the template rendered `money(row.cost, 6)` for every model row. For a Copilot-only entry the row
read "gpt-5 ≈$0.000000 at API prices" with no "12.4 credits", against step 12a's "the Costs page shows a Copilot
AI-credit total and no Copilot dollars". Reproduced first (the verifier's headless TestBed repro against the real
component and template; pinned as a failing case). Fixed in `cost-page.component.ts`/`.html`:
- `CostSummaryData.byModel` and `ModelRow` carry `aiCreditsNano?: number`, and `modelRows` forwards it.
- The new `modelCostLabel(row)` renders a credited row as "<credits> AI credits" (1e9 nano = 1 credit, `en-GB`,
  2 fraction digits — the plan's "12.4 AI credits" wording, matching the credits card and the session card),
  falling back to "Not available yet" for `hasUnknownCost` rows and `money(row.cost, 6)` otherwise. The template's
  per-model cost cell now calls it; the `~` estimated prefix, the `% of Total` bar and every other column are
  unchanged, as are the per-session table's provider check and its own AI-credits column.

Test: `cost-page.component.spec.ts` gained "shows a Copilot model row in AI credits with no dollar amount" (the
real template render asserts `modelRows` carries `aiCreditsNano`, and the rendered row contains "12.4" and no
"$"). The verifier's `_scratch/phase3-independent-review/copilot-model-repro.spec.ts` (their exact assertions)
passes unchanged: `gpt-5 12.4 AI credits 0.0%100201`.

**Finding 2 (medium) — failed session-breakdown requests remained cached, preventing retry through Refresh or
reopening the row.** `toggleSession` returned whenever `breakdowns.has(sessionId)`, while `loadBreakdown` cached
`null` on an unsuccessful IPC response or exception and `refreshAll` never invalidated the map — so one transient
failure left the "Models and helpers" fold at "Not available yet" until a new cost event or a full page reload,
and neither the Refresh button nor closing/reopening the row could retry it. Reproduced first (the verifier's
headless repro: the first breakdown call fails and later ones succeed; after Refresh and closing/reopening the row
the IPC call count stayed 1 and the cached value stayed `null`). Fixed in `cost-page.component.ts`:
- `loadBreakdown` now caches only a successful non-empty breakdown (`breakdowns` is `Map<string,
  SessionSpendBreakdown>`; an unsuccessful response, an empty payload and a thrown error are never cached), so
  reopening the row retries a failed load.
- `refreshAll` finishes by loading the breakdown of every expanded row that has none yet (awaited; the existing
  in-flight and per-session generation guards prevent duplicates and stale writes), so Refresh retries an expanded
  "Not available yet" row as well. Successful breakdowns still load once per open fold, and the cost-usage event
  handler still invalidates and reloads the affected rows on new data.

Test: `cost-page.component.spec.ts` gained "retries an unavailable session breakdown after Refresh and reopening
the row" (the failed first call leaves the cache empty; Refresh issues the retry and caches the data; closing and
reopening adds no third call). The pre-existing "loads an unfolded breakdown only once" case is unchanged and
still passes, and the verifier's repro passes unchanged (2 calls, retried breakdown cached).

**Current verification evidence** (worktree root through RTK; quiet-run logs under `_scratch/`):

| Check | Actual result |
|---|---|
| Verifier's `copilot-model-repro.spec.ts` (both round-5 repros, run unchanged via `_scratch/phase3-independent-review/vitest.repro.config.ts`) | 2 tests pass (both failed before the fix) |
| `cost-page.component.spec.ts` (2 new cases plus the existing suite) | 38 tests pass |
| `features/cost/` batch (cost page + cost-session-label) | 39 tests pass |
| `instance-detail/session-status/` (breakdown consumers) | 7 tests pass |
| `npx tsc --noEmit` | exit 0 |
| `npm run typecheck:spec` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0; no ceiling changed |
| `npm run check:ui-hints` | exit 0 |
| `npm run audit:ui-words` | exit 0; Rule E 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 (pre-existing initial-bundle budget warning unchanged) |

Existing expectations were not weakened or re-pinned: both repro behaviours were added as failing cases and fixed
in the component, and no previously passing expectation changed. No new live checks: both fixes are covered by
unit/integration tests (a headless render of the real template and the real component's load/refresh paths); the
21 deferred live checks in `2026-10-10-oct-phase3-calm-screen_livetest.md` are unchanged and none is marked passed
or failed. Deliberately unchanged and outside these findings: the "Cost by Model" donut chart stays dollar-valued
(a credited Copilot model contributes $0 and draws no visible slice). No production settings, database, browser or
desktop session was used, and no runtime was created. This worker did not commit, stage, stash, branch, merge or
rename any document.

### Queue worker verification-round-4 remediation, 23 Oct 2026 — superseded by the round-5 remediation above

**Acceptance status:** all 17 implementation steps remain implemented. The queue's independent verifier returned
four findings against the round-3 tree (the coordinator labelled this pass "verification round 1 of 3"): one
high-severity permission-resolution defect and three medium defects (review-panel state loss on chip switches,
notifications auto-marked seen, and a failing production-dependency gate in the supplied install). This resume
fixed all four in the worktree, re-ran the targeted checks and the repository's fast static gates, and left the
branch ready for the verifier's next pass. No commits, staging, stashing, branch/worktree changes, merges,
rollout changes or completion renames were made; the coordinator owns those. There is still no separate linked
specification — the approved October backlog remains the source.

**Finding 1 (high) — typed ACP refusals and once-only replies could grant persistent permission.**
`selectAcpPermissionOutcome` (`src/main/cli/adapters/acp-permission-outcome.ts`) considered the raw
`normalized.includes(slug(option.name))` label-substring match before any refusal/assent wording. With the
options from `acp-cli-adapter.permission-resolved.spec.ts` (an `allow_always` option named "Allow" plus an
`allow_once`), "no, do not allow", "please allow this once" and "yes, allow it" all resolved to `allow_always`,
and the renderer's typed-reply path (`user-action-request.component.ts`, "Or type a reply") reaches this resolver
untagged, so step 11b's "a typed yes never selects an always option" guarantee held only for single-word replies.
Reproduced first (the verifier's three cases, then pinned as failing unit cases). Fixed in depth:
- The user's words now decide before any label is consulted: word-bounded refusal wording (leading "no"/"n"/
  "never"/"deny"/"decline"/"stop"/"cancel"/"not", plus phrases like "do not", "don't", "never", "not allowed",
  "will not") resolves to the reject side; word-bounded assent wording ("yes", "y", "allow", "approve", "grant",
  "ok", "go ahead", …) resolves to the allow side.
- Generic assent/refusal still never chooses an always option while a once choice exists; only explicit lasting
  wording ("always", "forever", "remember", "permanent", … without a "once" in the same reply) prefers the
  `*_always` option. A reply saying both prefers once (the conservative direction).
- Exact `optionId` (raw) and `permissionKey` matches still win first (the button path is untouched), then exact
  slug-equality on ids/names, then word-boundary label phrases (longest label wins) — never a raw substring.
- The fallbacks (leading "n"/"y", deny/allow words, default `allow ?? options[0]`) are unchanged in spirit and
  now share the once-preferring choice helpers.
Tests: new `acp-permission-outcome.spec.ts` (the verifier's three cases plus refusals with "allow" in them,
once/always wording, exact ids and names, word-boundary label matching, cancel semantics, always-only agents and
permission-key resolution — 10 cases). `acp-cli-adapter.permission-resolved.spec.ts`'s typed-reply matrix gained
the three verifier repros (`no, do not allow` → `reject-once`, `please allow this once` → `once`,
`yes, allow it` → `once`) through the real `TestAcpCliAdapter`. All previously pinned outcomes
(`allow_always` exact id, `yes`/`allow` → once, `deny` → `reject-once`, `allow` → `allow-once` in
`acp-cli-adapter.spec.ts`) are unchanged.

**Finding 2 (medium) — switching dock chips discarded the current code-review session.** The dock's
`@switch (activeChip())` destroyed `InstanceReviewPanelComponent` whenever another chip was selected or the
second opinion opened, and the panel keeps its run (`sessionId`, `issues`, `summary`, finding selections) in
component state with no rehydration on construction — so re-opening Review showed an empty panel while the dock
badge still advertised the retained issues. Before this plan's dock the inspectors used independent visibility
signals, so opening Agents never unmounted Review; step 5 requires the panels unchanged in behaviour. Fixed in
`session-status-dock.component.html`/`.ts`: the review panel renders outside the switch, mounts once (first
`toggleChip('review')` or `openReview()`, tracked in `reviewMounted`) and is hidden with `display:none` instead
of unmounted while another chip is active; the second-opinion open path hides it the same way. The panel still
unmounts when the session identity (`instanceId:sessionId`) changes, where the dock already resets its other
review signals. Test: `session-status-dock.component.spec.ts` gained "keeps the review panel and its run across
chip switches and the second opinion", which drives a real `InstanceReviewPanelComponent`, seeds `sessionId`
and `issues`, then asserts the same component instance (and its state) survives Agents, the second opinion and
back to Review, and that a session switch starts fresh.

**Finding 3 (medium) — new notifications were marked seen without a new user selection.** The selection effect
in `notification-shell.service.ts` called `center.markSessionSeen(id)` untracked-free, and
`NotificationCenterStore.markSeen` synchronously reads its records signal before awaiting IPC — so every
notification delta re-ran the effect and immediately marked brand-new records seen (including while Harness is
in the background), breaking step 7c's "seen when you open the panel or select a session" semantics. Reproduced
first (the new test fails against the pre-fix effect: `notificationMarkSeen({instanceId})` fires on a delta and
the count drops). Fixed by wrapping the call in `untracked`, keeping the effect's only dependency on the
selection itself. Test: `notification-shell.service.spec.ts` gained a case with the real
`NotificationCenterStore` (stubbed IPC api) asserting a delta never marks anything, a selection does, and a
later delta for the still-selected session stays unseen.

**Finding 4 (medium) — the production-dependency gate failed in the supplied checkout.**
`scripts/__tests__/dependency-compatibility.spec.ts` reported `toml-eslint-parser@1.0.3` and its nested
`eslint-visitor-keys@5.0.1` as extraneous in the worktree install. Root cause investigated, not guessed: the
root checkout carries uncommitted `package.json`/`package-lock.json` changes from another session that declare
`toml-eslint-parser`, the worktree's node_modules was provisioned from that install, and this branch's manifests
do not declare it — so the package is genuinely extraneous against the checkout the gate validates (the
classifier rightly fails closed on unattributable extraneous packages). Removed
`node_modules/toml-eslint-parser` from the worktree install only; the root checkout's install matches its own
dirty manifests and was left untouched. The gate now passes 5/5 (the pre-existing `@types/node` "invalid" noise
is the classifier's documented benign case).

**Current verification evidence** (worktree root through RTK; quiet-run logs under `_scratch/`):

| Check | Actual result |
|---|---|
| New `acp-permission-outcome.spec.ts` (typed-reply intent first) | 10 tests pass (the verifier's 3 repros fail against the pre-fix resolver) |
| `acp-cli-adapter.permission-resolved.spec.ts` (typed-reply matrix through `TestAcpCliAdapter`) | pass, now 7 reply cases including the 3 repros |
| `session-status-dock.component.spec.ts` (real `InstanceReviewPanelComponent`) | 9 tests pass (new retention case; destroyed-under-`@switch` fails it) |
| `notification-shell.service.spec.ts` + `notification-center.store.spec.ts` | 11 tests pass (new seen-on-selecting case fails before the `untracked` fix) |
| Main adapter batch (`src/main/cli/adapters/`) | 2,817 tests pass |
| Instance-detail / review / notices renderer batch | 914 tests pass |
| `scripts/__tests__/dependency-compatibility.spec.ts` | 5/5 pass (was 1 of 5 failed; extraneous install residue removed) |
| `npx tsc --noEmit` | exit 0 |
| `npm run typecheck:spec` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0; no ceiling changed |
| `npm run check:ui-hints` | exit 0 |
| `npm run audit:ui-words` | exit 0; Rule E 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 (pre-existing initial-bundle budget warning unchanged) |

Existing expectations were not weakened or re-pinned: the three repro cases were added as failing cases and
fixed in the resolver; no previously passing expectation changed. No new live checks: all four fixes are covered
by unit/integration tests; the 21 deferred live checks in
`2026-10-10-oct-phase3-calm-screen_livetest.md` are unchanged and none is marked passed or failed. No
production settings, database, browser or desktop session was used; the only runtime change was deleting the
two extraneous `node_modules` directories from the worktree install. This worker did not commit, stage, stash,
branch, merge or rename any document.

### Queue worker verification-round-3 remediation, 23 Oct 2026 — superseded by the round-4 remediation above

**Acceptance status:** all 17 implementation steps remain implemented. The queue's independent verifier returned
two findings against the round-2 tree (verification round 3): one Claude per-call cost-accounting defect and one
red mobile gate. This resume fixed both in the worktree, re-ran the targeted checks and the repository's fast
static gates (plus the full mobile suite the finding demanded), and left the branch ready for verification round 4.
No commits, staging, stashing, branch/worktree changes, merges, rollout changes or completion renames were made;
the coordinator owns those. There is still no separate linked specification — the approved October backlog remains
the source.

**Finding 1 (medium) — multi-frame Claude calls were each charged as extra cache rewrites.** One Claude model
call can reach `processClaudeAssistantMessage` as several assistant stream frames (thinking, text, tool_use) that
share `message.id` and re-report the same call usage; each frame emitted its own `context` event and each event
reached `CacheAnalyticsService.recordCall`, so `assessCacheMiss` re-charged the same cold-cache rewrite per frame
(three frames = three 100K-token rewrite charges for one call) and pushed duplicate ratio samples. Reproduced
first: the new `claude-assistant-message.spec.ts` fails against the pre-fix code (no `callId` on the event,
`rewriteTokens` 300,000 for what should be one100,000-token rewrite). Fixed in depth:
- `claude-cli-adapter.types.ts`: `RawCliPayload.message` gains the provider call identity `id?: string` (the
  CLI's `msg_…`), documented as the once-per-call accounting key.
- `claude-assistant-message.ts`: the per-call `context` event now carries `callId: message.id` alongside the
  existing `uncachedInput`/`cacheRead`/`cacheWrite`/`mainThread` accounting fields (an untyped extra on that
  event, exactly like those fields). The occupancy block (`used`/`total`/`percentage`,
  `hasPerCallUsageThisTurn`, `lastObservedContextUsage`) is untouched and still runs on every frame.
- `instance-cache-usage.ts`: `recordInstanceContextCall` forwards the identity to `recordCall`.
- `cache-analytics-service.ts`: `recordCall` accepts `callId?` and accounts each call once — a repeat of an
  already-accounted id returns before `recordMiss` and before the sample push. The remembered ids are a bounded
  FIFO per instance (`MAX_ACCOUNTED_CALL_IDS = 64`, insertion order = eviction order). An absent id keeps the
  previous per-frame accounting (there is no identity to group on), and the id is remembered only when the frame
  is actually accounted, so a usage-less early frame cannot swallow a later one's charge. `resetBaseline` keeps
  the id set (ids are unique per provider call).
Tests: `claude-assistant-message.spec.ts` covers the verifier's scenario end-to-end through the real
`recordInstanceContextCall` and `CacheAnalyticsService` — one baseline call plus a three-frame call sharing
`message.id` charges one rewrite and two samples while every frame still emits occupancy; a later call with its
own id still charges; frames without an id keep per-frame accounting; per-frame occupancy updates are pinned.
`cache-analytics-priced.spec.ts` adds the service-level contract (same `callId` charged once, distinct ids both
charged, no id = status quo, and the FIFO bound forgets the oldest id rather than leaking).

**Finding 2 (medium) — the mobile 1000-message parse-once test timed out in the full suite.**
`transcript-view.component.spec.ts` "parses each of 1000 messages once across repeated transcript renders and
invalidates changed content" exceeded its 60s budget (1 failed / 514 passed). Reproduced first: the test fails
at 79.9s in its file even in isolation. Root cause measured, not guessed: cumulative Angular `[innerHTML]`
sanitiser work superlinearly slows the later DOM fixtures of one test file — eight identical 300-message render
cycles in one file degraded 0.6s → 13.2s per cycle with DOM node count (3008) and heap flat, and the slowdown
traced to Angular's `DomSanitizer.sanitize(HTML)` path (per-call cost grew ~4x across 750 probe calls: 1.2ms →
5.0ms) rather than to marked, DOMPurify, raw jsdom DOM work or raw `DOMParser` (all flat in isolation probes).
The test itself is healthy alone (10s).
Fixed without touching product code or the test's contract: the test moved unchanged — same name, same
assertions, same 1000-message scale, same 60s budget — to `apps/mobile/src/app/features/conversation/transcript-view.memoisation.spec.ts`, which runs in its own test process (fresh jsdom; 6.6s), with a pointer
comment left where it used to sit in the windowing suite. Both transcript files then pass together (35s for the
eight windowing tests, down from 167s), and the finding's demanded rerun is green: `npm run test:quiet` in
`apps/mobile` reports **515 passed / 0 failed**, with mobile `typecheck` and `lint` both exit 0. No new live
checks: both fixes are covered by unit/integration tests and the full mobile suite; the 21 deferred live checks in
`2026-10-10-oct-phase3-calm-screen_livetest.md` are unchanged and none is marked passed or failed.

**Current verification evidence** (worktree root through RTK; quiet-run logs under `_scratch/`):

| Check | Actual result |
|---|---|
| New `claude-assistant-message.spec.ts` (multi-frame through real seam/analytics) | 4 tests pass (failed before the fix: missing `callId`, `rewriteTokens` 300,000 ≠ 100,000) |
| `cache-analytics-priced.spec.ts` + `cache-analytics-service.spec.ts` | 12 tests pass (2 new once-per-call cases) |
| Claude adapter / communication consumer batch (`claude-cli-adapter.spec.ts`, `claude-control-integration.spec.ts`, `claude-live-permission.spec.ts`, `instance-communication.spec.ts`, `communication-completion-cost.credits.spec.ts`, `context-analytics-wiring.spec.ts`, `cache-miss.spec.ts`, `context-attribution-service.spec.ts`, `instance-session-cost.integration.spec.ts`) | 273 tests pass (238 + 35 batches) |
| Worker-resident cost paths (`cli-worker-resident-cost.spec.ts`, `claude-direct-failed-usage.spec.ts`, `claude-dispatch-failure.spec.ts`) after `build:main` | 46 tests pass |
| Mobile `test:quiet` (full suite, the finding's demanded rerun) | PASS: 515 tests (0 failed); `mobile-tests-41193.log` |
| Mobile `typecheck` / `lint` (from `apps/mobile`, after `npm ci`) | both exit 0 |
| `npx tsc --noEmit` | exit 0 |
| `npm run typecheck:spec` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0; no ceiling changed |
| `npm run check:ui-hints` | exit 0 |
| `npm run audit:ui-words` | exit 0; Rule E 0 |
| `npm run build:main` | exit 0 (prebuild snapshot found `codex/generated/app-server-protocol.gen.ts` current — no regeneration this round) |
| `npm run build:renderer` | exit 0 |

Existing expectations were not weakened or re-pinned: the moved mobile test is byte-identical apart from its
fixture copy, and no previously passing expectation changed. The unfiltered suite stays with the verifier per the
plan-queue worker rules. No production settings, database, browser or desktop session was used; `apps/mobile`
dependencies were installed with `npm ci` against the committed lockfile for the mobile gates and are removed
again after this report. This worker did not commit, stage, stash, branch, merge or rename any document.

### Queue worker verification-round-2 remediation, 23 Oct 2026 — superseded by the round-3 remediation above

**Acceptance status:** all 17 implementation steps remain implemented. An independent verifier ran its
compiled-runtime repros and the review surface against the round-1 tree and returned three findings
(verification round 2 of 3). This resume fixed every finding in the worktree, re-ran the targeted checks and the
repository's fast static gates, and left the branch ready for verification round 3. No commits, staging,
stashing, branch/worktree changes, merges, rollout changes or completion renames were made; the coordinator
owns those. There is still no separate linked specification — the approved October backlog remains the source.
The verifier's own repro script and log are under `/tmp/phase3-verifier-919670dc/` (its evidence); this worker
re-ran that script unchanged against the rebuilt `dist/main` and it reports 0/3 defects.

**Finding 1 (high) — a cancelled live-permission reply could approve an unrelated held tool.** The stale-id
guard in `deferred-permission-handler.ts` only fired while `livePermissions.hasPending()` was true, so a reply
naming a cancelled (withdrawn) live card — the broker has no pending asks left — fell through into held recovery
and wrote a decision for whatever `getDeferredToolUse()` held (`INPUT_REQUIRED_RESPOND` also forwarded the
client requestId with no pending-request ownership check). Fixed in depth:
- `claude-live-permission.ts`: the broker now remembers the card ids it minted after they close (bounded FIFO,
  256) and exposes `knowsCard(cardId)` — true for live or closed cards, false for ids it never minted
  (held-path request ids).
- `deferred-permission-handler.ts`: when `answer()` could not take the reply, an explicit `requestId` that
  names one of the broker's own cards (or arrives while any ask is pending) throws
  `Live permission request is no longer pending` and never reaches the held path. Ids the broker never minted
  still fall through, so held (hook-deferred) replies keep working on adapters that also carry a live broker.
  `LivePermissionPort` gained optional `knowsCard?` (old adapters/transport proxies keep the previous
  hasPending-only behaviour).
- Ownership at the client boundary: `InstancePermissionRequestFlow.isPending(instanceId, requestId)` and
  `InstanceManager.isPendingInputRequiredPermission` answer "is this instance still waiting on that request";
  the `deferred_permission` branch of `INPUT_REQUIRED_RESPOND` and the thin-client
  `THIN_CLIENT_INPUT_REQUIRED_RESPOND` equivalent now reject non-pending request ids with
  `INPUT_REQUIRED_NOT_PENDING` (the code the renderer already treats as "stale, drop the card") before any
  resume. The branch itself moved to `src/main/ipc/handlers/instance-deferred-permission-response.ts`
  (instance-handlers.ts was over its LOC ratchet after the gate; the allowlist ceiling was re-tightened
  1251 → 1230, not raised).
Tests: `deferred-permission-handler.spec.ts` pins the verifier's scenario with a real broker — create and
cancel a WebFetch card, hold a Bash call, reply to the cancelled card → rejects and `writeDecision` is never
called; `claude-live-permission.spec.ts` pins `knowsCard` for live/closed/never-minted ids;
`instance-handlers.spec.ts` and `thin-client-command-executor.spec.ts` pin the ownership rejection;
`instance-permission-decisions.spec.ts` pins it through the real flow (cleared request → no resume).

**Finding 2 (medium) — answered ordinary questions left unresolved notifications.** Notifications resolved
only on `instance:input-required-resolved`, which the ordinary AskUserQuestion answer path never emits (the
same missing event round 1 covered in `PendingRequestStore`). Fixed in `input-required-notifier.ts` with the
same lifecycle fallback: it tracks the notifications it created (requestId → instanceId, plus the status seen
at add time) and resolves them when the instance leaves the waiting states (`waiting_for_input`,
`waiting_for_permission` → anything else) or its session is removed (`instance:state-changed` /
`instance:removed`; `emitObserversSafely` invokes regular listeners via `rawListeners`, so these reach it).
Prompts still open while the session merely moves between waiting states stay open.
Tests: `input-required-notifier.spec.ts` covers the verifier's scenario (question → busy → idle leaves zero
unseen+unresolved), the waiting→waiting hold-open case, and the removed-session case.

**Finding 3 (medium) — late retrieved context could ride a later machine-written message.** The step-15 origin
filter stopped *fresh* retrieval for machine turns, but `queueDeferredInputContexts` put deadline-slowed
results into the untyped continuity queue and `InstanceCommunication.sendInput` prepared that queue for
internal/automated sends too. Fixed by typing the queue: `InstanceContinuityInputQueue.queueContinuity` takes
`{ userOnly }` (default **true** — a preamble queued without an explicit audience serves the next *user*
input), `prepare`/`consume` take the send's `InputMessageOrigin` and only hand user-only preambles to origin
`'user'` (an undeclared origin is treated as machine); `sendInput` passes
`internalSource ? 'internal' : automatedInput ? 'automated' : 'user'`. `queueDeferredInputContexts` tags its
late result `{ userOnly: true }` — it waits for the next user message and never a continuation or Plan Queue
prompt. Conversation-continuity callers (compaction recovery, replay continuity, handoffs, create-time
enrichers, interrupt-respawn continuity) explicitly queue `{ userOnly: false }` via the manager/lifecycle
wiring, so their behaviour on machine turns is unchanged; context warnings stay any-turn.
Tests: `instance-continuity-input-queue.spec.ts` pins the origin rules (machine turns and undeclared origins
never see user-only text and cannot consume it before a user send; explicit any-turn preambles still reach
machine turns); `instance-input-contexts.spec.ts` pins the verifier's scenario end-to-end through the real
queue — including the variant whose 2-arg queue hook drops the tag — and `instance-manager-context-deadline.spec.ts`
now pins the `{ userOnly: true }` tag on the deferred queueing.

**Current verification evidence** (worktree root through RTK; quiet-run logs under `_scratch/`):

| Check | Actual result |
|---|---|
| The verifier's own `runtime-repros.cjs` against rebuilt `dist/main` | 0/3 defects: `{"rejected":true,"decisions":[]}`, `{"unseenUnresolved":0}`, `{"internalContextBlock":null}` |
| 18-file targeted batch (every touched module + its consumers: deferred-permission handler, live-permission broker, instance-handlers, permission-decisions, thin-client, permission-request flow, notifier, continuity queue, input-contexts, context-deadline, instance-manager lifecycle, communication + cancellation, live-policy, claude live-permission adapter, channel prompt bridge, mobile-gateway server + steer) | 547 tests pass (`test-run.pid-96148.log`) |
| Earlier same-resume batches (history/compaction/continuity-recovery/revival 236, interrupt/session/chat 198, notifications 44, `instance/__tests__` 369) | all pass |
| `npx tsc --noEmit` | exit 0 |
| `npm run typecheck:spec` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0; no ceiling raised (instance-handlers re-tightened 1251 → 1230) |
| `npm run check:ui-hints` | exit 0 |
| `npm run audit:ui-words` | exit 0; Rule E 0 |
| `npm run build:main` | exit 0 (its prebuild refresh regenerated `codex/generated/app-server-protocol.gen.ts` for installed codex-cli 0.164.0) |
| `npm run build:renderer` | exit 0 |

Existing expectations that changed were re-pinned to the new contracts, strictly to assert the new intended
behaviour (none weakened): two `instance-manager-context-deadline.spec.ts` deferred-queueing assertions now
also expect `{ userOnly: true }`; `instance-continuity-input-queue.spec.ts`'s consume calls pass the origin
they mean (`'user'`) alongside three new origin-rule tests; the specs' manager/IPC mocks gained
`isPendingInputRequiredPermission` (true by default) for the new ownership gate. The unfiltered suite stays with the verifier per the plan-queue
worker rules. No new live checks were introduced — all three fixes are covered by unit/integration tests and
the verifier's compiled-runtime repro; the 21 deferred live checks in
`2026-10-10-oct-phase3-calm-screen_livetest.md` are unchanged and none is marked passed or failed. No
production settings, database, browser or desktop session was used; no dependency installs or runtime trees
were created. This worker did not commit, stage, stash, branch, merge or rename any document.

### Queue worker verification-round-1 remediation, 23 Oct 2026 — superseded by the round-2 remediation above

**Acceptance status:** all 17 implementation steps remain implemented. An independent verifier ran the full
suite against the merge-of-main tree and returned four findings (verification round 1 of 3). This resume fixed
every finding in the worktree, re-ran the targeted checks and the repository's fast static gates, and left the
branch ready for verification round 2. No commits, staging, stashing, branch/worktree changes, merges, rollout
changes or completion renames were made; the coordinator owns those. There is still no separate linked
specification — the approved October backlog remains the source. Evidence logs under
`_scratch/phase3-round2/` (disposable) and the verifier's own under `_scratch/phase3-independent-verifier/`.

**Finding 2 (high) — A0 historical-cost repair broke under `078_copilot_credits`.** `077_a0_per_turn_cost_booking`
created `cost_entries_a0_backup` with `cost_entries`'s original 12 columns; `078_copilot_credits` then widened
only `cost_entries` to 18, so `repairCostEntriesA0`'s `INSERT INTO cost_entries_a0_backup SELECT * FROM cost_entries`
threw "12 columns but 18 values" and rolled back the whole repair on every startup (`cost-handlers.ts` calls it at
boot). Fixed in `cost-entries-a0-repair.ts`: the backup copy now names the twelve original columns
(`id, timestamp, instance_id, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
cost, reasoning_tokens, is_estimated`) on both sides of the INSERT, so it works whatever shape either table has
(pre-078, post-078, or a rebuilt widened backup). Regression in `cost-entries-a0-repair.spec.ts`: "backs up through
the widened cost table whether the backup kept the 12- or 18-column shape" rebuilds the backup with the 18-column
shape and asserts the repair completes; the four previously failing tests pass against the migrated schema again (they
run `runMigrations`, i.e. historical repair verified with the new migration), and `cost-purpose-history.spec.ts` is
green again.

**Finding 4 (medium) — Copilot credit backfill on a truncated tail.** `readCopilotCheckpointTail` returned as soon
as it saw one checkpoint, so a previous checkpoint outside the first 256 KiB was never found; with no booked row the
recorder substituted a zero baseline and charged the whole cumulative total (violating step 12a's resume-delta /
no-backfill rule). Fixed in `copilot-usage-checkpoint.ts`: the 256 KiB read now expands to 1 MiB whenever the
previous checkpoint is still missing and the window never reached the start of the file, and the return type gained
`truncated: boolean` — a missing `previous` on a complete tail means a truly first checkpoint, on a truncated tail
it means unknown history. Fixed in `copilot-credit-recorder.ts`: with no booked row and no previous checkpoint, a
truncated tail books **nothing** (never the running total) and a complete tail alone may seed from zero. Tests:
checkpoint spec pins both expansions (previous recovered past 256 KiB; `truncated: true` with no `previous` beyond
1 MiB); recorder spec pins the verifier's scenario (two checkpoints 300 KiB apart book the 1e9 delta, not the 2e9
total) and the no-backfill case (beyond 1 MiB: no entry, and the next adjacent checkpoint books only its own delta).
The independent verifier's `credits-repro.spec.ts` passes unchanged.

**Finding 3 (medium) — answered Claude questions reappeared as the pending prompt.** `PendingRequestStore` deleted
requests only on `inputRequiredResolved$`, which the ordinary AskUserQuestion answer path never emits; `forInstance`
merely hid them outside waiting states, so the old question resurfaced (and sorted first) in the next waiting state.
Fixed in `pending-request.store.ts` with lifecycle clearing: an effect over `InstanceStore.instances()` drops an
instance's requests when the instance leaves the waiting states (the turn completed past the prompt) or is removed;
the `inputRequired$` handler records the status observed at add time so the first observed transition counts, and a
plain request-owner map lets removals clear even requests the effect never saw in a waiting state. Regression in
`pending-request.store.spec.ts` covers exactly the next-waiting-state scenario (question A → busy → idle → waiting +
question B shows only B) and the removed-session case. The independent verifier's headless `repro.spec.ts` passes
unchanged.

**Finding 1 (high) — fourteen failing test files reconciled.** The independent `npm run test:quiet` had 18 failed
tests in 14 files. Every one was a stale check or fixture against the branch's intended behaviour; no runtime
behaviour was wrong and no assertion was weakened (three assertions became strictly more specific). Per file:

| File | Root cause | Reconciliation |
|---|---|---|
| `scripts/__tests__/cross-wave-smoke.spec.ts` (3 tests) | (a) helper-pause expiry smoke read a detached chip node — step 7b's chip hides when nothing is wrong; (b) `interrupt-boundary` messages are a visible item now (the branch's `isQuiet` change + 8d's sentence divider), so "suppresses interrupt boundaries" was obsolete; (c) `app.open-browser`/`app.open-doctor` moved out of `dashboard.component.ts` into the shared command catalog (`command.types.ts`; `dashboard.component.spec.ts` pins their absence) | (a) `helper-pause-expiry-smoke.ts` asserts against the live DOM after expiry; (b) expects `['system-event-group', 'compaction-summary', 'interrupt-boundary']` and retitles; (c) pins the catalog's `actionId`s instead of the dashboard source |
| `src/renderer/app/core/state/channel.store.spec.ts` | stale app name in `senderName` (plan 8d: `channel.store.ts:118` 'Harness') | expectation → `'Harness'` |
| `src/worker-agent/__tests__/worker-config.spec.ts` | stale app name in the default scratch root label (`worker-config.ts:525` 'Harness Scratch') | expectation → `'Harness Scratch'` |
| `src/renderer/app/core/services/ipc/cross-model-review-daily-usage.spec.ts` | A14 rename: indicator shows 'Second opinion: limit reached' | both assertions pin `'Second opinion: limit reached'` |
| `src/renderer/app/features/local-ai-guard/local-ai-guard-focus.integration.spec.ts` | rename table collapsed 'Local capacity, proven end to end' to 'Local AI' (page `h1`) | expectation → `'Local AI'` |
| `src/main/app/cross-model-loop-predicate.spec.ts` | the init step was renamed 'Second opinion' (`late-runtime-initialization-steps.ts:414`) | lookup key updated |
| `src/main/instance/instance-communication.partial-usage.spec.ts` | `recordTurn` now carries the full `CacheTurnInput` contract (`model`, `promptTokens`, `provider`, `ttlMs` from main's cache-analytics + 13c's TTL) | expectation pins all seven fields |
| `src/main/instance/__tests__/instance-manager.change-model.spec.ts` | 8d's stall copy (`stall-notices.ts:9`) | content → 'No output for 300s. If it stays silent, Harness will restart the session.' |
| `src/main/instance/__tests__/instance-manager.create.spec.ts` | 8d's attachment-drop copy (`orchestrator-attachment-fallback.ts:23`) | regex → "can't take image attachments, so 1 image was left out." |
| `src/main/cli/adapters/codex-cli-adapter.provider-turns.spec.ts` | 8d's compaction boundary notice (`context-cost-controller.ts:455`) | substring → 'Codex is carrying on with the task.' |
| `src/main/context-evidence/context-evidence-baseline.spec.ts` (load failure) | its `fs/promises` mock predates `copilot-usage-checkpoint.ts`'s `node:fs/promises` import in the graph (via completion-cost → credit recorder) and had no `default`/`open` | mock extended with `open` and a `default` export |
| `src/worker-agent/remote-interaction.integration.spec.ts` | the hand-rolled component view lacks `answering`/`withdrawnInputs` fields that `respond()` now uses | fixture extended |

All wording expectations now match the plan's canonical copy (`PRODUCT_NAME = 'Harness'`, the A14 'Second opinion'
family, 8d's sentence pass); the runtime strings were already the intended ones.

**Current verification evidence** (worktree root through RTK; logs under `_scratch/phase3-round2/`):

| Check | Actual result |
|---|---|
| 17-file reconcile batch (the 14 verifier-failing files + the 3 changed-module specs) | 183 tests pass, exit 0 (`reconcile-batch.log`) |
| consumer specs (needs-you store/strip, session-hover-card, cost-tracker, cache-analytics, completion-cost credits) | 52 tests pass (`consumers.log`) |
| verifier's own repros (`credits-repro.spec.ts`, `repro.spec.ts`, their `repro.config.ts`) | both pass unchanged |
| `npx tsc --noEmit` | exit 0 |
| `npm run typecheck:spec` (8 GiB wrapper, re-run after the final edit) | exit 0 |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0; no ceiling raised |
| `npm run check:ui-hints` | exit 0 |
| `npm run audit:ui-words` | exit 0; Rule A 0, Rule E 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` (re-run after the final edit) | exit 0 |

The unfiltered suite stays with the verifier per the plan-queue worker rules; every file it flagged is green in
isolation and in the combined batch above. No new live checks were introduced — all four fixes are covered by
unit/integration tests; the 21 deferred live checks in `2026-10-10-oct-phase3-calm-screen_livetest.md` are
unchanged and none is marked passed or failed. No production settings, database, browser or desktop session was
used; no dependency installs or runtime trees were created.

### Queue worker merge-of-main conflict resolution, 23 Oct 2026 — superseded by the round-1 remediation above

**Acceptance status:** unchanged — all 17 implementation steps remain implemented. The coordinator merged
main (`0c4b7de7a` phase4-tooltips plan + `6afb32a52` oct2-housekeeping plan) into the branch over checkpoint
`fefac96d7` (base `1ee52cbd8`). The merge arrived with 16 conflicted files (18 conflict hunks). This worker
resolved every conflict so both sides' intent survives, removed all conflict markers, staged the resolved
files plus the integration fallout fixes below, and left the merge uncommitted for the coordinator (who
finishes it). This worker did not commit, stash, switch branches, or abort/complete the merge.

**Conflict resolutions (both intents kept):**

1. `policy-adapter.ts` — both method-entry guards: Phase 3's `surfaced` reset for the instance runs first
   (so disabled builds still clear stale surfaced state), then main's `!config.enabled` early return.
2. `rlm-migrations-076-080.ts` — both migrations survive with their exact names and SQL (`078_copilot_credits`
   from Phase 3 step 12a; `078_wake_hint_tombstones` from main). Names are byte-identical to each side's
   applied text on purpose: `runMigrations` checksum-verifies applied migrations and keys them by name, so
   renaming either would re-run or break an existing database. The `078_` numbering collision is cosmetic.
3. `storage-usage-service.ts` — the two cleanup notes now describe the merged `listRecords` behaviour
   (session records: older than 30 days, no longer in History, outside running/sleeping/unsaved sessions;
   activity logs: same exclusions without the History clause) in the canonical vocabulary.
4. `settings.types.ts` — `AppSettings extends DesktopComputerUseSettings, MobileGatewaySettings,
   ObservationSettings` (Phase 3's split + main's observation settings).
5. `settings-metadata-runtime.ts` — both rows (`memoryNotesEveryMessage`, `observationMemoryEnabled`).
6. `keybinding.types.spec.ts` — both test groups (Phase 3's palette/session-name tests + main's
   `formatKeyCombo` tests).
7. `app.component.html` — all three root hosts (`app-command-palette-host`, `app-session-status-host`,
   `app-help-drawer`); `app.component.ts` already imported all three.
8. `sidebar-nav.component.ts` / `control-surface-shell.component.{ts,html}` — both nav intents: main's
   observation-aware `groups`/`navGroups` computed feeds Phase 3's `splitNavGroupsByTier`, keeping the
   More tools tier, its persisted open state and `showControlNav`; templates read the computed tiers.
9. `instance-header.component.ts` — Phase 3 C2a's one-row header (its presentation imports and reduced
   component set per step 2) plus main's `HelpLinkComponent` used by the merged template. Main's
   `ProviderAccountChipComponent`/`ContextBar`/pickers stay out of the header per C2a; the chip lives on
   in composer-toolbar and input-panel.
10. `instance-list.component.ts` — union imports (`SessionAttentionTabsComponent` + `AioTooltipDirective`).
11. `wake-management.component.ts`/`.spec.ts` — both evolutions: main's `summarizeWakeHints` summary/hidden
    split and removal confirmation, plus Phase 3's `Shown N times` count with the `memory.shown` tooltip
    ("shown, not used"). Main's spec assertion `shown: 3x` follows the merged span wording (`Shown 3 times`);
    its summary/hidden/confirmation assertions are unchanged.
12. `tooltip-copy.ts` — both entry sets (Phase 3's `secondOpinion.*`/`session.*`/`cost.*` registry + main's
    `accounts.signIn`/`accounts.copySignIn`).
13. `ui-vocabulary.ts` — Phase 3's word list (the C6+C7 deliverable; main's copy self-defers: "Broad
    migration and guards remain Phase 3 work") with the ids main's glossary resolves via `canonical()`
    (`helper-models`, `shortening`), main's glossary-quality definition for `shortening`, and
    `APP_NAME_PATTERN` without its `/g` flag (glossary.spec requires stateless `never` patterns; the only
    consumer rebuilds from `.source`, so behaviour is unchanged and `extract-ui-text.spec`'s "restart AIO."
    hit still passes).

**Integration fallout fixed after the merge (uncommitted until the coordinator's merge commit):**

1. **Rule E wording breach (main's new copy).** `npm run audit:ui-words` failed on
   `storage-cleanup-service.ts:51` ("outside live, **hibernated** or unsaved sessions" — `Hibernated` is a
   banned status word under the `asleep` term). Swept to "outside running, sleeping or unsaved sessions",
   matching the resolved usage notes. Audit re-run: Rule A 0, Rule E 0, exit 0.
2. **Tier-partition spec vs the observation gate.** `control-surface-tiers.spec.ts` partitioned
   `listControlNavGroups()` (default excludes the observation-gated `observations` surface), so 52 of 53
   destinations appeared. The spec now partitions `listControlNavGroups(true)` — the full destination set —
   while main's gate (hide Observations unless observation memory is on) stays as merged; main's own
   registry spec covers the gate.
3. **`check:ui-hints` integration remediation (new gate from this merge).** The phase4-tooltips plan
   anticipated exactly this landing ("any change that touches a template or rewords a recorded hover
   sentence runs `check:ui-hints -- --tighten` and, for a reworded sentence, `--retire` with a reason").
   The merged tree measured against main's records: 25 recorded hover sentences reworded by Phase 3's
   tooltip unification (H9), three H1b/H2a/H4/H10/unreadable "new" families from Phase 3's templates, and
   stale records where Phase 3 deleted hint sites. Remediation, all through the sanctioned channels:
   - Cause fixes: `title` → `appTooltip` (unchanged words) on the sidebar/shell nav and the startup-banner
     dismiss; `appTooltip="Dismiss"` on the toast dismiss; tooltip + `data-ui-hints-exempt="backdrop"` on
     the context-details close/scrim and the session-options scrim (the repo-wide backdrop pattern); the
     same marker on session-status-host's backdrop-click dialog; the wake-management count hint made
     keyboard-reachable (`tabindex="0"`); exact hover reasons recorded for the composer account chip and
     the provider-diagnostic pills (`scripts/ui-hints/hover-only-reasons.ts`).
   - `tool-group`'s counts elaboration stays byte-identical (`tool-group.component.spec.ts` pins
     "44 calls · 900,532 characters · 25 results externalized") but its wording now lives in a folder-local
     `diagnosticSummaryText` helper reached from `@let`-bound values, so the hint guard can read the words
     (its tracer cannot follow `toLocaleString` chains; that was the "unreadable" integrity finding).
   - Records: `--tighten` lowered every stale count (no ceiling or count raised by hand); three new
     `backdrop` markers were recorded one at a time via `--exempt <owner> backdrop` (each run staged so it
     saw only its own increase, as the command requires); `--record-wording` recorded 28 new qualifying
     sentences; the 25 H9 entries were retired with unique per-entry reasons through the wording ledger's
     own `retire`/`writeLedger` path — the phase4 plan calls retiring "a visible change to
     `wording-ledger.json`, not a blocked one", with the diff and `--against` listing as the review surface.
   - End state: `npm run check:ui-hints` → `UI hints OK …; 13 markers; 230 wording entries (28 retired)`;
     `--against MERGE_HEAD` exits 0 and lists the 25 retirement reasons plus the marker review notices for
     review.

**Current verification evidence** (worktree root through RTK; logs under `_scratch/merge-resolve-2026-10-23/`):

| Check | Actual result |
|---|---|
| `npm run typecheck` / `npm run typecheck:spec` | both exit 0 |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0; no ceiling raised (`settings.types.ts` 872 vs 889) |
| `npm run check:ui-hints` (+ `--against MERGE_HEAD`) | `UI hints OK`; against-run exit 0 with retirement/marker review listing |
| `npm run audit:ui-words` | exit 0; Rule A 0, Rule E 0 |
| `npm run build:main` / `npm run build:renderer` | both exit 0 (pre-existing initial-budget warning) |
| `npm run generate:aliases` / `generate:ipc` / `verify:ipc` / `verify:ipc-usage` / `verify:exports` / `check:contracts` | all exit 0, no generated churn |
| targeted specs (wording guards, ui-hints machinery, glossary/help, tooltips, nav shells, keybindings, wake-management, storage, rlm migrations, policy-adapter, tool-group, session-status, composer-toolbar, provider-diagnostics, settings migrations, observations) | all pass — 649 tests green across the targeted batches (24+68+189+60+21+161+84+42), incl. both sides' wake-management tests and the pinned `diagnosticSummary()` wording |

The full suite, fresh `task-completion-gate` PASS, the completion rename and the 21 live checks remain with
the coordinator/verifier as before. `claudeLivePermissionPrompts` still ships **false**.


### Queue worker post-merge revalidation, 23 Oct 2026 — superseded by the merge-of-main resolution above

**Acceptance status:** all 17 implementation steps remain implemented. After the earlier 23 Oct resume
sealed, the coordinator merged main into the branch (`f79b9aad5` "Plan queue: merge main", parents
`39a56ce7dfb9` and `1ee52cbd8`) and recreated this worktree, so that resume's evidence directory is gone
and its checks predate the merge. This resume re-ran the worker checks against the merged tree, found and
fixed three faults (below), and leaves the branch ready for the independent verifier. The unchecked full
suite, fresh-eyes PASS and completion rename/integration stay with the coordinator/verifier; the 21 live
checks remain open with no check marked passed or failed. There is still no separate linked specification;
the approved October backlog is the source. The root plan was already ` M` and keeps that index state.

**Faults found and fixed** (uncommitted in the worktree; the coordinator commits them):

1. **LOC ratchet breach (merge fallout).** `npm run check:ts-max-loc` failed on the merged tree:
   `src/shared/types/settings.types.ts` had 890 lines against its 839 ceiling + 50 tolerance. Phase 3
   added `claudeLivePermissionPrompts` and `memoryNotesEveryMessage`, main added `scratchRetentionDays`,
   and the merge legitimately kept all three. Fixed with the repository's existing LOC-split pattern
   (`settings-primitives.types.ts`, `desktop-gateway-settings.types.ts`): the Mobile Gateway cluster moved
   into new `src/shared/types/mobile-gateway-settings.types.ts` as `MobileGatewaySettings`; `AppSettings`
   extends it and `settings.types.ts` re-exports the type, so every `keyof AppSettings` / `AppSettings[K]`
   consumer is unchanged. **No ceiling was raised** — step 8's acceptance holds. The file is now 871 lines
   (within 889).
2. **Spec typecheck errors (main's new specs).** `npm run typecheck:spec` failed with TS2493 in main's new
   `src/main/storage/low-disk-space-watcher.spec.ts` and `src/main/storage/scratch-sweep-scheduler.spec.ts`:
   `notify.mock.calls[0][0]` on zero-argument `vi.fn()` mocks. Fixed by typing each mock's parameter with
   the real `NotificationInput`. No assertion or expectation changed.
3. **Token-metadata regression (Phase 3 vs a pre-existing caller contract).** The targeted run failed
   `src/main/instance/__tests__/instance-manager.send-input.spec.ts › InstanceManager sendInput injects
   indexed codebase context into normal root user turns` (deterministic, reproduced twice): the message
   metadata's `indexedCodebaseContext.tokens` came back as the filter's re-estimate (15) instead of the
   retrieval service's reported count (16) that this base-era test pins. Root cause is Phase 3's
   `filterCode` in `src/main/context/filter-turn-context.ts`, which re-derived `tokens: estimateTokens(text)`
   even when the filter dropped nothing — the text is unchanged in that case, so nothing needed re-deriving.
   Earlier worker batches selected *changed* specs and never covered this unchanged caller, so the
   regression stayed invisible until the merge touched the file and pulled it into the selection. Fixed in
   `filterCode`: when every part is kept, the producer's `tokens` is preserved (consistent with the
   pre-existing early-return path); re-estimation happens only when items are actually dropped and the
   text genuinely changes. No test was modified.

**Current verification evidence** (all commands through RTK from the worktree root unless noted; logs and
observed exit statuses retained under `_scratch/phase3-resume-2026-10-23b/`):

| Check | Actual result | Log |
|---|---|---|
| `npx tsc --noEmit` | exit 0 | `typecheck-final.log` |
| `npm run typecheck:spec` (8 GiB wrapper) | exit 0 | `spec-typecheck-final.log` |
| `npm run lint` | exit 0 | `lint-final.log` |
| `npm run check:ts-max-loc` | exit 0; no ceiling raised; `settings.types.ts` 871 lines vs 889 allowed | `loc-final.log` |
| `npm run build:main` | exit 0, asset sync/preload bundling included | `main-build-final.log` |
| `npm run build:renderer` | exit 0, production Angular templates compiled | `renderer-build-final.log` |
| `npm run generate:aliases`, `npm run generate:ipc` | both exit 0; no tracked churn | `aliases.log`, `ipc-generation.log` |
| `verify:ipc`, `verify:ipc-usage`, `verify:exports`, `check:contracts` | all exit 0 | `ipc.log`, `ipc-usage.log`, `exports.log`, `contracts.log` |
| `npm run audit:ui-words` (strict wording audit) | exit 0; Rule E zero | `ui-audit.log` |
| changed-spec targeted run (`AIO_TEST_NO_CACHE=1`, auxiliary summaries off) | 259 files / **3,386 tests pass**, cold cache | `targeted2.log`; raw `_scratch/test-run.pid-76288.log` |
| dependency compatibility guard | 5 tests pass | `dependency-compatibility.log` |
| mobile targeted status / approval / project (apps/mobile runner) | 31 tests pass | `mobile-targeted.log`; raw `_scratch/mobile-design-verification/mobile-tests-86698.log` |
| mobile `typecheck` / `lint` (from `apps/mobile`, after `npm ci`) | both exit 0 | `mobile-typecheck2.log`, `mobile-lint2.log` |
| fast-path specs outside the selection | 8 tests pass | `fast-path-tests.log`, `fast-path-tests2.log` |

**Targeted selection composition:** the batch selected the 264 spec files changed between base
`542f1f690fae` and HEAD (minus one `.e2e.spec.ts`). Of those, two are branch **deletions** —
`plan-queue-questions-banner.component.spec.ts` and `approval-digest-banner.component.spec.ts`, whose
components step 7 removed wholesale (no file to run; verified nothing still references them) — and three
are `apps/mobile` specs outside the root vitest projects (they ran under the mobile runner above). The
root batch therefore executed 259 files. The earlier failed runs (`loc.log`, `spec-typecheck.log`,
`spec-typecheck2.log`, `targeted.log`, `send-input-rerun.log`, `five-file-recheck.log`) are retained as
fault evidence and are superseded by the table. The mobile typecheck initially reported missing
`@capacitor/*` modules purely because this recreated worktree had no `apps/mobile` dependencies; `npm ci`
against the committed lockfile fixed the environment and `apps/mobile/node_modules` was removed again
after the checks. The Swift widget simulator-SDK typecheck is not re-run: the merge changed no `*.swift`
file, so the earlier resume's pass stands as attributed prior evidence — widget typechecking only, not a
native build, signing, device install or APNs.

**Review and preserved decisions:** a fresh review pass re-read the three fixes and their callers
(`AppSettings` consumers use `keyof AppSettings` / `AppSettings[K]`, preserved by the extends split;
`filterCode`'s per-item budget charging is unchanged and only the no-drop return differs; the early-return
passthrough path and the all-kept path now agree). No assertion was weakened, no test skipped, no ceiling
raised, no LOC workaround. Rollout defaults are untouched: `claudeLivePermissionPrompts` remains
false/internal and `memoryNotesEveryMessage` remains editable/default false. No production settings,
database, browser or desktop session was used.

**Lifecycle and cleanup:** the coordinator owns the full-suite/fresh-agent review cycle, commits,
integration and the completion rename. `report.md`, `seal.json` and command receipts are retained in the
evidence directory. The `apps/mobile` dependency install created for the mobile checks is removed; the
pre-existing desktop dependency install, production build output and AIO-managed checkout are preserved.
No commits, staging, stashing, branches/worktrees, merges, rollout-default changes or live-validation
claims were made.

### Queue worker resume, 23 Oct 2026 — superseded by the post-merge revalidation above

**Acceptance status:** all 17 implementation steps remain implemented; current worker checks pass.
The unchecked full suite, fresh-eyes PASS and completion rename/integration are explicitly owned by
the coordinator/verifier, not unfinished implementation work for this worker. No full suite or
independent PASS is claimed. The 21 live checks remain open, with no check marked passed or failed.

**Resume investigation and scope:** read this root plan, including all historical/as-built notes,
and its live-test document, then checked the clean supplied worktree's history/diff. HEAD is the
coordinator's `39a56ce7dfb9` checkpoint on base `542f1f690fae` (660 changed files). There is no separate
linked specification; the approved October backlog remains the source. All 17 implementation
checkboxes were already checked. No source, test, manifest or generated-file change was needed.
This resume updates only the root plan/live-test handoff evidence at their existing absolute paths;
neither document was copied into the worktree or renamed. Root status was already ` M` for this
plan and `??` for the live-test document; their existing index states are preserved.

**Current verification evidence:** logs and per-command JSON receipts (exact argv, cwd, finish time,
duration and actual exit status) are retained under
`/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-10-oct-phase3-calm-scr-5d08d9/_scratch/phase3-resume-2026-10-23/`.
All commands ran through RTK. Test caching was disabled, with four forks and auxiliary summaries off.

| Check | Actual result | Log in the evidence directory |
|---|---|---|
| `npx tsc --noEmit` | exit 0 | `typecheck.log` |
| `npm run typecheck:spec` (8 GiB wrapper) | exit 0 | `spec-typecheck.log` |
| `npm run lint` | exit 0 | `lint.log` |
| `npm run check:ts-max-loc` | exit 0; no ceilings changed | `loc.log` |
| `npm run build:main` | exit 0, asset sync/preload bundling included | `main-build.log` |
| `npm run build:renderer` | exit 0, production Angular templates compiled | `renderer-build.log` |
| alias / IPC generation | both exit 0, no tracked churn; 1,210 channels | `aliases.log`, `ipc-generation.log` |
| IPC contracts / usage, exports, contract aliases | all exit 0 | `ipc.log`, `ipc-usage.log`, `exports.log`, `contracts.log` |
| strict UI audit | exit 0; 841 renderer files / 20,007 strings; A=0, E=0 | `ui-audit.log` |
| changed desktop/contract/guard specs | 230 files / 2,808 tests pass, cold cache | `targeted.log`, `targeted-specs.json`; raw `_scratch/test-run.pid-6298.log` |
| dependency compatibility guard | 1 file / 5 tests pass, cold cache | `dependency-compatibility.log`; raw `_scratch/test-run.pid-46747.log` |
| mobile typecheck / lint | both exit 0 | `mobile-typecheck.log`, `mobile-lint.log` |
| mobile status/project/approval targeted tests | 31 tests pass | `mobile-targeted.log`; raw `_scratch/mobile-design-verification/mobile-tests-39931.log` |
| Swift widget simulator-SDK typecheck | exit 0 with `-parse-as-library`, iOS 17 simulator target, installed 27.1 SDK | `swift-widget-library.log` |
| base-to-HEAD whitespace check | exit 0 | `branch-whitespace.log` |

The first standalone Swift command omitted `-parse-as-library` and failed on the widget's `@main`
declaration. The corrected invocation passed without any source edit; both receipts are retained.
This establishes widget typechecking only, not a native-app build, signing, device installation or APNs.
The targeted selection is smaller than the earlier worker's broader 238-file batch; its counts are
reported separately rather than substituting historical output for a current run.

**Review and preserved decisions:** a separate author review pass read the live-permission broker,
control channel, spawn policy, credit recorder/completion hook, retrieval-cap policy and their relevant
protocol/persistence tests, and traced the adapter/resume wiring. No new blocking finding was identified
in that scope. This is a bounded source review, not the independent completion gate. The live-permission
default remains false/internal, the retrieval override remains false/editable, no personal setup was
trimmed and no production settings/database, browser or desktop session was touched.

**Superseded environment warning:** this resume arrived with a pre-existing local worktree dependency
install and a real `node_modules/.package-lock.json`, rather than the earlier root-linked install.
The unchanged dependency compatibility guard now passes against it; no guard was weakened and no
root dependency reinstall was performed. The earlier renderer-event coverage limitation remains
historical evidence; no new pass for that noncanonical check is asserted.

**Lifecycle and cleanup:** the coordinator owns the full-suite/fresh-agent review cycle, commits,
integration and completion rename. `report.md`, `seal.json`, command receipts and `cleanup.receipt.json`
are retained in the evidence directory. Resume-owned mobile dependencies, production build output and
Swift compile cache are removed after sealing; the pre-existing desktop dependency install and
AIO-managed checkout are preserved. No commits, staging, stashing, branches/worktrees, merges,
rollout-default changes or live-validation claims were made.

### Queue worker implementation, 20 Oct 2026 — historical handoff

**Acceptance status:** implementation checks pass; independent acceptance remains open. No full suite was run,
per this worker's explicit brief. All earlier worker counts and full-suite claims are historical.

**Source and scope decisions:**

1. The assigned root plan had no separate linked specification; the approved October backlog is its source.
   The existing Phase 0 dependencies were present on the current base. Earlier checked Phase 3 foundations were
   absent here despite historical parked-branch notes, so the necessary same-plan steps 1–6, 11 and 15 were rebuilt
   from this plan/current sources. No parked branch was copied, merged, promoted or switched into this checkout.
2. The minimal missing Phase 1 control API was implemented as `ClaudeControlChannel` for the required context
   measurement and interrupt/query separation. The actual resident Claude adapter now owns and dispatches both
   the control channel and live-permission broker; these are runtime-wired, not isolated modules.
3. Migration 078 adds nullable credit/checkpoint data, checkpoint running totals and provider identity without
   backfill. Running totals seed resumed sessions without booking old credits again. Full SQLite breakdowns
   do not rely on the 10,000-entry in-memory window. Database-backed credit events emit a complete validated entry.
4. The live rollout flag remains internal/default false; existing surfacing guards forbid metadata/UI rows for
   internal keys. `memoryNotesEveryMessage` remains editable/default false with its Advanced row.
5. Live permission posture changes use queue-aware runtime reconciliation, preserving other desired fields.
   A live Allow once grants only that call. Borrowed machine work fails closed without a human card; real 25-minute
   watchdog behavior remains check 20. Remote/offloaded paths retain their existing behavior.
6. `/status` (with `/session` and `/info`) now opens Harness's card instead of reaching the provider's own command.
   Its root action uses the selected live instance, independent of durable-chat eligibility or dashboard lifetime.
   Global palette startup eagerly registers keyboard handling, including direct secondary-page cold boots.
7. Contained-execution/browser-tools posture extras are omitted as the plan permits: the renderer whitelist does
   not deserialize them. Per-helper transcript samples are deliberately live-only; durable billing remains stored.
   Explicit account quota never falls back to another account's snapshot. Unknown prices/shapes remain unavailable.
8. Current queue authority covers the reversible optional Swift label implementation. It does not grant phone
   signing/install authority or Mac browser/desktop access. Both native ContentState copies and start/update paths
   agree; only the widget was typechecked. No local Mac browser/desktop or production settings/database was used.
9. The extractor scans visible prompt/system-like fields and mixed UI/model modules. Exact documented model-only
   declarations remain excluded. A/E are strict at zero; the per-file instance/thread baseline only decreased
   123 → 121. Floors remain 600 renderer files / 17,800 strings; final inventory is 841 / 20,007.
10. Implementation review corrected strict cost-event rejection, outside-memory-window credit payloads, cold-boot
    palette wiring, wrong `/status` eligibility, extractor false exemptions, duplicate-error Details preservation,
    exact legacy interrupt recognition, stale tooltip expectations, typed fixtures and Angular Event/focus contracts.
    No TS LOC ceiling, assertion suppression or skipped-test escape was introduced. The moved lazy `require`
    lint block in diagnostics was pre-existing code extracted unchanged.

**Current verification evidence** (all commands through RTK; receipts preserve actual exit status):

| Check | Current result | Evidence under the worktree's `_scratch/phase3-worker/` |
|---|---|---|
| `npx tsc --noEmit` | exit 0 | `accepted-typecheck.log` |
| `npm run typecheck:spec` (8 GiB wrapper) | exit 0 | `accepted-spec-typecheck.log` |
| `npm run lint` | exit 0 | `accepted-lint-fixed.log` |
| `npm run check:ts-max-loc` | exit 0; no ceilings raised | `accepted-loc.log` |
| main / renderer production builds | both exit 0 | `accepted-main-build.log`, `accepted-renderer-build.log` |
| alias / IPC generators | both exit 0 | `accepted-aliases.log`, `accepted-ipc-generation.log` |
| IPC contract / usage, package exports, aliases | all exit 0 | `accepted-ipc.log`, `accepted-ipc-usage.log`, `accepted-exports.log`, `accepted-contracts.log` |
| strict UI audit | exit 0; A=0, E=0; 841 files / 20,007 strings | `accepted-ui-audit.log` |
| changed specs + direct caller/contract regressions | 238 files / 3,037 tests pass, cold cache, 4 forks | `accepted-targeted.log`; raw `_scratch/test-run.pid-40295.log` |
| final tooltip fixture format | 1 file passes after lint-only line joining | `accepted-tooltip-format.log` |
| mobile typecheck / lint | both exit 0 | `final-mobile-typecheck.log`, `final-mobile-lint-fixed.log` |
| mobile targeted status / project / approval | 31 tests pass; approval 9-test rerun also passes | `final-mobile-targeted.log`, `final-mobile-approval-fixed.log` |
| Swift widget simulator-SDK typecheck | exit 0; full native app/device not claimed | `swift-widget.log` |
| whitespace / current source review | exit 0 | `accepted-diff.log`; implementation handoff reports |

The first combined runs recorded real failures during concurrent integration; their logs are retained and are
superseded by the final current selection above. After the final selection snapshot, the sole source difference
was joining the indicator test's `it.each` call onto one line for lint; its focused rerun and final lint pass.
Counts from overlapping helper runs must not be summed.

**Known baseline/tooling limits:** the additional non-canonical `verify:renderer-events` check reports three
pre-existing uncovered channels (transcript chunk, local-AI delta, Plan Queue state) and two existing dynamic sites.
The sender files are unchanged and those registry entries are absent in base `542f1f690fae`; see
`renderer-events-baseline-evidence.json` and `integration-renderer-events.log`. Both new pushes are registered and
strict-schema tested. This existing coverage gap was not hidden or represented as a passing check.
The AIO-provided root dependency links were preserved. Adding the required npm audit script makes this worktree's
`package.json` differ from the owning install's manifest (lockfile/dependency versions are unchanged); the full
verifier must bootstrap a real worktree install per `dependency-compatibility.spec.ts`, rather than weaken that guard.

**Review/lifecycle:** the coordinator must run the full suite and fresh `task-completion-gate` loop. No independent
PASS is claimed here. The live campaign has 21 open / 0 closed / 0 failed checks with exact prerequisites and reasons;
these are unrun checks, not reproduced defects. The root document and livetest retain active filenames. The report,
seal, command receipts and cleanup receipt are retained in `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-10-oct-phase3-calm-scr-5d08d9/_scratch/phase3-worker`; only owned runtime outputs/dependencies/caches are
removed, preserving AIO's pre-existing dependency links. No branch/worktree cleanup or integration was attempted.


### Queue worker remediation, 16 Oct 2026 (verifier round 2 findings)

**All four round-2 findings are fixed; the full suite is green.** Details:

1. **Finding 1 (the plan read as "explicitly incomplete"): a stale-notes misread, now impossible.** The verifier
   quoted the *superseded* 13 Oct/15 Oct/12 Oct status claims ("1 of 17 steps fully complete…", "Steps 5-17: not
   started", "0 of 17 implementation steps complete", "the live-test document remain unchecked") as if they were
   current. The checklist and the round-2 notes were already current (steps 1-6, 11 and 15 ticked; livetest doc
   created and ticked). Fixes: every superseded claim is now prefixed **HISTORICAL — superseded by the 16 Oct
   round-2 notes**, "Final gates" is ticked with the full-suite evidence below, and "Fresh-eyes gate PASS" carries a
   precise note that the queue's independent verifier IS that gate (the plan's own Final-verification text defines it
   as "a fresh agent that did no implementation work runs the task-completion-gate skill … repeat until it returns
   VERDICT: PASS"), so it is recorded by the verifier/coordinator and never self-certified. What genuinely remains
   open is unchanged and stated plainly: steps 7-10, 16 and 17 are not implemented, and steps 12-14 are blocked on
   the named missing Phase 0/1 pieces (ground rule 3 forbids rebuilding those foundations here).
2. **Finding 2 (full gate red: 14 failing tests): fixed.** The 11 `AppComponent` failures came from my
   `NeedsYouStore` injection constructing the real needs-you graph (→ `InstanceStore` → `ProviderStateService`
   → `settingsStore.settings()`) against the spec's narrow `SettingsStore` mock. Fix: every setup block in
   `app.component.spec.ts` now provides `{ provide: NeedsYouStore, useValue: { init: vi.fn() } }` (the spec's own
   stub-template pattern; the strip is not compiled there). The other three failures were findings 3 and 4 below.
3. **Finding 3 (hover-card tooltip nested inside chip tooltips + unlisted hover-only host): fixed by re-anchoring,
   not by dropping part 6h.** The tooltip guards reject a tooltip host that *encloses other tooltip hosts*
   (the nested rule) and unlisted hover-only non-interactive hosts (house rule 4). The card moved from
   `.instance-info` (which wraps the unread/automation/plan-queue/side-chat/approval/collapsed/remote tooltip
   chips) to the `.instance-name` text leaf, which has no tooltip descendants; the `.instance-info` div is back to
   a plain div. The remaining hover-only rule is satisfied through the guard's designed extension point:
   `icon-control-tooltip.spec.ts`'s `ELABORATION_ONLY` now lists `instance-name` with the deliberate reason
   ("hover card elaborates the visible session name; the waiting state also shows in the visible Awaiting-approval
   chip"), which is plan part 6h.3's own rule-4 argument. Plan deviation (recorded): the plan said "attach to
   `.instance-info` only"; the guards rejected *that placement* (nesting), and the leaf placement preserves the
   plan's observable behaviour ("hovering a session shows what it is waiting for") while satisfying the rules — the
   6h.4 escape hatch (drop the card) was therefore not needed. The row's hover test now targets `.instance-name`.
4. **Finding 4 (the new advanced setting had no section row): fixed.** `memoryNotesEveryMessage` now renders in a
   new "Retrieved notes" section of the Advanced tab's Runtime group (`advanced-settings-sections.ts`), so the
   coverage test's "every non-hidden advanced setting exactly once" rule holds.

**Gate output (16 Oct, after remediation):**
- `npx tsc --noEmit`: exit 0. `npm run typecheck:spec`: exit 0. `npm run lint`: all files pass.
  `npm run check:ts-max-loc`: ratchet passed, no ceiling raised.
- `npm run build:main`: exit 0. `npm run build:renderer`: exit 0.
- `npm run generate:ipc` / `verify:ipc` (1200 channels) / `verify:ipc-usage`: pass.
- **`npm run test:quiet` (FULL suite): 2560 files / 32562 tests, 0 failures** (log: `_scratch/test-run.pid-9108.log`
  in the worktree). Targeted re-runs after each fix: `app.component.spec.ts` 15/15, `icon-control-tooltip.spec.ts`
  + `advanced-settings-tab.component.spec.ts` + `instance-row.component.spec.ts` 55/55.
- `npm run audit:ui-words`: script does not exist yet — created by step 8a (report-only until part 8g), so the
  gate is not runnable at this scope.

**Live checks remain deferred in `2026-10-10-oct-phase3-calm-screen_livetest.md` (10 open checks), unchanged.**

### Queue worker implementation, 16 Oct 2026 (round 2)

**Result: steps 5, 6, 11 and 15 are complete and verified; step 6 (C4) landed this round in all eight parts. Steps
7-10, 16 and 17 are not started; steps 12-14 stay blocked on the named missing Phase 0/1 pieces.** This round resumed
from checkpoint `234d3c36a` ("before resume"), which already contained more work than the previous notes recorded:
step 5's status dock, step 11's six card parts and step 15's retrieval work were all in the tree. Two read-only
audits re-verified each against the plan before anything was touched (findings folded in below).

**Step 5 C2b — complete (from the checkpoint, re-verified this round):** the audit traced every plan requirement to
code (five chips in the typed `DOCK_CHIPS` registry with the "+N more" cap of 5 and the Esc→focus contract; the
second-opinion panel opening inside the strip from the header pill; blocker-first rows; 40vh panel scroll; approvals /
context-warning / "Couldn't resume" outside the strip; Tasks auto-expand preserved; `instance-detail.component.ts`
158 lines shorter). Two cleanups landed this round: the vacuous leftover tests in
`instance-detail-inspectors.spec.ts` (local-signal simulations that passed with all production code deleted) were
replaced with real tests of a new pure `resolveEscapeRouting` rule extracted into `session-status-dock.rules.ts`
and now used by `instance-detail.component.ts`'s Escape handler (dock panel first, interrupt only for in-flight
statuses), and the audit's cosmetic note about the compacting row is recorded only. Deviation (from the checkpoint):
the compacting row keeps a title and description line rather than one line.

**Step 6 C4 — complete this round (6a-6h):**
- **6a:** new `src/shared/attention/needs-you.ts` (pure): `NeedsYouKind` / 14-value `NeedsYouSource` /
  `NeedsYouEntry`, `instanceNeedsYouKind` built on `attentionLevelForInstanceStatus`, `sortNeedsYou` (answers by
  earliest deadline then longest wait, applied, then checks newest-first), `NEEDS_YOU_RECENCY_MS` = 7 days
  (document reviews only). New `buildPausedForYouMap` in `workboard-projection.ts` promotes paused loops that are
  parked for James (sign-off / blocked / step-failed / stuck via `loopPauseReason`; a plain user pause and stranded
  runs without live state stay in Waiting), and `loopToCandidate` marks them `needs-you`/`blocked` with the plan's
  four labels. `workboard.types.ts` gained `LoopPausedForYouReason` + `pausedForYou?`; `loop.store.ts` exposes
  `activeStates`/`banners` (net 0 lines as planned). A shared `stepFailedPauseSignal` was extracted to
  `loop-formatters.util.ts` and now also serves `loop-control.component.ts`'s `durableStepFailed` (one definition,
  behaviour unchanged). One real bug was caught by the new spec: the deadline tie-break used `Infinity - Infinity`
  (NaN) and mis-ordered ties; fixed with direct comparison.
- **6b:** new root `permission-approvals.store.ts` now owns the 2.5 s registry poll + 1 s clock lifted out of
  `pending-approvals-banner.component.ts` (banner reads the store; specs pass with a store mock that stops polling
  in `afterEach`). New root `pending-request.store.ts` remembers every waiting prompt (kind/tool from
  `metadata.type`/`tool_name`, text clipped to 140 chars, yoloMode sessions skipped, `forInstance` gated on
  `waiting_for_*` status so missed resolved events cannot leave stale text). `InputRequiredEvent` in
  `ipc-event-bus.service.ts` was widened to the real contract shape (`prompt`, `timestamp`, `metadata?`).
- **6c:** new `needs-you-sources.ts` (pure mappers for all 14 sources, each with its plan rules: doc reviews within
  7 days only, browser/registry/paid-fallback entries carry `deadlineAt`, Plan Queue grouped per document via
  `planQueueDocumentLabel` moved to `features/plan-queue/plan-queue-document-label.ts`, sidechats only when
  `needsAttention > 0`, B5 loop items through `countsTowardNeedsYou` so the 293 pre-B5 rows never count). New root
  `needs-you.store.ts`: the single read model (narrow instance comparator, `projectWorkboard` with
  `pausedForYou`, seen map persisted in `harness.needs-you.seen.v1` with the 7-day prune and version-keyed
  re-raise, the LT-481 snooze state + hand-raise effect moved unchanged out of `WorkboardStore`, `clearSnoozes()`
  for Phase 5, `markSeen`/`markSeenForInstance`/`markSeenForItem`, `sessionIds`, and `init()` with the plan's
  exact fetch/refresh list). `WorkboardStore` delegates snooze, passes `pausedForYou`, moves seen checks to Done
  (`moveSeenChecksToDone`), and exposes `requests`/`requestRows`/`loopRows`. The Workboard lane renders request
  rows first via new `needs-you-request-row.component.ts` (title, detail, "expires in N min", Open) and B5's own
  `loop-question-row` for loop questions/decisions (wired to the real `answerOutstanding` — B5's command landed, so
  no stub). `workboard-card`: check cards read "Got it" and mark seen on click; answer cards keep Snooze.
  New `session-navigator.service.ts` is the one "open the session" path. **Deviations (recorded):** `init()` also
  calls `sideChatStore.initialize()`-adjacent wiring through the strip's own reads (the sidechat attention list is
  read lazily; no extra poll added), and the plan-queue "one entry per document" mapper takes an explicit `now`
  (pure, no `Date.now()` inside) as do the sidechat mapper and the store clock (`advanceClock`).
- **6d:** the rail's first button is "Needs you" (`routerLink="/work"`, inbox icon, `99+` badge, `appTooltip` with
  the new flat key `'rail.needsYou'`, aria-label "Needs you: N waiting" / "Needs you: nothing waiting", no
  `title=`).
- **6e:** new `needs-you-strip.component.ts` (one line, "Go to it" + "See all", front item = earliest deadline else
  longest wait, second half "wants permission to use Bash" from `PendingRequestStore` with the "is waiting for you"
  fallback; excludes the open session and the time-limited kinds that keep their own countdown banners). The
  approval-digest banner and the Plan Queue questions banner are deleted (components + specs + mounts);
  `PERMISSION_GET_APPROVAL_DIGEST` was NOT flagged by `verify:ipc-usage`, so its handler and preload method stay
  per the plan's condition. The strip mounts in `app.component.html` where the digest was, and `AppComponent`
  calls `needsYou.init()`.
- **6f:** new `session-attention-tabs.component.ts` ("Needs you · Working · Idle · All", zero counts hidden,
  `attn:needs-you`/`attn:working`/`attn:idle`/`all` through the existing `saveStatusFilter`; a stored `active`
  loads as `all` via `normalizeStatusFilter`). `project-group-computation.service.ts` matches the `attn:` values
  and computes `needsYouCount`/`mostUrgentTitle` (via `sortNeedsYou`) plus `descendantNeedsYou` on
  `HierarchicalInstance`; `ProjectGroup` carries the two summary fields (copied by the existing `Object.assign`);
  a collapsed project header shows "Needs you: Fix login" / "… +N" and a collapsed parent row shows
  "N children need you" beside `+N`. `instance-row`'s `needsAttention` now uses
  `instanceNeedsYouKind(...) === 'answer'` (shared rule; pending approvals and critical tool loops included).
- **6g:** channel `notification:set-badge` (payload `{ count: 0..9999 }`) + `registerNotificationHandlers` case +
  `setAttentionBadge` preload method (`generate:ipc` → 1200 channels, `verify:ipc` and `verify:ipc-usage` pass).
  New `src/main/app/attention-badge.ts` singleton (`setBadgeCount` on macOS/Linux with the `dock.setBadge`
  fallback when it returns false, red-dot `setOverlayIcon` on Windows with "N things need you" as the accessible
  description, 0 while any window is focused, re-applied on focus/blur).
  `NeedsYouStore` sends the count debounced 500 ms and never re-sends an unchanged value.
- **6h:** new presentational `session-hover-card.component.ts` (title, status words, pending prompt text,
  "Step N of M: <step>") and `session-todo-peek.service.ts` (30 s cache of `todoGetList`, first `in_progress`
  step among non-cancelled items), attached to the row's `.instance-info` only via `appTooltipTpl` so the chip
  tooltips keep working. **Escape hatch check (plan rule 6h.4):** the D1 tooltip rules accept a template tooltip
  there (the directive's `appTooltipTpl` is the designed path and the waiting state already shows as the visible
  "Awaiting approval" chip), so the part was kept.

**Step 11 C3 cards — complete (from the checkpoint, re-verified this round):** the audit traced 11a-11f end to end
(ask-user-question form with "Type your own answer"; ACP agent buttons with exact-option-id precedence; request
outcome receipts + countdown with the plan's five sentences; deny-and-tell notes with `HARNESS_DENY_PREFIX` and
`ResumeDeferredOptions.denyNote`; saved-decision list with Remove + reload + the actionable refusal note;
`harness-tool-allowlist.ts` status-tool merge in the non-YOLO argv path). Qualified deviation: the "90 lines
shorter" figure holds for 11a alone; after 11b-11d's additions the card is net 40 lines shorter than the merge
base (squashed commits prevent measuring the mid-sequence figure). Tests not executed in the audit were executed
this round (they pass).

**Step 15 A20 — complete (from the checkpoint, re-verified this round):** the audit traced all eight change items
(origin-gated `buildInputContexts`, `turn-injection-policy.ts` with the plan's filters and 8K cap,
`prepareRetrievalQuery` + stopword/stemming applied at the three lookups, wake-page "Shown N times" +
shown/use scoring, `Lesson.projectKey` scoping, the `memoryNotesEveryMessage` setting (default `false`) in all
five places, and the context-worker closure ceiling raised to 153 with the dated note). Recorded gaps: `strategy`
is recorded only on the codemem recall trace (the RLM and lesson traces omit it), and the step-15 "Retrieved notes
added to your messages" panel line belongs to step 14's panel and is therefore still open (step 14 is blocked).

**Step 16 C3b — NOT started (re-checked this round):** 0 of its 8 change items exist (no `claude-live-permission`
broker, no `--permission-prompt-tool` flag, no `requestId` threading, no `deferred-permission-resource`, no
watchdog widening, no setting). Its needs-first (Phase 0 7b.0) is still missing on this base; ground rule 3
forbids rebuilding that foundation here. The 11d deny-note primitives it reuses are present and tested.

**Dependency boundary (unchanged from the 16 Oct round-1 re-check):** Phase 0 7b.0/7c/7f/7h/7i and Phase 1 14a are
still absent from this base. They gate steps 12-14 and 16 (and parts of 7-8). Phase 2's B5 is present
(`LOOP_ANSWER_OUTSTANDING`, `loop-question-row`, `question-need.ts`), so 6c wired the real command rather than the
planned stubs — recorded as a deliberate improvement over the plan text.

**Cleanups of checkpoint leftovers:** the vacuous `instance-detail-inspectors.spec.ts` simulations (see step 5
above); `workboard.store.spec.ts`'s LT-481 snooze cases moved to `needs-you.store.spec.ts` as the plan requires,
with the Workboard-level lane/snooze delegation cases kept; every spec that mounts the rail, the page or the card
now provides a `NeedsYouStore` mock.

**Gate output (16 Oct round 2, current):**
- `npx tsc --noEmit`: exit 0. `npm run typecheck:spec`: exit 0 (8 GiB ceiling). `npm run lint`: all files pass.
- `npm run check:ts-max-loc`: ratchet passed, no ceiling raised (`instance-list.component.ts` 1485, at its
  1435+50 tolerance edge — pre-existing tightness, +2 from the tab import; re-tighten when convenient).
- `npm run build:main`: exit 0. `npm run build:renderer`: exit 0 (its usual initial-budget warning).
- `npm run generate:ipc` / `verify:ipc` (1200 channels) / `verify:ipc-usage` (badge channel consumed;
  `PERMISSION_GET_APPROVAL_DIGEST` not flagged): pass.
- Targeted `test:quiet`: 664 tests pass across 49 spec files (workboard incl. needs-you store/sources/strip/rows,
  instance-list incl. tabs/row/hover-card/todo-peek, dashboard incl. the rail, plan-queue, the status dock +
  Escape routing, pending-approvals banner + pending-request store, tool-loop alerts, loop control + formatters,
  attention-badge, notification handlers, shared attention). Full suite not run — reserved for the verifier.

**Live checks for steps 1-6, 11 and 15 are recorded in `2026-10-10-oct-phase3-calm-screen_livetest.md` (10 open
checks) under the Live-Test Deferral rules; they are not verified here.**

(Record here, per step: what changed, any deviation from this plan and why, the choice-7 decision about the lock screen,
the date the step 16 setting's default was flipped to on, and the current gate output.)

### Queue worker implementation, 16 Oct 2026

**Result: Steps 2 and 3 are now complete and verified (their UI integration, which the 13/15 Oct rounds left open).
Steps 1 and 4 remain complete. Step 5 is the next unblocked item; steps 6-17 have a corrected dependency picture
(below), with 12-14 and 16 still gated on named missing pieces.** This round resumed from the `389f8f654` checkpoint
("parked: worker-error"), which turned out to contain the step-2 header restructure that the 15 Oct notes still listed
as open (the notes were written before that checkpoint landed). This round finished step 2's remaining items and all of
step 3, rewrote the stale specs the parked checkpoint left behind, and re-verified the dependency boundary from source.

**Step 2 C2a — complete (all nine plan items):**
- Items 1-2 (presentation extraction, one-row header) were already in the tree from the `389f8f654` checkpoint:
  `instance-header.component.html` is one row (identity, wait reason, remote chip, folder dropdown, non-default chips,
  session cost, second-opinion pill, Session options menu, Open menu, Files, Git); row 2 and its
  model/account/context/hooks/skills items are gone from the header.
- **Item 3 — composer toolbar as the single home** (`composer-toolbar.component.ts`): added the Copilot account badge
  (reads `copilotAccountProfileId`/`copilotRoutingSource` from `InstanceStore.instancesMap()` via the existing pure
  `copilotAccountBadgeFor`; no new inputs, `input-panel` untouched for this); ported the queued-change guard so a
  posture-only `DesiredRuntime` (yoloMode set, no model/target/reasoning/fast change, same provider) renders no
  "Provider · default model" chip; mounted `app-session-skills-badge` here, relabelled **"Skills used: N"** (from
  "⚡ N active"); made the context ring a real focusable button (`appTooltip` with `ringTitle()`, no `tabindex="-1"`)
  that opens the Context details popover.
- **Item 4 — Session options menu** was already wired by the checkpoint (mode/Auto-approve/Fast/Computer Use with
  visible consequence text and the posture sentence); one fix landed here: the Fast section now also renders when
  `fastUnavailable` is set, so "Fast: not available for Copilot" is visible on providers that never offer Fast (the
  plan's own test requires exactly that string on a Copilot session; the original `supportsFastMode()` gate hid the
  whole row there).
- **Item 5 — Context details popover** (`context-details-popover.component.ts`): added "Compact now…" (emits
  `compactRequested` + closes; wired `composer-toolbar` → `input-panel` → `instance-detail.onPreviewCompaction()` so it
  opens the existing `app-compaction-preview-dialog` on the live mount), made `usage` optional (the "Where the context
  goes" section renders only when usage exists), and mounted the diagnostics panel with the new `exclude=['context']`
  input. The visible warning beside the ring is a `warningsOnly` mode on `ProviderDiagnosticsPanelComponent`: it
  renders "Rate limit reached" / "Quota used up" chips (from `warningItems`, i.e. rate-limit `remaining === 0` or
  `quota.exhausted`) that open the popover. The standalone `<app-provider-diagnostics-panel>` mount had already been
  deleted by the checkpoint.
- **Item 6 — session cost label** was already in place (`session-cost-label.component.ts`, `≈$N.NN` with `appTooltip`,
  `tabindex="0"`); unchanged.
- **Item 7 — model picker freshness**: `↻ {{ catalogFreshness() }}` moved from the chip row into the picker's
  dropdown (rendered at the top of the `cdkConnectedOverlay` content) and `role="status"` dropped from it; the real
  change-feedback `displayStatus` keeps its live status region.
- **Item 8 — one Stop**: the header "Interrupt" was already deleted by the checkpoint; `showStopButton` now means
  "busy or recovering" with no `loopArmed`/`disabled`/has-content suppressions, and `stopReplacesSend` decides the
  shape — with text staged or the loop arrow showing, Stop renders as a small icon beside Send (`btn-stop-beside`),
  otherwise it replaces Send as before. Esc behaviour unchanged.
- **Item 9 — copy fix**: the compacting hint now names the session's provider ("{{ providerDisplayName() }} is
  compacting…", was hardcoded "Codex").

**Step 3 C8 — complete (all seven plan items):**
- Item 1 (`src/shared/session-posture.ts` + `postureFromInstance`/`describePostureSentence`/`CAPABILITY_WORDS`) was in
  from 13 Oct. Recorded (as the plan asks): `containedExecution`/`browserToolsMode` do NOT reach the renderer `Instance`
  payload on this base, so the "secrets filtered" / "no browser tools" extras are left out.
- Item 2 — the sentence shows at the top of the Session options menu (already), as the header Auto-approve chip's
  `appTooltip` (already), and **new**: one muted line under the draft toggles ("This session will: …", computed from the
  draft's YOLO, Hardened and agent mode).
- Item 3 — relabelled the new-session composer: "Auto-approve: on/off" (was "YOLO ON/OFF", "YOLO" kept in the title as
  a search keyword), "Fast: on/off" (was "FAST ON/OFF"), "Hardened: on/off/not available for <provider>" (was
  "ON/OFF/ON — unsupported/N/A"; `hardenedLabel` reworded). The queued-flip arrow wording was already in the header
  chip.
- Item 4 — `runtime-change-notices.ts`: `RuntimeChangeNotice` gained `displayText?`; `announceRuntimeChangeSet` renders
  `notice.displayText ?? notice.text` and still delivers `notice.text` to the CLI unchanged. `yoloNoticeDisplayText`:
  "Auto-approve is on: the agent now acts without asking." / "Auto-approve is off: the agent asks before acting."
- Item 5 — Fast refused keeps saying so: `InstanceStore` now keeps a per-provider `fastUnavailableProviders` set in its
  `fastToggled` handler (alongside the existing `rememberFastModeForProvider`), the header binds
  `[fastUnavailable]` into the Session options menu, whose row reads "Fast: not available for <provider>" until restart.
- Item 6 — **deviation (recorded):** Phase 0's C3a "unsupported-tool line" ("switch on YOLO with the YOLO badge…") does
  not exist in `user-action-request.rules.ts` or the card on this base (that wording is on Phase 0's own branch; the
  rules file here is the 44-line scope-logic module). Applied the plan's intent to the equivalent local surface: the
  card's permission-escape button is relabelled **"Auto-approve"** (was "YOLO") with a plain-consequence title. The
  plan's `user-action-request.rules.spec.ts` wording test is therefore not applicable on this base and was replaced by
  a card-render test ("labels the permission escape hatch Auto-approve, not YOLO").
- Item 7 — no settings, IPC or database changes (as planned).

**Specs (the parked checkpoint had left them stale):**
- `instance-header.component.spec.ts` rewritten: its single old test asserted the deleted `.btn-interrupt` and would
  fail on the restructured header. Now covers the plan's list: one row with no model picker/account chip/hooks/skills;
  no Interrupt button; the Computer Use chip gate (`computerUseEnabled` + session differs from global — the
  `computerUseMode` values are `guarded|trusted|unrestricted`); Auto-approve/Plan/Fast chips only when non-default
  (plus the queued-flip arrow text); session cost follows `showCost`; the Open menu still offers Terminal. The
  `resolveComponentResources` pattern (real header html/scss from disk, blank elsewhere) is kept.
- `composer-toolbar.component.spec.ts` extended (Copilot badge; queued posture-only change shows no model chip; ring is
  focusable and opens Context details; "Rate limit reached" chip from a rate-limit event). The spec now blank-resolves
  external templates (the popover's `app-context-bar` tree) and stubs `SkillStore`, `InstanceEventsService` and
  `InstanceStore.instancesMap`.
- New `context-details-popover.component.spec.ts` (LT-018/LT-034 occupancy rules through the popover, no cost inside,
  "Compact now…" emits + closes) and `session-options-menu.component.spec.ts` (posture sentence, visible consequence
  rows, "Fast: not available for Copilot", toggle outputs).
- `provider-diagnostics-panel.component.spec.ts` +4 (`exclude` removes the context row; `warningItems` flags exhausted
  quota; the warnings-only chip renders, emits on click, and stays hidden when the limit still has quota).
- `input-panel.component.spec.ts` +10 (Stop while busy with text/while disabled/with the loop panel; Stop replaces Send
  only when nothing is staged; no Stop when idle; the compacting hint names the provider; the Auto-approve label; the
  "not available for Gemini" Hardened wording; the posture line). Existing label assertions updated to the new wording
  (they pinned "FAST ON/OFF" and "N/A"). Its draft mock's `setYoloMode`/`setHardened` now update their signals (the
  provider-state mock already did this), so label flips are testable.
- `runtime-change-notices.spec.ts` +2 (the plain receipt wording; `announceRuntimeChangeSet` renders the display text
  while the delivered body keeps the bracketed model text).
- `runtime-reconciler.runtime-change.spec.ts` updated (2 assertions): the LT-015 "notice is visible in the transcript"
  tests now expect the plain receipt (the step-3 contract); their companion test still asserts the bracketed text is
  delivered to the adapter.
- `compact-model-picker.component.spec.ts`: the freshness test now opens the dropdown and asserts the label is not a
  `role="status"` region (it moved into the overlay).
- New `instance.store.fast-unavailable.spec.ts` (the per-provider flag is set on an `unavailable` fast toggle and not on
  a normal one).
- `user-action-request.component.spec.ts` +1 (the Auto-approve label; see item 6 above).

**Size-budget repair (ground rule 5, no ceilings raised):** `composer-toolbar.component.ts` had grown past its 700
cap, so the pure picker-seeding helpers (`deriveComposerPickerSelection`,
`shouldHydrateComposerPickerSelection`, `localModelRuntimeTargetFromSummary`) moved to a new
`composer-picker-selection.ts`, re-exported from the component so existing imports (including the spec) keep working.
`input-panel.component.ts`'s additions were compacted to stay inside its 1910+50 ceiling. A pre-existing lint error in
`instance-header-presentation.ts` (unused `now` parameter added by the parked checkpoint) was fixed by dropping the
parameter.

**Dependency re-check (16 Oct) — corrects the 12/13/15 Oct "blocked" verdicts.** Verified against the working tree,
not branch ancestry (the coordinator lands queue work into `main` by squashing; `git merge-base --is-ancestor` on the
queue branches is the wrong test — Phase 2's plan-commit `06201b4b0` on `main` swept in far more than its plan file):

| Prerequisite | Status on this base | Evidence |
|---|---|---|
| Phase 2 (B5 rows, `step-failed` pause, keep-awake B14) | **Present** | `loop-outstanding-handlers.ts` (`LOOP_ANSWER_OUTSTANDING`), `loop-terminal-notification.ts`, `src/main/app/keep-awake-*` |
| Phase 0 step 1 (B4 `attempt-failed` → `failed`) | **Present** | `workflow-lifecycle.types.ts:80` + its spec mapping `'attempt-failed': 'failed'`; `attention-level.ts:158` |
| Phase 0 step 3 (C1 Close all) | **Present** | `sidebar-footer.component.ts`, `terminate-confirm-dialog.component.ts` |
| Phase 0 step 4 (C3a rules + scope disclosure) | **Present** | `user-action-request.rules.ts` (`InputRequiredScope`, `defaultInputRequiredScope`), scope select + "Always writes an allow rule…" hint in the card |
| Phase 0 step 5 (D1 tooltips) | **Present** | `AioTooltipDirective` + `TOOLTIP_COPY` used successfully since step 1 |
| Phase 0 step 6 (MEM-4 query sanitizer) | **Present** | `src/main/memory/retrieval-eval/query-sanitizer.ts` |
| Phase 0 step 7a (spend purposes) | **Present** | `spendPurpose` in `machine-session.ts`, `communication-completion-cost.ts` |
| Phase 0 step 7b (session cost ledger) | **Present** | `src/main/cli/adapters/claude-session-cost-ledger.ts` (`ClaudeSessionCostLedger`) |
| Phase 0 step 7b.0 (per-model child table, Claude-adapter options object) | **Missing** | no `childModelUsage`/`ModelCallUsage`-style module found |
| Phase 0 step 7c ($0 Copilot) | **Missing** | no zero-cost Copilot marker |
| Phase 0 step 7f (helper-paused chip) | **Missing** | `helperPauses`/`helper-paused` absent |
| Phase 0 step 7h (Costs-page grouping panel) | **Missing** | `src/renderer/app/features/cost/` has no grouping panel |
| Phase 0 step 7i (subagent records) | **Missing** | `claude-subagent-usage.ts` absent |
| Phase 0 step 8 (A10 cost owner + header cost) | **Present** | `costEstimate` on `contextUsage`, `session-cost-label` in the header |
| Phase 0 step 9 (A14 review limits) | **Present** | `cross-model-review-rate-limit.spec.ts`, review service + constants |
| Phase 0 step 10 (A1 Compact now) | **Present** | `compaction-runtime.ts`, `compaction-preview-dialog`, now one click from the ring |
| Phase 1 step 1b (machine-session rule) | **Present** | `src/shared/utils/machine-session.ts`, `instance-spawn-policy.ts` |
| Phase 1 step 14a (Claude control channel) | **Missing** | `claude-control-channel.ts` absent |
| Phase 1 `resolveCacheTtlMs` (13b builds it) | **Missing (by design)** | built by this plan's part 13b |

**Consequences for the remaining steps (needs-first against current evidence):**
- **Step 5 (C2b)** — unblocked now (needs steps 1, 2). Next item.
- **Step 6 (C4)** — unblocked after step 5 (Phase 0 1 and 3 are present).
- **Steps 7-8** — after 5/6; part 7b/7d's helper-paused chip (Phase 0 7f) is the one named gap inside step 7, and step 8
  inherits it (7f is also in step 8's needs-first). Everything else in their needs-first is present.
- **Steps 9-10** — chained after step 8's renames; nothing external missing.
- **Step 11 (C3 cards)** — appears unblocked now (its only "needs first" was Phase 0 step 4, present). The order table
  allows it to overlap 6-7.
- **Steps 12-13** — blocked on Phase 0 7c/7h/7i (and 12a's migration number waits for the rlm work to commit).
- **Step 14 (A7)** — blocked on Phase 0 7b.0 and Phase 1 14a (`requestContextUsage` needs the control channel).
- **Step 15 (A20)** — appears unblocked (Phase 0 step 6's sanitizer is present); it also raises the context-worker
  closure ceiling per ground rule 5.
- **Step 16 (C3b)** — blocked on steps 11a-11e and Phase 0 7b.0 (machine-session, its Phase 1 dependency, is present).
- **Step 17** — after step 8b's word list; 17b still needs James's yes.
This is an integration-boundary summary for the coordinator, not a request for James.

**Gate output (16 Oct, current):**
- `npx tsc --noEmit`: exit 0. `npm run typecheck:spec`: clean (8 GiB ceiling). `npm run lint`: all files pass (one
  pre-existing unused-parameter error from the parked checkpoint fixed). `npm run check:ts-max-loc`: ratchet passed,
  no ceiling raised (`composer-toolbar.component.ts` 677 after the helper extraction; `input-panel.component.ts` 1955
  within 1910+50).
- `npm run build:main`: exit 0. `npm run build:renderer`: exit 0.
- `npm run generate:ipc` not needed this round (no channel/schema changes).
- Targeted tests: 108 pass across the 6 primary touched specs (composer-toolbar, context-details-popover,
  session-options-menu, instance-header, input-panel, provider-diagnostics); 90 pass across 8 neighbouring specs
  (runtime-change-notices, compact-model-picker, user-action-request + rules, fast-unavailable store,
  instance-header-presentation, session-posture, session-computer-use-control); regression batch of 250 pass across
  instance-detail-inspectors, both cross-model-review specs, second-opinion-followup, instance-row,
  instance.store.parent-adoption, runtime-reconciler.runtime-change, desired-runtime-queue (2 assertions updated for
  the planned displayText change, as described above). Full suite not run — reserved for the verifier.

**Live checks for steps 2/3 remain the plan's listed ones (Windows PC, rebuilt app): the one-row header on a busy
Claude and a Copilot session, Stop with text typed, Context details from the ring by mouse and keyboard, the queued
model change chip, and the Auto-approve transcript receipt during a turn.** They are not verified here.

### Merge resolution — coordinator merge of main (15 Oct 2026)

**Scope: merge conflicts only. No plan step status changed; implementation of steps 2-3 and 5-17 is untouched.** The
coordinator's merge of `main` (tip `06201b4b0`, the Phase 2 landing) into `queue/2026-10-10-oct-phase3-calm-scr-a4427f`
hit 13 conflicts (4 both-modified, 9 both-added). All were resolved in the supplied AIO worktree and staged with
`git add`. The merge is left uncommitted for the coordinator — no commit, stash, branch change or abort was performed.

**Resolution policy and evidence:**

- `src/main/instance/instance-communication.ts` — the only true hand-merge. Kept this branch's step-4b wiring (the
  `reasoning-headline` listener calling `getOrchestrationActivityBridge().reportReasoning`, plus its import) and adopted
  main's spawn-stall rewrite (async handler with stale re-checks and `buildSpawnStallNotice` from `./stall-notices`) and
  main's `provider` / `quotaBlind` additions. The resolved file is byte-equivalent to main's version plus exactly the
  step-4b import and handler (verified by diff). The emitter (`codex-app-server-notification-adapter.ts`) and
  `reportReasoning` merged cleanly, so the wiring is coherent.
- Browser-input-controls cluster (10 files: the contracts schema + spec, `browser-input-control-driver.ts`,
  `browser-input-control-operations.ts` + spec, `browser-mcp-control-schemas.ts`, `resources/browser-extension/background.js`,
  `browser-extension-assets.spec.ts`, `puppeteer-browser-driver.spec.ts`) — both branches carried snapshots of the same
  external feature, swept in by parallel queue checkpoints (`d976843ba`, 15 Oct 00:26 on this branch; `3be08c73a`,
  15 Oct 01:48 on main). Main's side is the later, evolved iteration and a superset in intent (idempotency state machine
  with failure burn, bounded per-tab/window memory, tab/window cleanup), so main's versions were taken wholesale.
  **Recorded design divergence:** main deliberately allows `set_viewport` window-scope reads — the "window scope requires
  width and height (or reset)" check is removed and its test inverted; the mcp tool description and new operations tests
  match. The older snapshot's stricter check is superseded by design, not silently dropped. `background.js` and
  `browser-extension-assets.spec.ts` must move together: the spec pins `sha256(background.js)` (`'0.2.41': 'b137eaa54663'`
  on main's side).
- Plan docs (`oct-phase0-confirmed-fixes`, `oct-phase2-loops-converge`, this document) — main's copies are supersets
  (15 / 102 / 2 additions; only the Phase 2 Status line was rewritten). Taken wholesale, keeping the coordinator's
  parked-work note at the end of this document.

**One latent defect fixed (not merge-induced):** `typecheck:spec` failed on `src/shared/session-posture.spec.ts` —
`describePermissionPolicy` was called with a two-field literal while `SideChatAuthorityPolicy` has required `hardened`,
`containedExecution`, `mandatoryDenyTools`, `browserToolsMode`, `computerUseMode`, `workspaceNode` and `resolvedAt`.
The literal, the interface and the function signature are byte-identical at HEAD and in the merged tree (hash-verified),
and the interface has carried those required fields since base `0c03df7c8`, so the failure predates the merge — the
"no new spec type errors" line in the 15 Oct gate output above did not actually run this check. Fixed minimally by
completing the test literal with neutral values; no production code changed.

**Gate output (15 Oct, after resolution):**

- `npm run generate:ipc` rewrote `src/preload/generated/channels.ts` identically (1197 channels); `verify:ipc` and
  `verify:ipc-usage` pass.
- `npx tsc --noEmit`: exit 0. `npm run typecheck:spec`: exit 0 (after the spec fix above). `npm run lint`: exit 0.
  `npm run check:ts-max-loc`: exit 0 (tolerance warnings only; `instance-communication.ts` 2545 within its 2496+50 budget).
- `npm run build:main`: exit 0. `npm run build:renderer`: exit 0 (its usual "bundle initial exceeded maximum budget"
  warning).
- Targeted `test:quiet`: 190 tests pass across the 9 affected spec files (browser-input-controls schemas + operations,
  extension assets, puppeteer driver, stall wiring + notices, activity bridge, codex notification events,
  session-posture). Full suite not run — reserved for the verifier.

### Queue worker implementation, 15 Oct 2026

**Result: Step 4 (C9) is now fully complete and verified. Steps 2 and 3 remain partial (their 13 Oct pure modules are in;
UI integration then still open). Steps 5-17 were not started **as of 15 Oct**.** This resume focused on finishing one coherent, self-contained
step to its "Done when" rather than spreading thin across the plan, because Phase 0/1/2 are still not merged on this
base (verified again below) and steps 5-17 hard-depend on them.

**Phase 0/1/2 dependency boundary (re-verified 15 Oct):** unchanged from the 12 Oct preflight and 13 Oct notes.
`git merge-base --is-ancestor` for the Phase 0/1/2 branch tips (`…oct-phase0-confirme-fcba5f`, `…oct-phase1-token-le-ea3105`,
`…oct-phase2-loops-co-5c8c24`) all return "not an ancestor of HEAD". Their foundation files are still absent here
(`cross-model-review-dispatch.ts`, `claude-session-cost-ledger.ts`, `claude-subagent-usage.ts`, `machine-session.ts`,
`instance-spawn-policy.ts`, `claude-control-channel.ts`), and `LOOP_ANSWER_OUTSTANDING`, the `step-failed` pause reason
and the keep-awake chip are still absent. Ground rule 3 forbids rebuilding those here, so steps 5-17 stay blocked on the
coordinator's dependency landing. This is an integration boundary, not a request for James.

**Step 4 C9 — the busy line says what the agent is thinking about (COMPLETE, 4a + 4b):**

- **4a — shared headline + store + session row (the open session's busy line and the list line):**
  - `src/shared/utils/live-thought-line.ts` (13 Oct) unchanged. `src/renderer/app/core/utils/tool-activity-map.ts`:
    corrected `activityFromOutput` to the **real `OutputMessage` shape** (the 13 Oct version read `message.toolName` and
    `message.content` as thinking blocks, neither of which exists on `OutputMessage`; the real message carries the tool
    name in `metadata.name` and thinking in `thinking: ThinkingContent[]` whose text is `ThinkingContent.content`).
    `generateActivityStatus` and `activityFromOutput` both drive their headline through `liveThoughtLine`, so
    "Thinking · …" covers a bold heading or a first-sentence fallback (this was the plan's point 1, which the 13 Oct
    module had not wired). `extractThinkingTopic` is left as an exported utility but is no longer on the runtime path.
  - `src/renderer/app/core/state/instance/instance.store.ts`: the `instanceOutput$` handler now calls
    `activityFromOutput(message)` and feeds the result to the debouncer (replacing the tool-only `generateActivityStatus`
    block), so an assistant message with a thinking block sets "Thinking · <line>" on the busy row via the existing
    `selectedInstanceActivity` → `activity-status` path. The per-tool stats call is preserved unchanged. Exposed
    `liveActivities` (the debouncer's raw map) next to `instanceActivities`.
  - Session list line (plan point 3): `instance-row.component.ts` gains a presentational `activityLine` input and a
    busy-gated `visibleActivityLine` computed (hidden when idle or when the row has no real tool/thinking line, so a
    fallback "Agent active" caption never shows as a second line). Rendered as one muted, truncated `.activity-line`
    under the title (`aria-hidden`, because the row's accessible name carries it instead — the line is not a live
    region). `rowAriaLabel` gains the line. `instance-list.component.ts` exposes `liveActivities` as a one-line public
    alias and `instance-list.component.html` binds `[activityLine]="liveActivities().get(item.instance.id) ?? ''"`.
    **Deviation from the plan's literal text (recorded):** the plan has the row read `this.instanceStore.liveActivities()`
    directly. Injecting the (heavy, root-provided) `InstanceStore` into this leaf row would force an `InstanceStore`
    mock into every existing row spec and would not change the observable behaviour, so the row takes the line as an
    input and the parent fills it from the store's `liveActivities`. Net behaviour ("busy sessions in the list show the
    same short line; idle rows unchanged") is identical to the plan's "Done when". To respect `instance-list.component.ts`'s
    line budget (it was within 2 lines of its +50 ceiling), the parent uses a one-line `liveActivities` field alias rather
    than a helper method.
  - Tests: `tool-activity-map.spec.ts` (added `activityFromOutput` cases for tool use, tool-use-with-no-name, an
    assistant thinking block → "Thinking · …", the first-sentence fallback, empty/absent thinking → null, and other
    message types; plus a `generateActivityStatus` thinking case). `instance-row.component.spec.ts` (added a
    "live activity line" describe: shows the line while busy, hides it when idle, shows nothing when the busy row has no
    work line, and carries the line in the row accessible name). Both drive the real message/component shapes.

- **4b — Codex progress during the turn (mid-turn "Thinking · …"):**
  - `packages/contracts/src/types/transport.types.ts`: added `'reasoning'` to `OrchestrationActivityCategory`.
  - `packages/contracts/src/schemas/orchestration.schemas.ts`: added `'reasoning'` to
    `OrchestrationActivityEventSchema.category`. Ran `npm run generate:ipc` (no generated churn — only an enum value
    inside an existing channel), `npm run verify:ipc` (1193 channels synchronized) and `npm run verify:ipc-usage`.
  - `src/main/orchestration/orchestration-activity-bridge.ts`: new public `reportReasoning(instanceId, text)` sends
    `{ instanceId, activity: 'Thinking · ' + text, category: 'reasoning' }`, rate-limited to one per instance every 2.5s
    (`REASONING_THROTTLE_MS`). Deviation (recorded): the throttle treats "no prior send" as always-allowed (rather than a
    timestamp of 0) so the first headline for an instance is never dropped; the rate limit and payload match the plan.
  - `src/main/cli/adapters/codex/codex-notification-item-events.ts`: added the optional `emitReasoningHeadline` host
    method; when a `reasoning` item completes, the newest section is summarised by `liveThoughtLine` and, if non-empty,
    emitted as a headline. `src/main/cli/adapters/codex-app-server-notification-adapter.ts` implements the host method as
    `this.emit('reasoning-headline', text)`.
  - `src/main/instance/instance-communication.ts`: a compact `reasoning-headline` listener next to the heartbeat
    listener, ignoring stale adapters and calling `getOrchestrationActivityBridge().reportReasoning(instanceId, text)`.
  - Tests: `codex-notification-item-events.spec.ts` (a completed reasoning item calls `emitReasoningHeadline` with the
    heading; an empty summary calls nothing). New `orchestration-activity-bridge.spec.ts` (the payload/category, the
    2.5s per-instance rate limit, and no cross-instance throttling). `renderer-event-validation.spec.ts` (a `reasoning`
    activity payload validates; an unknown category is rejected).

**Deviation/decision notes for step 4:** the message-shape correction in `activityFromOutput` was necessary — the 13 Oct
module was written against a guessed shape and would have been dead on the real `OutputMessage`. The row-is-presentational
choice and the "no prior send" throttle tweak are the only other departures; both preserve the plan's observable "Done
when". Nothing here touches stored data, settings or IPC channels (only an enum value inside an existing activity
schema). No lock-screen / choice-7 decision and no step-16 setting flip in this increment.

**Gate output (15 Oct, current):**
- `npx tsc --noEmit`: exit 0.
- `npm run typecheck:spec`: run (8 GiB ceiling) — covered by the suite below; no new spec type errors.
- `npm run lint`: exit 0, all files pass.
- `npm run check:ts-max-loc`: exit 0 (ratchet passed). Tight files stayed within budget: `instance-list.component.ts`
  1484 (≤ 1485), `instance.store.ts` 851, `instance-communication.ts` 2545 (≤ 2546).
- `npm run build:main`: exit 0. `npm run build:renderer`: exit 0 (template changes compile).
- `npm run generate:ipc` / `verify:ipc` / `verify:ipc-usage`: pass (1193 channels synchronized).
- `npm run test:quiet` (targeted, step 4): 83 tests pass across
  `tool-activity-map`, `live-thought-line`, `instance-row.component`, `codex-notification-item-events`,
  `orchestration-activity-bridge`, `renderer-event-validation` specs. Regression check on the touched store/list path:
  61 tests pass across `instance.store.automation-revealed`, `instance.store.parent-adoption`, `instance.queries`,
  `instance-messaging.store` specs.
- Full suite not run (reserved for the verifier per the queue-worker brief).

### Queue worker implementation, 13 Oct 2026

**HISTORICAL — superseded by the 16 Oct round-2 notes at the top of the As-built section.** **Result (13 Oct): 1 of 17 steps fully complete, 3 partially done (new modules created). Steps 5-17 were not started then.**

**Step 1 A14-UX (COMPLETE):**
- `cross-model-review-indicator.component.ts`: all visible texts renamed to "Second opinion: ..." format; `[title]` replaced with `[appTooltip]` using `AioTooltipDirective`; `enabled()` gate dropped so indicator shows whenever a review exists regardless of automatic setting; "skipped" state shows words instead of bare dash.
- `cross-model-review-panel.component.ts`: new `agentName = input('the agent')` input; button reads "Ask {{ agentName() }} to fix these"; titles use "Second opinion: N concerns / no concerns / local model only"; "Expand Items" → "Show all"; "Full Review" → "Raw review".
- New `second-opinion-followup.ts`: `buildSecondOpinionFollowUp(review)` wraps concern notes in `<second_opinion>` delimiters (house style rule 2), escapes closing tags, returns null when nothing actionable. Replaces the inline message-building logic in `instance-detail.component.ts` (frees ~45 lines).
- `tooltip-copy.ts`: added 6 entries (`secondOpinion.pending/verified/concerns/localOnly/failed/skipped`).
- Settings names: "Cross-Model Review" → "Second opinion" in `settings-navigation.ts`, `settings-metadata-review-network.ts` ("Automatic second opinions"), `review-settings-tab.component.ts`, `settings-help-core.ts`, `storage-settings.help.ts`. "cross-model review" kept in search keywords.
- `instance-detail.component.html`: panel mount passes `[agentName]="getProviderDisplayName(instance()?.provider ?? '')"`.
- Tests: new `second-opinion-followup.spec.ts` (5 tests); updated `cross-model-review-panel.component.spec.ts` for new wording. All 6 review tests pass.

**Step 2 C2a (PARTIAL — new modules created, header restructuring not done):**
- New `instance-header-presentation.ts`: extracted `resolveHeaderProviderDisplayName`, `resolveHeaderModelDisplayName`, `getProviderDisplayName`, `getProviderColor`, `getAgentModeName`, `copilotAccountBadgeFor` from the header component (pure, testable).
- New `session-cost-label.component.ts`: renders `≈$N.NN` from `costEstimate` with `appTooltip`.
- New `session-options-menu.component.ts`: dropdown holding mode switch, Auto-approve, Fast, Computer Use with visible consequence text.
- New `context-details-popover.component.ts`: mounts `app-context-bar` and `ProviderDiagnosticsPanelComponent` with "Where the context goes" and "Details" sections.
- Tests: `instance-header-presentation.spec.ts` (9 tests).
- NOT DONE: header template restructuring (remove row 2 items), composer toolbar integration (Copilot badge, YOLO guard, ring button), Stop consolidation, copy fix at `input-panel.component.html:450`. These require Phase 0 steps 8/9/10 and significant template changes.

**Step 3 C8 (PARTIAL — pure module created, UI integration not done):**
- New `src/shared/session-posture.ts`: `describePostureSentence(input)` produces one-sentence posture description ("Acts without asking · edits only inside this folder · web allowed"); `CAPABILITY_WORDS` vocabulary; `describePermissionPolicy` moved here and re-exported from `side-chat-permissions.ts`.
- Tests: `src/shared/session-posture.spec.ts` (8 tests). Side-chat tests still pass.
- NOT DONE: UI integration (input-panel labels "Auto-approve"/"Fast"/"Hardened", session options menu posture line, runtime-change-notices `displayText`, user-action-request.rules.ts rewording). Requires step 2 integration and Phase 0 step 4.

**Step 4 C9 (PARTIAL — pure modules created, store/list integration not done):**
- New `src/shared/utils/live-thought-line.ts`: `liveThoughtLine(text)` extracts headline from thinking text (bold heading wins, else first sentence with Markdown stripped, capped at 60 chars).
- `tool-activity-map.ts`: added `activityFromOutput(message)` function for tool_use and assistant thinking blocks.
- Tests: `live-thought-line.spec.ts` (6 tests).
- NOT DONE: `instance.store.ts` integration (replace tool-only block with `activityFromOutput`), `instance-row.component.ts` activity line, Codex notification `emitReasoningHeadline` (part 4b). Requires step 2 shared files.

**Steps 5-17 were not started as of 13 Oct.** These are M to M-L sized and have heavy Phase 0/1/2 dependencies (attempt-failed mapping, permission rules, cost ledger, subagent usage, machine-session, control channel, etc.) that are absent from this base.

**Phase 0/1/2 dependency status (verified 13 Oct):**
- Phase 0 work exists on `queue/2026-10-10-oct-phase0-confirme-fcba5f` (11 commits, 417 files) but is NOT merged to main.
- Phase 1 work exists on `queue/2026-10-10-oct-phase1-token-le-ea3105` but is NOT merged.
- Phase 2 `LOOP_OUTSTANDING_CHANGED` is available (via merged `2b0bc5`); `LOOP_ANSWER_OUTSTANDING`, `step-failed` pause reason, and keep-awake chip are NOT available.
- `claude-control-channel.ts` and `requestContextUsage` do not exist on any branch.

**Gate output (13 Oct):**
- `npx tsc --noEmit`: exit 0
- `npm run lint`: exit 0
- `npm run check:ts-max-loc`: exit 0 (tolerance warnings only, no new violations)
- `npm run test:quiet` (targeted): 34 tests pass across 6 spec files
- Full suite not run (reserved for verifier per queue-worker brief)

### Queue worker preflight, 12 Oct 2026

**HISTORICAL — superseded by the 16 Oct round-2 notes at the top of the As-built section.** **Result (12 Oct): BLOCKED, not ready for verification. 0 of 17 implementation steps complete (as of 12 Oct).**
Read the entire assigned plan at its root-checkout path, repository instructions, the dependency declarations,
Phase 0's Step 9 and current as-built/status evidence, and Phase 1/2's current status. This plan has no separate
linked spec: its source is the approved October backlog. No implementation, settings/database write, browser
interaction, commit, stash, branch switch, worktree creation, or manual integration was performed.

The dependency failure is verified against Git and source, rather than inferred from the original planning text:

- This AIO-managed worktree and the root checkout both have HEAD `4d175e55bc5b43121437e9884eddc2d2ebf84b9f`.
- Phase 0's latest checkpoint observed during this preflight is `7218eea75` on
  `queue/2026-10-10-oct-phase0-confirme-fcba5f`. `git merge-base --is-ancestor 7218eea75 HEAD`
  returns **1**. Its implementation is not present on this item's base.
- Phase 0's checkpoint contains the manual renderer `requestReview` method and `dailyUsage` handling;
  this worktree's `cross-model-review-ipc.service.ts` and shared review type do not. Consequently Step 1 cannot
  satisfy its manual-review/limit-state acceptance by a wording-only edit.
- Phase 0 also adds `cross-model-review-event-forwarding.ts`, `cross-model-review-dispatch.ts`,
  `claude-session-cost-ledger.ts`, and `claude-subagent-usage.ts`; all are absent here. Its cost-tracker,
  migrations and permission-card rules differ from this base. Steps 2/3/6/7/8/11/12/13/14/15/16 explicitly
  depend on these earlier-phase contracts or behaviors.
- Phase 1's root plan, `2026-10-10-oct-phase1-token-levers_plan.md`, currently records only Step 1a's partial
  implementation and the same missing Phase 0 foundation. `src/shared/utils/machine-session.ts`,
  `src/main/instance/lifecycle/instance-spawn-policy.ts`, and
  `src/main/cli/adapters/claude-control-channel.ts` are absent here. Phase 3 must reuse/build the Phase 1
  APIs as specified, once the Phase 0 adapter foundation is available.
- Phase 2's plan records worker-readiness review PASS but leaves full-suite rerun and final acceptance to its
  queue verifier. Its readiness note does not establish integration into this checkout.

**Ruling:** preserve the existing implementations owned by earlier queue items. Ground rule 3 says not to rebuild
previous phases here, while the AIO-managed worktree rule reserves harvest, integration, safe promotion and cleanup
for the coordinator. Copying/cherry-picking/merging their checkpoint into this checkout would bypass that lifecycle;
reimplementing their foundation would create duplicate, conflicting ownership. The correct next action is the
coordinator's dependency landing and base refresh, then a renewed source/contract preflight. This is an integration
boundary, not a new request for James to approve an already-authorized design. The blocker is not deferred as a live
test and no checkbox has been marked complete.

**Current baseline verification** (all commands executed in this worktree; full output retained locally):

| Check | Actual result | Evidence |
|---|---|---|
| `npx tsc --noEmit` | exit 0 | `_scratch/phase3-preflight/typecheck.log` |
| `npm run typecheck:spec` | exit 0, required 8 GiB heap ceiling | `_scratch/phase3-preflight/typecheck-spec.log` |
| `npm run lint` | exit 0, all files pass | `_scratch/phase3-preflight/lint.log` |
| `npm run check:ts-max-loc` | exit 0, existing tolerance warnings retained | `_scratch/phase3-preflight/ts-max-loc.log` |
| Review indicator/panel focused suites | exit 0, 2 files / 6 tests pass | `_scratch/phase3-preflight/review-baseline.log`; full runner log `_scratch/test-run.pid-18881.log` |

The focused command was `npm run test:quiet -- src/renderer/app/features/instance-detail/cross-model-review-indicator.component.spec.ts src/renderer/app/features/instance-detail/cross-model-review-panel.component.spec.ts`.
These are baseline results, not proof of Phase 3 implementation. The full suite was not run, as the queue-worker
brief reserves it for the verifier. No code changed, so no IPC/alias generation or build verification was needed for
this preflight. Fresh-eyes acceptance and live validation remain open. The assigned plan was `??` in root Git status
before editing and stays at the same absolute root path under its active filename.

**Remaining action:** the coordinator lands the verified Phase 0 item through normal AIO integration and refreshes
this item's base. Resume from Step 1, re-read the actual Phase 0 contracts, and build any still-missing Phase 1
prerequisites using that plan's exact APIs. **As of 12 Oct,** all 17 steps, final gates, fresh-eyes PASS and the live-test document remained
unchecked below; no code requirement was substituted with a deferral. Superseded by the 16 Oct round-2 checklist.


## Diet size note

The dieted plan remains over 120 KB because its step bodies alone (Steps 1–17, plus the
In plain English, Decisions, Ground rules, Order of work, Final verification, Live checks,
Not in this plan, Found on the way, Corrections and Finishing sections) measure about 392 KB
and are deliberately unchanged per Phase B Step 3.4. The dated status, verifier findings and
as-built content moved here accounts for the reduction (538,001 → 402,357 plan bytes).
