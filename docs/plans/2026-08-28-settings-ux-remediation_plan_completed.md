# Settings UX Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Implemented and verified 2026-09-19 (Tasks 1–8, Task 9 Steps 1, 2, 5, 6). The two live-window checks (Task 9 Steps 3–4) need a rebuilt Electron instance and are deferred to [2026-08-28-settings-ux-remediation_livetest.md](./2026-08-28-settings-ux-remediation_livetest.md).

**As-built summary (2026-09-19):** James approved building this as part of the 2026-09-18 stranded-worktree rescue follow-ups. Tasks were built in parallel against current `main` (Tasks 1–2 first, as the foundation). Deviations from the plan text, all behaviour-preserving: `settings-viewport-media.ts`, `permissions-settings-tab.types.ts`, `advanced-settings-sections.ts`, `remote-nodes-section-state.ts` and new `.html` templates were split out to stay under the 700-line LOC ratchet (no ceiling raised); Permissions and Advanced help copy lives in `help/settings-help-core.ts`, not `settings-help-system.ts` as the plan named; the shared switcher's `tabs` input accepts a readonly list (an AOT-only type error surfaced by `build:renderer`). Two real defects were found and fixed during the work: an Ecosystem effect that silently reloaded a file from disk on every keystroke, wiping unsaved edits (fixed with `untracked()`); and the Remote Nodes detail view's intra-view "Back to computers" control needed a narrow, commented exclusion in `control-surface-back-audit.spec.ts`, following that audit's existing Workboard precedent. Structural checks found no dropped IPC call or setting key across the rewritten tabs. Evidence: Settings + Help specs 41 files / 391 tests; full suite 2158 files / 25,595 tests; both typechecks, lint, LOC, `build:main`, `build:renderer`; native-title audit 0 unnamed controls; two independent fresh-eyes gates PASS. No colour-contrast tool was run.

**Goal:** Make the Settings shell and its five most overloaded tabs understandable, responsive, keyboard-accessible, and safe to operate without changing the underlying settings behaviour.

**Architecture:** Separate shell presentation from content width, add one reusable internal section switcher, and reorganise each overloaded tab around user tasks with progressive disclosure. Existing stores, IPC services, setting keys, remote-node actions, and persistence remain authoritative; this work changes information architecture and component presentation rather than domain contracts.

**Tech Stack:** Electron 40, Angular 22 standalone `OnPush` components, signals, semantic HTML/ARIA, SCSS design tokens, Vitest/Angular TestBed.

**Spec:** No separate specification was requested. This plan is the canonical implementation document for the 2026-08-28 source and screenshot audit summarised in the design baseline below.

## Global Constraints

- Work in James's current checkout. Do not create a branch or worktree.
- Do not stage or commit this active plan or any implementation unless James explicitly requests a commit.
- Preserve all existing setting keys, values, defaults, IPC calls, save timing, validation, and dangerous-action confirmation behaviour.
- Do not add a package dependency. Reuse existing Angular primitives, signals, icons, tokens, cards, segmented controls, save-state banners, and danger zones.
- Do not introduce a new visual theme. Both current light and dark themes must remain token-driven and visually coherent.
- The application-supported minimum window is 800 × 600. No Settings page may create page-level horizontal scrolling at 800px.
- At 800–1180px, contextual Help must remain reachable through an overlay drawer even though the persistent rail cannot fit.
- Keyboard users must be able to reach, identify, activate, and leave every new navigation surface. Icon-only actions require accessible names and at least a 44 × 44px hit target.
- Status and validation must never rely on colour alone. Async errors use `role="alert"`; non-blocking completion state uses `role="status"` with `aria-live="polite"`.
- Internal page navigation must not steal focus or change the selected section merely because live data changes.
- Avoid speculative backend refactors. A page may split into focused renderer components, but domain state remains with its existing store/service unless extraction is required to prevent duplicated side effects.
- Read every affected file and relevant tests in full immediately before modifying it; account for concurrent user changes in the dirty tree.

---

## 1. Design Baseline and Target Information Architecture

### Problems confirmed by the audit

| Surface | Confirmed problem | Target structure |
| --- | --- | --- |
| Settings shell | The Help pane disappears below 1180px; the navigation still consumes 236px below 900px; content width and embedded-page behaviour are conflated | Compact 56px rail plus temporary navigation overlay; Help drawer; explicit `standard`, `expanded`, and `embedded` layout modes |
| Remote Nodes | Role, server setup, offloading, pairing, credentials, security, and fleet operations share one 835-line scrolling surface | Overview, Pairing, Computers, Advanced; Computers uses list/detail |
| Permissions | Default policy, browser education, pending requests, audit, rule learning, and statistics compete in one page | Requests, Rules, Audit, Insights; pending requests get priority without hijacking an active view |
| Auxiliary Models | Everyday routing choices, endpoint diagnostics, model tiers, per-slot overrides, and test tools have equal prominence | Overview, Models, Slots, Advanced |
| Ecosystem | A full workspace resource editor is constrained like a normal settings form and renders five resource lists at once | Embedded/full-width editor; one resource category at a time; stable list/detail workspace |
| Advanced | Unrelated runtime, browser, memory, security, hook, backup, reset, guide, and roadmap content forms a catch-all page | Runtime, Security, Data; guidance moves to Help; planned/non-functional content is removed |

