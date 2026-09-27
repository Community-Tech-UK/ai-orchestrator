# Skill Observability + Design Skills — Live Test Checklist

## Status — completed 2026-09-27

Open: 0 · Closed: 9 · Failed: 0

All checks now pass. The final positive half of check 4 was exercised through the real Skills UI
and a real `sendInput` call in an isolated current dev app. With `ui-ux-pro-max` promoted from
**Suggest** to **On**, a message equal to the skill's live catalogue description forced a
deterministic semantic self-match. The context worker persisted a new LT-547 budget-skip record for
that exact instance (`10,932` tokens needed, `5,000` available), and the health panel rendered
**“Detected, not injected”** with those values. The test instance was terminated and the control
was read back as **Suggest** after cleanup. See the 2026-09-27 evidence run below.

## Status — 2026-09-20
Open: 1 · Closed: 8 · Failed: 0
Check 4 is still the only open check, but **its blocker changed again on 2026-09-20** and it is no
longer about embeddings. Driving the check through the real UI reproduced three defects —
**LT-545** (the Skills page's Discover button and every skill control button fail IPC validation),
**LT-546** (the only control surface lists activated skills only, so a suggest-only skill has no
route to *On*, and it mislabels the D1a default as *On*) and **LT-547** (an enabled, detected skill
whose core exceeds the 5 000-token injection budget is dropped in silence — which is why
`ui-ux-pro-max`, at 10 932 tokens, can never auto-inject). The D1a *mechanism* is now proven live in
both directions; see the 2026-09-20 evidence run. The 2026-09-06 decision below is retained for the
record and its detection-quality analysis still stands, but its claim that the positive half waits
on an embedding provider is superseded.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Original plan reference: `2026-07-23-skill-observability-and-design-skills_plan_completed.md`.
That file is not present in this checkout; this live-test document and its dated evidence are the
available source of truth for the remaining check.

Each check: exact steps → expected observable result.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| 1. Migration applies cleanly | 2026-07-26 | `_migrations` row `053_skill_attribution` + `skill_activations`/`skill_controls` tables present in packaged app's `rlm.db`; no startup errors. Reconfirmed unchanged through 2026-08-25. |
| 2. Activation recording + toast + badge | 2026-08-25 (Batch B) | Fresh profile, real `sendInput`: live `skills:activation-delta` push received with no manual refresh (LT-170 fix), row persisted to the correct profile `rlm.db` (LT-480 fix), popover count increments on repeat trigger. All three halves pass independent of prior session state. |
| 3. Kill-switch end to end | 2026-08-25 (Batch B) | `skillsSetControl(disabled)` blocks a real trigger send (count unchanged); explicit `skillsLoad` returns `SKILL_DISABLED`; re-enable restores injection (count increments). LT-169 (cross-process `controlCache` staleness) root-caused and fixed 2026-08-18, hardened same day (fail-closed + single DB round trip), re-verified on the LT-480-corrected persistence path. |
| 4. Global skills visible; suggest-only by default; explicit promotion reports oversized injection | 2026-09-27 | Real Skills UI showed `ui-ux-pro-max` at **Suggest**, changed it to **On**, and a fresh real Claude `sendInput` using the live catalogue description persisted a new per-instance `budget-exceeded` record (`10,932 / 5,000`). The UI rendered “Detected, not injected”; cleanup terminated the instance and restored **Suggest**. |
| 5. Health panel + doctor lint | 2026-08-18 (Batch U2) | `skillsHealthSummary()` rows match real sends; `diagnosticsGetDoctorReport({force:true})` against the global catalogue returns `oversized-core` for `ui-ux-pro-max` (~45k chars), matching the doc's expectation exactly. |
| 6. Error correlation flag | 2026-08-18 (Batch U2 core mechanism; Batch U3 n=5 threshold) | Real CLI kill → instance `error` → `followed_by_error` flips (`precededErrors: 1`). Outlier-badge conditional (`totalActivations >= 5 && errorShare >= 0.5`) driven live via 5 real `recordActivation()`/`markErrorForInstance()` calls through the production service; renderer DOM shows literal string "precedes an error 5/5 times". |
| 7. visual-redesign skill scoping | 2026-08-25 (Batch B) | Fresh profile: "make this look designed" → activation row; unrelated backend message → no row. Both halves, fresh evidence. |
| 8. design-drift review agent | 2026-08-18 (Batch U2) | LT-200 (review-panel `agentIds` payload mismatch) found and fixed. Positive half: `hero.css` (bad font-family + broad transition) → findings in `design-drift/typography` and `design-drift/motion` with file:line citations. Negative half: `migration.sql` → zero findings. |
| 9. D2a trigger gate sanity | 2026-08-25 (Batch B) | Fresh profile: long diluted prompt → no injection; short deliberate "upload aab to the play developer api" → injection (`matched_trigger: 'upload aab'`). Both halves. |

Defects reproduced and fixed along the way (all closed): **LT-009** (empty skill registry — builtin assets never reached `dist/main`), **LT-169** (cross-process `controlCache` staleness defeated the kill-switch), **LT-170** (activation-delta push couldn't cross the context-worker process boundary), **LT-200** (review-panel `agentIds` payload never matched its schema), **LT-480** (auto-injected activations silently persisted to a shared per-checkout fallback DB instead of the profile DB).

## Final closed check

### 4. D1a: global skills visible, suggest-only, never auto-inject — CLOSED 2026-09-27

- Open Skills page → Discover.
- Expected: global skills (ai-design-workflow, security-best-practices, ui-ux-pro-max, doc-review-artifact, …) now appear (~33 total incl. 17 builtin). Send a message that semantically matches `ui-ux-pro-max` (e.g. "review this UI/UX design comprehensively"): NO auto-injection (no activation row for it), because suggest-only is the default.
- Set `ui-ux-pro-max` to **On** in the health panel, repeat, confirm it can inject when explicitly enabled (then set it back to **Suggest**).

**Negative half — PASSED** (2026-08-25, Batch B: no activation row for a semantically-matching message while suggest-only is the default).

**Positive half — OPEN, blocker class C (James's product decision).** Across three sessions (2026-08-18 Batch U2, 2026-08-19 Batch P3, 2026-08-19 Batch D4) the real production embedding path (`EmbeddingService`, which resolves to a local hashed n-gram fallback because Ollama is not installed in these test environments) was measured against all 36 real discoverable skills using real on-topic paraphrases and off-topic controls written before any score was seen. Findings:

- Current `similarityThreshold: 0.65` (`src/main/memory/skills-loader.ts:56`) admits only 2 of 36 genuine on-topic paraphrases (`ng-component` 0.6894, `review-pr` 0.7791) and 0 of 36 off-topic controls — roughly a 94% false-negative rate for genuine on-topic requests, including `ui-ux-pro-max` itself (0.337–0.393 across the three measurement runs).
- No single threshold cleanly separates the two populations in this sample: `min(on-topic) = 0.0961` is below `max(off-topic) = 0.3368`; the best achievable single cut point is ≈0.2335 and still misclassifies 3 of 72 data points.
- This is **not a wiring defect** — every link in the injection path behaves exactly as coded; `similarityThreshold: 0.65` is a deliberate, documented choice.

**DECISION — 2026-09-06: keep `0.65`, wire a real embedding provider, then re-measure.**

The four options on the table were: lower the global threshold, add per-skill thresholds, rewrite
the skill descriptions as prose, or wire a real embedding provider. Three of them are attempts to
tune around a similarity function that cannot express what is being asked of it.

`EmbeddingService` (`src/main/rlm/embedding-service.ts:1-9`) documents its own provider priority:
Ollama if available, then OpenAI if a key is configured, then a **local TF-IDF fallback**. Every
one of the three measurement sessions ran on that last tier — confirmed again on 2026-09-06:
`127.0.0.1:11434` is not reachable from the coordinator, so there is no local Ollama here. TF-IDF
over short prompts is essentially lexical overlap; it has no way to score "review this UI/UX
design comprehensively" as close to `ui-ux-pro-max`. That is exactly what the numbers show — the
skill scores 0.337–0.393 against its own on-topic paraphrases.

So the reported separation failure (`min(on-topic) = 0.0961` below `max(off-topic) = 0.3368`, best
cut ≈0.2335 still misclassifying 3 of 72) is a property of the fallback metric, not of the skills
or the threshold. Lowering the global cut to ~0.23 would buy a 94% false-negative rate traded for
admitting off-topic matches, on a metric that is due to be replaced — and per-skill thresholds
would bake 36 hand-tuned constants into that same doomed metric. Rewriting descriptions is
content churn to satisfy a lexical matcher.

Meanwhile the mechanism that actually works is unaffected: check 9 passed on the literal
trigger-phrase path (`matched_trigger: 'upload aab'`, `triggerMinConfidence: 0.05`). Conservative
semantic matching plus working triggers is the right failure mode while embeddings are absent —
it under-injects rather than injecting noise.

**What to do instead:** deploy an embedding provider, re-run this measurement against real
embeddings, and set the threshold from that data. `windows-pc` is connected and carries an RTX
5090 with 32 GB of VRAM, which is a natural host for it. Note that this is the same missing
capability blocking `sibling-audit-round2` B3 and `browser-gateway-reliability` check 1 — one
deployment unblocks three documents.

**This check stays open**, but its blocker class changes from **C (James's product decision)** to
**A (engineering, agent-runnable)**. Nothing further is waiting on James here.

> **Superseded in part on 2026-09-20.** The blocker is still class A, but it is not the embedding
> provider. A keyword-dense on-topic request reaches 0.6786 on the tier running today and *is*
> detected; the positive half is blocked by LT-545, LT-546 and LT-547. The detection-quality
> analysis above is unchanged. See the 2026-09-20 evidence run at the end of this file.

---

## Evidence run — 2026-09-20 (Plan Queue worker, branch `queue/2026-07-23-skill-observability-b8464f`)

**Environment.** Dev app built from the queue worktree (`npm run build:main`, then
`ng build --configuration development` — the production renderer bundle strips the `ng` global, so
no component or store is reachable over CDP and every UI assertion has to be faked; use the
development configuration for live UI work). Isolated profile
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-bab8464f`, renderer served from `dist/renderer/browser`
on `:4652` by a static server with SPA fallback (`python3 -m http.server` 404s on `/skills` and the
reload lands on an error page), Electron on `PORT=4652` with `--remote-debugging-port=9652`. All
sends are real `sendInput` calls to a real `claude` instance (`cdk00bp3h`, then `cewleywwi`) in
`/tmp/aio-lt-skillobs-ws`. Profile, workspace and both instances were removed afterwards.

**Runbook correction (Chrome 144 / Electron 40).** `Emulation.setPageVisibilityOverride` no longer
exists — the CDP call returns `-32601 'Emulation.setPageVisibilityOverride' wasn't found`.
`Emulation.setFocusEmulationEnabled {enabled:true}` plus `Page.setWebLifecycleState {state:'active'}`
gives the same result: `document.hidden:false`, `visibilityState:'visible'`, rAF running. Focus
emulation was enabled before every DOM read below.

### Check 4 — D1a: global skills visible, suggest-only, never auto-inject — STILL OPEN

#### 4a. "Open Skills page → Discover" — data PASSES, the UI FAILS

Clicking the real **Discover Skills** button on the Skills page paints a red banner:

```
IPC validation failed for SKILLS_DISCOVER: searchPaths: Invalid input: expected array, received object
```

Screenshot: `_scratch/lt-skillobs/skills-page-2026-09-20.png` (in the queue worktree).

The discovery *engine* is fine. Calling the preload wrapper with the shape it actually declares
returns the expected corpus, and the count matches this document's expectation exactly:

| Call | Result |
| --- | --- |
| `electronAPI.skillsDiscover({searchPaths:[…]})` — the shape the Angular service sends | `SKILLS_DISCOVER_FAILED … expected array, received object` |
| `electronAPI.skillsDiscover(['.claude/skills','.codex/skills','skills'])` | 37 bundles: 17 builtin + 20 global (3 names duplicated between `~/.claude/skills` and `~/.codex/skills`) |
| `electronAPI.skillsList()` after discovery | **33** registered skills — the "~33 total incl. 17 builtin" this check expects |

`ui-ux-pro-max` is present, at `/Users/suas/.claude/skills/ui-ux-pro-max`, description 914 chars.

Root cause and blast radius are filed as **LT-545**. It is not specific to discovery: three skills
channels were confirmed broken live through the real Angular service, and every one of them works
when the preload wrapper is called with positional arguments:

| Channel | Via `OrchestrationIpcService` | Via preload, positional |
| --- | --- | --- |
| `skills:discover` | `searchPaths: expected array, received object` | 37 bundles |
| `skills:set-control` | `skillName: expected string, received object; mode: Invalid option` | control upserted |
| `skills:match` | `text: expected string, received object` | `visual-redesign` @ confidence 1 |

The store swallows the failure into a toast — clicking **Suggest** on a health-panel row produced
`Could not update skill "ui-ux-pro-max"` and left the control untouched (`updatedAt` unchanged).

#### 4b. Negative half — RE-CONFIRMED on a message that provably clears the threshold

The phrasing this check names as its example ("review this UI/UX design comprehensively") scores
**0.2484** against `ui-ux-pro-max` on the tier that is running, so a negative result with it shows
only that the message was never a candidate — it does not exercise the suggest-only gate. This run
repeated the negative half with messages engineered to clear 0.65, which does test the gate:

- `playwright` (global, `~/.claude/skills/playwright`, no control record → source default
  `suggest-only`), message scoring **0.8888**: sent for real → **no activation row**.
- `ui-ux-pro-max`, message scoring **0.6786**: sent for real → no activation row.

#### 4c. Positive half — the mechanism is PROVEN; `ui-ux-pro-max` specifically cannot inject

Positive control, same message, same instance, one variable changed:

| Step | Control | Result |
| --- | --- | --- |
| 1 | `playwright` at the `suggest-only` default | no activation |
| 2 | `skillsSetControl('playwright','enabled')` | activation recorded: `matchedBy: 'embedding'`, `matchScore: 0.8888480099864527`, `tokensInjected: 880`, `skillSource: 'global'`; health summary `byEmbedding: 1` |
| 3 | back to `suggest-only` | resend → activation count unchanged (3) |

So **a global skill flipped to On does inject on the very next real send, and reverting stops it.**
That is the behaviour this check exists to prove, and it now has live evidence in both directions.

`ui-ux-pro-max` still cannot be made to inject, and the reason is **not** the embedding threshold.
It was isolated with a controlled probe rather than inferred: a fixture skill
(`.claude/skills/uiux-budget-probe`, deleted afterwards) was given `ui-ux-pro-max`'s **identical
914-character description** and a 78-token body. With both skills set to `enabled` and one real send
of the 0.6786 message:

```
uiux-budget-probe  matchedBy=embedding  matchScore=0.6785713094638416  tokens=78   → injected
ui-ux-pro-max      (same description, same score, same mode)                       → no row at all
```

The only difference between them is core size. `fetchSkills`
(`src/main/memory/unified-controller.ts:780`) budgets `maxTokensPerSkill = 5000`, and
`loadSkillsWithBudget` (`src/main/memory/skills-loader.ts:466`) skips anything that does not fit.
The app's own `skillsLoad` reports `ui-ux-pro-max` at **`tokenEstimate: 10932`** (43 728 chars) — more
than twice the budget — so it is detected, passes the control check, and is then dropped in silence:
no injection, no activation row, no health row, no log (`skills:detected` has no listener anywhere,
and `skills-loader.ts` has no logger at all). Filed as **LT-547**. Check 5's `oversized-core` doctor
lint already flags this skill; nothing connects that warning to the silent drop at injection time.

#### 4d. "Set `ui-ux-pro-max` to On in the health panel" — the surface cannot do it

Before any activation existed, the Skill Health panel read **"No skill activations recorded yet"**
with zero control buttons, while 33 skills were discovered. `getSkillHealthSummary`
(`src/main/persistence/rlm/rlm-skill-attribution.ts:182`) aggregates `skill_activations` only, and
`SkillHealthPanelComponent.rows()` maps over that summary, so a skill that has never injected has no
row and no control. A global skill defaults to `suggest-only`, therefore never injects, therefore
never appears, therefore can never be switched On — the D1a promotion path is circular. There is no
other surface: the instance-header badge is also activation-derived and only toggles
`enabled ↔ disabled`, and nothing in the renderer ever surfaces a *suggestion* for a suggest-only
skill (the only occurrences of `suggest-only` in `src/renderer` are a type union, the `CONTROL_MODES` constant and the mode label).

The same panel also mislabels the default. After an explicit `skillsLoad` gave `list-mcp-servers`
(global, `~/.claude/skills/list-mcp-servers`, **no** control record, effective mode `suggest-only`) a
row, the row rendered with **On** highlighted as active — `[class.active]="(row.mode ?? 'enabled')"`
falls back to `enabled` instead of the source default. Filed together as **LT-546**.

#### Correction to the 2026-09-06 decision note

That note's detection-quality analysis stands: the example phrasing in this check scores 0.2484 and
ordinary paraphrases do not reach 0.65 on the TF-IDF fallback tier, so conservative matching plus
working triggers remains the right failure mode until a real embedding provider exists. What is
superseded is the conclusion that **the positive half is waiting on that provider**. It is not —
a keyword-dense on-topic request reaches 0.6786 on the tier that is running today and is detected
(observed: the probe skill with the identical description injected at that exact score). The
positive half is blocked by LT-545, LT-546 and LT-547, all of which are ordinary engineering and
none of which needs James.

#### What remains for this check

1. LT-545 fixed, so **Discover Skills** and the control buttons work from the UI.
2. LT-546 fixed, so a never-activated global skill is listed with its true effective mode and can be
   promoted to On.
3. LT-547 fixed, so an enabled oversized skill either injects (progressive/partial load, or a budget
   that admits it) or reports plainly why it did not.
4. Then re-run 4a → 4d end to end through the UI with `ui-ux-pro-max` itself.

Nothing here is a James decision; no item in this check needs an operator.

> Plan Queue parked work: `queue/2026-07-23-skill-observability-b8464f` — 1 commit(s), reason: land-blocked.

---

## Evidence run — 2026-09-24 (settings)

Dev app from HEAD `f04f6748`, isolated profile `/tmp/aio-lt-0924-settings`, CDP on `:9712`/`:9722`.

**4a. Discover Skills / control buttons — LT-545 CONFIRMED FIXED LIVE.** Clicking the real
**Discover Skills** button on `/skills` produced **no IPC validation error** (previously
`IPC validation failed for SKILLS_DISCOVER: searchPaths: expected array, received object`); 38 skill
cards rendered including `ui-ux-pro-max`. Source: `OrchestrationIpcService.skillsDiscover()`
(`orchestration-ipc.service.ts:657`) sends `{searchPaths}`, and the preload wrappers for
`skills:discover`, `skills:set-control` and `skills:match` all now declare an object-payload
signature matching that shape (`orchestration.preload.ts:465, 517, 557`) — the double-wrap is gone.

**4b/4d. Suggest-only listing and promotion — LT-546 CONFIRMED FIXED LIVE.** `app-skill-health-panel`
(no route/tab needed — it's a side panel on `/skills`) now lists **every discovered skill**, not
only ones with activations: `ui-ux-pro-max` appeared with `0 activations`, and its
`.mode-btn.active` was correctly **`Suggest`**, not the previous "falls back to On" mislabel.
Clicking its `On` button promoted it live (`activeMode: "On"`, zero error toasts) — the D1a
promotion path is no longer circular.

**4c. Positive-half budget skip (LT-547) — mechanism verified in source, live repro inconclusive.**
See the status block above for the detail. Two real sends — one with keyword-dense UI/UX phrasing
direct to a live instance with `ui-ux-pro-max` set to `On`, one to a fixture skill
(`uiux-budget-probe`, deleted afterwards) carrying `ui-ux-pro-max`'s identical 1185-byte
description at `enabled` — produced **zero activations and zero budget-skip records for either
skill** (`skillsHealthSummary().budgetSkips` empty both times). This means the embedding score for
this run's phrasing fell below the detection threshold before the budget check was ever reached,
which is a detection-tier property this doc already documents, not a new finding. The
skip-recording code itself (`skills-loader.ts:488-499`, `unified-controller.ts:783-789`, migration
`066-070`, `skill-health-panel.component.ts:72-75` `.row-skip` UI) was read in full and is
correctly wired; it simply was not exercised by this run's messages.

### Cleanup

Both real instances used for this check terminated; the fixture skill directory removed; `ui-ux-pro-max`
and `uiux-budget-probe` controls reset (`suggest-only` / `disabled`) to their pre-run state.

## Evidence run — 2026-09-24 (continuation stopped before send)

**Outcome: no change to check 4; it remains OPEN.** The continuation recovered the exact keyword-dense
message used by the earlier harness and launched a fresh isolated dev profile to attempt the remaining
LT-547 live path. Two harness facts were established before a Harness context-policy steer told the
agent to stop broad exploration (LT-657: the user did not ask for this; the steer arrived as user-role input):

1. `ng serve` on the current Angular 22 checkout produced a blank renderer because a partially compiled
   `_PlatformLocation` reached the browser without the Angular linker and the JIT compiler was absent.
   This was a dev-server harness failure, not product evidence. A fresh development AOT bundle served
   statically loaded the real app correctly.
2. `skillsMatch` cannot preflight this semantic path: its IPC handler calls
   `SkillRegistry.matchTrigger()`, and the current `ui-ux-pro-max` metadata has no literal triggers.
   An empty `skillsMatch` result therefore says nothing about the send-time embedding detector.

The live `sendInput` was deliberately not issued after the stop request. The disposable instance was
terminated without a send, `ui-ux-pro-max` was restored and read back as `suggest-only`, the isolated
Electron process and static server were stopped, and the temporary profile was moved to Trash. No
activation or budget-skip evidence was created by this continuation, so none of the existing check
status or LT-547 conclusions change.

## Evidence run — 2026-09-27 (final LT-547 closure)

**Environment.** Current checkout, development AOT renderer served on `:4567`, isolated profile
`/tmp/aio-lt-0927-skillobs-fresh`, Electron CDP on `:9787`. The app was launched with
`--no-sandbox` because the agent runtime is itself sandboxed; without that flag Electron 40's child
sandbox cannot initialize in this environment. The test used a fresh Claude instance in
`/tmp/aio-lt-0927-skillobs-ws`.

**Deterministic detection input.** The earlier keyword-dense paraphrase no longer crossed the local
fallback detector's threshold. The final run therefore read the exact current description from
`skillsList()` and used that description as the real user message. This semantic self-match
exercises LT-547 without depending on a historical fallback-embedding score. The catalogue entry
was `ui-ux-pro-max`, global, `coreSize: 44,776`.

**Observed end-to-end result.**

1. The health-panel row initially showed **Suggest**.
2. Clicking the row's real **On** button changed `.mode-btn.active` to **On**.
3. `createInstance()` returned fresh instance `c6rnqb2td`; `sendInput()` succeeded and the instance
   entered `busy` with output present.
4. `skillsHealthSummary()` returned a new budget-skip row tied to that exact instance and session:
   `reason: budget-exceeded`, `tokens: 10932`, `budget: 5000`.
5. After clicking the real panel **Refresh** button, the row rendered:
   `Detected, not injected · needs 10,932 tokens, 5,000 available · just now`.
6. Cleanup terminated the fresh instance successfully, clicked **Suggest**, and read back
   `.mode-btn.active === "Suggest"`.

The new record was distinguished from the direct diagnostic preflight by both its unique row ID and
its fresh instance ID. This closes the final open half of check 4 and completes the document.
