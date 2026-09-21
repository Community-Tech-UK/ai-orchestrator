# Harness mobile: design fixes and enhancements plan

**Status:** Implementation complete, 15 September 2026. James approved all nine Wave 1–2 workstreams; all agent-runnable checks and the second fresh completion gate passed with no unresolved actionable findings. Native device validation remains pending in the linked live-test checklist. This document remains untracked and uncommitted.

**Date:** 15 September 2026  
**Owner:** James  
**Scope:** The nine approved Wave 1–2 workstreams in sections 3–11 for `apps/mobile`, including the gateway contract for attachment-safe queue recovery. Optional Wave 3 features are outside this implementation.  
**Goal:** Make it easy to see what needs attention, answer an agent, read its work and start the next task from a phone.

**Architecture:** Retain the standalone Angular/Capacitor app, signal-based stores, shared mobile components and current gateway. Put reusable presentation and interaction behavior in `shared/`, host-scoped UI state in `core/`, and route-specific behavior in `features/`. Extend a gateway contract only where the experience needs data it cannot currently provide.

**Tech stack:** Angular 22, TypeScript, Capacitor 7, SCSS, REST/WebSocket gateway and Vitest. No new UI library is proposed.

**Design brief:** This document contains the original review, approved direction and verified implementation record. It is a follow-up to the closed July mobile redesign. Implementation ownership and repair history are recorded in the task ledger linked below.

## 1. Recommendation and review evidence

Keep the existing dark, project-first design. Improve approval reliability and everyday interactions first, then make session information easier to scan and unify the remaining screens. The biggest problems are not a missing theme or icon set: they are interrupted answers, lost navigation context, hidden status and inconsistent presentation between live and past conversations.

### Original audit baseline

- Source and relevant tests for Hosts, Pairing, Projects, Sessions, Conversation, New Session, History, History Detail, Approvals, shared controls and their state/services.
- Current architecture and mobile design documents, including `docs/mobile-app/codex-visual-reference.md` and the July redesign. Existing All/Active filters, provider Continue, timestamps, model/reasoning selection, draft text persistence, code copying and reduced-motion styling are already implemented and should be retained.
- Twelve rendered preview states, primarily at **390 × 844 CSS pixels**, plus Projects at **375 × 812**. These use the current Angular app with clearly synthetic sessions and stubbed read APIs, not a reimplementation of the UI.
- Two interaction defects reproduced through the real components: a same-ID snapshot clears a typed approval answer; returning to a dismissed prompt opens its conversation without reopening the decision.

**Evidence location:** `_scratch/mobile-design-review-2026-09-15/`. The capture script, `runtime-evidence.json` and numbered PNGs are disposable local evidence. The HTML review embeds selected screenshots so they remain available inside the review artifact.

**Limits:** This is not a test of the installed iPhone build, native keyboard, Face ID, push delivery, photo picker, dictation or VoiceOver. Browser capability checks hide some native controls. Their absence from these screenshots is expected. Windows Browser Gateway was preflighted successfully, but its Chrome could not load the development preview through the LAN or Tailscale address; localhost returned HTTP 200. Local Gateway also timed out, so a headless local Chromium preview was used. No real host was paired and no real agent command was sent.

**Existing work:** Mobile changes adding hibernated sessions to Active were already present and have been preserved. Concurrent provider-account work is outside this task. The original review created documentation and ignored evidence; James then approved implementation. This task creates no branch/worktree and does not stage, commit or push changes.

**Reading the evidence below:** Findings and source line numbers under “Original audit evidence” describe the pre-implementation app. Current implementation and verification are recorded in section 13. Device checks are tracked in [the live-test checklist](2026-09-15-mobile-design-improvements_livetest.md).

### What is working

The black surfaces, system type, restrained outline icons and white primary buttons form a coherent base. Project disclosure and per-project New actions are useful. The bottom search/New dock is easy to reach. Live conversation text is readable, tool activity is collapsed, drafts already survive common navigation, and the transcript has touch-aware scrolling with a New output control. Keep these strengths.

### Element-by-element design assessment

