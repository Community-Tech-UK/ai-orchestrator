# Control Center Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Combine the app's Tools & Views and Settings surfaces into one Control Center model, and make the Back button a route-level shell responsibility so individual feature pages cannot forget it.
**Architecture:** Add a shared Control Surface registry, wrap all secondary routes in a Control Center shell with a visible Back header, derive dashboard/settings navigation from the registry, then remove duplicated per-component Back controls.
**Tech Stack:** Angular 21 standalone components, Angular Router, signals, TypeScript 5.9, Vitest, existing renderer CSS conventions.

## Global Constraints

- Do not commit during implementation unless James explicitly asks.
- Preserve existing public URLs in the first implementation pass. Routes like `/settings`, `/automations`, `/remote-nodes`, `/verification/settings`, and `/compare/split` must keep working.
- The dashboard route `/` remains outside the Control Center shell.
- Keep `/setup` outside this migration unless James explicitly decides first-run setup should behave like a normal secondary page.
- The structural Back control must be visible text plus icon, not icon-only. The label must be visible at desktop and mobile widths.
- The default Back target is `/` unless a route explicitly supplies a different product decision.
- Do not rely on individual feature components to provide the primary Back button after this migration.
- Keep feature-page action toolbars local unless a route genuinely needs shell-level action projection. Do not invent a global action API until there is a concrete repeated need.
- Use existing icon/navigation styling patterns in the repo. Do not add a new icon or UI dependency for this work.
- Use `apply_patch` for manual file edits.
- Before editing a file, read it in full and read its adjacent spec/caller files.
- After multi-file changes, run typecheck, spec typecheck, lint, TypeScript LOC ratchet, targeted tests, and the full quiet suite.

---

## Product Model

The app currently has two overlapping concepts:

- **Tools & Views:** routes launched from dashboard/sidebar navigation, such as Automations, Tasks, Memory, Replay, Fleet, Observations, Remote Nodes, and Split Compare.
- **Settings:** a settings route with internal tabs, plus several entries that are effectively tools or diagnostics, such as Models, MCP, Hooks, Worktrees, Snapshots, Archive, and Remote Config.

The proposed model is:

- **Control Center:** one shell for all secondary app surfaces.
- **Control Surface:** one route entry inside that shell. A surface can be a setting, tool, view, diagnostic, integration, or workflow surface.
- **Primary app:** dashboard and first-run setup remain outside this shell.

This means Settings and Tools are not separate "windows" conceptually. They are categories inside the same Control Center navigation.

The first implementation should keep the existing route paths. A later product pass can add prettier aliases like `/control/settings` or `/control/tools/automations`, but that should not be part of the first structural fix.

## Current Code Touchpoints

Read these files before implementation and keep the changes coordinated:

- `src/renderer/app/app.routes.ts`
  - Owns the route table.
  - Currently defines most secondary pages as top-level routes.
  - Needs the shared shell wrapper while preserving existing paths.
- `src/renderer/app/app.component.html`
  - Contains the app-level `<router-outlet />`.
  - Should not get the Back button; this is too broad because dashboard/setup should not be forced into the same chrome.
- `src/renderer/app/app.component.ts`
  - Contains app-level navigation behavior, including menu-driven Settings navigation.
  - Settings command should navigate through the new registry helper instead of hard-coding route assumptions.
- `src/renderer/app/features/dashboard/sidebar-nav.component.ts`
  - Currently owns Tools & Views navigation data locally.
  - Should stop being the source of truth and consume registry-derived nav groups.
- `src/renderer/app/features/settings/settings-navigation.ts`
  - Currently owns settings nav and includes tool-like entries.
  - Should become settings-section metadata only, or derive its tool entries from the shared registry.
- `src/renderer/app/shared/components/page-header/page-header.component.ts`
  - Existing optional page header with `backRoute`.
  - Do not rely on this opt-in component for the primary Back guarantee. Either leave it for local subheaders or replace usages with the new shell header.
- Feature pages that currently contain Back buttons
  - Remove their primary Back controls after the shell is active.
  - Keep local secondary navigation only when it is not the page-level Back affordance.

## Route Inventory

Use this inventory to seed the Control Surface registry. Re-check `app.routes.ts` during implementation because new routes may have landed.

### Primary Or Excluded

- `/` dashboard: excluded from Control Center.
- `/setup`: excluded by default because it is a first-run flow.

### Settings And Configuration

- `/settings`
- `/models`
- `/mcp`
- `/plugins`
- `/remote-config`
- `/communication`
- `/remote-access`
- `/channels`

### Automation, Agents, And Workflows

- `/automations`
- `/workflows`
- `/hooks`
- `/skills`
- `/reviews`
- `/specialists`
- `/worktrees`
- `/tasks`
- `/plan`
- `/campaigns`
- `/debate`
- `/ask-council`
- `/fleet`
- `/remote-nodes`

### Knowledge, Memory, And Search

- `/memory`
- `/memory/stats`
- `/rlm`
- `/training`
- `/semantic-search`
- `/search`
- `/knowledge`

### Code And Workspace Tools

- `/lsp`
- `/browser`
- `/vcs`
- `/multi-edit`
- `/editor`

### Monitoring, Diagnostics, And Review

- `/supervision`
- `/verification`
- `/verification/settings`
- `/stats`
- `/cost`
- `/snapshots`
- `/replay`
- `/security`
- `/logs`
- `/observations`
- `/compare/split`

### Storage And App Surfaces

- `/archive`

If an implementation pass finds another non-dashboard route, classify it explicitly. Do not leave it implicit.

## Desired UI Behavior

- Every Control Center route renders the same shell header.
- The Back control is the first prominent item in the shell header.
- Back defaults to dashboard (`/`) and is keyboard reachable.
- The header title and subtitle come from route metadata, not from hard-coded component copies.
- The shell includes a Control Center navigation area that lists Settings and Tools together.
- On desktop, the navigation can sit as a left rail or side panel depending on existing density constraints.
- On mobile/narrow widths, the navigation can collapse behind a menu or section picker, but the Back button remains visible in the header.
- Feature pages can still render their own content titles if they are semantically part of the page content, but they should not render the primary route title plus primary Back affordance again.
- Special wide/full-screen pages, such as split compare and editor-like views, still get a shell Back header. They may use a compact header variant, but not omit Back.

## Data Model

Create a registry under `src/renderer/app/shared/control-surface/`.

Suggested files:

- `control-surface.types.ts`
- `control-surface.registry.ts`
- `control-surface-route-data.ts`
- `control-surface-nav.ts`
- `control-surface.registry.spec.ts`

Use explicit string IDs instead of deriving from paths. Paths can change or gain aliases later; IDs are the stable API.

Suggested types:

```ts
export type ControlSurfaceKind =
  | 'setting'
  | 'tool'
  | 'view'
  | 'diagnostic'
  | 'integration'
  | 'workflow';

export type ControlSurfaceLayout =
  | 'standard'
  | 'wide'
  | 'fullBleed';

export type ControlSurfaceGroup =
  | 'settings'
  | 'automation'
  | 'agents'
  | 'knowledge'
  | 'code'
  | 'monitoring'
  | 'integrations'
  | 'storage';

export interface ControlSurfaceItem {
  readonly id: ControlSurfaceId;
  readonly path: string;
  readonly label: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly icon: string;
  readonly group: ControlSurfaceGroup;
  readonly kind: ControlSurfaceKind;
  readonly layout: ControlSurfaceLayout;
  readonly showInDashboardNav: boolean;
  readonly showInControlNav: boolean;
  readonly showInSettingsNav: boolean;
  readonly backRoute?: string;
}
```

Add helper functions:

```ts
export function getControlSurface(id: ControlSurfaceId): ControlSurfaceItem;
export function tryGetControlSurface(id: string): ControlSurfaceItem | undefined;
export function listControlSurfaces(): readonly ControlSurfaceItem[];
export function listControlNavGroups(): readonly ControlSurfaceNavGroup[];
export function listDashboardNavGroups(): readonly ControlSurfaceNavGroup[];
export function listSettingsExternalLinks(): readonly ControlSurfaceItem[];
export function controlSurfaceRouteData(id: ControlSurfaceId): ControlSurfaceRouteData;
```

Registry tests must assert:

- IDs are unique.
- Paths are unique unless an item explicitly declares an alias.
- Every item path starts with `/`.
- Every item has a non-empty label and title.
- Every item has a valid group, kind, and layout.
- Every item shown in dashboard/settings nav is also shown in Control Center nav unless explicitly documented.
- The registry contains all non-excluded routes from the route inventory.

## Route Shell Design

Create a shell component under `src/renderer/app/shared/control-surface/`.

Suggested files:

- `control-surface-shell.component.ts`
- `control-surface-shell.component.html`
- `control-surface-shell.component.scss`
- `control-surface-shell.component.spec.ts`

The shell should:

- Read the active route tree on navigation end.
- Find the nearest/deepest `controlSurfaceId` in route data.
- Look up metadata in the registry.
- Render the structural Back button.
- Render title/subtitle from metadata.
- Render Control Center navigation from registry groups.
- Apply layout classes based on `layout`.
- Render the child page through `<router-outlet />`.

The shell should not:

- Know feature-specific business logic.
- Hard-code route labels.
- Directly import every feature component.
- Hide Back because the route content is "full screen".

Implementation notes:

- Lazy routes such as `/campaigns` and `/channels` may put metadata on the parent route while their default child route renders content. The shell metadata lookup must walk the activated route tree and use the last `controlSurfaceId` it finds.
- Use route data for the ID only. Do not duplicate title/subtitle in `app.routes.ts`; that drifts.
- Keep a fallback error state for missing/unknown route metadata in development. The production UI can show a generic title, but tests should fail before that happens.

Example route data helper usage:

```ts
{
  path: 'remote-nodes',
  data: controlSurfaceRouteData('remote-nodes'),
  loadComponent: () =>
    import('./features/remote-nodes/remote-nodes-page.component')
      .then((m) => m.RemoteNodesPageComponent),
}
```

## Route Restructure

Update `src/renderer/app/app.routes.ts` so secondary routes are children of the shell while preserving paths.

Target shape:

```ts
const controlSurfaceRoutes: Routes = [
  {
    path: 'automations',
    data: controlSurfaceRouteData('automations'),
    loadComponent: () => import('./features/automations/automations-page.component')
      .then((m) => m.AutomationsPageComponent),
  },
  // Continue with the complete Control Surface route list in the detailed execution section.
];

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/dashboard/dashboard.component')
      .then((m) => m.DashboardComponent),
  },
  {
    path: '',
    loadComponent: () => import('./shared/control-surface/control-surface-shell.component')
      .then((m) => m.ControlSurfaceShellComponent),
    children: controlSurfaceRoutes,
  },
  {
    path: 'setup',
    loadComponent: () => import('./features/setup/setup.component')
      .then((m) => m.SetupComponent),
  },
  { path: '**', redirectTo: '' },
];
```

