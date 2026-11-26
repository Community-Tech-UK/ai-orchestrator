# Harness Mobile Codex-Inspired Redesign

**Date:** 2026-07-11  
**Owner:** James  
**Status:** COMPLETE — implemented, mobile-verified, and all repository completion gates green as of 2026-07-12  
**Scope:** `apps/mobile/` renderer only

## 1. Outcome

Make Harness Mobile feel like a focused, first-party iOS control surface. The home screen follows the supplied Codex project list: projects expand in place, sessions appear directly beneath their project, each project has its own new-session action, and a thumb-reachable bottom dock provides search plus a global New action.

The New Session screen follows the supplied Codex composer: a sparse full-screen canvas, compact context selectors above a keyboard-anchored composer, and progressive disclosure for provider/model choices. Harness retains its distinct value: live agent status, approvals, remote hosts, provider selection, attachments, dictation, and control actions.

This is not a pixel-for-pixel clone. Codex patterns are adopted where they reduce navigation and cognitive load; unsupported Codex controls are not imitated.

## 2. Design Principles

1. One obvious primary action per screen.
2. Put new-session actions next to the folder or context they affect.
3. Prefer progressive disclosure over displaying every provider and model choice.
4. Keep Harness-specific state visible but quiet until it needs attention.
5. Use native-feeling iOS spacing, type, safe areas, and interaction feedback.
6. Use semantic tokens and one monochrome SVG icon language; do not use emoji or font glyphs as structural icons.
7. Every interactive target is at least 44 by 44 points and has an accessible name and pressed, focused, and disabled state.

## 3. Shared Visual System

The existing true-black foundation remains. Shared styles will define:

- Background and surfaces: true black app background, `#1c1c1e` primary raised surface, and `#2c2c2e` secondary surface.
- Text: white primary text and iOS secondary grey, with semantic green, amber, red, blue, and loop-purple state colours.
- Type: SF/system typography with a restrained scale for navigation title, section title, row title, metadata, and captions.
- Spacing: a 4/8-point rhythm with 20-point phone gutters, 52-56-point rows, and generous section separation.
- Shape: circular 44-point header controls, 16-20-point sheets/composers, and pill-shaped primary actions.
- Motion: 150-250ms opacity/transform transitions, immediate press feedback, and reduced-motion support.
- Icons: a reusable inline-SVG icon component or small icon set with consistent 1.75-2px rounded strokes.

The visual primitives should be reusable by Hosts, Projects, Sessions, New Session, Conversation, History, Approval, and model-selection sheets. No new UI dependency will be added.

## 4. Home / Projects Interaction

### Header

- Left: circular menu button opens or navigates to host management.
- Centre: `Harness` with the active host and connectivity indicator below it.
- Right: circular overflow button.
- The overflow menu contains organization mode, Pause/Resume, History, and host/connection management. Approval state may be shown as an amber-labelled item or badge when action is required.

### Project list

- The default view is grouped by project.
- Each project is a flat folder row with folder icon, project name, disclosure state, and a trailing compose icon.
- Tapping the folder row expands or collapses its sessions in place.
- Tapping compose opens New Session with that directory preselected.
- Projects with no sessions still appear and can create a session without navigating through an empty intermediate screen.
- Expanded state is local UI state and should remain stable while live snapshots update.

### Inline sessions

- Sessions render directly below their project with a small visual indent.
- Each row prioritizes the session name; provider/model metadata appears only when useful.
- Busy work uses a restrained progress indicator. Awaiting approval uses amber iconography and text. Errors use red. Unread completion uses the existing blue-dot semantics.
- Live sessions route to Conversation. Persisted sessions route to read-only History Detail. Existing routing behavior remains intact.
- The separate Sessions route remains unchanged for deep links and compatibility, but it is no longer the primary browse path.

### Bottom dock

- A safe-area-aware floating dock contains a Search Sessions field and a white New button.
- Search filters projects and sessions locally by project name, session name, provider, and model. Matching sessions expand their project automatically for the filtered view without mutating the user's saved disclosure state.
- Global New opens the same New Session screen without a preset directory.
- Content receives sufficient bottom inset so the dock never obscures the final row.

