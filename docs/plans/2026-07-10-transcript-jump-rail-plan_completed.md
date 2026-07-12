# Transcript Jump Rail — Codex-style "jump to messages" for the main session window

**Date:** 2026-07-10
**Status:** IMPLEMENTED & verified 2026-07-10 (all phases; real-UI check done in the dev app via seeded stores — see `_scratch/jump-rail-shots/`). The two residual manual checks (live streaming marker shifting, and "Load earlier messages" re-layout with real on-disk history) are deferred live checks recorded in [the live-test plan](./2026-07-10-transcript-jump-rail-plan_livetest.md) per the Live-Test Deferral policy; unit specs cover both code paths and all canonical gates passed 2026-07-12.
**Requested by:** James — "this left hand 'jump to messages' thing in codex is ace, please implement it for the main session window"

## 1. What we're building

A slim vertical rail on the left edge of the main session transcript, mirroring
Codex's left-hand message navigator:

- One tick mark per **user message**, positioned proportionally to where that
  message sits in the full scrollable transcript.
- A subtle indicator showing the current viewport's position/extent in the
  conversation.
- **Hover** on a tick → floating preview card anchored to the rail showing the
  user prompt (truncated) plus the first lines of the assistant's reply
  (matches the Codex reference screenshot).
- **Click** on a tick → smooth-scroll the transcript to that message and flash
  a brief highlight on it.
- Rail is quiet by default (thin ticks) and grows/brightens on rail hover.
- Hidden entirely when there are fewer than 3 user messages or the transcript
  doesn't overflow (nothing to navigate).

Because `ChatDetailComponent` (chats feature) reuses `OutputStreamComponent`,
chat mode gets the rail for free.

## 2. Verified architecture facts (all read directly, 2026-07-10)

These were confirmed by reading the code, not inferred:

1. **The transcript is NOT virtualized.** `output-stream.component.html:36-40`
   renders a plain `@for (item of visibleItems(); track item.id)` — every
   display item is a top-level `<div class="transcript-item" [attr.data-item-index]="i">`
   inside the scroll container `<div class="output-stream" #container>`
   (`output-stream.component.html:20`). All rows are in the DOM, so
   `offsetTop` measurement and direct scroll-to work on any message.
2. **User messages are always top-level display items.** `isWorkItem()` at
   `display-item-processor.service.ts:458-465` only treats thought-groups,
   tool-groups, and error/tool messages as work items; only work items get
   wrapped into `work-cycle` containers (`wrapForDisplay()`, lines 568-599).
   A `message` item with `message.type === 'user'` therefore always renders
   as its own `.transcript-item`.
3. **Stable IDs exist.** `OutputMessage.id` is stable
   (`instance.types.ts:60-74`); `DisplayItem.id` is stable and used as the
   `@for` track key. Rows currently expose only `data-item-index` (positional),
   not the ID — we will add `data-item-id` for anchoring (HTML-only change).
4. **Scroll plumbing already exists.** `OutputScrollService` owns the scroll
   listener (`output-stream.component.ts:527-545`), per-instance scroll
   restore lives in effects at lines 300-426, auto-scroll-to-bottom at
   429-449, and `scrollToTop/scrollToBottom` buttons are absolutely positioned
   overlays inside the component (`output-stream.component.html:312-328`,
   SCSS 461-497). `:host` is `position: relative; display: flex; height: 100%`
   (`output-stream.component.scss:1-6`) — an absolutely positioned left rail
   anchors cleanly to the host.
5. **Older-message lazy loading changes the content above the fold.**
   `loadOlderMessages()` (`output-stream.component.ts:550-627`) prepends up to
   200 messages and compensates `scrollTop`; `olderMessagesHiddenCount` tracks
   messages still on disk. Rail markers must recompute when items/offsets
   change, and the rail only represents *loaded* messages.
6. **LOC ceiling is a hard constraint.** `scripts/check-ts-max-loc.ts:227`
   allowlists `output-stream.component.ts` at exactly **1266 lines — its
   current size**. The ceiling "must never grow" (script header, line 59).
   Any net TS additions to this file must be offset by extraction. The gate
   applies to `.ts` only; `.html`/`.scss` changes are free.
7. **Precedents to imitate:** `TranscriptFindController`
   (`transcript-find-controller.ts`, 264 lines) is a plain class instantiated
   by the component with callback deps — the model for our controller.
   `transcript-find-dom.ts` shows the house style for pure DOM helpers with
   jsdom specs. The find feature also shows the highlight-active-match CSS
   pattern we'll reuse for the post-jump flash.

