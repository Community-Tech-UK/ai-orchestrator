# Transcript Jump Rail Live Test

> Deferred live-validation checks for [2026-07-10-transcript-jump-rail-plan_completed.md](./2026-07-10-transcript-jump-rail-plan_completed.md).
> Prerequisites: a rebuilt/restarted dev app (`npm run dev`) with real on-disk session
> history and a provider able to stream a live turn. All code, unit tests (component +
> marker specs), typecheck, lint, LOC gate, and the seeded-store real-UI check (see
> `_scratch/jump-rail-shots/`) already passed in-loop. Rename this doc
> `_livetest_completed.md` only when both checks pass with evidence.

## Check 1: Markers shift correctly during a live streaming turn

1. Open a session with at least 3 user messages so the rail renders.
2. Send a prompt and, while the assistant is actively streaming a long reply, watch the
   left-edge rail.
3. Confirm each existing tick keeps pointing at its user message (hover previews still
   match) while the transcript grows, and the viewport indicator tracks the scroll
   position live.
4. After the turn completes, click a mid-conversation tick and confirm smooth-scroll +
   highlight land on the right message.

**Why deferred:** requires a live streaming provider turn; the dev seed data exercised
static layouts only.

## Check 2: "Load earlier messages" re-layout with real on-disk history

1. Open a session whose history is long enough that older messages are truncated behind
   the "Load earlier messages" affordance (real persisted history, not seeded stores).
2. Note the current tick positions, then load earlier messages.
3. Confirm the rail re-measures: new ticks appear for the older user messages, existing
   ticks shift proportionally, and clicking any tick (old or new) scrolls to the correct
   message.

**Why deferred:** the dev environment's on-disk history was empty; the re-layout logic is
unit-tested but the end-to-end measurement path needs real persisted transcripts.

## Evidence run — 2026-07-12

**Status: BLOCKED (0/2 checks passed).** The packaged Harness app was running and had real
provider activity, but this verification session had no permitted control surface for the
Harness desktop UI itself. Neither the live rail geometry nor the real-history "Load earlier
messages" interaction was observed. Keep both checks pending; no completion claim is made from
logs or static data because these acceptance criteria are visual and interactive.

## Evidence run — 2026-07-12 (packaged renderer via CDP)

**Status: PARTIAL (Check 1 passed; Check 2 pending).** A fresh packaged Harness session used a
real Codex provider for three short turns followed by a live 80-line streamed response. Before
streaming, the rail labels targeted ALPHA, BRAVO, and CHARLIE. During growth all three labels
remained stable, the fourth prompt appeared, and tick positions reflowed continuously as
transcript height grew from 632 to 1,673 pixels. Moving the transcript to mid-scroll changed the
viewport indicator from about 214 to 125 pixels. After completion, clicking the CHARLIE tick
landed on the CHARLIE user row and applied `jump-flash`.

The persisted-history check remains pending. The verifier opened every currently rendered
history entry, but none exposed the **Load earlier messages** affordance with rail markers. No
synthetic persistence claim is substituted for that required real on-disk pagination path.

## Evidence run — 2026-07-13 (isolated dev profile)

**Status: COMPLETE (2/2 checks passed).** Check 1 remains satisfied by the packaged live-stream
run above. For Check 2, the current dev renderer was started on a private CDP port and a copied
real on-disk archive containing 304 messages was added to the separate `harness-dev` profile.
Only the copied archive's resume cursor was cleared so the app exercised its real
replay-fallback pagination path; the production archive and profile were untouched.

Before loading earlier messages, the affordance was visible and the rail contained 46 ticks.
After activating it, the affordance disappeared and the rail re-measured to 171 ticks, including
the newly loaded earlier user rows. Clicking the first new tick landed on the original
`HOLY SHIT.` user row and applied `jump-flash`. This supplies the missing real-persistence,
re-layout, and click-target evidence.