### Shared interaction rules

1. Internal section selectors use a shared `SettingsSectionTabsComponent` with semantic tab roles, visible selected state, arrow/Home/End keyboard movement, and associated tab panels.
2. Selecting a top-level Settings tab retains the existing URL fragment contract. Internal sections are page-local UI state; do not add route or persistence complexity in this remediation.
3. Each page chooses its initial internal section once during initialisation. Subsequent live updates may add badges or notices but must not move the user.
4. Destructive and credential-sensitive controls stay visually separated at the bottom of their relevant Advanced/Data view.
5. Long tables use a card representation at narrow widths when each row is independently actionable. Horizontal scrolling is acceptable only inside a clearly bounded data-table region, never on the page itself.

---

### Task 1: Add explicit Settings layout modes and the shared section switcher

**Files:**

- Modify: `src/renderer/app/features/settings/settings-navigation.ts`
- Modify: `src/renderer/app/features/settings/settings-navigation.spec.ts`
- Modify: `src/renderer/app/features/settings/settings.component.ts`
- Modify: `src/renderer/app/features/settings/settings.component.html`
- Modify: `src/renderer/app/features/settings/settings.component.content.scss`
- Modify: `src/renderer/app/features/settings/settings.component.spec.ts`
- Create: `src/renderer/app/features/settings/ui/settings-section-tabs.component.ts`
- Create: `src/renderer/app/features/settings/ui/settings-section-tabs.component.scss`
- Create: `src/renderer/app/features/settings/ui/settings-section-tabs.component.spec.ts`

**Interfaces:**

```ts
export type SettingsLayoutMode = 'standard' | 'expanded' | 'embedded';

export interface SettingsSectionTab {
  id: string;
  label: string;
  panelId: string;
  badge?: string;
}
```

`SettingsNavItem.layout` defaults to `standard`. `expanded` keeps the Settings heading and normal content padding but permits a 1120px content measure. `embedded` keeps the current edge-to-edge, full-height behaviour used by feature pages.

`SettingsSectionTabsComponent` consumes `tabs`, `activeId`, and `ariaLabel`, and emits `activeIdChange`. It owns roving focus and automatically activates the focused tab for ArrowLeft, ArrowRight, Home, and End.

- [x] **Step 1: Write failing navigation-layout tests**

  Extend `settings-navigation.spec.ts` to assert that default tabs are `standard`, Remote Nodes/Permissions/Auxiliary Models are `expanded`, and Ecosystem is `embedded`. Extend `settings.component.spec.ts` to assert that `expanded` keeps the section header while `embedded` suppresses it and removes content padding.

- [x] **Step 2: Run the focused shell tests and confirm the new assertions fail**

  ```bash
  npm run test:quiet -- src/renderer/app/features/settings/settings-navigation.spec.ts src/renderer/app/features/settings/settings.component.spec.ts
  ```

  Expected: failure because layout metadata and the three-way layout state do not exist.

  **As-built:** confirmed by reverting the `layout:` markers on `NAV_ITEMS` (backup-copy diff, not `git checkout`) and re-running — 2 of 7 `settings-navigation.spec.ts` assertions failed as expected, then passed again after restoring.

- [x] **Step 3: Replace the binary `WIDE_TABS` decision with layout metadata**

  Add `layout?: SettingsLayoutMode` to `SettingsNavItem`, mark the three expanded pages and Ecosystem, and replace `isWideTab` with `layoutMode`, `isExpandedTab`, and `isEmbeddedTab` computed state. Do not change tab IDs, groups, labels, summaries, search terms, fragments, or badges.

- [x] **Step 4: Implement layout-specific shell classes**

  Keep `standard` at 840px, set `expanded` to `min(1120px, 100%)`, and preserve `embedded` edge-to-edge/full-height behaviour. Ensure the skeleton uses the active layout width. Do not suppress the section heading for `expanded` pages.

- [x] **Step 5: Write the section-switcher interaction tests**

  Cover semantic `tablist`/`tab` roles, `aria-selected`, `aria-controls`, a single `tabindex="0"`, click activation, wraparound arrows, Home/End, disabled absence, and visible focus styling.

  **As-built:** "disabled absence" is trivially satisfied — the component has no disabled-tab concept at all in this plan's scope, so there is nothing that could render a disabled tab; not separately asserted.

- [x] **Step 6: Implement `SettingsSectionTabsComponent`**

  Use signal `input()`/`output()`, `ChangeDetectionStrategy.OnPush`, native buttons, and token-driven SCSS. Keep all hit areas at least 40px high, render badges as text, and permit the strip itself to scroll without causing page-level overflow.

  **As-built:** built but not yet consumed by any page — Task 1 only requires the shared component and layout modes to exist with a correct, tested API. Remote Nodes/Permissions/Auxiliary Models (Tasks 3/5/6) are the first real callers.

- [x] **Step 7: Run the focused tests**

  ```bash
  npm run test:quiet -- src/renderer/app/features/settings/ui/settings-section-tabs.component.spec.ts src/renderer/app/features/settings/settings-navigation.spec.ts src/renderer/app/features/settings/settings.component.spec.ts
  ```

  Expected: all pass. **As-built:** ran; 4 files / 59 tests passed (this command also picks up the Task 2 assertions added to `settings.component.spec.ts` since it targets the whole file).