Implementation detail:

- Keep `setup` outside the shell.
- Preserve existing lazy child route modules for `campaigns` and `channels`.
- Add route data at the shell-child level for lazy route parents.
- If a lazy child has multiple pages, add more specific `controlSurfaceId` values on the child routes only when they represent distinct Control Center surfaces.

Add route tests that assert:

- Every registry route path is present under the shell route.
- No registry route is accidentally left as a top-level sibling.
- Excluded routes are explicitly excluded.
- Every shell child route has `data.controlSurfaceId`.

## Navigation Consolidation

### Dashboard Tools & Views

Update `src/renderer/app/features/dashboard/sidebar-nav.component.ts`.

- Remove the local source-of-truth route list.
- Import `listDashboardNavGroups()` from the registry.
- Keep dashboard-specific presentation logic in the component.
- Preserve existing badges and automation status indicators by attaching them at render time, not by forking the route metadata.

If another dashboard surface has hard-coded Tools & Views links, such as a workspace rail or quick action strip, update it to use registry helpers too.

### Settings

Update `src/renderer/app/features/settings/settings-navigation.ts`.

- Keep true settings sections as settings metadata.
- Move tool-like external entries to the Control Surface registry.
- Derive "external tools available from Settings" through `listSettingsExternalLinks()` so Settings no longer owns tool routes.
- Keep the current settings tab content in `SettingsComponent` for the first migration pass.

This avoids a risky rewrite of every settings tab while still fixing the structural model.

### Control Center Nav

The new shell should use `listControlNavGroups()`.

Recommended grouping:

- Settings
- Automation
- Agents
- Knowledge
- Code
- Monitoring
- Integrations
- Storage

Use the registry group order instead of alphabetical order. This keeps the nav predictable and avoids route additions reshuffling the UI.

## Settings Migration Strategy

Do this in two waves.

### Wave 1: Structural Unification

- `/settings` becomes a Control Surface route.
- The shell provides Back/title/nav.
- `SettingsComponent` keeps its internal tabs and save/apply behavior.
- Remove any Settings-owned primary Back affordance.
- Remove duplicated "Tools" entries from settings data only after equivalent registry-derived links exist in the Control Center nav.

### Wave 2: Settings Section Cleanup

Only after Wave 1 is verified:

- Decide whether settings tabs should become child URLs like `/settings/providers`, `/settings/models`, or remain internal state.
- If they become child URLs, add each section as a registry item or a secondary settings-section registry.
- Keep existing `/settings` as an alias/default to the most useful settings section.
- Add redirects rather than breaking old links.

Do not block the Back-button shell fix on Wave 2.

## Local Back Button Removal

Once route shelling is active and verified, remove page-level primary Back controls from feature components.

Known files from the current Back-button work:

- `src/renderer/app/features/remote-nodes/remote-nodes-page.component.ts`
- `src/renderer/app/features/campaign/campaign-page.component.ts`
- `src/renderer/app/features/campaign/campaign-page.component.html`
- `src/renderer/app/features/campaign/campaign-page.component.scss`
- `src/renderer/app/features/tasks/tasks-page.component.ts`
- `src/renderer/app/features/replay/session-replay-page.component.ts`
- `src/renderer/app/features/memory/memory-stats.component.ts`
- `src/renderer/app/features/verification/config/cli-settings-panel.component.ts`
- `src/renderer/app/features/verification/config/cli-settings-panel.component.html`
- `src/renderer/app/features/verification/config/cli-settings-panel.component.scss`
- `src/renderer/app/features/fleet-dashboard/fleet-dashboard.component.ts`
- `src/renderer/app/features/compare/split-session-compare.component.ts`
- `src/renderer/app/features/compare/split-session-compare.component.html`
- `src/renderer/app/features/compare/split-session-compare.component.scss`
- `src/renderer/app/features/automations/automations-page.component.html`
- `src/renderer/app/features/automations/automations-page.component.css`
- `src/renderer/app/features/channels/components/channel-connections/channel-connections.component.ts`
- `src/renderer/app/features/observations/observations-page.component.ts`
- `src/renderer/app/features/settings/settings.component.html`
- `src/renderer/app/features/verification/dashboard/verification-dashboard.component.html`
- `src/renderer/app/features/verification/dashboard/verification-dashboard.component.scss`

Also search before editing:

```bash
rtk rg -n "routerLink=\"/\"|goBack\\(|Back|back-button|backRoute|ArrowLeft|chevron-left|navigate\\(\\['/'\\]\\)" src/renderer/app
```

Removal rules:

- Remove only the primary route Back control.
- Remove `Router` injection/imports that existed only for Back.
- Keep local navigation that moves between tabs, subtabs, wizard steps, or detail panes.
- Keep route-specific action buttons like Refresh, Save, Run, Export, or Connect.
- If a component used its header purely for title and Back, remove that header and let the shell title stand.
- If a component header also holds page-specific actions, keep the action toolbar but remove Back/title duplication.

## Implementation Tasks

### Task 1: Add Control Surface Registry

- [ ] Re-read `app.routes.ts`, `sidebar-nav.component.ts`, and `settings-navigation.ts`.
- [ ] Create `src/renderer/app/shared/control-surface/control-surface.types.ts`.
- [ ] Create `src/renderer/app/shared/control-surface/control-surface.registry.ts`.
- [ ] Create `src/renderer/app/shared/control-surface/control-surface-route-data.ts`.
- [ ] Create `src/renderer/app/shared/control-surface/control-surface-nav.ts`.
- [ ] Add every in-scope route from the route inventory.
- [ ] Add explicit exclusions for `/` and `/setup`.
- [ ] Port dashboard/sidebar labels and icons into registry metadata.
- [ ] Port settings-owned tool links into registry metadata.
- [ ] Add `control-surface.registry.spec.ts`.
- [ ] Run targeted registry tests.

Targeted verification:

```bash
rtk npm run test:quiet -- src/renderer/app/shared/control-surface/control-surface.registry.spec.ts
```

### Task 2: Build The Shell

- [ ] Create `ControlSurfaceShellComponent`.
- [ ] Add visible Back button with text `Back`.
- [ ] Add title/subtitle rendering from registry metadata.
- [ ] Add grouped Control Center navigation.
- [ ] Add layout classes for `standard`, `wide`, and `fullBleed`.
- [ ] Add mobile/narrow-width CSS so Back remains visible.
- [ ] Add fallback handling for unknown route data.
- [ ] Add shell component tests.

Targeted verification:

```bash
rtk npm run test:quiet -- src/renderer/app/shared/control-surface/control-surface-shell.component.spec.ts
```

### Task 3: Wrap Routes

- [ ] Update `app.routes.ts` to add `controlSurfaceRoutes`.
- [ ] Move all in-scope secondary routes under the shell route.
- [ ] Preserve existing route paths.
- [ ] Preserve lazy route modules for `campaigns` and `channels`.
- [ ] Add `controlSurfaceRouteData(...)` to every shell child route.
- [ ] Keep `/` and `/setup` outside the shell.
- [ ] Add or update route tests for registry coverage.

Targeted verification:

```bash
rtk npm run test:quiet -- src/renderer/app/app.routes.spec.ts src/renderer/app/shared/control-surface/control-surface.registry.spec.ts
```

### Task 4: Convert Dashboard Navigation To Registry

- [ ] Update `sidebar-nav.component.ts` to consume `listDashboardNavGroups()`.
- [ ] Preserve automation badge behavior.
- [ ] Update any hard-coded dashboard quick links that duplicate Tools & Views.
- [ ] Update affected dashboard/sidebar tests.

Search command:

```bash
rtk rg -n "'/(automations|workflows|hooks|skills|reviews|specialists|worktrees|memory|debate|verification|lsp|mcp|browser|vcs|tasks|plan|stats|cost|snapshots|replay|remote-access|search|security|logs|observations|knowledge|plugins|models|remote-config|communication|multi-edit|editor|archive|semantic-search|channels|remote-nodes|fleet|compare/split)'|routerLink=\"/(automations|settings|models|mcp|remote-nodes|fleet|verification|tasks)" src/renderer/app
```

Targeted verification:

```bash
rtk npm run test:quiet -- src/renderer/app/features/dashboard
```

### Task 5: Fold Settings Into The Same Model

- [ ] Update `/settings` route metadata to use registry ID `settings`.
- [ ] Remove Settings-owned primary Back UI.
- [ ] Keep Settings tab behavior intact for Wave 1.
- [ ] Convert tool-like settings entries to registry-derived external links.
- [ ] Update menu-driven Settings navigation to use the registry path.
- [ ] Update settings tests.

Targeted verification:

```bash
rtk npm run test:quiet -- src/renderer/app/features/settings
```

### Task 6: Remove Per-Component Primary Back Buttons

- [ ] Search for Back controls using the command in "Local Back Button Removal".
- [ ] For each in-scope Control Surface component, remove only the primary Back control.
- [ ] Remove now-unused `Router`, `RouterLink`, `Location`, and icon imports.
- [ ] Keep local page actions and local tabs.
- [ ] Update component tests that expected local Back.
- [ ] Confirm no component-level primary Back remains for registry routes.

Targeted verification:

```bash
rtk npm run test:quiet -- \
  src/renderer/app/features/remote-nodes \
  src/renderer/app/features/campaign \
  src/renderer/app/features/tasks \
  src/renderer/app/features/replay \
  src/renderer/app/features/memory \
  src/renderer/app/features/verification \
  src/renderer/app/features/fleet-dashboard \
  src/renderer/app/features/compare \
  src/renderer/app/features/automations \
  src/renderer/app/features/channels \
  src/renderer/app/features/observations
```

### Task 7: Add Structural Back Coverage

- [ ] Add a route audit test that enumerates registry surfaces and checks each route has shell metadata.
- [ ] Add a shell-render test for at least one standard route, one settings route, one lazy route, and one full-bleed route.
- [ ] Add a static audit helper if needed to fail when a new top-level secondary route is added outside the shell.
- [ ] Document how to run the browser smoke check.

Browser smoke check requirements:

- Visit each registry route through app navigation or client-side routing.
- At desktop width, assert a visible `Back` control exists.
- At mobile/narrow width, assert a visible `Back` control exists.
- Click Back and assert navigation lands on `/`.
- Include lazy routes and nested routes such as `/memory/stats`, `/verification/settings`, `/channels`, `/campaigns`, and `/compare/split`.