| Element | Finding | Direction |
|---|---|---|
| Icons | Shared outline icons are coherent. Warning/error symbols often carry the visible session status alone; tiny Copy controls are difficult targets. | Retain the set; add short status words and enlarge interactive areas without enlarging every glyph. |
| Photography/illustration | No decorative photography is needed for this control app. Images are user attachments. | Spend design effort on content and states; do not add decorative artwork to empty space. |
| Color | Most screens use the restrained dark palette. History changes user messages to bright blue and puts assistant text in cards, unlike the live transcript. | Use the same transcript tokens in both views; reserve accent colors for actions and meaningful states. |
| Typography | Session names clip on narrow rows; the conversation subtitle clips activity/model/context. Metadata is often small. | Give titles room, use concise status text and move secondary details into an accessible details surface. |
| Spacing/layout | Project rows and dock are well structured. New Session repeats configuration in context rows and toolbar. Pairing presents a long technical form. | Keep the overall rhythm; consolidate configuration and progressively disclose manual setup. |
| Interaction/coherence | Approval state, modal behavior, back navigation and pending/error feedback vary between screens. | Establish shared interaction rules and test them through the rendered app. |

## 2. Visual direction

### Recommended: refine the current dark iOS design

- Keep `#000000` background, `#1c1c1e` raised surfaces, `#2c2c2e` secondary surfaces, white primary text and a clearly differentiated secondary text token.
- Retain green for connection/healthy state, amber for attention, red for failure and blue for action/unread state. Status must also have words or an accessible description.
- Keep 20px phone gutters, a 4/8px spacing rhythm and 44px minimum control areas under the existing app contract. Use approximately 17px body/row text, 13–15px supporting text and 22–28px page headings where space permits. Treat these as design targets to validate with larger text.
- Keep flat project/session rows. Add a second line or a two-line title where it resolves truncation; do not turn every row into a card.
- Use one neutral user bubble style and one assistant text style in both live and history transcripts. Keep Copy visible and reachable on touch devices.
- Keep motion brief and honor reduced motion. A visible grabber should either support the indicated gesture or be replaced with an explicit Close/Done affordance.

Two alternatives were considered: an activity-first home with permanent navigation tabs would make a larger change to the established project workflow; a light/system appearance would help a different viewing context but requires a full token and contrast pass. Both are later enhancements. The recommended first release keeps James's existing navigation model.

## 3. First: make approvals dependable and easy to return to

**Priority:** P1 / first release. **Effort:** M. **Type:** reproduced defects plus UX enhancement.

**Original audit evidence:** `app.component.ts:49` chooses the newest unsuppressed request. `approval-sheet.component.ts:312` resets answers and scope whenever its prompt input updates. `GatewayClient.handleEvent` replaces prompt objects on a snapshot (`gateway-client.service.ts:214`). In the rendered preview, the text “Keep this answer while updates arrive” became empty after a snapshot containing the same prompt ID. Dismissal adds an ID to the suppression set (`app.component.ts:111`); Projects' `openFirstPrompt()` only navigates (`projects.component.ts:433`). The preview then had one pending request and no approval sheet.

**Design and behavior:**

- [x] Add a persistent, conditional **Needs you · N** entry near the Projects heading and a request entry in the relevant conversation. Later dismisses presentation while keeping the request available.
- [x] Use a small host-scoped approval presentation store keyed by request identity. Keep the selected request stable while it is being answered. New requests join a visible list instead of replacing the current form. Preserve answers and scope across equivalent snapshots.
- [x] Show host, project and session title before the requested action in every approval. Permission prompts currently have no Open session action, even when the diff tells the user to open it (`approval-sheet.component.ts:36`, `:51`, `:80`). Add Open session and an actual way to inspect the full available change; do not link to another truncated label.
- [x] Add Sending feedback and one pending-decision guard per request. Keep the answer on rejection, show the scoped failure, and emit success haptics only after acknowledgement. Never transfer a pending result to another host/request.
- [x] Use clear scope labels: Once, This session and Always, with a short explanation of their existing permission meaning. Do not broaden the underlying permission scope.

