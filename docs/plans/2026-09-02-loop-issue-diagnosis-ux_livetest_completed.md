# Live tests — Loop issue diagnosis UX

## Final status — 2026-09-27

Open: 0 · Closed: 2 · Transferred: 1 · Failed: 0

LT-1 and LT-2, including LT-590 through LT-592, are confirmed fixed live. LT-3's mechanically
verifiable accessibility assertions also pass; its sole remaining auditory VoiceOver judgment is
preserved as
[RES-024](2026-09-27-livetest-human-external-residuals_livetest.md#res-024--voiceover-announcement-for-loop-diagnosis-cards).

## Status — 2026-09-20

Open: 1 · Closed: 0 · Failed: 2

- **LT-1 — FAILED.** Layout, wrapping and stacking are all correct at both widths, but in the
  light theme the severity chip, the fixability tag and every primary/danger button in the card
  drop to 1.6–1.9:1 contrast. Filed as `LT-590`.
- **LT-2 — FAILED.** No catalog gap: every signal id the detectors can emit is in
  `PROGRESS_SIGNAL_CATALOG`, and 2447 real recorded iterations produce zero fallback headlines.
  The failure is the other expectation — the WARN-escalation branch reuses signal id `A`, so 51
  real iterations headline "Repeating the same work" for a condition that measured no repeated
  work at all. Filed as `LT-591`, with a smaller consistency defect as `LT-592`.
- **LT-3 — OPEN, residual needs James.** Everything mechanically determinable is verified below
  (politeness, live-region scoping, zero live-region mutation on disclosure/focus, real Tab
  reachability, button names). Only the audible VoiceOver announcement is left.

Evidence run: [2026-09-20](#evidence-run--2026-09-20), [2026-09-24](#evidence-run--2026-09-24-loops-batch).

## Status — 2026-09-24 (loops batch)

Open: 1 (LT-3, needs James) · Closed: 2 (LT-1/LT-590, LT-2/LT-591+LT-592) · Failed: 0

Re-checked LT-590, LT-591 and LT-592 live against a rebuilt dev app (HEAD `f04f6748`), reusing the
2026-09-20 fixtures replayed into a real `LoopStore`. All three **CONFIRMED FIXED LIVE**:

- **LT-590** — light-theme chip/tag/button contrast is now 4.56:1–19.76:1 (was 1.09–1.91:1). Screenshot
  confirms legible text.
- **LT-591** — the escalation-A fixture now headlines "Editing files but tests are not moving" (the
  real D-prime signal that fired), not the bogus signal-A "Repeating the same work".
- **LT-592** — the A+F mixed-critical fixture now shows one fixability tag ("Usually fixable")
  consistent with one next step ("Give a hint…") and exactly one primary button ("Give a hint");
  previously it showed "Needs a decision" + a hint next step + two primary buttons.

LT-3 is unchanged (residual VoiceOver audio check, needs James) — see evidence run below.

> **Found a defect while running these checks?** Record it in the remediation
> register — `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN`
> item (index row, then observed behaviour, root cause, required behaviour and
> acceptance), and add the matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-09-02-loop-issue-diagnosis-ux_plan_completed.md](./2026-09-02-loop-issue-diagnosis-ux_plan_completed.md)

## Why these are deferred

The *behaviour* of the diagnosis card, chips, inspector evidence and pause
banner is verified in-loop by component tests that render the real template
(`loop-control.component.spec.ts`), covering the running-CRITICAL,
running-WARN, manual-pause and paused-no-progress cases. Those are **not**
deferred and must not be re-listed here.

What is left needs something an agent cannot produce: pixels on screen, real
detector output, and a screen reader.

## Prerequisites

- `npm run build` (or at least `npm run build:main` plus a renderer rebuild),
  then relaunch Electron. An already-running instance keeps the old
  `LAST ITER · CRITICAL` chip.
- A loop that can be steered into a stuck iteration (repeated reads / same
  tool set) without being dangerous to the workspace.

---

## LT-1 — Card renders legibly in the real HUD

Component tests assert text content, not layout.

1. Drive a loop into a WARN and then a CRITICAL completed iteration.
2. Look at the card in the active strip at a normal window width, and again
   with the window narrowed to roughly 900px.

Expected:
- The card sits under the status strip without overlapping the ping-pong row
  or the activity feed.
- Headline, chip and fixability tag stay on readable lines — they wrap, they
  do not clip or overflow horizontally.
- WARN styling is amber, CRITICAL is red, and both are readable in the
  active theme.

## LT-2 — Real detector messages read as English in the card

The catalog is keyed on detector signal ids (A–I, BLOCKED) and renders the
detector's own `message` verbatim. Unit tests use hand-written messages.

1. Let real detectors fire — ideally A, G and I at least once each.
2. Read the card's problem line and the "Why the loop thinks this" disclosure.

Expected:
- Every signal id the detectors actually emit is present in
  `PROGRESS_SIGNAL_CATALOG`. If a real iteration shows the fallback headline
  "Progress looks unhealthy", record the missing id — that is a catalog gap,
  not a display bug.
- The real detector `message` reads sensibly next to the catalog `meaning`
  line, without repeating it word for word.

## LT-3 — Screen-reader announcement

The card scopes its live region to the diagnosis prose, so toggling the
evidence disclosure or pressing a button should not re-announce the panel.

1. Turn on VoiceOver.
2. Trigger a CRITICAL iteration on a running loop.
3. Once announced, expand "Why the loop thinks this", then move through the
   card's buttons.

Expected:
- The diagnosis is announced once when it appears — assertively for CRITICAL,
  politely for WARN.
- Expanding the disclosure or focusing a button does **not** re-announce the
  whole card.
- Every button is reachable and correctly labelled.


---

## Evidence run — 2026-09-20

Run from the Plan Queue worktree `queue/2026-09-02-loop-issue-diagnosi-4c3b38`, against a dev
app built from that worktree (`build:main`, plus a development-configuration renderer build served
statically on port 4589 — development configuration because `window.ng` is not installed in a
production bundle) and launched isolated:
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-b94c3b38 PORT=4589 npx electron . --remote-debugging-port=9722`.
`Emulation.setFocusEmulationEnabled` and `setPageVisibilityOverride` were sent on every CDP
connection before any DOM read, so `document.hidden` was `false` and rAF fired throughout — the
occluded-window trap in the campaign runbook does not apply to anything below.

Screenshots, fixtures and the measuring scripts are kept at
`_scratch/lt-2026-09-20-loop-issue-diagnosis/` in the root checkout.

### How "real detector output" was obtained without a multi-hour steered loop

The prerequisite asked for a loop steered into a stuck iteration. A cheaper and *stronger* source
was available: the production loop-mode database already holds **2,873 recorded iterations**, of
which **2,447 carry progress signals** the detectors actually wrote. A read-only copy of
`~/Library/Application Support/harness/loop-mode/loop-mode.db` was taken and six representative
iterations were rebuilt into `LoopStatePayload`s (`build-fixtures.mjs`). The **iteration** in each
fixture is copied field for field out of its `loop_iterations` row — every signal id, verdict,
message, stage, test count, token and cost value below is verbatim detector/runtime output — and
the run's `config_json` (including its real `progressThresholds` and `completion.mode`) is the one
that produced it. The run **wrapper** is where the small amount of derivation lives: `chatId` is
repointed at the dev app's throwaway session, `totalIterations` is `seq + 1`, and the counters the
renderer does not read for this card (`iterationsOnCurrentStage`, `recentWarnIterationSeqs`,
`tokensSinceLastTestImprovement`) are defaulted. No `autoUnstick` block is set, so the
running-CRITICAL implication line renders its full-attempts-remaining form; nothing below turns on
that sentence.

Those fixtures were pushed into the live `LoopStore` through
`ng.getComponent(document.querySelector('app-loop-control')).store`, so the real
`loop-control.component` template, the real `buildLoopIssueView`, the real SCSS and the real
theme variables did the rendering. The only hand-made object in the whole run is the ping-pong
runtime block used for the overlap check, which has no persisted columns to copy; it is marked as
such where it is used, and it carries no diagnosis copy.

Iterations used:

| Fixture | Source iteration | Recorded | Real signals |
| --- | --- | --- | --- |
| `A-identical-critical` | `iter-loop-1778363605952-38a768a3-2-33da80` | 2026-05-09 | `A:CRITICAL` "Identical work hash repeated (3 consecutive, 3 of last 3)", `F:CRITICAL` "103124 tokens spent since last test improvement (>= critical 60000)" |
| `G-and-C-critical` | `iter-loop-1780598090148-e8d5e756-15-ed7e99` | 2026-06-04 | `A:CRITICAL`, `C:CRITICAL` "Stuck on IMPLEMENT for 16 iterations (>= critical 12)", `G:CRITICAL` "Same tool-call set repeated in last 3 iterations" |
| `I-grep-warn` | `iter-loop-1788370102259-60c9f3a7-0-49dc13` | 2026-09-02 | `G:WARN` "Tool grep called 65× in one iteration (provisional — needs confirmation next iteration)", `I:WARN` "Read-only tool grep returned the same result hash 3x without intervening edits" |
| `escalation-A` | `iter-loop-1778974464545-b67e72ab-3-9b1c79` | 2026-05-17 | `D-prime:WARN`, `A:CRITICAL` "3 WARN iterations in last 5 — escalated to CRITICAL" |
| `B-oscillation-warn` | `iter-loop-1780660254243-e804909e-3-b502e7` | 2026-06-05 | `B:WARN` "File content oscillating on 1 file(s) (low ratio)" |
| `F-tokens-warn` | `iter-loop-1778363605952-38a768a3-0-b4b65a` | 2026-05-09 | `F:WARN` "28927 tokens spent since last test improvement" |

---

### LT-1 — Card renders legibly in the real HUD — **FAILED**

#### Layout, wrapping and stacking — pass

Measured from the live DOM with `Emulation.setDeviceMetricsOverride` on the same CDP connection as
the reads and the screenshot (splitting those across connections silently reverts the override).

| Viewport | Card box | Gap: strip bottom → card top | Card `scrollWidth − clientWidth` | Document horizontal overflow | Headline | Implication | Signal-row overflow |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1400 × 900 | 962 × 276 at x=406 | 4 px | 0 | 0 | 1 line, no clip | 1 line | 0, 0 |
| 900 × 900 (CRITICAL) | 458 × 328 at x=414 | 4 px | 0 | 0 | wraps to 2 lines | 2 lines | 0, 0 |
| 900 × 900 (WARN) | 458 × 362 at x=414 | 4 px | 0 | 0 | wraps to 2 lines | 2 lines | 0, 0 |

Nothing clips and nothing overflows horizontally at either width; the chip and the fixability tag
stay on the head row while the headline wraps beneath them (`.li-issue-head` is
`flex-wrap: wrap` with the headline at `flex: 1 1 180px`).

Overlap with the neighbours, with a ping-pong runtime block present so the row actually renders
(`lt1-1400-pingpong.png`):

- card box `y 420 … 750`, ping-pong row `y 756 … 776`, activity feed `y 839 … 898`
- card↔ping-pong overlap **0 px** (6 px gap), card↔activity-feed overlap **0 px**
- DOM and visual order: status strip → diagnosis card → `REVIEW PING-PONG` → run config → `Live loop activity`

Screenshots: `lt1-1400-A.png`, `lt1-900-A.png`, `lt1-900-WARN.png`, `lt1-1400-pingpong.png`,
`lt-1400-{G-and-C-critical,I-grep-warn,escalation-A,B-oscillation-warn,F-tokens-warn}.png`.

#### WARN amber / CRITICAL red — pass in dark, **fail in light**

Contrast was measured twice, independently: once by compositing every ancestor `background-color`
and inherited `opacity` from the live computed styles, and once from the **rendered screenshot
pixels** (modal colour in each element box = background, the pixel furthest from it in relative
luminance = glyph). The two agree on every verdict. They differ by a few hundredths on large text
and by more on the smallest glyphs — `See why` in light theme reads 1.13:1 by computed style and
1.56:1 by pixel, because the darkest pixel a 11px antialiased label offers is an edge, not the
glyph core. Both are far under the floor, and the pixel figure is the conservative one, so the
tables below quote pixels wherever a screenshot exists.

Dark theme (the app default, `data-theme="dark"`), rendered-pixel figures:

| Element | CRITICAL | WARN |
| --- | --- | --- |
| Severity chip (`STUCK` / `WATCH`) | **5.09:1** | 6.75:1 (computed) |
| Fixability tag | **6.24:1** | 8.27:1 (computed) |
| Headline / problem | 14.77:1 | 14.71:1 |
| `Give a hint` | 12.80:1 | 12.82:1 |
| `See why` (primary) | 9.93:1 | 9.91:1 |
| `Stop` (primary danger) | **5.37:1** | n/a |

All pass WCAG AA for normal text. WARN renders amber (`rgb(247,192,122)` on
`rgba(247,192,122,0.08)`), CRITICAL renders red (`rgb(247,140,124)` on `rgba(247,140,124,0.1)`),
and `data-severity` carries the raw verdict as designed.

Light theme. Reachability was established through the product's own control —
`settingsStore.set('theme','light')` returned `data-theme="light"`, which is the Settings →
Appearance path and also what `theme: 'system'` resolves to on a Mac in light mode
(`settings.store.ts` `applyTheme`). Setting that same attribute is the *whole* of what `applyTheme`
does, so the screenshot runs set it directly; the computed figures were taken on the settings-store
run and the pixel figures on the attribute run, and they describe the same rendering:

| Element | CRITICAL rendered | WARN computed | AA floor |
| --- | --- | --- | --- |
| Severity chip | **1.75:1** | **1.41:1** | 4.5:1 |
| Fixability tag | **1.91:1** | **1.46:1** | 4.5:1 |
| `See why` (primary) | **1.56:1** | **1.09:1** | 4.5:1 |
| `Stop` (primary danger) | **1.65:1** | n/a | 4.5:1 |
| Headline / problem / implication / next | 17.64:1 | 18.34:1 | pass |

No WARN screenshot was taken in light theme, so that column is the computed-style figure; the
CRITICAL card was measured by both methods and they agree on every verdict.

The prose survives because it uses `var(--text-primary, …)`. Everything that carries the *severity*
— the chip, the tag and the filled buttons — is a hard-coded dark-theme hex in
`loop-issue-card.component.scss` and washes out completely. `lt1-theme-light.png` shows the STUCK
chip and the `See why` label effectively invisible. Filed as **LT-590**.

For completeness the `high-contrast` theme was also measured by the computed-style method and
passes (chip 5.73:1, tag 6.99:1, `Stop` 6.05:1).

---

### LT-2 — Real detector messages read as English in the card — **FAILED**

#### Every emitted signal id is in the catalog — pass

Two independent checks:

1. **Static.** Every construction site of a `ProgressSignalEvidence` in main was read, not grepped
   for one pattern: `loop-progress-detector.ts` emits `A`, `B`, `C`, `D`, `D-prime`, `E`, `F`, `G`,
   `H`; `loop-progress-idempotent-read.ts` emits `I`; `loop-coordinator.ts`,
   `loop-coordinator-state-helpers.ts`, `loop-blocked-file-handler.ts` and
   `loop-terminal-intent-actions.ts` all emit `BLOCKED`. `loop-nonconvergence.ts` re-emits an id
   that already fired. That is exactly the 11 keys in `PROGRESS_SIGNAL_CATALOG`.
2. **Empirical.** The real `buildLoopIssueView` was run over all **2,447** real signal-bearing
   iterations (`corpus-scan.ts`). Ids actually emitted in practice: `A`, `B`, `C`, `D-prime`, `F`,
   `G`, `H`, `I`. **Fallback headlines produced: 0.** (`D`, `E` and `BLOCKED` never fired in this
   corpus; `BLOCKED` is raised out of band and by design never lands in `progressSignals`.)

No catalog gap. This half of the check passes.

#### Real messages next to the catalog copy — one real failure, two nits

Read in the card (`problem` line and the `Why the loop thinks this` disclosure) and in the
inspector evidence column, which is where the `meaning` line actually renders
(`loop-iteration-evidence.component.ts`; the card's disclosure deliberately shows title + message
only). Live example, real iteration `iter-loop-1788370102259-60c9f3a7-0-49dc13`:

- `Repeating the same tool calls` · WATCH · "Tool grep called 65× in one iteration (provisional —
  needs confirmation next iteration)" · *"The same tool was called over and over with the same
  arguments, or the same tool set repeated across iterations."*
- `Re-reading the same content` · WATCH · "Read-only tool grep returned the same result hash 3x
  without intervening edits" · *"A read-only lookup — read, grep, ls, search — keeps returning the
  same result with no edits in between, even if the path differs."*

Those read correctly and do not repeat each other. The within-iteration `G` branch does key on
`(toolName, argsHash)`, so the meaning's "with the same arguments" is accurate for the
`called 65× in one iteration` wording too — checked in the detector rather than assumed.
`lt2-inspector-I.png`.

**The failure.** The WARN-escalation branch of `evaluateLoopProgress` pushes its escalation under
signal id **`A`**, which the catalog defines as identical-work-hash repetition. The escalation
measures no work hashes at all — it counts WARN iterations. On real iteration
`iter-loop-1778974464545-b67e72ab-3-9b1c79` the card renders:

> **STUCK** · **Repeating the same work** · *Usually fixable*
> 3 WARN iterations in last 5 — escalated to CRITICAL
> …
> **What you can do** Give a hint that names a different approach, file, or next concrete step.
> ▾ 2 reasons the loop thinks this
> · Repeating the same work — STUCK — 3 WARN iterations in last 5 — escalated to CRITICAL
> · Editing files but tests are not moving — WATCH — Tests unchanged at null pass for 4 iterations despite file writes

(That `null` is a separate, already-fixed 2026-05 detector bug — see the last subsection. It is not
what LT-591 is about.)

The agent had not repeated any work; it kept editing files while the test count stood still. The
real cause is demoted to the second row and the advice comes from the wrong signal. This happens on
**51 of the 2,447** real iterations. `lt-1400-escalation-A.png`. Filed as **LT-591**.

The existing unit test `leads with the escalated CRITICAL the detector appends after the WARNs`
asserts this exact headline with a hand-written message, which is why the gate stayed green — the
precise gap this live test exists to close.

**Second finding, same run.** On `iter-loop-1778363605952-38a768a3-2-33da80` (`A:CRITICAL` +
`F:CRITICAL`) the card's tag says **"Needs a decision"** while its bolded next step says **"Give a
hint that names a different approach…"**, and *both* `See why` and `Stop` render with the `primary`
fill. `rollupFixability` is dominated by the not-by-hint `F`, `nextStep` follows the first CRITICAL
in detector order (`A`), and `actionsFor` promotes `inspect` and `stop` independently. 3 of 2,447
iterations show the contradictory next step, 6 show two primaries. Filed as **LT-592**.

**Two copy nits, not filed.** `B`'s "File content oscillating on 1 file(s) (low ratio)" leaks the
churn-ratio grading and an unpluralised "file(s)"; the "(provisional — needs confirmation next
iteration)" suffix the confirmation phase appends to `G` and `H`
(`WEAK_PROGRESS_SIGNAL_IDS = ['G','H']`) is detector-internal vocabulary. Both still read as English next to their meaning
line, so they are recorded here rather than filed.

#### A historical message that is already fixed — checked, not filed

Ten real May-2026 iterations carry `D-prime` messages reading "Tests unchanged at **null** pass for
N iterations despite file writes". That is a raw `null` in an operator-facing line, so it was
traced rather than assumed stale: the original implementation (`ae847338`) used
`tail.slice(0, k > 0 ? k : tail.length)`, which fell back to the whole window — including its
leading `null` counts — when the first entry had no test count. Commits `3fc4c502` / `75eb9595`
(2026-05-26) replaced it with a latest-contiguous-suffix scan. `dprime-probe.ts` drives the current
exported function over five shapes and confirms it: leading nulls → `null`, all null → `null`, null
in the middle → `null`, current iteration null → `null`, measured windows → "Tests unchanged at
**7** pass …". No live defect.

---

### LT-3 — Screen-reader announcement — **OPEN (residual needs James)**

Everything that can be determined without a screen reader was verified against the live DOM.

**Politeness matches severity.** The diagnosis region is `role="alert"` for CRITICAL and
`role="status"` for WARN, both `aria-atomic="true"`. Those roles carry implicit
`aria-live="assertive"` and `aria-live="polite"`, which is why no explicit `aria-live` is present —
the component comment says so and the DOM confirms it (`ariaLive: null` with the roles set).

**The live region is scoped to the prose.** For both severities: `live.contains(details)` is
`false` and `live.contains(button)` is `false` for every action button. The region's text is the
chip word, the headline, the fixability tag, the problem, the implication and the next step, and
nothing else.

**Toggling and focusing do not disturb it.** A `MutationObserver` on the live region
(`childList` + `subtree` + `characterData` + `attributes`) recorded, for both severities:

| Action | Mutations inside the live region |
| --- | --- |
| Open `Why the loop thinks this` | **0** |
| Close it again | **0** |
| Focus each action button in turn | **0** |

A screen reader re-announces a live region when its subtree changes; nothing changes, so nothing
should be re-announced. That is the strongest statement available without listening.

**Buttons are reachable and labelled.** Real `Input.dispatchKeyEvent` Tab traversal (synthetic
`KeyboardEvent`s do not move focus) starting from the status strip:

`Inspect → Hint → Follow-up → Stop` (strip) → **`2 reasons the loop thinks this` (SUMMARY) →
`Give a hint` → `See why` → `Stop`** (card, in visual order) → composer.

All are native `<button type="button">`, `tabIndex 0`, not disabled, accessible name = visible text,
28 px tall. The disclosure is a native `<details>/<summary>`, so its expanded state is exposed
without any `aria-expanded` bookkeeping.

**Residual — needs James.** The one thing left is whether VoiceOver actually *speaks* the
diagnosis once, assertively for CRITICAL and politely for WARN. That is an auditory fact with no
read surface: macOS exposes no API for what a screen reader has just uttered, and the scripted
route (enabling "Allow VoiceOver to be controlled with AppleScript" in VoiceOver Utility, then
polling the caption panel) still starts by turning VoiceOver on, which seizes this Mac's audio,
keyboard and focus while other queue workers are running on it. It would also have nothing to read:
the dev app used here is deliberately unfocused and off-screen. This is a physical-machine /
assistive-technology operator boundary, not a technical blocker — and it is narrow, because
everything VoiceOver's behaviour depends on is already measured above.

What is left for James, once a build carrying the LT-590/LT-591 fixes is running:

1. Turn on VoiceOver (⌘F5).
2. Put a loop into a CRITICAL last iteration and confirm the diagnosis is spoken once, and
   interrupts (assertive).
3. Repeat on a WARN iteration and confirm it queues rather than interrupts (polite).
4. Expand `Why the loop thinks this`, then Tab through the card's buttons, and confirm the panel
   is not re-announced.

Steps 2–4's mechanical preconditions are all verified above; only the audio is unconfirmed.

> Plan Queue parked work: `queue/2026-09-02-loop-issue-diagnosi-4c3b38` — 1 commit(s), reason: land-blocked.

---

## Evidence run — 2026-09-24 (loops batch)

Batch id `loops`, HEAD `f04f6748`. Dev app launched isolated:
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-0924-loops npx electron . --remote-debugging-port=9713`, renderer
served from the shared `http://127.0.0.1:4567` dev bundle. `Emulation.setFocusEmulationEnabled` /
`setPageVisibilityOverride` were sent on every CDP connection before any DOM read (via
`_scratch/lt-2026-08-11/cdp-eval.mjs`), so the occluded-window trap does not apply below.

Rather than re-run a multi-hour steered loop, the six fixtures built on 2026-09-20
(`_scratch/lt-2026-09-20-loop-issue-diagnosis/fixtures.json`, copied read-only into
`_scratch/lt-2026-09-24/loops/fixtures.json`) were replayed into a real chat's `LoopStore` the same
way as the earlier run: `ng.getComponent(document.querySelector('app-loop-control')).store` with
`activeByChat` seeded directly, so the real template, `buildLoopIssueView`, SCSS and theme variables
did the rendering. Driver: `_scratch/lt-2026-09-24/loops/drive.mjs` (adapted from the 2026-09-20
copy), contrast script `_scratch/lt-2026-09-24/loops/contrast.js` (same as 2026-09-20's, patched to
parse Chromium's `color(srgb r g b)` computed-style format for `color-mix()` results, which the
original regex-only parser choked on — this build's fixed SCSS uses `color-mix()`/CSS vars, which
2026-09-20's flat hex/rgba build did not).

### LT-590 — light-theme severity contrast — CONFIRMED FIXED LIVE

`settingsStore.set('theme', 'light')` (the same reachability path as 2026-09-20), then measured the
`A-identical-critical` (CRITICAL) and `F-tokens-warn` (WARN) fixtures with the patched contrast
script, contrast = WCAG relative-luminance ratio from live computed styles:

| Element | CRITICAL | WARN | 2026-09-20 (before fix) |
| --- | --- | --- | --- |
| Severity chip | 4.80:1 | 4.84:1 | 1.75:1 / 1.41:1 |
| Fixability tag | 4.56:1 | (not separately isolated; same class) | 1.91:1 / 1.46:1 |
| Primary button (`Give a hint` / `See why`) | 14.00:1 | 14.56–19.76:1 | 1.56:1 / 1.09:1 |
| `Stop` (danger) | 6.55:1 | n/a | 1.65:1 |

All at or above the 4.5:1 AA floor for normal text (chip/tag text is 10px — the floor still applies,
and both clear it, though narrowly at ~4.6–4.8:1). Screenshot
`_scratch/lt-2026-09-24/loops/lt590-light-critical2.png` shows the STUCK chip and "Usually fixable"
tag clearly legible on the light-theme card, a stark contrast with 2026-09-20's `lt1-theme-light.png`
(chip/label effectively invisible). `.li-issue-actions button.primary`/`.danger` now resolve through
`var(--primary-color)`/`var(--error-color)` via `color-mix()` (`loop-issue-card.component.scss:2-4,
34-42,156-164`) instead of the old flat dark-theme hex.

### LT-591 — WARN-escalation signal id — CONFIRMED FIXED LIVE

Seeded the `escalation-A` fixture (the real recorded iteration `iter-loop-1778974464545-b67e72ab-3-
9b1c79`, a `D-prime:WARN` escalated to CRITICAL by the WARN-accumulation branch). Card now renders:

> **STUCK** · **Editing files but tests are not moving** · *Usually fixable*
> Tests unchanged at null pass for 4 iterations despite file writes — 3 WARN iterations in last 5 —
> escalated to CRITICAL
> **What you can do** Hint which tests should change, or whether it should run them at all.

— headlining the real D-prime signal that actually fired, not the old synthetic signal-A "Repeating
the same work". Read the fix in `src/main/orchestration/loop-progress-detector.ts:713-728`: the
escalation branch now promotes whichever WARN signal actually fired (`SIGNAL_PRIORITY`-ordered) to
CRITICAL in place and appends the escalation clause to *its own* message, rather than fabricating a
synthetic signal under id `A`. (The `null` in "unchanged at null pass" is the separate, already-fixed
2026-05 detector bug the 2026-09-20 run traced and explicitly did not file — verbatim historical
fixture data, not a live regression.)

### LT-592 — mixed-signal fixability/next-step/primary consistency — CONFIRMED FIXED LIVE

Seeded the `A-identical-critical` fixture (real `A:CRITICAL` + `F:CRITICAL`, the exact case
2026-09-20 filed). Card now renders one coherent recommendation:

- Tag: **"Usually fixable"** (was "Needs a decision")
- Next step: **"Give a hint that names a different approach, file, or next concrete step."**
  (matches the tag; 2026-09-20 also had "Give a hint…" but under the contradictory "Needs a decision"
  tag)
- Buttons: `Give a hint` (`primary`), `See why` (no `primary`), `Stop` (`danger`, no `primary`) — one
  primary action, not two.

Read the fix in `src/renderer/app/features/loop/loop-issue-diagnosis.util.ts:412-444`: `fixability`,
`nextStep` and the primary-action flags in `actionsFor()` are now all derived from the single
governing signal `worstSignals[0]` (headline still names both critical signals for context, but the
decision surface — tag/next-step/primary — no longer picks each independently).

### LT-3 — unchanged, still needs James

Nothing mechanical changed since 2026-09-20; the residual VoiceOver-audio check still needs a human
with a screen reader on this Mac. Not re-verified or re-driven this run.

### Cleanup

Theme reset to dark (`settingsStore.set('theme', 'dark')`) before moving to the next doc. No settings
were left changed; no chats/instances from this section were reused past this doc (both chats created
for it were torn down in the batch's final cleanup along with the dev app and profile).