Avoid direct deep-link asset false failures in the Angular dev server by navigating from `/` when necessary.

### Task 8: Visual And Interaction QA

- [ ] Start the app in dev mode.
- [ ] Check the Control Center shell on desktop.
- [ ] Check the shell at a narrow/mobile viewport.
- [ ] Verify `standard`, `wide`, and `fullBleed` layouts do not overlap content.
- [ ] Verify Settings no longer feels like a separate window from Tools.
- [ ] Verify routes with local action bars still expose their actions.
- [ ] Verify Back always returns to dashboard.
- [ ] Capture screenshots for the final notes if visual changes are substantial.

Dev command:

```bash
rtk npm run dev
```

### Task 9: Final Verification Gate

- [ ] Run TypeScript app compilation.
- [ ] Run TypeScript spec compilation.
- [ ] Run lint.
- [ ] Run TypeScript LOC ratchet.
- [ ] Run targeted tests for changed areas.
- [ ] Run the full quiet test suite.
- [ ] Run manual browser smoke checks.
- [ ] Report exact pass/fail status for every item.

Commands:

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run test:quiet -- src/renderer/app/shared/control-surface src/renderer/app/features/settings src/renderer/app/features/dashboard
rtk npm run test:quiet
```

## Acceptance Criteria

- Every Control Surface route has a visible structural Back button.
- Back exists because of the shell, not because each feature remembered to add it.
- The Back label is visible at desktop and mobile widths.
- Clicking Back from every in-scope route returns to `/`.
- Settings and Tools appear inside one Control Center navigation model.
- Dashboard Tools & Views and Settings external links are derived from the same registry.
- Existing route paths still work.
- `/` remains a clean dashboard without Control Center chrome.
- `/setup` remains outside the shell unless deliberately changed.
- No duplicated primary Back buttons remain inside migrated feature components.
- Typecheck, spec typecheck, lint, LOC ratchet, targeted tests, full tests, and browser smoke checks pass.

## Risks And Mitigations

- **Route wrapping can break lazy routes.**
  - Mitigation: move lazy route parents under the shell without changing their child modules; add route coverage tests for `campaigns` and `channels`.
- **Shell title can drift from feature page title.**
  - Mitigation: registry is the title source of truth. Remove duplicated feature titles where they are just route titles.
- **Full-bleed pages can lose usable space.**
  - Mitigation: support a compact `fullBleed` layout class while still rendering Back.
- **Settings migration can become too large.**
  - Mitigation: Wave 1 only wraps and links Settings. Wave 2 URL-izes settings sections separately.
- **New routes can bypass the shell later.**
  - Mitigation: registry and route audit tests fail when a secondary route is not shell-managed.
- **Hard-coded links can keep old labels/groups alive.**
  - Mitigation: search for route literals and convert dashboard/settings navigation sources to registry helpers.
- **Component tests may fail because local Back disappeared.**
  - Mitigation: update tests to assert shell Back at shell level and page actions at page level.

## Rollback Strategy

If route wrapping causes a serious regression:

- Revert only the route wrapper change in `app.routes.ts`.
- Keep the registry in place if it compiles; it is passive until consumed.
- Restore component-level Back controls only for affected routes as a temporary fallback.
- Keep route audit tests skipped only with a clear issue reference or local note. Do not silently delete them.

## Follow-Up Decisions

These should be decided after the structural fix is stable:

- Whether the visible product label should be "Control Center", "Tools", "Settings & Tools", or another name.
- Whether `/settings` should remain a settings landing page or redirect to a richer Control Center route.
- Whether settings tabs should become deep-linkable child URLs.
- Whether shell-level action projection is worth adding for routes with common actions.
- Whether first-run `/setup` should ever enter this shell after initial configuration is complete.

---

## Detailed Agentic Execution Plan

This section is the implementation handoff. It supersedes the higher-level task list above where the two differ.

### Current-State Findings To Preserve

- `src/renderer/app/app.routes.ts` currently defines all secondary pages as top-level routes. The first implementation must preserve those public paths.
- `src/renderer/app/app.routes.ts` includes two routes missing from the earlier inventory:
  - `/chat-search` should be a Control Surface.
  - `/operator` is a legacy redirect to `/` and should remain outside the shell.
- `src/renderer/app/app.component.ts`, `src/renderer/app/app.component.html`, and `src/renderer/app/app.component.scss` currently provide a temporary global `route-backstop` button for every non-dashboard route. Remove this after the shell is verified so Back is route-shell responsibility, not app-root responsibility.
- `src/renderer/app/features/settings/settings.component.ts` still supports modal-style close through `closeDialog`. Keep the output for legacy callers, but remove only the route-level Back button from the routed page template.
- `src/renderer/app/features/settings/settings.component.html` embeds feature pages for wide settings tabs (`models`, `mcp`, `hooks`, `worktrees`, `snapshots`, `archive`, `remote-config`). Do not deep-link those tabs in this pass.
- `src/renderer/app/features/campaign/campaign.routes.ts` has a single empty child route. Put `controlSurfaceRouteData('campaigns')` on the parent shell child route.
- `src/renderer/app/features/channels/channels.routes.ts` has empty, `messages`, and `settings` child routes. Put `controlSurfaceRouteData('channels')` on the parent shell child route so the shell title/nav is stable across `/channels`, `/channels/messages`, and `/channels/settings`.
- No `src/renderer/app/app.routes.spec.ts` exists today. Add it.

### Control Surface Registry Inventory

Use this exact inventory unless the implementation pass finds a new route in `app.routes.ts`; if it does, add it here and classify it explicitly before implementing.

| ID | Path | Label | Group | Kind | Layout | Dashboard | Control | Settings External |
|---|---|---|---|---|---|---:|---:|---:|
| `settings` | `/settings` | Settings | settings | setting | standard | no | yes | no |
| `chat-search` | `/chat-search` | Chat Search | knowledge | tool | standard | no | yes | no |
| `automations` | `/automations` | Automations | automation | workflow | standard | yes | yes | no |
| `campaigns` | `/campaigns` | Campaigns | automation | workflow | wide | yes | yes | no |
| `workflows` | `/workflows` | Workflows | automation | workflow | standard | yes | yes | no |
| `hooks` | `/hooks` | Hooks | automation | workflow | standard | yes | yes | yes |
| `skills` | `/skills` | Skills | agents | tool | standard | yes | yes | no |
| `reviews` | `/reviews` | Code Reviews | agents | workflow | standard | yes | yes | no |
| `specialists` | `/specialists` | Agent Roles | agents | tool | standard | yes | yes | no |
| `worktrees` | `/worktrees` | Worktrees | code | tool | standard | yes | yes | yes |
| `supervision` | `/supervision` | Supervisor | monitoring | diagnostic | wide | yes | yes | no |
| `rlm` | `/rlm` | Learning Database | knowledge | view | standard | yes | yes | no |
| `training` | `/training` | Training Data | knowledge | tool | standard | yes | yes | no |
| `memory` | `/memory` | Memory Browser | knowledge | view | standard | yes | yes | no |
| `memory-stats` | `/memory/stats` | Memory Stats | knowledge | diagnostic | standard | no | yes | no |
| `debate` | `/debate` | Debate Arena | agents | workflow | standard | yes | yes | no |
| `verification` | `/verification` | Verification | monitoring | workflow | wide | yes | yes | no |
| `verification-settings` | `/verification/settings` | Verification Settings | settings | setting | standard | no | yes | no |
| `lsp` | `/lsp` | Language Server | code | tool | standard | yes | yes | no |
| `mcp` | `/mcp` | MCP Servers | integrations | integration | standard | yes | yes | yes |
| `browser` | `/browser` | Browser Gateway | integrations | tool | wide | yes | yes | no |
| `vcs` | `/vcs` | Git | code | tool | standard | yes | yes | no |
| `tasks` | `/tasks` | Background Jobs | code | diagnostic | standard | yes | yes | no |
| `plan` | `/plan` | Plan Mode | code | tool | standard | yes | yes | no |
| `stats` | `/stats` | Statistics | monitoring | diagnostic | standard | yes | yes | no |
| `cost` | `/cost` | Costs & Usage | monitoring | diagnostic | standard | yes | yes | no |
| `snapshots` | `/snapshots` | Snapshots | storage | tool | standard | yes | yes | yes |
| `replay` | `/replay` | Replay | monitoring | view | wide | yes | yes | no |
| `remote-access` | `/remote-access` | Remote Access | integrations | integration | standard | yes | yes | no |
| `search` | `/search` | Search Code | code | tool | standard | yes | yes | no |
| `security` | `/security` | Security | monitoring | diagnostic | standard | yes | yes | no |
| `logs` | `/logs` | Logs | monitoring | diagnostic | standard | yes | yes | no |
| `observations` | `/observations` | Telemetry | knowledge | diagnostic | standard | yes | yes | no |
| `knowledge` | `/knowledge` | Knowledge Graph | knowledge | view | wide | yes | yes | no |
| `plugins` | `/plugins` | Plugins | integrations | integration | standard | yes | yes | no |
| `models` | `/models` | Models | settings | setting | standard | yes | yes | yes |
| `remote-config` | `/remote-config` | Remote Config | integrations | integration | standard | yes | yes | yes |
| `communication` | `/communication` | Instance Messaging | integrations | integration | standard | yes | yes | no |
| `multi-edit` | `/multi-edit` | Multi-File Edit | code | tool | wide | yes | yes | no |
| `editor` | `/editor` | Editor | code | tool | fullBleed | yes | yes | no |
| `archive` | `/archive` | Archive | storage | view | standard | yes | yes | yes |
| `semantic-search` | `/semantic-search` | Semantic Search | code | tool | standard | yes | yes | no |
| `channels` | `/channels` | Discord & WhatsApp | integrations | integration | standard | yes | yes | no |
| `remote-nodes` | `/remote-nodes` | Remote Nodes | integrations | integration | standard | yes | yes | no |
| `ask-council` | `/ask-council` | Ask Council | agents | workflow | wide | no | yes | no |
| `fleet` | `/fleet` | Fleet Dashboard | monitoring | diagnostic | wide | yes | yes | no |
| `compare-split` | `/compare/split` | Split Compare | monitoring | tool | fullBleed | no | yes | no |

Explicit exclusions:

| Path | Reason |
|---|---|
| `/` | Primary dashboard; must not receive Control Center chrome. |
| `/setup` | First-run/setup flow; keep outside shell in this pass. |
| `/operator` | Legacy redirect to `/`; keep as top-level redirect outside shell. |
| `/**` | Catch-all redirect; keep outside shell. |

### Task 0: Baseline And Scope Guard

**Files:**
- Read: `src/renderer/app/app.routes.ts`
- Read: `src/renderer/app/app.component.ts`
- Read: `src/renderer/app/app.component.html`
- Read: `src/renderer/app/app.component.scss`
- Read: `src/renderer/app/features/dashboard/sidebar-nav.component.ts`
- Read: `src/renderer/app/features/settings/settings-navigation.ts`
- Read: `src/renderer/app/features/settings/settings.component.ts`
- Read: `src/renderer/app/features/settings/settings.component.html`
- Read: `src/renderer/app/features/campaign/campaign.routes.ts`
- Read: `src/renderer/app/features/channels/channels.routes.ts`

**Interfaces:**
- Consumes: current route table and navigation constants.
- Produces: a clean baseline proving the work starts from known failures, not from stale assumptions.

- [ ] **Step 0.1: Capture current route inventory**

Run:

```bash
rtk rg -n "path:|loadChildren|loadComponent|redirectTo" src/renderer/app/app.routes.ts
```

Expected: output includes `/chat-search`, `/operator`, `/setup`, `/channels`, `/campaigns`, and `/compare/split`.

- [ ] **Step 0.2: Capture current Back-button inventory**

Run:

```bash
rtk rg -n "route-backstop|routerLink=\"/\"|goBack\\(|Back|back-button|backRoute|ArrowLeft|chevron-left|navigate\\(\\['/'\\]\\)" src/renderer/app
```

Expected: output includes the app-level `route-backstop` plus many feature-level Back controls. Use the output as the removal checklist in Task 7.

- [ ] **Step 0.3: Run the nearest existing tests before editing**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/app.component.spec.ts src/renderer/app/features/settings/settings-navigation.spec.ts
```

Expected: PASS before edits. If it fails, record the failure in the implementation notes and do not hide it with this feature work.

### Task 1: Add Control Surface Types, Route Data, And Registry

**Files:**
- Create: `src/renderer/app/shared/control-surface/control-surface.types.ts`
- Create: `src/renderer/app/shared/control-surface/control-surface.registry.ts`
- Create: `src/renderer/app/shared/control-surface/control-surface-route-data.ts`
- Create: `src/renderer/app/shared/control-surface/control-surface-nav.ts`
- Create: `src/renderer/app/shared/control-surface/control-surface.registry.spec.ts`

**Interfaces:**
- Produces: `ControlSurfaceId`, `ControlSurfaceItem`, `controlSurfaceRouteData(id)`, `listControlSurfaces()`, `listControlNavGroups()`, `listDashboardNavGroups()`, `listSettingsExternalLinks()`, `getControlSurface(id)`, `tryGetControlSurface(id)`.
- Consumes: none from later tasks.

- [ ] **Step 1.1: Create the type file**

Create `src/renderer/app/shared/control-surface/control-surface.types.ts` with these exported types:

```ts
export type ControlSurfaceKind =
  | 'setting'
  | 'tool'
  | 'view'
  | 'diagnostic'
  | 'integration'
  | 'workflow';

export type ControlSurfaceLayout =
  | 'standard'
  | 'wide'
  | 'fullBleed';

export type ControlSurfaceGroup =
  | 'settings'
  | 'automation'
  | 'agents'
  | 'knowledge'
  | 'code'
  | 'monitoring'
  | 'integrations'
  | 'storage';

export type ControlSurfaceId =
  | 'settings'
  | 'chat-search'
  | 'automations'
  | 'campaigns'
  | 'workflows'
  | 'hooks'
  | 'skills'
  | 'reviews'
  | 'specialists'
  | 'worktrees'
  | 'supervision'
  | 'rlm'
  | 'training'
  | 'memory'
  | 'memory-stats'
  | 'debate'
  | 'verification'
  | 'verification-settings'
  | 'lsp'
  | 'mcp'
  | 'browser'
  | 'vcs'
  | 'tasks'
  | 'plan'
  | 'stats'
  | 'cost'
  | 'snapshots'
  | 'replay'
  | 'remote-access'
  | 'search'
  | 'security'
  | 'logs'
  | 'observations'
  | 'knowledge'
  | 'plugins'
  | 'models'
  | 'remote-config'
  | 'communication'
  | 'multi-edit'
  | 'editor'
  | 'archive'
  | 'semantic-search'
  | 'channels'
  | 'remote-nodes'
  | 'ask-council'
  | 'fleet'
  | 'compare-split';

export interface ControlSurfaceItem {
  readonly id: ControlSurfaceId;
  readonly path: string;
  readonly label: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly icon: string;
  readonly group: ControlSurfaceGroup;
  readonly kind: ControlSurfaceKind;
  readonly layout: ControlSurfaceLayout;
  readonly showInDashboardNav: boolean;
  readonly showInControlNav: boolean;
  readonly showInSettingsNav: boolean;
  readonly backRoute?: string;
}

export interface ControlSurfaceNavGroup {
  readonly id: ControlSurfaceGroup;
  readonly label: string;
  readonly items: readonly ControlSurfaceItem[];
}

export interface ControlSurfaceRouteData {
  readonly controlSurfaceId: ControlSurfaceId;
}
```

- [ ] **Step 1.2: Create the route-data helper**

Create `src/renderer/app/shared/control-surface/control-surface-route-data.ts`:

```ts
import type { ControlSurfaceId, ControlSurfaceRouteData } from './control-surface.types';

export function controlSurfaceRouteData(id: ControlSurfaceId): ControlSurfaceRouteData {
  return { controlSurfaceId: id };
}
```

- [ ] **Step 1.3: Create the registry**

Create `src/renderer/app/shared/control-surface/control-surface.registry.ts`.

Use `CONTROL_SURFACES` as the source of truth. The icon constants below are concrete safe defaults that match the existing inline-SVG pattern; during implementation, prefer moving the exact current dashboard icon strings from `sidebar-nav.component.ts` into the matching constants before deleting the old nav array.

The file must expose these exact exports:

```ts
import type {
  ControlSurfaceGroup,
  ControlSurfaceId,
  ControlSurfaceItem,
  ControlSurfaceNavGroup,
} from './control-surface.types';

const GROUP_LABELS: Record<ControlSurfaceGroup, string> = {
  settings: 'Settings',
  automation: 'Automation',
  agents: 'Agents',
  knowledge: 'Knowledge',
  code: 'Code',
  monitoring: 'Monitoring',
  integrations: 'Integrations',
  storage: 'Storage',
};

const GROUP_ORDER: readonly ControlSurfaceGroup[] = [
  'settings',
  'automation',
  'agents',
  'knowledge',
  'code',
  'monitoring',
  'integrations',
  'storage',
];

const GROUP_ICONS: Record<ControlSurfaceGroup, string> = {
  settings: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
  automation: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  agents: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',
  knowledge: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><line x1="8.5" y1="7.5" x2="15.5" y2="7.5"/>',
  code: '<path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/>',
  monitoring: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  integrations: '<path d="M9 12h6"/><path d="M8 8H6a4 4 0 0 0 0 8h2"/><path d="M16 8h2a4 4 0 0 1 0 8h-2"/>',
  storage: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><line x1="10" y1="12" x2="14" y2="12"/>',
};

function surface(
  item: Omit<ControlSurfaceItem, 'icon'> & { readonly icon?: string },
): ControlSurfaceItem {
  return {
    icon: item.icon ?? GROUP_ICONS[item.group],
    ...item,
  };
}

export const CONTROL_SURFACES: readonly ControlSurfaceItem[] = [
  surface({ id: 'settings', path: '/settings', label: 'Settings', title: 'Settings', subtitle: 'Configure app behavior, providers, and diagnostics.', group: 'settings', kind: 'setting', layout: 'standard', showInDashboardNav: false, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'chat-search', path: '/chat-search', label: 'Chat Search', title: 'Chat Search', subtitle: 'Find prior conversations and reusable context.', group: 'knowledge', kind: 'tool', layout: 'standard', showInDashboardNav: false, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'automations', path: '/automations', label: 'Automations', title: 'Automations', subtitle: 'Schedule and monitor recurring agent work.', group: 'automation', kind: 'workflow', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'campaigns', path: '/campaigns', label: 'Campaigns', title: 'Campaigns', subtitle: 'Coordinate multi-loop campaign runs.', group: 'automation', kind: 'workflow', layout: 'wide', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'workflows', path: '/workflows', label: 'Workflows', title: 'Workflows', subtitle: 'Compose reusable automation flows.', group: 'automation', kind: 'workflow', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'hooks', path: '/hooks', label: 'Hooks', title: 'Hooks', subtitle: 'Run commands on agent lifecycle events.', group: 'automation', kind: 'workflow', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: true }),
  surface({ id: 'skills', path: '/skills', label: 'Skills', title: 'Skills', subtitle: 'Browse available agent skills.', group: 'agents', kind: 'tool', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'reviews', path: '/reviews', label: 'Code Reviews', title: 'Code Reviews', subtitle: 'Inspect review output and follow-up work.', group: 'agents', kind: 'workflow', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'specialists', path: '/specialists', label: 'Agent Roles', title: 'Agent Roles', subtitle: 'Choose specialist personas and responsibilities.', group: 'agents', kind: 'tool', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'worktrees', path: '/worktrees', label: 'Worktrees', title: 'Worktrees', subtitle: 'Manage git worktrees for parallel agent work.', group: 'code', kind: 'tool', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: true }),
  surface({ id: 'supervision', path: '/supervision', label: 'Supervisor', title: 'Supervisor', subtitle: 'Observe active agent trees and state.', group: 'monitoring', kind: 'diagnostic', layout: 'wide', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'rlm', path: '/rlm', label: 'Learning Database', title: 'Learning Database', subtitle: 'Inspect reinforcement learning memory context.', group: 'knowledge', kind: 'view', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'training', path: '/training', label: 'Training Data', title: 'Training Data', subtitle: 'Review training datasets and learning signals.', group: 'knowledge', kind: 'tool', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'memory', path: '/memory', label: 'Memory Browser', title: 'Memory Browser', subtitle: 'Browse remembered project and session context.', group: 'knowledge', kind: 'view', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'memory-stats', path: '/memory/stats', label: 'Memory Stats', title: 'Memory Stats', subtitle: 'Inspect memory usage and storage health.', group: 'knowledge', kind: 'diagnostic', layout: 'standard', showInDashboardNav: false, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'debate', path: '/debate', label: 'Debate Arena', title: 'Debate Arena', subtitle: 'Run and inspect multi-agent debates.', group: 'agents', kind: 'workflow', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'verification', path: '/verification', label: 'Verification', title: 'Verification', subtitle: 'Run cross-model verification workflows.', group: 'monitoring', kind: 'workflow', layout: 'wide', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'verification-settings', path: '/verification/settings', label: 'Verification Settings', title: 'Verification Settings', subtitle: 'Configure verification CLI behavior.', group: 'settings', kind: 'setting', layout: 'standard', showInDashboardNav: false, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'lsp', path: '/lsp', label: 'Language Server', title: 'Language Server', subtitle: 'Inspect language-server integration state.', group: 'code', kind: 'tool', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'mcp', path: '/mcp', label: 'MCP Servers', title: 'MCP Servers', subtitle: 'Manage tool servers shared across provider CLIs.', group: 'integrations', kind: 'integration', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: true }),
  surface({ id: 'browser', path: '/browser', label: 'Browser Gateway', title: 'Browser Gateway', subtitle: 'Control managed browser automation.', group: 'integrations', kind: 'tool', layout: 'wide', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'vcs', path: '/vcs', label: 'Git', title: 'Git', subtitle: 'Review source-control state and changes.', group: 'code', kind: 'tool', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'tasks', path: '/tasks', label: 'Background Jobs', title: 'Background Jobs', subtitle: 'Monitor local background repo jobs.', group: 'code', kind: 'diagnostic', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'plan', path: '/plan', label: 'Plan Mode', title: 'Plan Mode', subtitle: 'Draft and review structured implementation plans.', group: 'code', kind: 'tool', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'stats', path: '/stats', label: 'Statistics', title: 'Statistics', subtitle: 'Inspect app metrics and throughput.', group: 'monitoring', kind: 'diagnostic', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'cost', path: '/cost', label: 'Costs & Usage', title: 'Costs & Usage', subtitle: 'Track provider spend and usage.', group: 'monitoring', kind: 'diagnostic', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'snapshots', path: '/snapshots', label: 'Snapshots', title: 'Snapshots', subtitle: 'Capture and restore workspace checkpoints.', group: 'storage', kind: 'tool', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: true }),
  surface({ id: 'replay', path: '/replay', label: 'Replay', title: 'Replay', subtitle: 'Replay sessions and observation streams.', group: 'monitoring', kind: 'view', layout: 'wide', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'remote-access', path: '/remote-access', label: 'Remote Access', title: 'Remote Access', subtitle: 'Control remote access and pairing surfaces.', group: 'integrations', kind: 'integration', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'search', path: '/search', label: 'Search Code', title: 'Search Code', subtitle: 'Search indexed codebase content.', group: 'code', kind: 'tool', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'security', path: '/security', label: 'Security', title: 'Security', subtitle: 'Review security and audit findings.', group: 'monitoring', kind: 'diagnostic', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'logs', path: '/logs', label: 'Logs', title: 'Logs', subtitle: 'Inspect app logs and debug output.', group: 'monitoring', kind: 'diagnostic', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'observations', path: '/observations', label: 'Telemetry', title: 'Telemetry', subtitle: 'Review observations and reflections.', group: 'knowledge', kind: 'diagnostic', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'knowledge', path: '/knowledge', label: 'Knowledge Graph', title: 'Knowledge Graph', subtitle: 'Explore structured project knowledge.', group: 'knowledge', kind: 'view', layout: 'wide', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'plugins', path: '/plugins', label: 'Plugins', title: 'Plugins', subtitle: 'Manage runtime plugin integrations.', group: 'integrations', kind: 'integration', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'models', path: '/models', label: 'Models', title: 'Models', subtitle: 'Choose provider models and overrides.', group: 'settings', kind: 'setting', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: true }),
  surface({ id: 'remote-config', path: '/remote-config', label: 'Remote Config', title: 'Remote Config', subtitle: 'Sync settings from remote configuration sources.', group: 'integrations', kind: 'integration', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: true }),
  surface({ id: 'communication', path: '/communication', label: 'Instance Messaging', title: 'Instance Messaging', subtitle: 'Configure cross-instance communication.', group: 'integrations', kind: 'integration', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'multi-edit', path: '/multi-edit', label: 'Multi-File Edit', title: 'Multi-File Edit', subtitle: 'Review and apply coordinated edits.', group: 'code', kind: 'tool', layout: 'wide', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'editor', path: '/editor', label: 'Editor', title: 'Editor', subtitle: 'Edit workspace files directly.', group: 'code', kind: 'tool', layout: 'fullBleed', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'archive', path: '/archive', label: 'Archive', title: 'Archive', subtitle: 'Browse and restore archived sessions.', group: 'storage', kind: 'view', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: true }),
  surface({ id: 'semantic-search', path: '/semantic-search', label: 'Semantic Search', title: 'Semantic Search', subtitle: 'Search code and memory semantically.', group: 'code', kind: 'tool', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'channels', path: '/channels', label: 'Discord & WhatsApp', title: 'Discord & WhatsApp', subtitle: 'Connect external messaging channels.', group: 'integrations', kind: 'integration', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'remote-nodes', path: '/remote-nodes', label: 'Remote Nodes', title: 'Remote Nodes', subtitle: 'Pair and monitor remote worker nodes.', group: 'integrations', kind: 'integration', layout: 'standard', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'ask-council', path: '/ask-council', label: 'Ask Council', title: 'Ask Council', subtitle: 'Compare answers across multiple providers.', group: 'agents', kind: 'workflow', layout: 'wide', showInDashboardNav: false, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'fleet', path: '/fleet', label: 'Fleet Dashboard', title: 'Fleet Dashboard', subtitle: 'Monitor attention zones across the agent fleet.', group: 'monitoring', kind: 'diagnostic', layout: 'wide', showInDashboardNav: true, showInControlNav: true, showInSettingsNav: false }),
  surface({ id: 'compare-split', path: '/compare/split', label: 'Split Compare', title: 'Split Compare', subtitle: 'Compare two sessions side by side.', group: 'monitoring', kind: 'tool', layout: 'fullBleed', showInDashboardNav: false, showInControlNav: true, showInSettingsNav: false }),
];

const CONTROL_SURFACE_BY_ID = new Map<ControlSurfaceId, ControlSurfaceItem>(
  CONTROL_SURFACES.map((surface) => [surface.id, surface]),
);

export function listControlSurfaces(): readonly ControlSurfaceItem[] {
  return CONTROL_SURFACES;
}

export function tryGetControlSurface(id: string): ControlSurfaceItem | undefined {
  return CONTROL_SURFACE_BY_ID.get(id as ControlSurfaceId);
}

export function getControlSurface(id: ControlSurfaceId): ControlSurfaceItem {
  const surface = CONTROL_SURFACE_BY_ID.get(id);
  if (!surface) {
    throw new Error(`Unknown control surface: ${id}`);
  }
  return surface;
}

export function listControlNavGroups(): readonly ControlSurfaceNavGroup[] {
  return groupSurfaces(CONTROL_SURFACES.filter((surface) => surface.showInControlNav));
}

export function listDashboardNavGroups(): readonly ControlSurfaceNavGroup[] {
  return groupSurfaces(CONTROL_SURFACES.filter((surface) => surface.showInDashboardNav));
}

export function listSettingsExternalLinks(): readonly ControlSurfaceItem[] {
  return CONTROL_SURFACES.filter((surface) => surface.showInSettingsNav);
}

function groupSurfaces(items: readonly ControlSurfaceItem[]): readonly ControlSurfaceNavGroup[] {
  return GROUP_ORDER
    .map((group) => ({
      id: group,
      label: GROUP_LABELS[group],
      items: items.filter((item) => item.group === group),
    }))
    .filter((group) => group.items.length > 0);
}
```

- [ ] **Step 1.4: Create the nav helper file**

Create `src/renderer/app/shared/control-surface/control-surface-nav.ts` as a thin re-export so consumers import nav functions from one place:

```ts
export {
  getControlSurface,
  listControlNavGroups,
  listControlSurfaces,
  listDashboardNavGroups,
  listSettingsExternalLinks,
  tryGetControlSurface,
} from './control-surface.registry';

export type {
  ControlSurfaceGroup,
  ControlSurfaceId,
  ControlSurfaceItem,
  ControlSurfaceKind,
  ControlSurfaceLayout,
  ControlSurfaceNavGroup,
  ControlSurfaceRouteData,
} from './control-surface.types';
```

- [ ] **Step 1.5: Add registry tests**

Create `src/renderer/app/shared/control-surface/control-surface.registry.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { listControlNavGroups, listControlSurfaces, listDashboardNavGroups, listSettingsExternalLinks } from './control-surface.registry';
import type { ControlSurfaceGroup, ControlSurfaceKind, ControlSurfaceLayout } from './control-surface.types';

const EXPECTED_PATHS = [
  '/settings',
  '/chat-search',
  '/automations',
  '/campaigns',
  '/workflows',
  '/hooks',
  '/skills',
  '/reviews',
  '/specialists',
  '/worktrees',
  '/supervision',
  '/rlm',
  '/training',
  '/memory',
  '/memory/stats',
  '/debate',
  '/verification',
  '/verification/settings',
  '/lsp',
  '/mcp',
  '/browser',
  '/vcs',
  '/tasks',
  '/plan',
  '/stats',
  '/cost',
  '/snapshots',
  '/replay',
  '/remote-access',
  '/search',
  '/security',
  '/logs',
  '/observations',
  '/knowledge',
  '/plugins',
  '/models',
  '/remote-config',
  '/communication',
  '/multi-edit',
  '/editor',
  '/archive',
  '/semantic-search',
  '/channels',
  '/remote-nodes',
  '/ask-council',
  '/fleet',
  '/compare/split',
] as const;

const VALID_GROUPS: readonly ControlSurfaceGroup[] = [
  'settings',
  'automation',
  'agents',
  'knowledge',
  'code',
  'monitoring',
  'integrations',
  'storage',
];

const VALID_KINDS: readonly ControlSurfaceKind[] = [
  'setting',
  'tool',
  'view',
  'diagnostic',
  'integration',
  'workflow',
];

const VALID_LAYOUTS: readonly ControlSurfaceLayout[] = ['standard', 'wide', 'fullBleed'];

describe('control surface registry', () => {
  it('has unique ids and paths', () => {
    const surfaces = listControlSurfaces();

    expect(new Set(surfaces.map((surface) => surface.id)).size).toBe(surfaces.length);
    expect(new Set(surfaces.map((surface) => surface.path)).size).toBe(surfaces.length);
  });

  it('contains every in-scope route path', () => {
    const paths = listControlSurfaces().map((surface) => surface.path).sort();

    expect(paths).toEqual([...EXPECTED_PATHS].sort());
  });

  it('has valid metadata for every surface', () => {
    for (const surface of listControlSurfaces()) {
      expect(surface.path.startsWith('/')).toBe(true);
      expect(surface.label.trim()).not.toBe('');
      expect(surface.title.trim()).not.toBe('');
      expect(surface.icon.trim()).not.toBe('');
      expect(VALID_GROUPS).toContain(surface.group);
      expect(VALID_KINDS).toContain(surface.kind);
      expect(VALID_LAYOUTS).toContain(surface.layout);
    }
  });

  it('keeps dashboard and settings links inside the Control Center nav', () => {
    const controlIds = new Set(listControlNavGroups().flatMap((group) => group.items.map((item) => item.id)));
    const dashboardIds = listDashboardNavGroups().flatMap((group) => group.items.map((item) => item.id));
    const settingsExternalIds = listSettingsExternalLinks().map((item) => item.id);

    for (const id of [...dashboardIds, ...settingsExternalIds]) {
      expect(controlIds.has(id)).toBe(true);
    }
  });
});
```

- [ ] **Step 1.6: Run targeted registry tests**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/shared/control-surface/control-surface.registry.spec.ts
```

Expected after Step 1.3 is complete: PASS.

### Task 2: Add Route Audit Tests Before Moving Routes

**Files:**
- Create: `src/renderer/app/app.routes.spec.ts`
- Modify later: `src/renderer/app/app.routes.ts`

**Interfaces:**
- Consumes: `routes` from `app.routes.ts`, `listControlSurfaces()` from the registry.
- Produces: tests that fail until Task 4 wraps routes under the shell.

- [ ] **Step 2.1: Add route-audit spec**

Create `src/renderer/app/app.routes.spec.ts`:

```ts
import type { Route, Routes } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { listControlSurfaces } from './shared/control-surface/control-surface.registry';
import { routes } from './app.routes';

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function childPath(parent: string, child: string | undefined): string {
  if (!child) {
    return parent || '/';
  }
  const joined = `${parent}/${child}`.replace(/\/+/g, '/');
  return normalizePath(joined);
}

function routeHasControlSurfaceData(route: Route): boolean {
  return typeof route.data?.['controlSurfaceId'] === 'string';
}

function collectTopLevelPaths(appRoutes: Routes): string[] {
  return appRoutes
    .filter((route) => route.path && !route.redirectTo)
    .map((route) => normalizePath(route.path as string));
}

function findShellRoute(appRoutes: Routes): Route | undefined {
  return appRoutes.find((route) =>
    route.path === ''
    && Boolean(route.children?.length)
    && route.loadComponent !== undefined
  );
}

function collectShellChildPaths(shellRoute: Route): string[] {
  return (shellRoute.children ?? [])
    .filter((route) => route.path && !route.redirectTo)
    .map((route) => childPath('', route.path));
}

describe('app routes', () => {
  it('keeps dashboard, setup, operator redirect, and catch-all outside the Control Center shell', () => {
    const topLevelPaths = collectTopLevelPaths(routes);

    expect(topLevelPaths).toContain('/setup');
    expect(routes.find((route) => route.path === '')?.children).toBeUndefined();
    expect(routes.find((route) => route.path === 'operator')?.redirectTo).toBe('');
    expect(routes.find((route) => route.path === '**')?.redirectTo).toBe('');
  });

  it('places every Control Surface route under the shell route', () => {
    const shellRoute = findShellRoute(routes);
    expect(shellRoute).toBeDefined();

    const shellPaths = new Set(collectShellChildPaths(shellRoute as Route));

    for (const surface of listControlSurfaces()) {
      expect(shellPaths.has(surface.path)).toBe(true);
    }
  });

  it('does not leave Control Surface routes as top-level siblings', () => {
    const topLevelPaths = new Set(collectTopLevelPaths(routes));

    for (const surface of listControlSurfaces()) {
      expect(topLevelPaths.has(surface.path)).toBe(false);
    }
  });

  it('adds control surface metadata to every shell child route', () => {
    const shellRoute = findShellRoute(routes);
    expect(shellRoute).toBeDefined();

    for (const child of (shellRoute as Route).children ?? []) {
      if (!child.redirectTo) {
        expect(routeHasControlSurfaceData(child)).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2.2: Run the route-audit spec and confirm it fails for the expected reason**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/app.routes.spec.ts
```

Expected before Task 4: FAIL because there is not yet a shell route containing all Control Surface children.

### Task 3: Build The Control Surface Shell

**Files:**
- Create: `src/renderer/app/shared/control-surface/control-surface-shell.component.ts`
- Create: `src/renderer/app/shared/control-surface/control-surface-shell.component.html`
- Create: `src/renderer/app/shared/control-surface/control-surface-shell.component.scss`
- Create: `src/renderer/app/shared/control-surface/control-surface-shell.component.spec.ts`

**Interfaces:**
- Consumes: `controlSurfaceId` route data from child routes.
- Consumes: registry lookup/nav helpers from Task 1.
- Produces: a reusable shell with a visible text Back button, route title/subtitle, grouped Control Center nav, layout classes, and child `<router-outlet />`.

- [ ] **Step 3.1: Create shell component class**

Create `src/renderer/app/shared/control-surface/control-surface-shell.component.ts`:

```ts
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, startWith } from 'rxjs';
import { getControlSurface, listControlNavGroups, tryGetControlSurface } from './control-surface.registry';
import type { ControlSurfaceId, ControlSurfaceItem } from './control-surface.types';

@Component({
  selector: 'app-control-surface-shell',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './control-surface-shell.component.html',
  styleUrl: './control-surface-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ControlSurfaceShellComponent {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly navGroups = listControlNavGroups();
  private readonly activeSurfaceId = signal<ControlSurfaceId | null>(null);
  protected readonly activeSurface = computed<ControlSurfaceItem>(() => {
    const id = this.activeSurfaceId();
    return id ? getControlSurface(id) : getControlSurface('settings');
  });
  protected readonly layoutClass = computed(() => `layout-${this.activeSurface().layout}`);

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        startWith(null),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.activeSurfaceId.set(this.findActiveSurfaceId()));
  }

  protected backToDashboard(): void {
    const target = this.activeSurface().backRoute ?? '/';
    void this.router.navigateByUrl(target);
  }

  private findActiveSurfaceId(): ControlSurfaceId | null {
    let current: ActivatedRoute | null = this.route;
    let lastId: ControlSurfaceId | null = null;

    while (current) {
      const value = current.snapshot.data['controlSurfaceId'];
      if (typeof value === 'string' && tryGetControlSurface(value)) {
        lastId = value as ControlSurfaceId;
      }
      current = current.firstChild;
    }

    return lastId;
  }
}
```

- [ ] **Step 3.2: Create shell template**

Create `src/renderer/app/shared/control-surface/control-surface-shell.component.html`:

```html
<section class="control-shell" [class]="layoutClass()">
  <header class="control-header">
    <button class="control-back" type="button" (click)="backToDashboard()" aria-label="Back to dashboard">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M19 12H5" />
        <path d="M12 19l-7-7 7-7" />
      </svg>
      <span>Back</span>
    </button>

    <div class="control-title-block">
      <p class="control-kicker">Control Center</p>
      <h1>{{ activeSurface().title }}</h1>
      @if (activeSurface().subtitle) {
        <p class="control-subtitle">{{ activeSurface().subtitle }}</p>
      }
    </div>
  </header>

  <div class="control-body">
    <aside class="control-nav" aria-label="Control Center navigation">
      @for (group of navGroups; track group.id) {
        <section class="control-nav-group">
          <h2>{{ group.label }}</h2>
          @for (item of group.items; track item.id) {
            <a
              class="control-nav-item"
              [routerLink]="item.path"
              routerLinkActive="active"
              [routerLinkActiveOptions]="{ exact: item.path !== '/channels' && item.path !== '/campaigns' }"
            >
              <svg class="control-nav-icon" viewBox="0 0 24 24" aria-hidden="true" [innerHTML]="item.icon"></svg>
              <span>{{ item.label }}</span>
            </a>
          }
        </section>
      }
    </aside>

    <main class="control-content">
      <router-outlet />
    </main>
  </div>
</section>
```

- [ ] **Step 3.3: Create shell SCSS**

Create `src/renderer/app/shared/control-surface/control-surface-shell.component.scss`. Keep the shell utilitarian and dense; do not add decorative cards around the page content.

Use this structure:

```scss
:host {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.control-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.control-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-elevated);
}

.control-back {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 76px;
  height: 34px;
  padding: 0 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  font-weight: 700;
  cursor: pointer;
}

.control-back:hover {
  background: var(--glass-strong);
}

.control-back svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.control-title-block {
  min-width: 0;
}

.control-kicker,
.control-subtitle {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.control-kicker {
  text-transform: uppercase;
  letter-spacing: 0;
  font-weight: 700;
}

.control-title-block h1 {
  margin: 0.1rem 0;
  color: var(--text-primary);
  font-size: 1.1rem;
  line-height: 1.2;
}

.control-body {
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: minmax(210px, 250px) minmax(0, 1fr);
  min-height: 0;
}

.control-nav {
  min-height: 0;
  overflow: auto;
  padding: 0.85rem;
  border-right: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.control-nav-group + .control-nav-group {
  margin-top: 1rem;
}

.control-nav-group h2 {
  margin: 0 0 0.4rem;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0;
}

.control-nav-item {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-height: 32px;
  padding: 0.35rem 0.5rem;
  border-radius: 6px;
  color: var(--text-secondary);
  text-decoration: none;
  font-size: var(--text-sm);
}

.control-nav-item:hover,
.control-nav-item.active {
  background: var(--glass-strong);
  color: var(--text-primary);
}

.control-nav-icon {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.control-content {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
}

.control-content > router-outlet {
  display: contents;
}

.control-content > * {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.layout-wide .control-body {
  grid-template-columns: minmax(190px, 220px) minmax(0, 1fr);
}

.layout-fullBleed .control-body {
  grid-template-columns: minmax(170px, 200px) minmax(0, 1fr);
}

@media (max-width: 840px) {
  .control-header {
    align-items: flex-start;
    padding: 0.75rem;
  }

  .control-body {
    grid-template-columns: 1fr;
  }

  .control-nav {
    display: flex;
    gap: 0.5rem;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--border-color);
  }

  .control-nav-group {
    flex: 0 0 auto;
    min-width: 180px;
  }
}
```

- [ ] **Step 3.4: Add shell tests**

Create `src/renderer/app/shared/control-surface/control-surface-shell.component.spec.ts` with TestBed, a Router stub, and route stubs. Test at least:

```ts
it('renders a visible text Back button', () => {
  const button = fixture.nativeElement.querySelector('.control-back') as HTMLButtonElement | null;
  expect(button?.textContent?.trim()).toContain('Back');
});

it('navigates to the active surface backRoute or dashboard', () => {
  const button = fixture.nativeElement.querySelector('.control-back') as HTMLButtonElement;
  button.click();
  expect(router.navigateByUrl).toHaveBeenCalledWith('/');
});

it('renders grouped Control Center navigation from the registry', () => {
  expect(fixture.nativeElement.textContent).toContain('Control Center');
  expect(fixture.nativeElement.textContent).toContain('Settings');
  expect(fixture.nativeElement.textContent).toContain('Automations');
});
```

The route-stub setup may use a minimal object cast to `ActivatedRoute` with `snapshot.data.controlSurfaceId = 'automations'` and `firstChild = null`.

- [ ] **Step 3.5: Run shell tests**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/shared/control-surface/control-surface-shell.component.spec.ts
```

Expected: PASS.

### Task 4: Wrap Routes Under The Shell

**Files:**
- Modify: `src/renderer/app/app.routes.ts`
- Test: `src/renderer/app/app.routes.spec.ts`
- Test: `src/renderer/app/shared/control-surface/control-surface.registry.spec.ts`

**Interfaces:**
- Consumes: `controlSurfaceRouteData(id)` from Task 1.
- Produces: shell-managed secondary routes with preserved paths.

- [ ] **Step 4.1: Import route-data helper**

At the top of `src/renderer/app/app.routes.ts`, add:

```ts
import { controlSurfaceRouteData } from './shared/control-surface/control-surface-route-data';
```

- [ ] **Step 4.2: Move secondary routes into `controlSurfaceRoutes`**

Restructure `app.routes.ts` to this shape:

```ts
const controlSurfaceRoutes: Routes = [
  {
    path: 'settings',
    data: controlSurfaceRouteData('settings'),
    loadComponent: () =>
      import('./features/settings/settings.component').then((m) => m.SettingsComponent),
  },
  {
    path: 'chat-search',
    data: controlSurfaceRouteData('chat-search'),
    loadComponent: () =>
      import('./features/chat-search/chat-search-page.component').then((m) => m.ChatSearchPageComponent),
  }
];

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
  },
  {
    path: '',
    loadComponent: () =>
      import('./shared/control-surface/control-surface-shell.component').then(
        (m) => m.ControlSurfaceShellComponent,
      ),
    children: controlSurfaceRoutes,
  },
  {
    path: 'operator',
    redirectTo: '',
  },
  {
    path: 'setup',
    loadComponent: () =>
      import('./features/setup/setup-center.component').then((m) => m.SetupCenterComponent),
  },
  {
    path: '**',
    redirectTo: '',
  },
];
```

When moving routes:

- Keep `path` values unchanged.
- Keep `loadComponent` and `loadChildren` imports unchanged.
- Add `data: controlSurfaceRouteData('<id>')` to every shell child.
- Add the remaining route objects in this exact path/id order after the two example entries above: `automations`, `campaigns`, `workflows`, `hooks`, `skills`, `reviews`, `specialists`, `worktrees`, `supervision`, `rlm`, `training`, `memory`, `memory/stats`, `debate`, `verification`, `verification/settings`, `lsp`, `mcp`, `browser`, `vcs`, `tasks`, `plan`, `stats`, `cost`, `snapshots`, `replay`, `remote-access`, `search`, `security`, `logs`, `observations`, `knowledge`, `plugins`, `models`, `remote-config`, `communication`, `multi-edit`, `editor`, `archive`, `semantic-search`, `channels`, `remote-nodes`, `ask-council`, `fleet`, `compare/split`.
- Use these route-data IDs for the paths that do not match their ID text exactly: `memory/stats` -> `memory-stats`, `verification/settings` -> `verification-settings`, and `compare/split` -> `compare-split`.
- Put `operator` redirect outside shell.
- Put `setup` outside shell.
- Put catch-all outside shell.
- Put `campaigns` parent under shell with `controlSurfaceRouteData('campaigns')`.
- Put `channels` parent under shell with `controlSurfaceRouteData('channels')`.

- [ ] **Step 4.3: Run route and registry tests**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/app.routes.spec.ts src/renderer/app/shared/control-surface/control-surface.registry.spec.ts
```

Expected after route wrapping: PASS.

### Task 5: Replace Dashboard Navigation Source

**Files:**
- Modify: `src/renderer/app/features/dashboard/sidebar-nav.component.ts`
- Test: add `src/renderer/app/features/dashboard/sidebar-nav.component.spec.ts` if no existing coverage catches this.

**Interfaces:**
- Consumes: `listDashboardNavGroups()` from Task 1.
- Produces: dashboard Tools & Views derived from the registry.

- [ ] **Step 5.1: Replace local nav interfaces with registry types**

In `sidebar-nav.component.ts`, remove the local `NavItem`, `NavGroup`, and `NAV_GROUPS` declarations after their metadata has been moved into `CONTROL_SURFACES`.

Add:

```ts
import { listDashboardNavGroups } from '../../shared/control-surface/control-surface-nav';
```

Set:

```ts
readonly groups = listDashboardNavGroups();
```

- [ ] **Step 5.2: Update template property names**

Keep the existing template structure, but replace:

```html
@for (item of group.items; track item.route) {
  <a class="nav-item"
    [routerLink]="item.route"
    routerLinkActive="active"
    [title]="item.label">
```

with:

```html
@for (item of group.items; track item.id) {
  <a class="nav-item"
    [routerLink]="item.path"
    routerLinkActive="active"
    [title]="item.label">
```

Replace the automation badge condition:

```html
@if (item.route === '/automations' && unreadAutomations() > 0) {
```

with:

```html
@if (item.id === 'automations' && unreadAutomations() > 0) {
```

Keep `[innerHTML]="item.icon"` unchanged.

- [ ] **Step 5.3: Add or update dashboard nav test**

If no component test exists, add `src/renderer/app/features/dashboard/sidebar-nav.component.spec.ts` with assertions that `Automations`, `Browser Gateway`, `Models`, and `Background Jobs` render, and that `/settings` does not render in dashboard Tools & Views.

- [ ] **Step 5.4: Run dashboard nav tests**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/features/dashboard/sidebar-nav.component.spec.ts
```

Expected: PASS.

### Task 6: Keep Settings Internal Tabs, Remove Settings-Owned Tool Source Of Truth

**Files:**
- Modify: `src/renderer/app/features/settings/settings-navigation.ts`
- Modify: `src/renderer/app/features/settings/settings.component.ts`
- Modify: `src/renderer/app/features/settings/settings.component.html`
- Modify: `src/renderer/app/features/settings/settings-navigation.spec.ts`
- Test: `src/renderer/app/features/settings/settings.component.spec.ts`

**Interfaces:**
- Consumes: `listSettingsExternalLinks()` from Task 1.
- Produces: settings still works as one route, with internal sections intact and no primary local Back button.

- [ ] **Step 6.1: Keep settings tab union unchanged for Wave 1**

Do not remove these `SettingsTab` members in this pass:

```ts
| 'models'
| 'mcp'
| 'hooks'
| 'worktrees'
| 'snapshots'
| 'archive'
| 'remote-config'
```

They are still embedded settings tabs until a later URL cleanup.

- [ ] **Step 6.2: Add registry-derived external links without changing tab rendering**

In `settings-navigation.ts`, import:

```ts
import { listSettingsExternalLinks } from '../../shared/control-surface/control-surface-nav';
```

Export:

```ts
export const SETTINGS_EXTERNAL_LINKS = listSettingsExternalLinks();
```

This gives settings and Control Center a shared source for tool-like entries without removing the embedded tabs prematurely.

- [ ] **Step 6.3: Remove Settings sidebar Back button**

In `settings.component.html`, remove only this block:

```html
<div class="sidebar-header">
  <button class="back-btn" type="button" (click)="goBack()" aria-label="Back to dashboard">
    <app-settings-nav-icon name="back" />
    <span>Back</span>
  </button>
</div>
```

Do not remove search, nav, help pane, wide tab rendering, or `Escape` behavior.

- [ ] **Step 6.4: Keep `goBack()` for Escape and legacy modal callers**

In `settings.component.ts`, keep:

```ts
goBack(): void {
  this.closeDialog.emit();
  void this.router.navigate(['/']);
}
```

This preserves `Escape` behavior and modal close behavior. The visible route-level Back button now comes from the shell.

- [ ] **Step 6.5: Update Settings menu command**

In `app.component.ts`, replace:

```ts
void this.router.navigate(['/settings']);
```

inside the `menu:open-settings` listener with:

```ts
void this.router.navigateByUrl(getControlSurface('settings').path);
```

Add the import:

```ts
import { getControlSurface } from './shared/control-surface/control-surface-nav';
```

- [ ] **Step 6.6: Update settings navigation tests**

Extend `settings-navigation.spec.ts`:

```ts
import { SETTINGS_EXTERNAL_LINKS } from './settings-navigation';

it('derives tool-like settings links from the Control Surface registry', () => {
  expect(SETTINGS_EXTERNAL_LINKS.map((item) => item.id).sort()).toEqual([
    'archive',
    'hooks',
    'mcp',
    'models',
    'remote-config',
    'snapshots',
    'worktrees',
  ].sort());
});
```

- [ ] **Step 6.7: Run settings tests**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/features/settings/settings-navigation.spec.ts src/renderer/app/features/settings/settings.component.spec.ts
```

Expected: PASS.

### Task 7: Remove The App-Level Route Backstop

**Files:**
- Modify: `src/renderer/app/app.component.ts`
- Modify: `src/renderer/app/app.component.html`
- Modify: `src/renderer/app/app.component.scss`
- Modify: `src/renderer/app/app.component.spec.ts`

**Interfaces:**
- Consumes: shell route coverage from Task 4.
- Produces: no global Back button outside the Control Center shell.

- [ ] **Step 7.1: Remove route-backstop state and binding from `app.component.ts`**

Remove these imports if they become unused:

```ts
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
```

Replace with:

```ts
import { Router, RouterOutlet } from '@angular/router';
```

Remove these members:

```ts
private routerEventsSubscription: { unsubscribe(): void } | null = null;
protected readonly currentRouteUrl = signal(this.router.url || '/');
protected readonly showRouteBackstop = computed(() => this.isNonDashboardRoute(this.currentRouteUrl()));
```

Remove this call from `ngOnInit()`:

```ts
this.bindRouteBackstop();
```

Remove these methods:

```ts
protected goToDashboard(): void {
  void this.router.navigate(['/']);
}

private bindRouteBackstop(): void {
  this.currentRouteUrl.set(this.router.url || '/');
  this.routerEventsSubscription?.unsubscribe();
  this.routerEventsSubscription = this.router.events.subscribe((event) => {
    if (event instanceof NavigationEnd) {
      this.currentRouteUrl.set(event.urlAfterRedirects || event.url || '/');
    }
  });
}

private isNonDashboardRoute(url: string): boolean {
  const path = url.split(/[?#]/)[0] || '/';
  return path !== '/';
}
```

Remove the cleanup lines from `ngOnDestroy()`:

```ts
this.routerEventsSubscription?.unsubscribe();
this.routerEventsSubscription = null;
```

- [ ] **Step 7.2: Remove route-backstop template block**

In `app.component.html`, remove the whole `@if (showRouteBackstop())` block that renders:

```html
<button
  type="button"
  class="route-backstop"
  data-testid="route-backstop"
>
```

- [ ] **Step 7.3: Remove route-backstop styles**

In `app.component.scss`, remove the complete selector blocks for `.route-backstop`, `.route-backstop.macos`, `.route-backstop:hover`, and `.route-backstop svg`.

Keep title-bar overlay, startup banner, app-main, and toast styles.

- [ ] **Step 7.4: Update AppComponent spec**

In `app.component.spec.ts`, remove:

```ts
import { NavigationEnd, Router } from '@angular/router';
import { Subject } from 'rxjs';
```

and replace the router stub with:

```ts
let router: { navigate: ReturnType<typeof vi.fn>; navigateByUrl: ReturnType<typeof vi.fn>; url: string };
```

Use:

```ts
router = {
  navigate: vi.fn(),
  navigateByUrl: vi.fn(),
  url: '/',
};
```

Delete the two route-backstop tests named `does not show the route fallback back button on the dashboard route` and `shows a route fallback back button on non-dashboard routes`.

- [ ] **Step 7.5: Run AppComponent tests**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/app.component.spec.ts
```

Expected: PASS.

### Task 8: Remove Per-Component Primary Back Buttons

**Files:**
- Modify only components whose Back button is a primary route Back control.
- Do not modify `/setup` Back behavior.
- Do not remove local tab/wizard/detail navigation.

**Interfaces:**
- Consumes: shell Back button from Task 3.
- Produces: no duplicated primary Back buttons inside migrated Control Surface routes.

- [ ] **Step 8.1: Generate the removal list**

Run:

```bash
rtk rg -n "routerLink=\"/\"|goBack\\(|Back|back-button|backRoute|navigate\\(\\['/'\\]\\)" src/renderer/app/features src/renderer/app/shared/components/page-header/page-header.component.ts
```

Classify each hit:

- Remove: primary Back to dashboard inside a Control Surface route.
- Keep: `/setup` Back to workspace.
- Keep: image lightbox, menu keyboard ArrowLeft, local previous/next, modal backdrop, source-control diff overlay.
- Keep: `PageHeaderComponent.backRoute` API if there are still non-Control-Surface local consumers; otherwise leave it for compatibility and stop passing `backRoute` from migrated pages.

- [ ] **Step 8.2: Remove obvious route Back controls**

For each migrated page:

- Remove the button markup.
- Remove the `goBack()` or `navigateBack()` method only if no other local code calls it.
- Remove `Router` injection/imports only if no remaining local navigation uses them.
- Remove CSS selectors that existed only for that Back button.
- Update tests that asserted local Back to assert shell Back at shell level instead.

Known files likely requiring edits:

```text
src/renderer/app/features/automations/automations-page.component.html
src/renderer/app/features/automations/automations-page.component.ts
src/renderer/app/features/browser/browser-page.component.html
src/renderer/app/features/browser/browser-page.component.ts
src/renderer/app/features/campaign/campaign-page.component.html
src/renderer/app/features/campaign/campaign-page.component.ts
src/renderer/app/features/channels/channels-page.component.ts
src/renderer/app/features/channels/components/channel-connections/channel-connections.component.ts
src/renderer/app/features/channels/components/channel-messages/channel-messages.component.ts
src/renderer/app/features/channels/components/channel-settings/channel-settings.component.ts
src/renderer/app/features/chat-search/chat-search-page.component.ts
src/renderer/app/features/codebase/codebase-page.component.ts
src/renderer/app/features/communication/communication-page.component.ts
src/renderer/app/features/compare/ask-council-page.component.ts
src/renderer/app/features/compare/split-session-compare.component.html
src/renderer/app/features/compare/split-session-compare.component.ts
src/renderer/app/features/cost/cost-page.component.html
src/renderer/app/features/cost/cost-page.component.ts
src/renderer/app/features/debate/debate-page.component.ts
src/renderer/app/features/editor/editor-page.component.ts
src/renderer/app/features/fleet-dashboard/fleet-dashboard.component.ts
src/renderer/app/features/hooks/hooks-page.component.ts
src/renderer/app/features/knowledge/knowledge-page.component.ts
src/renderer/app/features/logs/logs-page.component.ts
src/renderer/app/features/lsp/lsp-page.component.html
src/renderer/app/features/lsp/lsp-page.component.ts
src/renderer/app/features/mcp/mcp-page.component.html
src/renderer/app/features/mcp/mcp-page.component.ts
src/renderer/app/features/memory/memory-page.component.ts
src/renderer/app/features/memory/memory-stats.component.ts
src/renderer/app/features/models/models-page.component.ts
src/renderer/app/features/multi-edit/multi-edit-page.component.ts
src/renderer/app/features/observations/observations-page.component.ts
src/renderer/app/features/plan/plan-page.component.ts
src/renderer/app/features/plugins/plugins-page.component.ts
src/renderer/app/features/remote-access/remote-access-page.component.ts
src/renderer/app/features/remote-config/remote-config-page.component.ts
src/renderer/app/features/remote-nodes/remote-nodes-page.component.ts
src/renderer/app/features/replay/session-replay-page.component.ts
src/renderer/app/features/review/reviews-page.component.ts
src/renderer/app/features/rlm/rlm-page.component.ts
src/renderer/app/features/security/security-page.component.html
src/renderer/app/features/security/security-page.component.ts
src/renderer/app/features/semantic-search/semantic-search-page.component.ts
src/renderer/app/features/skills/skills-page.component.ts
src/renderer/app/features/snapshots/snapshot-page.component.html
src/renderer/app/features/snapshots/snapshot-page.component.ts
src/renderer/app/features/specialists/specialists-page.component.ts
src/renderer/app/features/stats/stats-page.component.ts
src/renderer/app/features/supervision/supervision-page.component.ts
src/renderer/app/features/tasks/tasks-page.component.ts
src/renderer/app/features/training/training-page.component.ts
src/renderer/app/features/vcs/vcs-page.component.html
src/renderer/app/features/vcs/vcs-page.component.ts
src/renderer/app/features/verification/config/cli-settings-panel.component.html
src/renderer/app/features/verification/config/cli-settings-panel.component.ts
src/renderer/app/features/verification/dashboard/verification-dashboard.component.html
src/renderer/app/features/verification/dashboard/verification-dashboard.component.ts
src/renderer/app/features/workflow/workflow-page.component.ts
src/renderer/app/features/worktree/worktree-page.component.ts
```

- [ ] **Step 8.3: Run targeted feature tests in batches**

Run smaller batches to keep failures readable:

```bash
rtk npm run test:quiet -- src/renderer/app/features/browser src/renderer/app/features/channels src/renderer/app/features/settings
rtk npm run test:quiet -- src/renderer/app/features/verification src/renderer/app/features/compare src/renderer/app/features/remote-nodes
rtk npm run test:quiet -- src/renderer/app/features/tasks src/renderer/app/features/replay src/renderer/app/features/memory src/renderer/app/features/automations
```

Expected: PASS after component tests are updated.

### Task 9: Browser Smoke Test The Shell

**Files:**
- No source files unless smoke testing exposes a bug.

**Interfaces:**
- Consumes: built app behavior.
- Produces: manual evidence that the Back guarantee works in the real UI.

- [ ] **Step 9.1: Start the app**

Run:

```bash
rtk npm run dev
```

Expected: Electron dev app starts. If the port/process is already active, attach to the existing dev app and note that in the final report.

- [ ] **Step 9.2: Desktop smoke path**

At desktop width, visit these routes through in-app navigation or client-side routing:

```text
/settings
/chat-search
/automations
/campaigns
/channels
/channels/messages
/memory/stats
/verification/settings
/remote-access
/remote-nodes
/compare/split
```

For each route:

- Confirm the shell header is visible.
- Confirm the Back button contains visible text `Back`.
- Click Back.
- Confirm the app returns to `/`.

- [ ] **Step 9.3: Narrow-width smoke path**

At a narrow/mobile viewport, repeat:

```text
/settings
/channels/settings
/compare/split
```

Confirm:

- Back text remains visible.
- The nav does not overlap the page content.
- Full-bleed content remains usable.

### Task 10: Final Verification Gate

**Files:**
- All changed files.

**Interfaces:**
- Produces: final evidence before claiming completion.

- [ ] **Step 10.1: Typecheck app code**

Run:

```bash
rtk npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 10.2: Typecheck spec code**

Run:

```bash
rtk npx tsc --noEmit -p tsconfig.spec.json
```

Expected: PASS.

- [ ] **Step 10.3: Run lint**

Run:

```bash
rtk npm run lint
```

Expected: PASS.

- [ ] **Step 10.4: Run TypeScript LOC ratchet**

Run:

```bash
rtk npm run check:ts-max-loc
```

Expected: PASS. If a new file breaches the ratchet, split it by responsibility instead of raising the limit.

- [ ] **Step 10.5: Run targeted tests**

Run:

```bash
rtk npm run test:quiet -- \
  src/renderer/app/app.routes.spec.ts \
  src/renderer/app/app.component.spec.ts \
  src/renderer/app/shared/control-surface \
  src/renderer/app/features/dashboard/sidebar-nav.component.spec.ts \
  src/renderer/app/features/settings
```

Expected: PASS.

- [ ] **Step 10.6: Run full quiet suite**

Run:

```bash
rtk npm run test:quiet
```

Expected: PASS.

- [ ] **Step 10.7: Final report checklist**

Report the actual status of each item:

```text
- Registry and route audit: pass/fail
- Shell Back visible on desktop and narrow widths: pass/fail
- Dashboard nav derives from registry: pass/fail
- Settings remains functional with internal tabs: pass/fail
- App-level route-backstop removed: pass/fail
- Per-page primary Back buttons removed: pass/fail
- Existing routes preserved: pass/fail
- Typecheck/spec typecheck/lint/LOC/full tests: pass/fail
```