**Files:** `apps/mobile/src/app/app.component.ts`; `features/approval/approval-sheet.component.ts`; `features/projects/projects.component.ts`; `features/conversation/conversation.component.{ts,html}`; proposed `core/approval-presentation.store.ts`. Paths under `features/` and `core/` here and below are relative to `apps/mobile/src/app/`.

**Acceptance:** Type an answer, deliver an equivalent snapshot and another request, then verify the answer and selected request remain intact. Later → Projects → Needs you must reopen the exact unresolved request. A delayed decision permits one submission; a rejected decision keeps its answer and retry action. Switching hosts cannot display or submit another host's request.

## 4. Make shared controls comfortable and accessible

**Priority:** P1 / first release. **Effort:** M. **Type:** source-backed interaction gaps and measured touch targets.

**Original audit evidence:** Shared sheets declare a modal dialog but implement no focus entry, containment, Escape handling or focus return (`shared/mobile-sheet.component.ts:13`). Approval duplicates that shell. Copy controls measured **59.3 × 22px** in the preview (`shared/copy-button.component.ts:46`); attachment removal is explicitly 24px in both composers. Several fields remove the focus outline. This is a gap against the app's own 44px control contract, not a claim that every such element fails WCAG.

- [x] Standardize the shared sheet header, visible Close/Done, initial focus, contained focus, background inactivity, Escape and focus return. Reuse that behavior for approvals without losing their decision-specific states.
- [x] Give Copy, image removal, queue actions and compact selectors non-overlapping 44 × 44px interactive areas. Keep their glyphs visually small.
- [x] Label the conversation textarea; restore visible keyboard focus on inputs/search; announce selected provider/model/reasoning and unread completion through the parent row's accessible name or description.
- [x] Check text/background combinations at their actual size and weight; preserve readable status text when reduced motion stops a spinner. Avoid blanket color changes before measuring the combinations.

**Files:** `shared/mobile-sheet.component.ts`, `shared/mobile-header.component.ts`, `shared/mobile-session-row.component.ts`, `shared/model-sheet.component.ts`, `shared/copy-button.component.ts`, both composer templates/styles and `apps/mobile/src/styles.scss`.

**Acceptance:** Keyboard can enter, operate and close every sheet without reaching background controls, then returns to the opener. Measured hit regions meet the app target at 375px. At 200% browser text size, decisions and Send remain reachable, with no overlap or horizontal page scrolling. VoiceOver and native text-size checks are recorded in [the live-test checklist](2026-09-15-mobile-design-improvements_livetest.md).

**Reference targets:** Apple's [Buttons guidance](https://developer.apple.com/design/human-interface-guidelines/buttons) recommends a 44 × 44pt hit region. Web [WCAG 2.2](https://www.w3.org/TR/WCAG22/) uses a different minimum target criterion with exceptions. For text, validate the applicable [contrast minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum), generally 4.5:1 for ordinary text. These are implementation checks, not a completed accessibility certification.

## 5. Make drafting and queued messages predictable

**Priority:** P1 / first release. **Effort:** M for composer; L with attachment-safe queue recovery. **Type:** source-backed behavior.

**Original audit evidence:** Conversation Return invokes send unless Shift is held (`conversation.component.ts:298`); the textarea has one row and no auto-grow implementation. The queue uses a short flattened preview and an X (`composer-queue.component.ts:25`). A failed first item intentionally blocks later items (`src/main/mobile-gateway/mobile-input-queue.ts:262`). Cancel-to-edit returns text only, even though the queued item can have attachments (`mobile-input-queue.ts:357`, `gateway-client.service.ts:463`).

- [x] Make Return insert a newline in the phone composer; retain a documented physical-keyboard send shortcut and ignore composition events. Grow the draft to a bounded height, then scroll within it.
- [x] Distinguish Sending, Queued, Stopping and Failed in visible text. Keep actionable failure messages until resolved or dismissed; reserve short-lived notices for successful transient events.
- [x] Show a compact queue count that expands to full message previews, order and blocked status. Replace ambiguous X-only recovery with **Return to draft** and **Remove** actions.
- [x] Extend cancellation/recovery to return text plus attachments for editing. Preserve an existing draft instead of silently overwriting it. Keep FIFO ordering; retry requires a deliberate backend contract and must not duplicate delivered input.