### Alternate organization mode

- Chronological mode remains available from the overflow menu.
- It uses the same session-row component and bottom dock, avoiding a second visual language.

## 5. New Session Interaction

### Layout

- Full-screen true-black canvas with a circular back button.
- The upper portion intentionally remains quiet.
- Context selectors sit above the composer and move upward naturally when the keyboard opens.
- The composer remains above the keyboard and bottom safe area without nested scrolling or viewport jumps.

### Context selectors

The selectors are:

1. Active Harness host. Selecting it opens the existing Hosts screen.
2. Working directory. A project-triggered session arrives preselected; global New opens the recent-directory sheet.
3. Provider/execution target. Defaults to Auto and opens a compact provider sheet.
4. Model and reasoning summary. Opens the existing model sheet for model selection; reasoning remains a read-only host-resolved value from the session plan.

Harness will not display Codex's branch or `Work locally` controls unless the existing creation contract genuinely supports equivalent behaviour. No decorative or non-functional selectors will be added.

### Composer

- A multi-line `Ask Harness` field auto-focuses when a directory is already selected and grows to a sensible maximum height. Global New presents the directory chooser first, then focuses the composer after selection.
- Toolbar actions: add image, session settings, resolved model/reasoning summary, dictation, and circular send/start.
- Image thumbnails appear as removable attachments without displacing the primary toolbar.
- Start is disabled until a working directory is selected. An empty first prompt remains allowed if the current runtime contract permits it.
- Sending provides immediate pressed/loading feedback and prevents duplicate creation.
- Draft persistence, attachment conversion, dictation, host-side session-plan resolution, and navigation to the created conversation remain unchanged.

### Sheets

- Directory, provider, and model choices use bottom sheets with clear titles, selected states, dismissal affordances, and 44-point rows.
- Advanced choices do not occupy the main canvas.
- Unsaved composer text survives sheet dismissal and app eviction through the existing draft store.

## 6. Remaining Screens

Hosts, Add Host, Conversation, History, History Detail, Approval, Lock, and model selection receive shared typography, icons, spacing, surfaces, and touch states. Their information architecture remains unchanged unless a current interaction prevents the shared system from working.

Specific cleanup includes:

- Replace structural emoji/glyph icons.
- Normalize circular header controls and back buttons.
- Standardize empty, loading, disconnected, and error states.
- Ensure fixed conversation controls and approval sheets respect safe-area insets.
- Keep approval actions visually dominant and destructive actions spatially separated.

## 7. Component Boundaries

Implementation should introduce small presentational primitives rather than duplicating inline CSS:

- `MobileIconComponent`: known SVG icons with accessible decorative/label handling.
- `MobileHeaderComponent`: back/menu, centred title/subtitle, and trailing action slots.
- `SessionRowComponent`: one row contract for live and history sessions.
- `BottomDockComponent`: search plus primary action.
- `ContextSelectorComponent`: icon, label/value, selected/disabled state.
- Existing `ModelSheetComponent` is restyled and reused rather than replaced unless its current API blocks the design.

Feature components continue to own routing, gateway calls, signals, and state derivation. Shared components remain presentational and do not inject `GatewayClient` or `Router`.

## 8. Data Flow and State

1. `GatewayClient` remains the source for snapshots, prompts, pause state, history, model catalogue, and session-plan resolution.
2. `ProjectsComponent` continues merging live projects, persisted history, and recent directories, then derives expandable project/session view models.
3. Disclosure state and search query remain local signals. Gateway updates reconcile rows by stable project/session IDs without resetting disclosure state.
4. Per-project compose routes to `/new-session?dir=<project path>`; global New routes without `dir`.
5. `NewSessionComponent` retains the existing create payload and services. UI sheets write to the same `selectedDir`, `provider`, `model`, attachment, and prompt signals.
6. Successful creation navigates to the existing Conversation route. Failures leave the draft and selections intact.