## 3. Design decisions

- **New standalone component** `TranscriptJumpRailComponent` in
  `src/renderer/app/features/instance-detail/`, single-file with inline
  template (like `transcript-find-bar.component.ts`), `OnPush`, signals.
  Rendered inside `output-stream.component.html` as an absolutely positioned
  overlay on the host's left edge (same containment as the scroll buttons).
- **Anchor on user messages only** (Codex behaviour). A marker =
  `{ itemId, messageId, promptExcerpt, replyExcerpt, ratio }` where `ratio` is
  `anchorEl.offsetTop / scrollContainer.scrollHeight`, mapped to rail pixels.
- **Pure logic lives in a helper module** `transcript-jump-rail.markers.ts`:
  - `collectJumpTargets(items)` — walk top-level display items, pick
    user messages, pair each with the following assistant content (the next
    top-level `thought-group` response / assistant `message`; skip
    work-cycles' internals) to build prompt+reply excerpts (plain text,
    ~160 chars, strip markdown via existing content, not innerHTML).
  - `computeMarkerLayout(targets, measuredOffsets, scrollHeight, railHeight)`
    — proportional positions with a minimum 6px separation clamp.
  - `activeMarkerIndex(markers, scrollTop, viewportHeight)` — which marker is
    currently at/above the viewport top (for highlighting).
  These are pure and fully unit-testable without a component fixture.
- **Measurement strategy:** the component receives the viewport element
  (`container()?.nativeElement` passed as an input from the template) and the
  `visibleItems()` array. It measures anchor rows by
  `viewport.querySelector('[data-item-id="…"]')` inside a rAF, and recomputes
  on: (a) items array identity change (effect — `visibleItems()` is already
  reference-stabilised, see `output-stream.component.ts:277-283`, so this
  fires only on real changes), (b) a `ResizeObserver` on the viewport's
  content (catches streaming growth, collapse/expand, window resize), and
  (c) viewport `scroll` events (passive listener, rAF-throttled) for the
  viewport indicator + active tick only (no re-measure on scroll).
- **Jump behaviour:** `viewport.scrollTo({ top: anchorTop - 12, behavior: 'smooth' })`,
  then add a temporary `jump-flash` class to the anchor row (CSS animation,
  removed on `animationend`). Before jumping, set nothing on the component's
  scroll state — the existing `OutputScrollService` listener will observe the
  programmatic scroll and correctly update `userScrolledUp` /
  button visibility / saved position, exactly as it does for the existing
  scroll-to-top/bottom buttons.