**Files:** `features/conversation/conversation.component.{ts,html,scss}`, `features/conversation/composer-queue.component.ts`, `core/gateway-client.service.ts`, `core/models.ts`, `src/main/mobile-gateway/mobile-input-queue.ts` and the mirrored gateway DTO/schema where applicable. Queue work must read the HTTP route and delivery race handling before implementation.

**Acceptance:** Write three paragraphs and use an IME without accidental send. A failed first queued message explains why the next two are waiting. Return a queued message with an image to an already nonempty draft without losing either input. A cancellation/delivery race produces a clear result and no duplicate send.

## 6. Make Projects useful at a glance

**Priority:** P1 for attention; P2 for list refinement. **Effort:** M. **Type:** observed presentation gaps and enhancement.

**Original audit evidence:** The collapsed preview shows folder names and compose icons but no busy/attention counts, although the view model has those values (`project-list.view-model.ts:67`, `projects.component.ts:195`). Session rows use icons for busy/error/approval, leave `lastActivity` unrendered and apply a fixed indent in every layout (`shared/mobile-session-row.component.ts:43`, `:80`). Long titles visibly clip. All/Active already exists and intentionally filters out terminal failures.

- [x] Add compact project summaries such as “2 running · 1 needs you”, shown only when useful. Place Needs you above the list so collapsed projects do not hide requests.
- [x] Keep All/Active semantics, including current hibernated-session work. Add a separate Needs attention view for pending approvals and failed sessions; do not silently redefine Active.
- [x] Give session names up to two lines where needed; put short status words and relative activity on a supporting line. Include provider/model only when it helps distinguish work.
- [x] Apply indentation only to sessions nested under a project. Disambiguate same-named folders with a short parent-path label.
- [x] Preserve disclosure choices. For large groups, offer a short preview plus Show all; measure a 30-project/200-session fixture before deciding whether virtualization is necessary.

**Files:** `features/projects/projects.component.{ts,scss}`, `features/projects/project-list.view-model.ts`, `features/sessions/sessions.component.ts`, `shared/mobile-session-row.component.ts`, `core/status.ts` only if genuinely needed.

**Acceptance:** Identify waiting, failed and running work without opening every project. A long session name remains identifiable at 375px. Search still finds hidden rows. Live updates retain the existing press-stability protection and do not move a row under an active finger.

## 7. Preserve the user's place when navigating

**Priority:** P1 / first release. **Effort:** M. **Type:** source-backed navigation gap.

**Original audit evidence:** Projects routes archived rows to `/history/:id`, but History Detail's Back always goes to `/history` (`project-list.view-model.ts:160`, `history-detail.component.ts:300`). Projects query, filter, organization and disclosure are initialized as component-local signals (`projects.component.ts:291`).

- [x] Record a safe originating browse route and restore host-scoped query, filter, organization, disclosure and scroll position.
- [x] Return to Projects when a session was opened there and to History when opened there. Use a sensible fallback for direct links and notification entry.
- [x] Keep draft text while navigating and make any wider draft-context persistence explicit. Do not reuse another host's selected folder, model or return position.

**Files:** `features/projects/projects.component.ts`, `features/history/history-detail.component.ts`, `features/history/history.component.ts`, `features/conversation/conversation.component.ts`, proposed `core/mobile-browse-state.store.ts`, and route helpers if needed.

**Acceptance:** Search → open live/past session → Back restores the same results and position. History → detail → Back returns to History. Cold entry, host switch and notification entry each have a safe destination. Exercise browser/device Back as well as the visible button.

## 8. Give live and past conversations one readable design

**Priority:** P2 / second release. **Effort:** M. **Type:** visually confirmed inconsistency plus enhancement.

