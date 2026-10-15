# Open decisions — resolved 2026-08-19

**Status reconciliation — 2026-09-24:** this is a dated decision/evidence ledger, not today's
open-work list. The August decisions and later measurement sections retain their original scope.
Later decisions can supersede them: LT-189 was removed after the original banner decision and
then restored on 2026-09-23, as reconciled in its section below. Consult the
[remediation register](livetest-remediation-register.md) and each owning live-check record for
current implementation and verification status; no live checks were rerun for this correction.

James delegated these: *"for my decisions go with whatever you recommend if you can."* This records
what was decided, the reasoning, and — importantly — the three I did **not** take and why.

Each decision states its own falsification condition where one exists, so a future reader can tell
whether it was right rather than only that it was made.

---

## Decisions taken for implementation — original 2026-08-19 record

### LT-208 — harden the automation-retry condition · **DECIDED: harden it**

`AutomationScheduler` distinguishes "async echo of the failure that armed this retry" from "a genuine
disable racing a pending retry" with `event.automation?.enabled === true`, and a comment asserts every
disable path flips `enabled` and never `active`. That is true of every current call site — but nothing
enforces it, and `AutomationUpdatePayloadSchema` permits setting `active: false` independently.

**Decision: change the condition to `enabled === true && active !== false`, and add a test asserting a
retry is cancelled when an automation is disabled via `active: false` alone.**

Reasoning: strictly safer, and **no behaviour change today** — the echo path carries `active: true`, so
the added clause cannot alter any current outcome. This is the cheapest possible close of a latent
trap, and the codebase has produced five instances of the "invariant asserted in a comment, unenforced
in code" class in a single day. The schema-restriction alternative is a bigger, more disruptive change
for the same protection.

### LT-193 — unpriced fallback renders as `$0` · **DECIDED: make unknown distinguishable from zero**

`addAccountingCost()` coalesces an absent cost to `0`, and that total renders directly as a dollar
figure in three components — so "cost unknown" is indistinguishable from "cost was zero".

**Decision: carry unknown-ness through to the display, following the pattern the layer below already
gets right.** `LocalAiFallbackSpend` already stores `NULL` rather than `0` and tracks a separate
`unknown_reservations` counter; `exceedsConfiguredCeiling()` already treats undefined correctly. Copy
that upward: make the incident/effectiveness total distinguish "no priced dispatches" from "some
dispatches unpriced", and render unknown as `—` (or `$X + n unpriced`) rather than a confident `$0`.

Reasoning: a confident wrong number is worse than an absent one — this campaign has now produced four
cost-reporting defects of exactly that shape. The correct pattern already exists one layer down, so
this is consistency work, not invention.

### LT-217 — browser audit table is 99.7% bookkeeping · **DECIDED: stop the writes; add pruning; do NOT backfill-delete**

3,444,307 rows, 1.36 GB, ~32% of `rlm.db`, no pruning path, against ~11,000 genuine agent actions.

**Decision, in three parts:**
1. **Stop auditing the two internal bookkeeping paths.** `attachExistingTab()` fires once per tab per
   inventory report (~2–3 rows/second, continuously); `listApprovalRequests()` is a read-only poll on a
   permanent 5s timer. Neither is an agent-attributable browser *decision*, which is what this table is
   for. Keep an `extension_attach_tab` row when an **agent** initiates an attach.
2. **Add retention pruning** for `actionClass: 'read'` rows beyond a generous horizon (90 days),
   wired where other maintenance runs.
3. **Do not run a destructive backfill or `VACUUM` in this change.** Reclaiming the existing 1.36 GB
   means compacting a live 4.2 GB database that the running app holds open. That is a separate,
   deliberate maintenance operation — recommended, but it needs the app stopped and James's say-so.

Reasoning: (1) is pure upside and stops the bleeding. (2) bounds future growth. (3) is where the actual
risk lives, so it is separated rather than bundled. **Falsifier:** if anyone is genuinely using
`extension_attach_tab` rows for forensics, (1) is wrong — nothing found in the repo reads them back.