- **Hover preview:** rendered by the rail component itself as an absolutely
  positioned card to the right of the rail (inside the host, so it overlays
  the transcript like Codex). Shows the prompt excerpt bold-ish + reply
  excerpt dimmed, mirroring the screenshot. Pointer-events on the card kept
  off (it's a peek, not a click target) to avoid hover-flicker; a short
  show/hide delay (~120ms) prevents strobing while moving along the rail.
- **Layout accommodation:** when the rail is visible, `.output-stream` gets
  extra left padding (CSS class toggled by an `@if` wrapper or `:has()`),
  e.g. `padding-left: 18px`, so ticks never overlap text. Current left
  padding is only 4px (`output-stream.component.scss:15`).
- **Older messages on disk:** when `hasOlderMessages()` is true, show a small
  "•••" cap at the top of the rail; clicking it triggers the existing
  `loadOlderMessages()` (passed in as a callback input). This is honest about
  the rail representing only loaded history.
- **No new settings** in v1. Visibility heuristic (≥3 user messages AND
  scrollable overflow) keeps it out of the way for short sessions. A display
  setting can follow if James wants one.

## 4. LOC-budget strategy (blocking constraint)

`output-stream.component.ts` may not exceed 1266 lines. Wiring the rail needs
roughly: 1 import, 1 `imports:` array entry, ~6-10 lines of template-facing
surface (a computed for `hasOlderMessages`/loader callback is already there;
we mostly pass existing members). Offset by extracting the self-contained
markdown LRU cache (`renderMarkdownContent` + cache fields,
`output-stream.component.ts:1220-1256`, ~40 lines) into
`output-stream-markdown-cache.ts` with a thin call site. Net change must be
≤ 0 lines; **do not raise the allowlist ceiling.**

## 5. Implementation phases

### Phase 1 — pure logic + anchoring attribute
1. Add `[attr.data-item-id]="item.id"` to the `.transcript-item` div
   (`output-stream.component.html:37`). HTML-only.
2. Create `transcript-jump-rail.markers.ts` (pure functions from §3) +
   `transcript-jump-rail.markers.spec.ts` covering: user-message extraction
   incl. skipping work-cycles/tool-groups; prompt/reply pairing incl.
   "user message is last item" (no reply yet); excerpt truncation; layout
   min-separation clamp; active-index math at top/bottom edges; empty/1-user
   sessions producing no markers.
3. Targeted gate: `npm run test:quiet -- src/renderer/app/features/instance-detail/transcript-jump-rail.markers.spec.ts`.

### Phase 2 — extraction to free LOC headroom
4. Extract the markdown LRU cache into `output-stream-markdown-cache.ts`
   (class `MarkdownRenderCache`, constructor-injected render fn + perf
   recorder callbacks). Update `output-stream.component.ts` call site.
   Existing behaviour unchanged; add a small spec for LRU eviction +
   `MAX_CACHEABLE_LENGTH` skip (logic previously untested).
5. Gate: `npx tsc --noEmit`, `npm run check:ts-max-loc`, targeted specs
   (`output-stream` specs still green).

### Phase 3 — the rail component
6. Create `transcript-jump-rail.component.ts` (standalone, inline template,
   `OnPush`, signals; < 400 lines). Inputs: `items` (RenderedDisplayItem[]),
   `viewport` (HTMLElement | null), `hasOlderMessages`, plus
   `loadOlder = output<void>()` and `jumped = output<string>()` if the parent
   ever needs it. Internals per §3: measurement effect + ResizeObserver +
   passive scroll listener (all cleaned up via `DestroyRef`), hover state,
   preview card, click-to-jump + flash-class application.
7. Wire into `output-stream.component.html` (render the rail inside the
   `@else` branch next to `#container`; add the padding-left rule and
   `jump-flash` animation to `output-stream.component.scss`).
8. Component spec (`transcript-jump-rail.component.spec.ts`, jsdom, follow
   `transcript-find-dom.spec.ts` style): markers render for N user messages;
   click calls `viewport.scrollTo` with the anchor's offset; hidden below
   thresholds; ResizeObserver/scroll listeners detached on destroy.

### Phase 4 — verification
9. Canonical checklist: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`,
   `npm run lint`, `npm run check:ts-max-loc`, `npm run test:quiet`.
10. **Real-UI check (required):** `npm run dev`, open a long session and
    verify: ticks appear and track user messages; hover previews match the
    right prompt/reply; click jumps + flashes; viewport indicator tracks
    scrolling; streaming a new turn shifts markers without jank; "Load
    earlier messages" (both button and rail "•••") re-lays-out markers and
    keeps scroll position; instance switching restores correctly (no
    regression to the scroll-restore machinery — this is the riskiest
    adjacency, see §6); chat mode still renders. Check a session with 1-2
    user messages shows no rail.

## 6. Risks / what could break

- **Scroll-restore machinery** (`output-stream.component.ts:300-426`) is
  subtle and battle-scarred (see comments about auto-clamp corruption). The
  rail must never write `scrollTop` outside an explicit user click, and the
  click path deliberately reuses the same programmatic-scroll shape as the
  existing buttons so the listener semantics stay identical. Do not touch the
  restore effects.
- **Streaming perf:** measurement runs on item-change + resize only, inside
  rAF, and reads `offsetTop` (layout, no style flush loops). Keep the
  per-recompute work O(user messages), not O(DOM nodes).
- **`visibleItems` filtering:** tool-call visibility toggles change item
  composition; markers recompute from the same `visibleItems()` the template
  renders, so they can't drift from the DOM.
- **Bottom-anchored short transcripts:** `.transcript-item:first-child { margin-top: auto }`
  (SCSS:26-28) — offsetTop still measures correctly, but the no-overflow
  visibility check must use `scrollHeight > clientHeight`, not message count
  alone.
- **LOC gate:** Phase 2 must land before Phase 3 wiring, or the gate fails.

## 7. Out of scope (v1)

- Ticks for assistant/tool/system items or find-match ticks on the rail.
- Persisting rail hover/expansion state; user setting to disable the rail.
- Representing on-disk (unloaded) history as proportional rail space.
- Mobile app parity.