**Original audit evidence:** The same synthetic transcript renders with neutral user bubbles and unboxed assistant text in Conversation, but bright-blue user bubbles, smaller text, role labels and assistant cards in History Detail (`history-detail.component.ts:176`). The history header always says “Past session / Read-only” (`:45`). The live header clips a string combining activity, context, model and connection (`conversation.component.ts:135`, `shared/mobile-header.component.ts:66`). A tool use/result pair is displayed as “2 tool calls”.

- [x] Share transcript presentation: typography, neutral bubble color, content width, role treatment, code/table styling and Copy placement. Preserve the read-only distinction through a clear status label and absence of a composer.
- [x] Show the actual session title/project in History Detail. Give the live header a concise activity/connection line and a details sheet for the full title, host, provider, model and context.
- [x] Keep activity collapsed by default, but use an honest label such as “2 activity entries” unless use/result pairing is available. Let users inspect full command/result/error details instead of expanding to another truncated label.
- [x] Retain touch-aware following, New output, readable long code/diffs and explicit copy actions. Do not add automatic scrolling when someone is reading older output.

**Files:** `features/conversation/conversation.component.{ts,html,scss}`, `features/history/history-detail.component.ts`, `shared/transcript-items.ts`, `shared/mobile-header.component.ts`, `apps/mobile/src/styles.scss`; extract a shared transcript component/style only to remove the confirmed duplication.

**Acceptance:** Identical messages have the same visual treatment in live and past views. The full session identity and offline state are reachable at 375px. A use/result pair is not misrepresented as two calls. Long commands, errors and tables can be inspected without horizontal page overflow.

## 9. Simplify New Session and fix its folder chooser

**Priority:** P1 for folder selection; P2 for consolidation. **Effort:** S for folder fix; M for full flow. **Type:** reproduced picker defect plus design refinement.

**Original audit evidence:** The project-origin path returns from `ngOnInit()` before loading recent folders (`new-session.component.ts:486`); opening the folder sheet only sets a flag (`:89`). The rendered sheet offered only the preset folder even when a second recent directory was available from the stubbed API. Provider/model settings repeat in the context stack and toolbar. Picking model or reasoning closes the sheet immediately (`:563`).

- [x] Keep immediate project preselection, then load recent folders on opening the chooser. Preserve the selected folder on failure and show Retry. This needs no filesystem browser.
- [x] Keep the intentionally quiet upper canvas. Consolidate host/folder context and the provider/model/reasoning summary; remove duplicate configuration affordances. Native keyboard reachability remains a deferred live check.
- [x] Let model and reasoning be chosen in one visit with Done. Preserve the existing provider Continue action. Always expose the currently selected model, including one under Other versions.
- [x] Show visible Starting feedback and errors next to Start. Keep text and selections on failure. Define host-scoped draft configuration; do not put large image blobs into Preferences as an incidental convenience.

**Files:** `features/new-session/new-session.component.{ts,scss}`, `features/new-session/new-session.presentation.ts`, `shared/model-sheet.component.ts`, `core/draft-store.ts` if configuration persistence is selected.

**Acceptance:** Project A → New → choose recent B preserves the draft and starts with B. A directory API failure leaves A usable with Retry. Model and reasoning can change before one Done action. Native attachment/dictation and keyboard reachability checks are recorded in [the live-test checklist](2026-09-15-mobile-design-improvements_livetest.md).

## 10. Make setup and connection recovery clearer

**Priority:** P2 / second release. **Effort:** M. **Type:** observed setup density and source-backed state presentation.

**Original audit evidence:** Pairing shows the connection-code textarea, host, port, token, label and TLS switch together (`features/hosts/add-host.component.ts:56`); its final action is below the initial viewport in the browser preview. Native QR is already supported. Only the active host's connection is observed; inactive host state is not established (`features/hosts/hosts.component.ts:182`). Expired-pairing explanations already exist in `core/connection-status.ts` and should be reused.