## 9. Error, Loading, and Offline Behaviour

- Offline with cached data: show cached projects/sessions with a quiet disconnected indicator; creation controls are disabled with a recovery explanation.
- Offline without data: show a focused connection state and host-management action.
- Recent-directory failure: keep a preset directory usable; otherwise show retry plus guidance to open a directory on the host.
- Model/session-plan failure: retain Auto/default selection, label resolution as unavailable, and allow retry without discarding the draft.
- Session creation failure: display cause and recovery near the composer; restore the send action and preserve all input.
- Live updates must not move a row under the user's finger during an active press or reset expanded projects.

## 10. Accessibility and Mobile Behaviour

- All icon-only controls have explicit `aria-label` values.
- Dynamic status includes text or an accessible label; colour is never the only indicator.
- Focus order follows the visual hierarchy, and sheets return focus to their trigger.
- Inputs retain a 16px minimum font size to avoid iOS zoom.
- Layout is checked at 375px and 393px widths, phone landscape, large text, and reduced motion.
- Keyboard opening, safe-area changes, and the bottom dock/composer must not hide content or create horizontal scrolling.

## 11. Verification

Targeted tests will cover:

- Project/session view-model merging, disclosure stability, search filtering, and session routing.
- Per-project and global New route parameters.
- New Session selector state, sheet choices, preserved drafts, and create payload compatibility.
- Disabled/loading/error behaviour and accessible labels.

Runtime checks will cover:

- Browser rendering at 375x812 and 393x852.
- Home, search, project expansion, per-project New, global New, provider/model sheet, keyboard composer, and creation-error recovery.
- iOS Simulator layout when the native project can run without the MLKit simulator limitation; otherwise the browser viewport plus a current device build is the explicit limitation.
- Mobile package typecheck, lint, tests, and production build.
- Because this is a multi-file change, the root canonical TypeScript, lint, LOC, and full test gates will also run before completion is claimed.

## 12. Non-Goals

- Rebuilding the desktop renderer on mobile.
- Adding a mobile filesystem browser.
- Adding unsupported worktree, branch, or local/remote execution controls.
- Changing gateway authentication, pairing, APNs, or transport behaviour.
- Installing a UI or icon package.
- Replacing the existing conversation transcript or approval domain logic.

## 13. Implementation Verification

The renderer redesign is implemented across the approved `apps/mobile/` scope.

Current mobile-package evidence:

- `../../node_modules/.bin/vitest run --config vitest.config.ts`: 17 files and 80 tests passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- Browser runtime checks passed at 375x812, 393x852, and 852x393 with no horizontal overflow. The checks covered live and offline Projects, search, project disclosure, per-project and global New, directory/provider/model sheets, draft preservation, Conversation, History, History Detail, Approval, reduced motion, and enlarged root text.
- The generic iOS Simulator build passed, but produced an x86_64-only app. Installation on an Apple-silicon iPhone 17 Pro simulator failed with `Failed to find matching arch`, matching the tracked MLKit simulator limitation.

Repository-wide results (re-run 2026-07-12 after the unrelated blockers were fixed):

- `npx tsc --noEmit`: passed.
- `npx tsc --noEmit -p tsconfig.spec.json`: passed.
- `npx tsc --noEmit -p tsconfig.electron.json`: passed.
- `npm run lint`: passed.
- `npm run check:ts-max-loc`: passed (the previously blocking over-limit files were brought back under their ceilings).
- Full default Vitest suite: all 1313 spec files pass (run file-complete via a resumable runner equivalent to `npm run test:quiet`; the two previously failing unrelated specs — the model-token guard allowlist after the settings-migrations split, and the RLM maintenance store's critical-dismissal rule — were fixed, not skipped).

Mobile-package gates re-confirmed the same day: 17 files / 80 tests passed, `npm run typecheck` passed, `npm run lint` passed, `npm run build` passed.

With every canonical repository gate green, this spec is renamed `_completed`.
