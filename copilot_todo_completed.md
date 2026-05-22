# AI Orchestrator GUI + settings improvement backlog

Based on a code review of AI Orchestrator plus nearby projects:

- **AI Orchestrator:** `src/renderer/app/features/dashboard/*`, `src/renderer/app/features/settings/*`, `src/renderer/styles/_theme.scss`, `src/renderer/styles/_base.scss`, `src/renderer/app/core/state/settings.store.ts`
- **CodePilot:** `src/components/settings/SettingsLayout.tsx`, `src/components/layout/AppShell.tsx`, `src/components/layout/NavRail.tsx`, `src/app/globals.css`
- **Actual Claude:** `components/Settings/Settings.tsx`, `components/design-system/ThemeProvider.tsx`
- **Agent Orchestrator:** `packages/web/src/app/loading.tsx`, `packages/web/src/app/projects/[projectId]/loading.tsx`
- **Online Orchestrator:** `multi-ai-query/sidepanel/sidepanel.css`, `multi-ai-query/popup/popup.css`

## Highest priority

1. **Rebuild settings into a proper workspace, not just a list of tabs.**
   - Add a sticky header, icons, search, section summaries, and better grouping.
   - Persist the active section with hash links and last-opened state.
   - Current gap: `settings.component.ts` is functional, but visually plain and text-heavy compared with `CodePilot/src/components/settings/SettingsLayout.tsx`.

2. **Add live appearance preview with apply/cancel for theme changes.**
   - Preview light/dark/system, density, font size, and sidebar style before committing.
   - Borrow the "preview vs saved state" model from `Actual Claude/components/design-system/ThemeProvider.tsx`.
   - Current gap: `SettingsStore` applies theme changes immediately with no preview path.

3. **Introduce a richer semantic design token system.**
   - Keep the existing global tokens, but add shell-specific tokens for sidebar, rail, settings cards, badges, status pills, terminal surfaces, charts, and empty states.
   - Borrow the semantic layering from `CodePilot/src/app/globals.css`.
   - Current gap: `_theme.scss` is good at basics, but too much component styling still falls back to one-off `rgba(...)` values.

4. **Extract a reusable settings UI kit.**
   - Build shared components for setting cards, segmented controls, inline help, validation rows, danger zones, copy rows, code preview blocks, and save state banners.
   - Current gap: `setting-row.component.ts` is doing too much with one generic row, and many settings tabs re-implement card styling inline.

5. **Standardize draft/apply/save behavior across settings.**
   - Keep instant-save for low-risk preferences, but use draft/apply/reset flows for network, permissions, remote-node, and other operational settings.
   - Add explicit "Saved", "Saving...", and "Needs restart" states.
   - Current gap: behavior is inconsistent between simple tabs and richer flows like `remote-nodes-settings-tab.component.ts`.

## Dashboard and shell polish

6. **Split the dashboard chrome into a compact nav rail plus a quieter workspace sidebar.**
   - Put global destinations in a slim icon rail, keep session/project selection in the wider sidebar.
   - Borrow the desktop feel, badges, and tooltip-first approach from `CodePilot/src/components/layout/NavRail.tsx`.
   - Current gap: the dashboard sidebar is carrying too many jobs at once.

7. **Promote the control plane from a hidden overlay to a clearer first-class panel.**
   - Make it dockable, pinnable, or structurally integrated into the main shell.
   - Current gap: `dashboard.component.html` hides a lot of navigation inside the "More..." path and a floating panel, which makes discovery feel uneven.

8. **Polish the title bar and top-right status cluster.**
   - Unify updates, quota, pause state, startup health, and background activity into a cleaner top-bar system.
   - Add clearer hierarchy, more spacing consistency, and fewer "floating widget" vibes.
   - Current gap: `app.component.html` and `app.component.scss` feel bolted on rather than designed as one desktop chrome system.

9. **Add workspace layout presets.**
   - Save and switch between layouts like Coding, Research, Review, and Monitoring.
   - Extend `view-layout.service.ts` beyond width persistence into named presets and per-mode panel visibility.

## Smoothness and visual quality

10. **Upgrade loading, empty, and first-run states everywhere.**
    - Add shell skeletons, richer empty states, and next-step actions.
    - Borrow route-level loading polish from `agent-orchestrator/packages/web/src/app/projects/[projectId]/loading.tsx`.
    - Current gap: some paths are polished, but many still fall back to plain text or spinner-only states.

11. **Improve micro-interactions and motion.**
    - Add smoother sidebar collapse, panel docking, hover depth, pressed states, resize affordances, and status animations.
    - Keep a reduced-motion mode.
    - Current gap: the app already has decent transitions, but the shell still feels more functional than premium.

12. **Make settings navigation easier to scan.**
    - Add icons, short summaries, status badges, and "recommended" markers.
    - Surface health warnings directly beside sections like Doctor, CLI Health, Models, and Remote Nodes.
    - Current gap: the left settings nav is just a long text list with little information scent.

13. **Add contextual help and preview panels inside settings.**
    - For complex areas, show examples, runbooks, previews, and live status in a secondary pane.
    - Good candidates: theme/display, models, remote nodes, doctor, permissions.
    - Current gap: some tabs are advanced, but the surrounding shell does not help the user understand them quickly.

14. **Introduce a setup center for environment and provider readiness.**
    - Turn startup checks, provider health, and CLI setup into a guided first-run and recovery flow.
    - Borrow the "setup center" product thinking visible in `CodePilot/src/components/layout/AppShell.tsx`.
    - Current gap: AI Orchestrator has the data already, but not the guided UX.

## Architecture needed for better UI iteration

15. **Move large inline styles out of component decorators and into shared SCSS partials.**
    - Start with `settings.component.ts`, `setting-row.component.ts`, `sidebar-nav.component.ts`, and `sidebar-actions.component.ts`.
    - This will make the design system easier to tune and keep visually consistent.

16. **Create shell-level component standards.**
    - Define patterns for rails, panels, cards, section headers, badges, empty states, and toolbars.
    - Current gap: dashboard, settings, doctor, and feature pages each feel like they were designed in slightly different systems.

17. **Rationalize settings information architecture before adding more tabs.**
    - Separate "daily preferences" from "operator tools" from "advanced diagnostics".
    - Keep powerful pages like MCP, Hooks, Worktrees, Archive, and Doctor, but stop treating all of them like equivalent preference tabs.

18. **Add visual QA checkpoints for the shell and settings.**
    - Capture screenshots for key layouts in dark/light mode and major empty/loading/error states.
    - This is the safest way to keep future polish work from regressing.