- [x] Make Scan QR and Paste connection code the primary setup paths. Put host/port/token/TLS under Manual setup. Explain prerequisites in short steps and keep the next action close to its input.
- [x] After parsing, show the proposed host/connection summary and clear validation feedback. Do not expose tokens in screenshots, debug messages or the host list.
- [x] Provide Reconnect, Pair again and Change host where appropriate, using the existing distinction between offline and pairing expired.
- [x] Label inactive hosts Selected/Not selected or Not checked rather than implying a live offline measurement. Put host removal behind a deliberate secondary action, retaining its confirmation and revoke warning.
- [x] Retain App Lock; validate native availability before revising disabled biometric copy from browser evidence.

**Files:** `features/hosts/add-host.component.ts`, `features/hosts/hosts.component.ts`, `core/connection-status.ts`, `core/pairing.ts` only if validation needs a shared result, plus existing pairing/host tests.

**Acceptance:** Pair through QR or paste without editing technical fields. Manual setup remains available. Expired pairing offers Pair again rather than generic network advice. Changing hosts retains the correct connection identity and never shows a false health result.

## 11. Make loading, errors and history actions explicit

**Priority:** P1 for failed-operation feedback; P2 for history enhancements. **Effort:** M. **Type:** source-backed gaps.

**Original audit evidence:** Transcript fetch failures are swallowed (`gateway-client.service.ts:407`), so a connected empty transcript can say “No messages yet” without a successful load. Pause silently catches failures (`projects.component.ts:412`). History has loading/error text but no retry action. Model changes dismiss the picker before the request succeeds. Voice/image paths often suppress failure detail.

- [x] Define loading, empty, cached/offline, failed and success states for transcript/history/directory/model requests. Show Retry when retry can help; retain usable cached content and the draft.
- [x] Keep pending/error feedback with Pause/Resume and model changes. Avoid reporting success before host acknowledgement. Normalize errors so raw HTTP enums are not the user-facing explanation.
- [x] Explain unavailable/denied photo and microphone access with the next useful action. Native permission requests remain deliberate user actions.
- [x] Add searchable History with explicit live/archive labels and session identity. Offer **Start a new session in this project** with the folder preselected. Do not label this Resume: mobile restoration of archived context is not established by the current API.

**Files:** `core/gateway-client.service.ts`, `core/voice-input.service.ts`, `core/image-attachment.service.ts`, conversation/new-session/project/history components and their tests.

**Acceptance:** Failed loading cannot look like an empty conversation. Failed Pause/Resume stays visible and retryable. A selected model change reports pending/failure in context. History finds a known past session and starts related work with an explicit fresh-session action.

## 12. Delivery order and later enhancements

Effort labels are relative: S is a focused component change; M crosses a few presentation/state surfaces; L changes both mobile and gateway contracts. They are not calendar commitments.

| Wave | Deliverable | Included items | Exit condition |
|---|---|---|---|
| 1: dependable daily use | Stable/reopenable approvals, accessible controls, safe drafting, visible attention, navigation restoration and working folder picker | 3–7; folder part of 9; failure feedback part of 11 | The core scenarios below pass through real UI; no lost answer, hidden unresolved request or lost draft. |
| 2: visual consistency and less friction | Unified transcripts, consolidated New Session, guided pairing, clear connection recovery and searchable History | 8; remaining 9–11 | Side-by-side screen review, small-phone and larger-text browser checks pass. Native keyboard validation remains in the live-test checklist under the repository's deferral procedure. |
| 3: selected enhancements | Favorites/pinned projects, richer reusable session presets, system/light appearance, and a notification/activity inbox across hosts | Select individually after waves 1–2 | Each has a concrete user need and bounded contract; cross-host aggregation and persistent images need a separate design. Host-scoped draft configuration is already included in approved section 9. |

Recommended first execution sequence: **approval stability/reopening → shared sheet/control behavior → folder picker and navigation → composer/queue recovery → visible attention and errors → visual consolidation**. A read-only Needs you list can begin alongside shared controls once request identity is defined. Avoid simultaneous edits to the shared stores, running browser or same component files.

Do not add a permanent tab bar, decorative dashboard charts, generated imagery or a desktop-sized configuration surface without evidence that it improves the three core jobs: check work, answer an agent, start a task.

## 13. Verification and completion contract

### Implementation and current evidence