### LT-218 — `browser.snapshot` succeeds with empty text when it cannot read the page · **DECIDED: explicit unreadable flag, not a hard failure**

**Decision: keep the call succeeding, but carry an explicit `textUnavailableReason` (or
`unreadable: true`) that callers can branch on, and surface it in the tool result.**

Reasoning: the alternative — failing outright like `query_elements` does — is more consistent but
riskier, because `capturePageText` uses `executeScript` with `allFrames: true`. A page with one
inaccessible iframe would start hard-failing where it previously returned usable partial text. The flag
preserves partial reads while removing the silent-wrong-answer, which was the actual defect.

**Caveat that does not change the decision:** this code lives in the extension bundle, so the fix
cannot be live-verified until the extension is redeployed and reloaded on the node. Implement and
unit-test now; live verification is a deferred check.

### LT-138 — no Settings UI for `allowPrCreation` · **DECIDED: build the control**

The backend is correct and the CLI refusal (`cliWritable=no`) is deliberate — this is meant to be a
human GUI decision. But no GUI exists, and the error message points users at "project settings" that
are not there.

**Decision: build the per-project opt-in control in Settings.** When a setting is deliberately
operator-only *and* the CLI correctly refuses it, the GUI is the only remaining path — so it has to
exist or the feature is unreachable by design. Leaving it operator-only is not a coherent option here;
that is the current state and it is a dead end.

### LT-189 — `notify-and-allow` fallback · historical decision and later reconciliation