**Task 1 as-built summary (for Tasks 3–8 building on this):**

- `SettingsLayoutMode = 'standard' | 'expanded' | 'embedded'` and `resolveSettingsLayout(item)` live in `settings-navigation.ts:35-51,91-94`. `SettingsNavItem.layout?` defaults to `standard` when omitted — only `remote-nodes`, `permissions`, `auxiliary-models` are `expanded`; `ecosystem`, `models`, `mcp`, `hooks`, `worktrees`, `snapshots`, `archive`, `remote-config`, `doctor` are `embedded` (this is the old `WIDE_TABS` set plus `ecosystem`, which the plan explicitly calls out as newly embedded). `WIDE_TABS` and `isWideTab` are removed; nothing else in `src/` referenced them (verified by repo-wide grep).
- `SettingsComponent` exposes `layoutMode`, `isExpandedTab`, `isEmbeddedTab` (computed off `activeItem()`) in place of `isWideTab`. The template's `.settings-content`/`.settings-body`/`.settings-skeleton` now take `.expanded`/`.embedded` classes instead of a single `.wide` class; `.settings-body.expanded` caps at `min(1120px, 100%)`, `.settings-body.embedded` is `max-width: none; height: 100%` (unchanged), and the section header (`@if (!isEmbeddedTab() && activeItem(); ...)`) is suppressed only for `embedded`, never for `expanded`.
- `SettingsSectionTabsComponent` (`ui/settings-section-tabs.component.ts`) is the shared switcher for Tasks 3/5/6: `tabs: input.required<SettingsSectionTab[]>()`, `activeId: input.required<string>()`, `ariaLabel: input('Section')`, `activeIdChange: output<string>()`. It renders a `role="tablist"`/`role="tab"` strip with `aria-selected`, `aria-controls` (pointing at each tab's `panelId` — the consuming page is responsible for giving its panel that `id`), and a single roving `tabindex="0"` on the active tab. ArrowLeft/ArrowRight wrap; Home/End jump to the first/last tab; the newly-focused tab is activated immediately (no separate "focus vs. select" step) and receives DOM focus via `viewChildren` + `queueMicrotask`. Minimum tab hit height is 40px; the strip scrolls horizontally (`overflow-x: auto`) rather than ever causing page-level horizontal scroll.
- Confirmed empirically (7/7 tests passing) that this repo's vitest **can** render a signal-`input()` component with `TestBed.createComponent` + `fixture.componentRef.setInput(...)`, for an inline-template component — see `setting-row.component.spec.ts` (pre-existing, still green) and the new `settings-section-tabs.component.spec.ts`. The task brief's blanket claim that vitest cannot render `input()` components does not hold for this pattern in this repo; it may be specific to `templateUrl`-based components or another subproject. `settings-section-tabs.component.spec.ts` therefore renders the real component rather than testing the keyboard model as a bare, disconnected function.

---

### Task 2: Make the Settings navigation and Help adaptive at the minimum window width

**Files:**

- Modify: `src/renderer/app/features/settings/settings.component.ts`
- Modify: `src/renderer/app/features/settings/settings.component.html`
- Modify: `src/renderer/app/features/settings/settings.component.nav.scss`
- Modify: `src/renderer/app/features/settings/settings.component.content.scss`
- Modify: `src/renderer/app/features/settings/settings.component.shell.scss`
- Modify: `src/renderer/app/features/settings/settings.component.spec.ts`
- Modify: `src/renderer/app/shared/help/help-pane.component.scss`
- Modify: `src/renderer/app/shared/help/help-pane.component.spec.ts`

**Interfaces:**

```ts
readonly compactViewport: Signal<boolean>;       // matchMedia('(max-width: 900px)')
readonly compactNavOpen: WritableSignal<boolean>;
readonly helpDrawerOpen: WritableSignal<boolean>;
readonly effectiveNavCollapsed: Signal<boolean>;
```

The desktop `navCollapsed` and `helpCollapsed` preferences remain separately persisted. Opening or closing a compact overlay must not overwrite either desktop preference.

- [x] **Step 1: Add failing responsive-state tests**

  Stub `window.matchMedia` in `settings.component.spec.ts`. Assert that compact mode starts with a 56px-equivalent collapsed rail, the navigation toggle opens a modal-style overlay without changing `NAV_COLLAPSED_KEY`, selecting a tab closes the overlay, and Escape closes Help first, then compact navigation, before closing Settings.

- [x] **Step 2: Add failing Help drawer tests**

  Assert that a “Help & tips” button is available below the rail breakpoint, opens the existing `HelpPaneComponent` content in a labelled drawer with a backdrop, traps no focus, closes from its own button/backdrop/Escape, and leaves the persisted desktop `helpCollapsed` value unchanged.

  **As-built:** "traps no focus" means deliberately — the drawer is a lightweight dismissible panel, not a focus-trapping modal; there is no focus-trap code to test, so this is a negative property (nothing added) rather than an assertion.

- [x] **Step 3: Run focused tests and confirm failure**

  ```bash
  npm run test:quiet -- src/renderer/app/features/settings/settings.component.spec.ts src/renderer/app/shared/help/help-pane.component.spec.ts
  ```

  **As-built:** confirmed by reverting `onKeydown`'s Escape ladder to the old single-branch version (backup-copy diff, not `git checkout`) and re-running — the new "closes Help, then compact nav, then Settings on Escape" test failed as expected (1 of 40), then passed again after restoring.

- [x] **Step 4: Implement compact viewport state and cleanup**

  Register one `MediaQueryList` change listener and remove it through `DestroyRef`. In compact mode, the existing nav toggle controls `compactNavOpen`; on wider viewports it continues to control and persist `navCollapsed` exactly as today.

  **As-built:** extracted into `settings-viewport-media.ts` (`bindSettingsViewportMediaQueries()`), not left inline in `SettingsComponent` — the class was 718 lines with it inline, 18 over the repo's 700-line LOC ratchet cap (`scripts/check-ts-max-loc.ts`; the file is not on the allowlist). The extraction is behaviourally identical: it registers **two** listeners (compact-nav ≤900px and Help-drawer ≤1180px, see Step 5) and both are torn down via the same `DestroyRef`. `npm run check:ts-max-loc` passes at 684 lines.

- [x] **Step 5: Implement the overlay navigation and Help drawer**

  At widths up to 900px, keep a 56px rail in flow and position the expanded 236px navigation over content with a scrim. At widths up to 1180px, replace the hidden Help rail with a header affordance and fixed drawer. Apply `aria-expanded`, `aria-controls`, dialog labelling, and deterministic Escape order.

  **As-built:** added a `helpDrawerMode: Signal<boolean>` (mirrors `compactViewport` but for the 1180px breakpoint) — needed to decide when to show the "Help & tips" trigger and route `toggleHelp()`/Escape through the drawer instead of the desktop collapse; not in the plan's Interfaces block but required to implement this step and the Global Constraint that Help stay reachable at 800–1180px. The drawer reuses the existing `HelpPaneComponent` with a `.drawer` host class (see `help-pane.component.scss`) rather than a second content renderer, so Help content itself is defined once.

- [x] **Step 6: Verify narrow shell geometry in component styles**

  At 800px, account for the 56px rail, content gutter, scrollbar, and drawer overlay. No fixed-width child may force the Settings page beyond the viewport. Preserve current behaviour above each breakpoint.

  **As-built:** verified by inspection (no page-level `overflow-x` introduced; the compact rail, nav overlay, and Help drawer are all `position: absolute` over `.settings-page` — they never add to in-flow width) rather than a live 800×600 render, which needs the rebuilt Electron shell (Task 9 Step 3, out of scope for this pass).

- [x] **Step 7: Run focused tests**

  ```bash
  npm run test:quiet -- src/renderer/app/features/settings/settings.component.spec.ts src/renderer/app/shared/help/help-pane.component.spec.ts
  ```

  Expected: all pass. **As-built:** ran; 2 files / 45 tests passed.

**Task 2 as-built summary:**

- `SettingsComponent` gains `compactViewport`, `compactNavOpen`, `helpDrawerMode`, `helpDrawerOpen` signals (`settings.component.ts:156-168`) and `effectiveNavCollapsed = computed(() => compactViewport() ? true : navCollapsed())`. The media-query wiring itself lives in `settings-viewport-media.ts` (`bindSettingsViewportMediaQueries`, `SETTINGS_COMPACT_NAV_QUERY = '(max-width: 900px)'`, `SETTINGS_HELP_DRAWER_QUERY = '(max-width: 1180px)'`), called once from the constructor with the four signals + `DestroyRef`.
- `toggleNav()`/`toggleHelp()` branch on `compactViewport()`/`helpDrawerMode()` respectively: below the breakpoint they flip the transient `compactNavOpen`/`helpDrawerOpen` signal only; at/above it they run the pre-existing desktop persistence path unchanged (`navCollapsed`/`helpCollapsed` + `localStorage`). `selectTab()` additionally closes `compactNavOpen` when in a compact viewport. `onKeydown()`'s Escape now closes, in order: the Help drawer, then the compact-nav overlay, then Settings itself (`goBack()`), stopping propagation at whichever step it closes so at most one layer closes per key press.
- Template: a `.settings-nav-scrim` button behind the nav rail when the compact overlay is open (`compactViewport() && compactNavOpen()`); the rail itself gets `.nav-overlay-open` instead of `.nav-collapsed` while open. A "Help & tips" trigger button appears in the section header (or an `.embedded-help-bar` for embedded/no-heading tabs) whenever `helpDrawerMode()`; clicking it opens `#settings-help-drawer`, an `aside[role="dialog"][aria-modal="true"]` positioned over the page with its own scrim, hosting a second `<app-help-pane class="drawer">` bound to the same `activeHelp()`/`activeHelpStatus()` as the desktop rail.
- SCSS: `settings.component.nav.scss`'s `@media (max-width: 900px)` block now keeps `.settings-sidebar` at 56px by default and only widens `.nav-overlay-open` to 236px (absolutely positioned, `z-index: calc(var(--z-overlay) + 1)`). `settings.component.shell.scss` adds the scrim/drawer/trigger rules using the repo's existing `--z-overlay`/`--z-modal`/`--overlay-dark-medium` tokens (matching the pattern in `pause-detector-events-dialog.component.scss`) rather than new raw z-index numbers. `help-pane.component.scss`'s existing `@media (max-width: 1180px) { display: none }` rule gets a `:host(.drawer)` override so the same component renders inside the drawer at widths where the plain rail is hidden.
- Deferred to a live check (not run in this pass — needs the rebuilt Electron shell, Task 9 Step 3): actually resizing a window to 800×600/900×700/1180×800 and confirming no page-level horizontal scroll and correct focus order by eye. All four gates that can run headlessly (`npx tsc --noEmit`, `npm run test:quiet` on the focused specs, `npm run check:ts-max-loc`) pass.

---

### Task 3: Reorganise Remote Nodes into task-based sections

**Files:**

- Modify: `src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts`
- Modify: `src/renderer/app/features/settings/remote-nodes-settings-tab.component.html`
- Modify: `src/renderer/app/features/settings/remote-nodes-settings-tab.component.scss`
- Modify: `src/renderer/app/features/settings/remote-nodes-settings-tab.component.spec.ts`
- Modify: `src/renderer/app/features/settings/remote-nodes-pairing-ui.spec.ts`
- Modify: `src/renderer/app/features/settings/help/settings-help-system.ts`

**Interfaces:**

```ts
type RemoteNodesSection = 'overview' | 'pairing' | 'computers' | 'advanced';
readonly activeSection = signal<RemoteNodesSection>('overview');
readonly selectedNodeId = signal<string | null>(null);
```

Existing remote-node IPC methods, pairing-token handling, settings writes, browser automation configuration, Android configuration, repair actions, and credential redaction must not change.

- [x] **Step 1: Add failing information-architecture tests**

  Assert that the page renders four section tabs with matching tab panels and only the active panel visible. Assert that Overview includes role/server status summaries and primary actions, Pairing contains coordinator pairing plus collapsed legacy/manual pairing, Computers contains the roster, and Advanced contains editable server/offload/TLS/token controls and the danger zone.

- [x] **Step 2: Add preservation tests before moving controls**

  Extend existing specs so every existing action remains wired: start/stop server, save server configuration, issue/revoke pairing credentials, copy pairing details, regenerate the manual token, update browser/Android automation, repair a node, and revoke a node. These tests should call the same public handlers or click controls before and after the template move.

- [x] **Step 3: Run Remote Nodes specs and confirm the new IA tests fail**

  ```bash
  npm run test:quiet -- src/renderer/app/features/settings/remote-nodes-settings-tab.component.spec.ts src/renderer/app/features/settings/remote-nodes-pairing-ui.spec.ts src/renderer/app/features/settings/remote-nodes-browser-automation.spec.ts src/renderer/app/features/settings/remote-node-repair-panel.component.spec.ts src/renderer/app/features/settings/remote-node-android-config.component.spec.ts src/renderer/app/features/settings/coordinator-pairing.component.spec.ts
  ```

- [x] **Step 4: Build the Overview and Pairing views**

  Overview shows a compact status strip for computer role, server state, connected/degraded counts, and automatic offload summary. Its primary actions navigate to Pairing or Advanced. Pairing makes the normal coordinator flow dominant and puts legacy CLI/manual details in a collapsed `<details>` region with an explicit “Advanced pairing” label.

- [x] **Step 5: Move configuration and secrets to Advanced**

  Place port, host, namespace, TLS, and offload switches in a “Server and routing” card. Keep manual token controls in the existing danger-zone treatment, below normal configuration. Secret values remain masked by default and are never copied or revealed automatically.

- [x] **Step 6: Update Remote Nodes contextual Help**

  Replace long duplicated inline explanation blocks with concise, view-independent guidance in the existing help registry. Keep only local, actionable warnings inline, such as a server error or an unhealthy node.

- [x] **Step 7: Add responsive and accessibility styling**

  Section tabs remain usable at 800px, summary cards collapse without horizontal scrolling, form labels stay associated with controls, and all icon-only actions receive accessible labels and 44px hit targets.

- [x] **Step 8: Run the complete Remote Nodes focused suite**

  Use the command from Step 3. Expected: all pass.

---

### Task 4: Convert Connected Computers to a list/detail workspace

**Files:**

- Create: `src/renderer/app/features/settings/remote-node-list.component.ts`
- Create: `src/renderer/app/features/settings/remote-node-list.component.scss`
- Create: `src/renderer/app/features/settings/remote-node-list.component.spec.ts`
- Create: `src/renderer/app/features/settings/remote-node-detail.component.ts`
- Create: `src/renderer/app/features/settings/remote-node-detail.component.scss`
- Create: `src/renderer/app/features/settings/remote-node-detail.component.spec.ts`
- Modify: `src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts`
- Modify: `src/renderer/app/features/settings/remote-nodes-settings-tab.component.html`
- Modify: `src/renderer/app/features/settings/remote-nodes-settings-tab.component.scss`
- Modify: `src/renderer/app/features/settings/remote-nodes-settings-tab.component.spec.ts`

**Interfaces:**

```ts
// List
readonly nodes = input.required<readonly RemoteNodeRosterEntry[]>();
readonly selectedNodeId = input<string | null>(null);
readonly nodeSelected = output<string>();

// Detail
readonly node = input.required<RemoteNodeRosterEntry>();
readonly backRequested = output<void>();
readonly actionRequested = output<RemoteNodeDetailAction>();

type RemoteNodeDetailAction =
  | { type: 'repair'; nodeId: string }
  | { type: 'revoke'; nodeId: string }
  | { type: 'configure-browser'; nodeId: string; config: BrowserAutomationConfigInput }
  | { type: 'configure-android'; nodeId: string; config: AndroidAutomationConfigDraft }
  | { type: 'copy'; value: string; description: string };
```

Import `BrowserAutomationConfigInput` from `remote-node-ipc.service.ts` and `AndroidAutomationConfigDraft` from `remote-node-android-config.component.ts`; do not define duplicate renderer-only copies of those contracts.

- [x] **Step 1: Write failing list/detail tests**

  Cover status text, name/address/platform summary, selection state, keyboard activation, empty roster, initial selection of the first node, preservation of a still-present selection after refresh, fallback when the selected node disappears, and the narrow-layout Back action.

- [x] **Step 2: Run the new specs and confirm failure**

  ```bash
  npm run test:quiet -- src/renderer/app/features/settings/remote-node-list.component.spec.ts src/renderer/app/features/settings/remote-node-detail.component.spec.ts
  ```

- [x] **Step 3: Extract the roster and selected-node detail**

  The list shows scan-friendly health and capability summaries. The detail owns the existing capability chips, repair panel, browser automation editor, Android configuration, connection commands, and revoke action for one selected node. Keep async operations and authoritative state in the parent; child components emit typed user intents.

- [x] **Step 4: Implement responsive master/detail behaviour**

  At expanded widths, show list and detail side by side. At narrow content widths, show the list first and then the selected detail as a drill-in view with a visible Back to computers action. Do not rely on hover to expose actions.

- [x] **Step 5: Run all Remote Nodes tests**

  Run the full command from Task 3 Step 3 plus both new specs. Expected: all pass.

---

### Task 5: Split Permissions into Requests, Rules, Audit, and Insights

**Files:**

- Modify: `src/renderer/app/features/settings/permissions-settings-tab.component.ts`
- Modify: `src/renderer/app/features/settings/permissions-settings-tab.component.html`
- Modify: `src/renderer/app/features/settings/permissions-settings-tab.component.scss`
- Modify: `src/renderer/app/features/settings/permissions-settings-tab.layout.scss`
- Modify: `src/renderer/app/features/settings/permissions-settings-tab.permissions.scss`
- Modify: `src/renderer/app/features/settings/permissions-settings-tab.patterns.scss`
- Modify: `src/renderer/app/features/settings/permissions-settings-tab.stats.scss`
- Create: `src/renderer/app/features/settings/permissions-settings-tab.component.spec.ts`
- Modify: `src/renderer/app/features/settings/help/settings-help-system.ts`

**Interfaces:**

```ts
type PermissionsSection = 'requests' | 'rules' | 'audit' | 'insights';
readonly activeSection = signal<PermissionsSection>(
  this.pendingPermissions().length > 0 ? 'requests' : 'rules',
);
```

The initial section is chosen once. A later arriving permission updates the Requests badge but does not navigate away from the section the user is reading.

- [x] **Step 1: Write failing section and priority tests**

  Cover the four panels, Rules as the initial panel when the queue is empty, Requests as the initial panel when requests already exist, a live pending-count badge, and no automatic section change after initialisation.

- [x] **Step 2: Write failing accessibility and action-preservation tests**

  Cover accessible names and 44px targets for Allow/Block actions, batch scope and decision controls, keyboard operation, audit filter labelling, loading/error announcements, and the existing allow/block/rule/audit handlers.

- [x] **Step 3: Run the new focused spec and confirm failure**

  ```bash
  npm run test:quiet -- src/renderer/app/features/settings/permissions-settings-tab.component.spec.ts
  ```

- [x] **Step 4: Recompose the four views**

  Requests contains the approval queue and batch controls. Rules contains default action, preflight, suggested automatic rules, and rule analysis. Audit contains filters and decision/denial history. Insights contains the activity summary. Keep headings and panel IDs stable enough for screen-reader relationships.

- [x] **Step 5: Move browser education into contextual Help**

  Remove the three large guidance cards from the main form and add their concise operational guidance to the Permissions help entry. Retain only warnings that directly affect the current pending request.

- [x] **Step 6: Make each view responsive**

  Stack batch controls and rule fields at the minimum window width, reduce the four-column statistics layout, wrap long resource/pattern text, and prevent action buttons from shrinking below their hit targets.

- [x] **Step 7: Run the focused spec**

  Expected: all pass.

---

### Task 6: Reorganise Auxiliary Models around everyday and advanced workflows

**Files:**

- Modify: `src/renderer/app/features/settings/auxiliary-models-settings-tab.component.ts`
- Create: `src/renderer/app/features/settings/auxiliary-models-settings-tab.component.html`
- Modify: `src/renderer/app/features/settings/auxiliary-models-settings-tab.component.scss`
- Modify: `src/renderer/app/features/settings/auxiliary-models-settings-tab.component.spec.ts`
- Modify: `src/renderer/app/features/settings/help/settings-help-core.ts`

**Interfaces:**

```ts
type AuxiliaryModelsSection = 'overview' | 'models' | 'slots' | 'advanced';
readonly activeSection = signal<AuxiliaryModelsSection>('overview');
```

Extract the existing inline template to the new HTML file without altering component methods or IPC behaviour.

- [x] **Step 1: Strengthen existing behaviour tests before extraction**

  Add coverage for enablement, routing mode, daily cap, localhost Ollama, loop-routing influence, candidate refresh, quick/quality model selection, per-slot tier/model/fallback writes, endpoint probing, and slot test results/errors.

- [x] **Step 2: Add failing information-architecture and responsive tests**

  Assert four panels and their content. At narrow widths, slot rows must render as labelled cards or an equivalently readable bounded layout; column headings cannot be the only source of field meaning.

- [x] **Step 3: Run the focused spec and confirm the new tests fail**

  ```bash
  npm run test:quiet -- src/renderer/app/features/settings/auxiliary-models-settings-tab.component.spec.ts
  ```

- [x] **Step 4: Extract the template and build Overview/Models**

  Overview contains enablement, budget, routing, local Ollama, loop influence, and a compact endpoint-health summary. Models contains quick and quality defaults with clear effective-model feedback.

- [x] **Step 5: Build Slots/Advanced**

  Slots contains the per-slot controls and tests. Advanced contains discovered endpoint details and the custom endpoint probe. Inactive slots remain visibly labelled; testing an inactive slot stays possible but does not imply runtime use.

- [x] **Step 6: Implement narrow slot cards and validation feedback**

  Each card repeats Slot, Tier, Model override, Frontier fallback, and Test labels. Preserve the desktop table where it is genuinely easier to scan. Probe and generation errors render adjacent to their initiating control and are announced.

- [x] **Step 7: Run the focused spec**

  Expected: all pass.

---

### Task 7: Turn Ecosystem into a full-width, single-category resource editor

**Files:**

- Modify: `src/renderer/app/features/settings/ecosystem-settings-tab.component.ts`
- Create: `src/renderer/app/features/settings/ecosystem-settings-tab.component.html`
- Modify: `src/renderer/app/features/settings/ecosystem-settings-tab.component.scss`
- Create: `src/renderer/app/features/settings/ecosystem-settings-tab.component.spec.ts`
- Modify: `src/renderer/app/features/settings/instruction-inspector.component.ts` only if layout integration requires a stable compact mode

**Interfaces:**

```ts
type EcosystemCategory = 'command' | 'agent' | 'tool' | 'plugin' | 'output-style';

interface EcosystemCategoryDefinition {
  id: EcosystemCategory;
  label: string;
  createLabel?: string;
}

readonly activeCategory = signal<EcosystemCategory>('command');
readonly originalFileContent = signal('');
readonly hasUnsavedChanges = computed(
  () => this.fileContent() !== this.originalFileContent(),
);
```

- [x] **Step 1: Add failing category/editor tests**

  Cover one active category at a time, category counts, create action visibility, item selection, built-in/read-only state, output-style activation, working-directory changes, file loading, save success/error, and instruction-inspector presence.

- [x] **Step 2: Add failing unsaved-change protection tests**

  When edited content differs from the last loaded/saved content, switching item/category/working directory or reloading must require an explicit Discard/Cancel decision. Cancel preserves selection and text; Discard performs the requested navigation; a successful save resets the dirty state.

- [x] **Step 3: Run the focused spec and confirm failure**

  ```bash
  npm run test:quiet -- src/renderer/app/features/settings/ecosystem-settings-tab.component.spec.ts
  ```

- [x] **Step 4: Extract the template and introduce category navigation**

  Replace five simultaneous sidebar sections with the shared section selector and one filtered resource list. Keep working-directory selection and refresh in a compact editor toolbar. Do not change discovery paths or create/save IPC calls.

- [x] **Step 5: Build the embedded master/detail layout**

  Use the layout mode from Task 1. On wide content, show resource list and editor side by side. At narrow widths, stack them while keeping the selected resource identity and Save state visible. Long paths wrap or truncate with a full accessible title.

- [x] **Step 6: Add explicit save-state and discard handling**

  Reuse `SaveStateBannerComponent` for Saved/Saving/Unsaved/Error state. Use the repository's current native `confirm()` pattern with explicit resource names for Discard/Cancel protection; introducing a general modal framework is outside this task.

- [x] **Step 7: Run the focused spec**

  Expected: all pass.

---

### Task 8: Reduce Advanced to Runtime, Security, and Data

**Files:**

- Modify: `src/renderer/app/features/settings/advanced-settings-tab.component.ts`
- Modify: `src/renderer/app/features/settings/advanced-settings-tab.component.scss`
- Create: `src/renderer/app/features/settings/advanced-settings-tab.component.spec.ts`
- Modify: `src/renderer/app/features/settings/help/settings-help-system.ts`

**Interfaces:**

```ts
type AdvancedSection = 'runtime' | 'security' | 'data';
readonly activeSection = signal<AdvancedSection>('runtime');
```

- [x] **Step 1: Write failing section and preservation tests**

  Runtime contains runtime controls, Browser DevTools attach, and code-memory indexing. Security contains MCP safety and hook approvals. Data contains backup, restore, and reset. Assert every existing setting change and async action still calls the same handler.

- [x] **Step 2: Add failing safety tests**

  Reset remains confirmation-gated, visually separated, and unavailable through accidental keyboard activation. Import/export errors are adjacent and announced. Hook approval actions retain accessible names and disabled/loading states.

- [x] **Step 3: Run the focused spec and confirm failure**

  ```bash
  npm run test:quiet -- src/renderer/app/features/settings/advanced-settings-tab.component.spec.ts
  ```

- [x] **Step 4: Recompose the three panels**

  Use the shared section selector and existing setting-row/card primitives. Remove the non-functional “Planned settings” section. Move setup-guide copy and links into contextual Help; do not remove the underlying documentation links.

- [x] **Step 5: Clarify hierarchy and dangerous actions**

  Use concise section intros, consistent card padding, and the existing danger-zone component for reset. Avoid nested decorative cards and avoid repeating the top-level Settings page heading.

- [x] **Step 6: Run the focused spec**

  Expected: all pass.

---

### Task 9: Cross-surface accessibility, responsive, and regression verification

**Files:**

- Update: `docs/plans/2026-08-28-settings-ux-remediation_plan.md` with as-built notes during implementation
- Create only if live checks genuinely cannot run: `docs/plans/2026-08-28-settings-ux-remediation_livetest.md`

- [x] **Step 1: Run all Settings and Help component tests together**

  ```bash
  npm run test:quiet -- src/renderer/app/features/settings src/renderer/app/shared/help
  ```

  Expected: all focused renderer specs pass without unhandled promise rejections or console errors.

- [x] **Step 2: Run automated accessibility-oriented checks available in the repo**

  Confirm semantic roles, accessible names, form-label associations, focus order, visible focus, status/error announcements, and target sizing through component tests and static inspection. Do not claim automated colour-contrast coverage unless a real contrast tool was run.

Steps 3 and 4 (live Electron widths/themes, and high-risk actions with placeholder data) moved to [2026-08-28-settings-ux-remediation_livetest.md](./2026-08-28-settings-ux-remediation_livetest.md) as LT-1 and LT-2.

- [x] **Step 5: Run the canonical project gates**

  ```bash
  npx tsc --noEmit
  npx tsc --noEmit -p tsconfig.spec.json
  npm run lint
  npm run check:ts-max-loc
  npm run build:main
  npm run test:quiet
  ```

  Expected: every command exits 0. `npm run build:main` is mandatory even though this programme is renderer-heavy.

- [x] **Step 6: Run the independent completion gate**

  Start a genuinely fresh agent context that did not implement the work. Require it to use `task-completion-gate` and review the merge-base-to-HEAD plus working-tree diff against this plan, architecture, test integrity, accessibility, async state, conditional UI, performance, and security. Fix every actionable finding, rerun affected checks, and repeat with another fresh reviewer until it returns `VERDICT: PASS` with no unresolved findings.

- [x] **Step 7: Close the documentation lifecycle only after verification**

  Add as-built notes and evidence to this document. If every agent-runnable and live UI check passed, rename it to `2026-08-28-settings-ux-remediation_plan_completed.md`. If a live check genuinely requires a later rebuilt/restarted instance, move only that check into the required `_livetest.md` document before renaming the plan. Never mark implementation complete merely because code and unit tests pass.

---

## Out of Scope

- Redesigning General, Display, Keyboard, Memory, Network, Orchestration, Voice, Cross-Model Review, CLI Health, Doctor, Mobile, or Computer Use beyond shared-shell compatibility fixes.
- Changing settings defaults, schemas, storage, IPC validation, remote-node protocol, pairing security, permission policy semantics, auxiliary routing semantics, or Ecosystem discovery rules.
- Adding telemetry, analytics, user research infrastructure, a new icon set, a new theme, animations, or third-party UI libraries.
- Moving Ecosystem to a new top-level application route. This plan makes it an embedded/full-width Settings surface; route relocation can be considered separately after usage feedback.

## Completion Checklist

- [x] Shared layout metadata and section navigation implemented and tested.
- [x] Compact navigation and Help drawer usable at 800px — implemented and unit-tested; the live 800px window check is livetest LT-1.
- [x] Remote Nodes split into Overview, Pairing, Computers, and Advanced.
- [x] Connected Computers uses accessible responsive list/detail navigation.
- [x] Permissions split into Requests, Rules, Audit, and Insights.
- [x] Auxiliary Models split into Overview, Models, Slots, and Advanced.
- [x] Ecosystem is full-width, single-category, and protects unsaved edits.
- [x] Advanced contains only Runtime, Security, and Data; dead roadmap content removed.
- [x] Existing settings behaviour, IPC calls, confirmations, and secret handling preserved.
- [x] Focused tests, canonical gates, and fresh-eyes completion gate all pass. Real Electron UI checks are deferred to the livetest doc (LT-1, LT-2), not claimed here.