| Workstream | Implemented behavior | Evidence |
|---|---|---|
| 3. Approvals | Stable host/request selection and answers, Later/reopen, request context/full details, scoped pending/rejection feedback and acknowledgement haptics. | Approval store/app/sheet behavioral suites; rendered snapshot, reopening and delayed/rejected decision checks. |
| 4. Shared controls | Native dialog shell, background inactivity, focus containment/return, explicit Close/Done, visible focus and 44px control targets. | Fourteen Tab steps plus Escape/opener checks; Settings/Model dismissal; measured queue/removal controls; actual larger-text browser checks. VoiceOver remains a device check. |
| 5. Drafting and queue | Return inserts a line, bounded composer growth, visible operation states, full queue previews, image-safe recovery and delivery-claim conflict handling. | Real-store early-load teardown/successor tests; browser draft/queue recovery and sizing; backend queue race tests. |
| 6. Projects | Needs you, separate attention filter, useful project summaries, readable titles/status/activity, duplicate-folder labels and Show all. | Project view-model/behavior tests; synthetic 30-project/200-session browser fixture and held-row stability check. |
| 7. Navigation | Host-scoped browse state and safe return origins, delayed scroll restoration and host-scoped drafts. | History/Projects search and scroll restored to 3000px after delayed refresh and browser Back; host/preset tests and recreated-composer recovery. |
| 8. Transcripts | Shared live/past typography and bubbles, full session identity/details, honest activity-entry labels and full tool output. | Rendered live/history screens, transcript helper tests and escaped tool-detail path review. |
| 9. New Session | Recent-folder chooser/Retry, consolidated settings, model/reasoning Done, host-scoped configuration and safe late-result handling. | Folder/provider/model tests; actual early-load text/config recovery, photo/late-create browser checks and Settings opener return. |
| 10. Pairing | QR/paste primary paths, disclosed manual setup, masked endpoint review and distinct recovery actions/host labels. | Pairing/hosts suites and rendered code-summary/expired-pairing checks. Real QR, secure storage and device pairing remain live checks. |
| 11. States and History | Explicit load/cache/error/retry states, acknowledgement-based feedback, bounded requests, actionable native errors and searchable History. | Gateway/history/model/pause tests and browser failure/retry checks, including a 15-second unconfirmed model change with no automatic write retry. |

Latest actual-checkout verification after repairs: **324 mobile tests pass**, with mobile typecheck, lint and production build. The independent reviewer repeated those checks in an isolated dependency installation, then passed both root typechecks, lint, file-size ratchet, both production builds and the full root suite: **24,716 passed tests, one existing skipped test, 2,082 files**. Use Node **24.15.0** from `.nvmrc`; the independent root run used the supported `AIO_TEST_MAX_FORKS=4` setting.

The final source-parity record confirms all **70 task paths** are unchanged since review began and byte-identical to the tested snapshot. The earlier actual-checkout root run passed 24,709 tests across 2,081 files. The seven-test/one-file difference comes entirely from concurrent provider-account tests; this review certifies the mobile task scope, not later unrelated checkout edits. Raw command logs, structured results, source hashes and the count comparison are retained under `_scratch/mobile-completion-gate-round2/`. The passing root result is `snapshot-test-evidence/test-results.round2-electron-full.json`; actual-checkout mobile results remain under `_scratch/mobile-design-verification/`.

The first genuinely fresh final gate found early-load draft loss, two hidden focus indicators and incorrect Settings/Model focus return. These were reproduced and repaired. Further screenshot inspection repaired composer growth; real-store tests also cover early photo removal/addition. The [second fresh completion gate](../../.superpowers/sdd/2026-09-15-mobile-design-improvements_plan/completion-gate-round2.md) returned **VERDICT: PASS**, independently verifying the repairs and all nine workstreams with no unresolved actionable findings. Its separate fresh UI reviewer also returned PASS. The first failed report and all unsuccessful verifier setup runs remain available as evidence.