**Reconciled 2026-09-24 against source and Git history:** the original passive-banner decision
below was followed by removal in `1ad92f5e` (2026-08-26). W4 of the
[September 23 sweep](2026-09-23-outstanding-plans-sweep_plan_completed.md) recorded a decision
not to restore it during that sweep because the removal accompanied a deliberate policy change.
That W4 entry is not the latest outcome: `be5cce3b` (2026-09-23) restored the notification
section. The current
[component](../../src/renderer/app/features/local-ai-guard/local-ai-fallback-banner.component.ts)
and [its specs](../../src/renderer/app/features/local-ai-guard/local-ai-fallback-banner.component.spec.ts)
contain passive, dismissible `notify-and-allow` notifications. The
[completed remediation plan's final reconciliation](2026-07-19-livetest-failure-remediation_plan_completed.md)
records James's decision to restore the banner. **Restored in code; rebuilt-app check pending.**
The old removal does not justify rebuilding it again, and the earlier live proof does not verify
the restored build.

**Original observation — 2026-08-19:** `LocalAiRoutingGuard.notify()` called a `notifyFallback`
callback that the inspected production construction site did not supply.

**Original decision: wire `notifyFallback` and surface it as a passive, dismissible banner**, reusing the
existing `local-ai-fallback-banner` component (extended to render notify-and-allow events alongside its
current `require-confirmation` queue). Keep the effectiveness dashboard as the durable record.

Reasoning: a toast is missable and this is a spend event on a security-adjacent fallback — the user
should be able to find out after the fact, which a toast does not allow. An OS notification is too
heavy for something that can fire repeatedly. A passive banner is discoverable, non-blocking, and
reuses a component that already exists.

---

## Taken as scope decisions — deliberately *not* building

### LT-220 — Antigravity emits no `tool_result` events · **DECIDED: accept the gap, correct the doc**

`agy` does support `--output-format stream-json` (the adapter's header comment saying otherwise is
wrong and should be corrected). But rewriting a provider adapter's output pipeline is substantial work
with real regression risk, on a secondary provider, to enable evidence capture nobody is currently
relying on.

**Decision: correct the adapter's false comment and the livetest doc's premise (Antigravity does *not*
share Gemini's code path), and record the capture gap as known and accepted.** Revisit if Antigravity
becomes a primary provider or evidence capture becomes load-bearing for it.

### LT-270 — cost governor recovers 3.1% against a ≥60% target · **DECIDED: rescope the target, don't build the fallback**

**Decision: correct the doc's ≥60% acceptance target to reflect what the automatic path can actually
do on builds that never confirm native compaction, and record the measured 3.1%.** Do **not** add a
restart-with-summary fallback to the automatic path.

Reasoning: the manual Compact button's LT-017 fallback carries a known risk — swapping the thread out
from under an interrupted turn — which was explicitly flagged on 2026-08-12. Taking that risk
*automatically*, without a human pressing anything, is a materially worse trade than accepting that
the automatic path is a safety pause rather than a cost-recovery mechanism. The honest fix is to stop
claiming it recovers cost. **Falsifier:** if a Codex build lands that confirms `thread/compacted`, the
premise changes and the target becomes achievable — re-measure then.

### Provider-exclusions check 6 · **DECIDED: leave the doc open**

Check 6 ("no automatic Copilot traffic over a working day") cannot be satisfied by an agent by
construction, and the campaign's standing rule is that a doc is not renamed until *every* check passes.
Closing on 5 of 6 would break that rule for one of the few docs where the remaining check is genuinely
cheap for a human.

**Decision: leave it open, record the supporting evidence (~4 weeks of production logs: zero
automatic-selection Copilot spawns), and state the closure criterion in one line** — after a normal
working day, check the Copilot quota chip moved only for sessions James started explicitly.

### Skill-injection threshold (0.65) · **DECIDED: measure all 35 before setting a number**

Seven skills measured 0.199–0.399 against a 0.65 threshold; off-topic controls sat at 0.188–0.232. So
there is real separation, but the sample is thin and the on/off-topic bands nearly touch at the bottom
(`debug-workflow` 0.199 vs off-topic 0.232 — **already inverted**).

**Decision: do not pick a number off seven samples.** Run the same measurement across the full 35-skill
registry — on-topic paraphrase and an off-topic control per skill — and set the threshold from the
resulting distribution, or conclude that cosine similarity on whole descriptions is the wrong
discriminator. Picking ~0.30 now would look principled and would misfire on at least one measured skill.

### LT-196 — correction miner structurally dead for Claude · **DECIDED: needs its own spec, not a snap call**

The miner depends on `tool_result` `OutputMessage`s in the archived transcript; LT-062 (correctly)
stopped writing those for ordinary tool successes and failures. The signal still exists on the internal
`'tool_result'` event used for live doom-loop detection.

**Decision: do not snap-decide.** The plausible fix — move the miner from a post-hoc archived scan to a
live capture off the internal event — is an architecture change to how learning data is gathered, not a
bug fix. It deserves a spec. Recorded as the recommendation; not implemented.

### LT-215 and LT-168 · **DECIDED: recommendation recorded, implementation deferred**

- **LT-215** (degradation notice misses a child that died in the restart window): recommend a
  short-lived per-parent "died while parent was not idle/busy" list, drained into `droppedChildIds` by
  the notice builder **in addition to** the existing stale-membership check.
- **LT-168** (auth-repair resume): recommend archive-at-block-time, so the existing revival lookup can
  find the instance, rather than respawning an errored adapter in place.

Both are session-lifecycle changes on paths where this campaign has already produced respawn and
wedge defects. They are the right shape, but they want implementing deliberately with their own
verification rather than folded into a batch of small fixes.

### LT-137 · **DECIDED: leave open, P3**

An adversarially-timed interrupt during a deferred-permission auto-resume drops the approved action.
No crash; recovers on a further prompt. The state machine correctly rejects the illegal transition.
Recommend an interrupt-side guard when someone is next in that code — not worth a dedicated change.

---

## Decisions not taken in the original 2026-08-19 delegation

1. **Committing the CI fix.** Both `AGENTS.md` and the global rules say never commit unless explicitly
   asked. "Go with your recommendation" covers decisions; committing is an action gated by a standing
   rule, and the change is currently staged by *another* agent. My recommendation is unchanged: commit
   it. It needs three words from James.
2. **Building the packaged-app debug port.** It would unblock three docs at once and I recommend it —
   but a debug port on the packaged app that hosts real, live sessions is a security-relevant scope
   expansion, not a decision an agent should take on its own initiative.
3. **Compacting the 1.36 GB of existing audit rows** (LT-217 part 3). Needs the app stopped; the
   deletion is irreversible.

---


## LT-220 — DONE (2026-08-20)

The false claim is corrected at source. `src/main/cli/adapters/antigravity-cli-adapter.ts`'s header no
longer says `agy` "has no `--output-format stream-json` mode"; it records that `agy --help` lists
`text, json, stream-json`, that the plain-text parsing is therefore a **choice not a constraint**, that
context-evidence capture is consequently always empty for Antigravity in every mode with no error
raised, and that the gap is **known and accepted** with the condition for revisiting it. Evidence
appended to the provider-agnostic-context-evidence livetest doc, including the finding that its check 4
cannot pass as written because its premise (Antigravity shares Gemini's code path) is untrue.
`tsc` and `lint` clean.

## LT-270 — DONE (2026-08-20)

The cost-governor doc's `≥60%` acceptance target is rescoped in place, with the measured numbers
(407,155 on / 420,330 off = 3.1%), the root cause (native compaction never confirms on these builds, so
the automatic path pauses and resumes on the same context), the reason the restart-with-summary fallback
was deliberately **not** added to the automatic path, and an explicit falsifier — if a Codex build lands
that confirms `thread/compacted`, the premise changes and the original target becomes meaningful again.
Check 4 is now assessed against what the automatic path is actually for: it must not increase cost and
must not lose work. On the measured run it did neither.

# Implementation status — verified 2026-08-20

Two implementation batches stalled on the host-overload watchdog before delivering their reports (see
the campaign runbook's "Host overload" section — loadavg hit ~300). Their **code** landed and is
green; the **evidence** they owed was completed directly by the orchestrator rather than by resuming
them into a saturated machine.

## LT-208 — DONE, and the revert-proof now exists

`automation-scheduler.ts:101` reads `event.automation.enabled === true && event.automation.active !== false`.

Revert-and-confirm run directly (via a `/tmp` copy, no `git` working-tree command):

| State | Result |
| --- | --- |
| With the fix | **28/28 pass** |
| Clause removed | **1 of 28 fails** — "LT-208: a genuine disable via active=false ALONE (enabled left true) still cancels an armed retry", `AssertionError: expected 1 to be +0` (the retry fired when it should have been cancelled) |
| Restored | **28/28 pass** |

**The no-op claim is evidenced by the same run**: only the new test changes state between the two
runs — the other 27 pass identically with and without the clause, which is what "strictly safer, no
behaviour change today" has to mean to be worth asserting.

## LT-193 — DONE

`unpricedDispatchCount` is threaded through `local-ai-row-mappers.ts`, `local-ai-incident-service.ts`,
`local-ai-health-repository.ts` and `src/shared/types/local-ai-guard.types.ts`, with a
`unpriced_dispatch_count` DB column. 30 files / 488 tests pass across `src/main/local-ai-guard` and
`src/main/automations`.

**Open, and stated rather than left ambiguous:** `addAccountingCost()` still reads
`current + (incoming ?? 0)` at `local-ai-row-mappers.ts:666`. That is consistent with the chosen
design — the total stays a non-nullable number and `unpricedDispatchCount` carries the unknown-ness
alongside it — but **whether the three renderer sites actually display that count was not confirmed**
(`local-ai-target-card.component.ts:479`, `local-ai-incident-panel.component.ts:295-296`,
`local-ai-effectiveness-panel.component.html:71`). Until they do, the fix is real in the data layer
and invisible in the UI, which is the half a user sees. **Residual: verify or complete the renderer
half.**

## LT-217 — DONE (parts 1 and 2), and the safety question is answered

- `recordAudit: false` on both `attachExistingTab` branches and on `listApprovalRequests`, plumbed
  through `browser-gateway-result.ts:38,67`.
- `pruneReadEntriesBefore()` on the audit store, plus a new `browser-audit-retention-maintenance.ts`
  module, with tests in three spec files.

**The load-bearing question — does anything read these rows back? — is now answered: no.**
Searched directly rather than inferred:

- The three `extension_attach_tab` hits outside specs (`worker-extension-relay.ts:184`,
  `browser-extension-native-host.ts:448`, `browser-gateway-rpc-server.ts:197`) are all **RPC method
  name** references, not audit-row reads.
- `browser_audit_entries` is read in exactly two places, both in `browser-audit-store.ts`: a
  `SELECT … WHERE id = ?` and one `list()`.
- The **only** consumer of `list()` in browser-gateway is `getAuditLog()`
  (`browser-gateway-service.ts:744`), the agent-facing `browser.get_audit_log` read tool, which maps
  rows through `toAgentSafeAudit()` and returns them for inspection. **Nothing branches on them.**

So dropping the bookkeeping writes cannot regress behaviour; it makes the one tool that reads this
table return signal instead of 99.7% noise. Part 3 (compacting the existing 1.36 GB) remains James's,
unchanged.

## Current-status corrections — 2026-08-31

- **LT-168 is no longer deferred or awaiting a decision.** It was implemented on 2026-08-31 using a
  bounded restart-and-replay of the still-live errored instance, with regression coverage. A rebuilt
  live auth replay remains, but the product choice is closed.
- **LT-220 remains an accepted capability gap, not an open decision.** The adapter comment and the
  owning livetest premise are corrected; no Antigravity stream-parser rewrite is planned.
- **LT-270 is closed under the rescoped contract.** The measured automatic path reduced input by
  3.1%, increased neither cost nor work loss, and is documented as a safety pause rather than a
  compaction mechanism on provider builds that never confirm native compaction.
- **LT-217 parts 1–2 are implemented.** Only optional destructive compaction of historical rows is
  still operator-gated; the production defect is no longer “found, not fixed”.

## Skill-injection threshold — measured 2026-09-23

Follows up "Skill-injection threshold (0.65) · DECIDED: measure all 35 before setting a number".

**What the runtime compares.** `SkillsLoader.detectRelevantSkills()` (`src/main/memory/skills-loader.ts`)
embeds the user message and compares it with `EmbeddingService.cosineSimilarity()` against a cached
embedding of each skill's **whole frontmatter `description`**, taken from `precomputeEmbeddings()`. It
checks **every** discovered skill, and each skill that scores at or above `similarityThreshold` becomes a
candidate, capped at 3. The embedder is the RLM `EmbeddingService` (`src/main/rlm/embedding-service.ts`)
at default config (`provider: 'auto'`). Nothing in `src/main` calls `configure()` on it, so the chain
is Ollama `nomic-embed-text` at `localhost:11434`, then OpenAI (never keyed), then the local hashed
word/bigram/char-trigram bag (`local-tfidf`, 384-d, L2-normalised). There is no Ollama server on this
Mac, and although `Ollama.app` is installed, `nomic-embed-text` has not been pulled. That means
**the backend that actually runs is `local-tfidf`.** The run recorded that provider for every embedding.

**Method.** `_scratch/skill-threshold/measure.ts` runs the real path, not a copy of it:
`getSkillsLoader().initialize(repoRoot)` handles discovery, sync and the description embeddings,
then the message is embedded with `getEmbeddingService()` and scored with `cosineSimilarity()`. The
prompts in `prompts.json` were written before any score was seen: one on-topic request and one
off-topic control per skill, both phrased the way a user would type them rather than lifted from
the description. The earlier seven-skill raw data was never recorded, so the method follows the
2026-08-18/19 36-skill runs in `2026-07-23-skill-observability-and-design-skills_livetest.md`,
which used the same backend.

**Count.** The runtime discovers **36 skills, not 35**. They come from `src/main/skills/builtin`
(17 directories), the project's `.claude/skills` and `~/.claude|.agents|.codex/skills`. By resolved
source, 16 are builtin, 19 global and 1 project. `human-public-writing` exists both as a builtin and
under `~/.agents/skills`, and the global copy wins because the registry keys skills by directory name.

| Population (n=36 each) | min | median | max |
| --- | --- | --- | --- |
| On-topic prompt vs its own skill | 0.123 | 0.325 | 0.496 |
| Off-topic prompt vs its paired skill | -0.024 | 0.140 | 0.258 |
| Off-topic prompt vs **best of all 36** (what the runtime sees) | 0.193 | 0.274 | 0.371 |
| On-topic prompt vs best **wrong** skill | 0.210 | 0.355 | 0.449 |

- **Overlap.** 24 of the 36 on-topic scores are at or below the highest off-topic score (0.371).
  Two skills are inverted against their own controls: `fresh-clone` (on 0.123, off 0.224) and
  `fal-image-gen` (on 0.208, off 0.258).
- **Ranking.** The intended skill ranks first for only **16/36** on-topic prompts (4/16 builtins),
  with a median rank of 3. For a typical on-topic prompt, the best wrong skill scores higher than the
  right one (median 0.355 vs 0.325).
- **Threshold sweep** (0.10–0.70; recall is out of the 36 on-topic prompts):
  - 0.65 (current): recall 0/36, no false positives.
  - 0.45: recall 7/36 (19%). This is the lowest value with no off-topic or wrong-skill hits.
  - 0.38: recall 10/36, with no off-topic hits. However, 13 on-topic messages would also pull in
    wrong skills (25 wrong injections).
  - 0.33: recall 17/36 (the Youden-best cut). It fires on 3 off-topic messages and makes 93
    wrong-skill hits across 24 messages.
  - 0.30: recall 20/36. It fires on 13 of 36 off-topic messages.
- **Alternatives on the same backend, all worse or no better** (experimental):
  - Argmax plus a margin over the runner-up (`analysis.json` `marginSweep`): at a margin of 0.10,
    3/36 correct, 1 wrong skill and no off-topic hits.
  - First sentence only (`variants.txt`): top-1 11/36.
  - Best-scoring sentence of the description (`variants.txt`): top-1 10/36.

**Decision: (b). No threshold separates acceptably, so `0.65` stays unchanged.** Every cut that admits
meaningful recall also injects off-topic or wrong skills. The only clean cut, 0.45, recovers 19%.
Cosine against whole descriptions on the `local-tfidf` backend measures word and character overlap,
not intent, so it is the wrong discriminator. At 0.65, embedding injection stays effectively off
(the right way to fail) and the trigger path does the work, as `triggerMinConfidence` has since check 9.
`skills-loader.ts` now carries a comment beside the constant citing this section. The existing
`skills-loader.spec.ts` assertion already pins the value.

**What the right discriminator would be:**

1. Explicit triggers and slash commands as the primary deterministic path. This already works.
2. Semantic matching only on a real semantic embedder. The first-priority provider,
   `nomic-embed-text` via Ollama, is not installed, so it was **not measured**, and whether it would
   separate is unknown. Treat a threshold as specific to one embedding model. The single constant is
   currently applied to whichever backend `auto` resolves to, and the cosine scales of different
   models are not comparable.
3. Scoring against several short example requests per skill, rather than one long description, and
   picking skills by rank and margin across the whole registry rather than by an absolute cut.
4. Refusing embedding injection outright when the provider resolves to `local`.

Items 2–4 are recommendations and have not been implemented.

**Raw data:** `_scratch/skill-threshold/` (gitignored) contains:

- `results.csv`: per skill and kind, with own score, rank, top-1 skill and prompt.
- `results.json`: the full 72×36 matrix plus provider and model.
- `analysis.json`: the sweeps and per-skill figures.
- `variants.txt`
- The scripts `measure.ts`, `analyse.js` and `variants.ts`.