Browser evidence uses the actual Angular app with synthetic data. Verified widths are 375, 390 and 430px portrait plus 844px landscape. The restored three-line composer grows to 85px; long drafts stay bounded with Send reachable. The 200-row timing is a desktop Chromium fixture measurement, not an iPhone performance benchmark. Existing viewport/landmark/heading accessibility observations predate these changes; no full accessibility certification is claimed.

The self-contained [as-built screen review](../../.aio-review/2026-09-15-mobile-design-improvements-as-built.html) embeds fourteen screenshots, including the repaired screens. Its 1200px and 390px checks pass: all thirteen sections and controls work, all images load, and no overflow, script error or external request occurs. Markdown remains canonical; the HTML is an ignored render target.

### Required implementation scenarios

- [x] Approval: same-ID refresh, newer request, Later/reopen, slow response, rejection, host switch and cleared request.
- [x] Navigation: Projects search/filter/disclosure/scroll → live/history → visible and browser Back; route/direct-entry fallback and distinct host state.
- [x] Composer: three paragraphs, simulated IME/keyboard shortcut, bounded responsive growth, early-load teardown/recreation, failed send, queued images, existing draft and delivery/cancellation race.
- [x] Browse: 30 projects/200 sessions, duplicate folder names, long titles, unread completion, paused/offline/pairing expired, Active including hibernated sessions, and attention outside Active.
- [x] Browser appearance/accessibility: 375×812 and 390×844, 430px phone and 844px landscape, 200% root text, reduced motion, touch-target measurements, visible focus, modal containment/return and mocked App Lock overlay.
- [x] Error states: delayed/failed transcript, history, directories, model change, creation and Pause/Resume; preserve cached content and drafts where present.

Remaining native/human/external checks, with exact steps and expected results, are in [the pending live-test checklist](2026-09-15-mobile-design-improvements_livetest.md); no phone deployment or native success is claimed here.

Add behavioral tests for state transitions, request identity, routing and recovery. Existing source-string assertions are insufficient proof of rendered focus, keyboard behavior or preserved answers. Reproduce and verify fixes in the app before adjusting assertions to the intended behavior. Small styling-only changes need visual verification rather than tests that merely repeat CSS values.

### Commands for implementation

The mobile package is standalone. From `apps/mobile`, run `rtk npm run typecheck`, `rtk npm run lint` and `rtk npm run build`. The added `test:quiet` script invokes the root-installed Vitest runner with the mobile config, retains full logs/structured results in ignored scratch and preserves its exit code. Run `rtk proxy env NODE_OPTIONS=--no-experimental-webstorage npm run test:quiet -- --maxWorkers=2` with the pinned Node version on PATH. During development select the relevant spec file rather than running everything repeatedly.

At completion run the repository's canonical gates from the root:

```sh
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run build:main
rtk npm run build:renderer
rtk npm run test:quiet
```

Mobile build/test gates are additional to the root gates. Queue contract changes require the focused mobile-input-queue, gateway and mirrored DTO tests. Verify imports, routes and runtime wiring. Use a genuinely fresh completion reviewer with `task-completion-gate`, fix every actionable finding and repeat until PASS. Do not rename this plan `_completed` until implementation and required verification are complete; use the repository's live-test deferral procedure only for genuinely unavailable native/external checks.

### Status of this planning task

- [x] Source review and existing-work reconciliation.
- [x] Rendered preview and focused reproduction evidence.
- [x] Prioritised design plan with files, dependencies and acceptance scenarios.
- [x] Independent plan review: PASS, no unresolved actionable findings. Interactive artifact validated at 1200px and 390px: all ten embedded images load, all thirteen review sections have working controls, and no script errors, external requests or page overflow were observed.
- [x] All nine approved Wave 1–2 workstreams implemented and independently verified, subject to the explicit native live-test deferrals. Wave 3 remains individually selectable follow-up scope.

### Implementation tracking

The task ledger is `.superpowers/sdd/2026-09-15-mobile-design-improvements_plan/progress.md` (ignored working evidence). It records ownership, decisions, focused checks and review findings. Approval covers the nine concrete workstreams above, including host-scoped draft configuration; optional wave 3 enhancements are excluded.
