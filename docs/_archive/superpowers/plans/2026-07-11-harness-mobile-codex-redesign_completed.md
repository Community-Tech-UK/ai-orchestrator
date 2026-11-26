# Harness Mobile Codex-Inspired Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Harness Mobile's project browser and new-session flow around the supplied Codex iOS patterns, then apply the same polished visual language across the remaining mobile surfaces.

**Architecture:** Keep `GatewayClient`, `HostStore`, routing, drafts, attachments, dictation, and creation payloads unchanged. Extract pure project/session derivation from `ProjectsComponent`, introduce small presentational primitives under `shared/`, and let feature components continue to own signals and navigation. The work is renderer-only inside `apps/mobile/`.

**Tech Stack:** Angular 21 standalone components, zoneless signals, TypeScript 5.9, SCSS/CSS, Capacitor 7, Vitest 3 with jsdom.

## Global Constraints

- Renderer-only scope: do not change the mobile gateway, contracts, pairing, APNs, or transport.
- Do not add packages or UI/icon dependencies.
- Use true black `#000000`, surfaces `#1c1c1e` and `#2c2c2e`, white primary text, iOS secondary grey, and existing semantic status colours.
- Use one inline-SVG icon language with 1.75-2px rounded strokes; no emoji or font glyphs as structural icons.
- Every interactive target is at least 44 by 44 points and has an accessible name plus pressed, focused, and disabled states.
- Preserve existing live/history routing, drafts, image attachments, dictation, provider/model resolution, and create payload shape.
- Preserve the separate Sessions route for deep links, but make inline project expansion the primary browse path.
- Do not add unsupported branch, worktree, or local/remote execution selectors.
- Respect iOS safe areas, 16px minimum input text, reduced motion, 375px and 393px widths, and landscape.
- Do not commit or push. James has not authorized either operation, so this plan intentionally omits commit steps.
- Preserve all unrelated changes in the existing dirty worktree.

---

## File Structure

### Create

- `apps/mobile/src/app/shared/mobile-icon.component.ts` — typed inline-SVG icon registry and renderer.
- `apps/mobile/src/app/shared/mobile-icon.component.spec.ts` — icon-registry completeness test.
- `apps/mobile/src/app/shared/mobile-header.component.ts` — three-column iOS header with projected leading/trailing actions.
- `apps/mobile/src/app/shared/mobile-sheet.component.ts` — safe-area bottom-sheet shell with scrim dismissal.
- `apps/mobile/src/app/shared/mobile-session-row.component.ts` — shared live/history session row presentation.
- `apps/mobile/src/app/shared/mobile-primitives.component.spec.ts` — header, sheet, and session-row interaction/accessibility tests.
- `apps/mobile/src/app/features/projects/project-list.view-model.ts` — pure project merge, session-row, filter, and route derivation.
- `apps/mobile/src/app/features/projects/project-list.view-model.spec.ts` — merge/dedupe/search/routing coverage.
- `apps/mobile/src/app/features/projects/projects.component.spec.ts` — rendered accordion and per-project compose coverage.
- `apps/mobile/src/app/features/new-session/new-session.presentation.ts` — pure labels, resolved-plan summary, and start-state helpers.
- `apps/mobile/src/app/features/new-session/new-session.presentation.spec.ts` — presentation-state coverage.
- `apps/mobile/src/app/features/new-session/new-session.component.spec.ts` — directory-sheet, preset-directory, and create-payload coverage.
- `apps/mobile/src/app/shared/structural-icon-audit.spec.ts` — prevents structural emoji/glyph regressions across mobile components.

### Modify

- `apps/mobile/src/styles.scss` — semantic tokens, reusable button/header/sheet/dock/focus/motion styles.
- `apps/mobile/src/app/features/projects/projects.component.ts` — Codex-style header, inline projects/sessions, overflow, search dock.
- `apps/mobile/src/app/features/sessions/sessions.component.ts` — shared header/session rows and compatibility-route polish.
- `apps/mobile/src/app/features/new-session/new-session.component.ts` — context selectors plus keyboard-anchored composer and sheets.
- `apps/mobile/src/app/shared/model-sheet.component.ts` — shared sheet shell and visual-system styling.
- `apps/mobile/src/app/features/hosts/hosts.component.ts` — shared header/icons/touch states.
- `apps/mobile/src/app/features/hosts/add-host.component.ts` — shared header/icons, clearer pairing hierarchy.
- `apps/mobile/src/app/features/history/history.component.ts` — shared header/session rows.
- `apps/mobile/src/app/features/history/history-detail.component.ts` — shared icons/header and transcript polish.
- `apps/mobile/src/app/features/conversation/conversation.component.ts` — shared icons/header and composer markup.
- `apps/mobile/src/app/features/conversation/conversation.component.scss` — Codex-style composer, safe-area spacing, icon states.
- `apps/mobile/src/app/features/approval/approval-sheet.component.ts` — shared sheet spacing, accessible segmented state, icon cleanup.
- `apps/mobile/src/app/features/lock/lock-screen.component.ts` — vector lock mark and shared primary button.
- `docs/superpowers/specs/2026-07-11-harness-mobile-codex-redesign.md` — mark complete and rename only after every gate passes.

---

### Task 1: Shared Mobile Visual Primitives

**Files:**
- Create: `apps/mobile/src/app/shared/mobile-icon.component.ts`
- Create: `apps/mobile/src/app/shared/mobile-icon.component.spec.ts`
- Create: `apps/mobile/src/app/shared/mobile-header.component.ts`
- Create: `apps/mobile/src/app/shared/mobile-sheet.component.ts`
- Create: `apps/mobile/src/app/shared/mobile-session-row.component.ts`
- Create: `apps/mobile/src/app/shared/mobile-primitives.component.spec.ts`
- Modify: `apps/mobile/src/styles.scss`

**Interfaces:**
- Produces: `MobileIconName`, `MOBILE_ICON_PATHS`, `MobileIconComponent`.
- Produces: `MobileHeaderComponent` with projected `[mobileHeaderLeading]` and `[mobileHeaderTrailing]` content.
- Produces: `MobileSheetComponent` with `label: InputSignal<string>` and `dismiss: OutputEmitterRef<void>`.
- Produces: `MobileSessionRowView` and `MobileSessionRowComponent` with `row` input and `activate` output.
- Consumes: existing CSS variables from `styles.scss` and `displayStatusColor`-derived values supplied by feature components.

- [x] **Step 1: Write the failing icon registry test**

```ts
import { describe, expect, it } from 'vitest';
import { MOBILE_ICON_NAMES, MOBILE_ICON_PATHS } from './mobile-icon.component';

describe('mobile icon registry', () => {
  it('defines a non-empty vector path for every structural icon', () => {
    expect(MOBILE_ICON_NAMES).toEqual([
      'menu', 'more', 'folder', 'compose', 'chevron-down', 'chevron-left',
      'search', 'plus', 'history', 'pause', 'play', 'host', 'provider',
      'settings', 'microphone', 'arrow-up', 'attachment', 'clipboard',
      'close', 'check', 'lock', 'tool', 'warning', 'error', 'qr',
    ]);
    for (const name of MOBILE_ICON_NAMES) {
      expect(MOBILE_ICON_PATHS[name].trim().length).toBeGreaterThan(0);
    }
  });
});
```

- [x] **Step 2: Run the test and confirm the registry does not exist**

Run from `apps/mobile`:

```bash
../../node_modules/.bin/vitest run --config vitest.config.ts src/app/shared/mobile-icon.component.spec.ts
```

Expected: FAIL because `mobile-icon.component.ts` does not exist.

- [x] **Step 3: Implement the typed icon component**

Create the registry and component with this public shape:

```ts
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export const MOBILE_ICON_PATHS = {
  menu: 'M5 8h14M5 16h10',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  folder: 'M3 7.5h7l2 2H21v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5Z',
  compose: 'M13.5 5.5 18.5.5a2.12 2.12 0 0 1 3 3l-5 5L13.5 5.5ZM12 7H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7',
  'chevron-down': 'm7 9 5 5 5-5',
  'chevron-left': 'm15 18-6-6 6-6',
  search: 'm21 21-4.35-4.35M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z',
  plus: 'M12 5v14M5 12h14',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  pause: 'M9 5v14M15 5v14',
  play: 'm8 5 11 7-11 7V5Z',
  host: 'M4 5h16v11H4zM2 20h20M9 16v4M15 16v4',
  provider: 'm12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6V20h-4v-.08a1.7 1.7 0 0 0-1-.52 1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1H4v-4h.08a1.7 1.7 0 0 0 .52-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06L7.06 4.2l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6V4h4v.08a1.7 1.7 0 0 0 1 .52 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 .6 1h.08v4H20a1.7 1.7 0 0 0-.6 1Z',
  microphone: 'M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3ZM19 11a7 7 0 0 1-14 0M12 18v4',
  'arrow-up': 'm6 10 6-6 6 6M12 4v16',
  attachment: 'm20 11-8.5 8.5a5 5 0 0 1-7-7L14 3a3.5 3.5 0 0 1 5 5l-9.5 9.5a2 2 0 0 1-3-3L15 6',
  clipboard: 'M9 4h6a2 2 0 0 1 2 2v1h1a2 2 0 0 1 2 2v10H8a2 2 0 0 1-2-2V7H5a2 2 0 0 1-2-2h3M8 7h10v12H8V7Z',
  close: 'm6 6 12 12M18 6 6 18',
  check: 'm5 12 4 4L19 6',
  lock: 'M6 10h12v11H6V10ZM8 10V7a4 4 0 0 1 8 0v3M12 14v3',
  tool: 'm14.7 6.3 3-3a5 5 0 0 1-6.2 6.2L5 16l3 3 6.5-6.5a5 5 0 0 1 6.2-6.2l-3 3-3-3Z',
  warning: 'M12 3 2.5 20h19L12 3ZM12 9v5M12 18h.01',
  error: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM8 8l8 8M16 8l-8 8',
  qr: 'M3 3h7v7H3V3ZM14 3h7v7h-7V3ZM3 14h7v7H3v-7ZM14 14h3v3h-3v-3ZM18 14h3v7h-3M14 19h3v2h-3v-2Z',
} as const;

export const MOBILE_ICON_NAMES = Object.keys(MOBILE_ICON_PATHS) as (keyof typeof MOBILE_ICON_PATHS)[];
export type MobileIconName = keyof typeof MOBILE_ICON_PATHS;

@Component({
  standalone: true,
  selector: 'app-mobile-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
  template: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path [attr.d]="path()" />
    </svg>
  `,
  styles: [`:host, svg { display: block; width: 1em; height: 1em; } path { stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }`],
})
export class MobileIconComponent {
  readonly name = input.required<MobileIconName>();
  protected readonly path = computed(() => MOBILE_ICON_PATHS[this.name()]);
}
```

- [x] **Step 4: Write failing primitive interaction tests**

Use Angular `TestBed` to render `MobileSheetComponent` and `MobileSessionRowComponent`. Assert that clicking the scrim emits `dismiss`, a session row exposes its supplied accessible label, and clicking the row emits its stable row ID.

```ts
import '@angular/compiler';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { MobileSessionRowComponent } from './mobile-session-row.component';
import { MobileSheetComponent } from './mobile-sheet.component';

describe('mobile visual primitives', () => {
  it('dismisses a sheet from its labelled scrim', async () => {
    await TestBed.configureTestingModule({
      imports: [MobileSheetComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    const fixture = TestBed.createComponent(MobileSheetComponent);
    fixture.componentRef.setInput('label', 'Provider');
    const dismissed = vi.fn();
    fixture.componentInstance.dismiss.subscribe(dismissed);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.mobile-sheet__scrim') as HTMLButtonElement).click();
    expect(dismissed).toHaveBeenCalledOnce();
  });

  it('announces and activates a stable session row', async () => {
    await TestBed.configureTestingModule({
      imports: [MobileSessionRowComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    const fixture = TestBed.createComponent(MobileSessionRowComponent);
    fixture.componentRef.setInput('row', {
      id: 'session-1', title: 'Polish mobile UX', subtitle: 'Codex',
      statusLabel: 'working', tone: 'working', unread: false, live: true,
    });
    const activated = vi.fn();
    fixture.componentInstance.activate.subscribe(activated);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Open Polish mobile UX, working');
    button.click();
    expect(activated).toHaveBeenCalledWith('session-1');
  });
});
```

- [x] **Step 5: Implement the header, sheet, and session-row components**

Use these exact public contracts:

```ts
export interface MobileSessionRowView {
  id: string;
  title: string;
  subtitle?: string;
  statusLabel: string;
  tone: 'working' | 'attention' | 'error' | 'loop' | 'idle' | 'history';
  unread: boolean;
  live: boolean;
}
```

`MobileHeaderComponent` projects leading and trailing buttons into fixed 44px columns and centres `title` plus optional `subtitle`. `MobileSheetComponent` renders a labelled `role="dialog"`, an independent scrim button, a grabber, and projected content. `MobileSessionRowComponent` owns only rendering and emits `row().id`; it must not inject `Router` or `GatewayClient`.

- [x] **Step 6: Add shared semantic styles**

Extend `styles.scss` with `--surface-raised`, `--separator`, `--focus-ring`, `--control-size: 44px`, `--mobile-gutter: 20px`, `--dock-height: 72px`, and reusable `.mobile-icon-button`, `.mobile-primary-button`, `.mobile-empty-state`, `.mobile-bottom-dock`, `.mobile-pressable`, and `:focus-visible` rules. Add `@media (prefers-reduced-motion: reduce)` to disable non-essential transitions and animations.

- [x] **Step 7: Run primitive tests and the mobile typecheck**

```bash
../../node_modules/.bin/vitest run --config vitest.config.ts src/app/shared/mobile-icon.component.spec.ts src/app/shared/mobile-primitives.component.spec.ts
npm run typecheck
```

Expected: both test files PASS and TypeScript exits 0.

---

### Task 2: Pure Project and Session View Model

**Files:**
- Create: `apps/mobile/src/app/features/projects/project-list.view-model.ts`
- Create: `apps/mobile/src/app/features/projects/project-list.view-model.spec.ts`
- Modify: `apps/mobile/src/app/features/projects/projects.component.ts`

**Interfaces:**
- Consumes: `MobileProjectDto`, `MobileInstanceDto`, `MobileHistorySessionDto`, `MobileRecentDirDto`.
- Produces: `ProjectListGroup`, `MobileSessionRowView` instances, `mergeProjects()`, `buildProjectGroups()`, `filterProjectGroups()`, `sessionTargetRoute()`, and `newSessionNavigation()`.

- [x] **Step 1: Write failing merge, dedupe, filter, and routing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  buildProjectGroups,
  filterProjectGroups,
  mergeProjects,
  newSessionNavigation,
  sessionTargetRoute,
} from './project-list.view-model';

describe('project list view model', () => {
  const live = [{
    id: 'live-1', displayName: 'Polish Harness Mobile UX', status: 'busy',
    provider: 'codex', model: 'gpt-5.6', workingDirectory: '/work/aio',
    projectName: 'aio', createdAt: 1, lastActivity: 20,
    pendingApprovalCount: 0, hasUnreadCompletion: false,
  }];
  const history = [{
    id: 'history-live-1', name: 'Polish Harness Mobile UX', provider: 'codex',
    model: 'gpt-5.6', workingDirectory: '/work/aio', projectName: 'aio',
    createdAt: 1, lastActiveAt: 20, archived: false, live: true, instanceId: 'live-1',
  }, {
    id: 'history-2', name: 'Older session', provider: 'claude', model: null,
    workingDirectory: '/work/aio', projectName: 'aio', createdAt: 1,
    lastActiveAt: 10, archived: true, live: false,
  }];

  it('merges live, history, and recent directories without double-counting live history', () => {
    const projects = mergeProjects([], live, history, [{
      path: '/work/empty', displayName: 'empty', lastAccessed: 5, isPinned: false,
    }]);
    expect(projects.map((project) => [project.name, project.sessionCount])).toEqual([
      ['aio', 2], ['empty', 0],
    ]);
  });

  it('builds one live and one history row and filters by session name', () => {
    const groups = buildProjectGroups([], live, history, []);
    expect(groups[0].sessions.map((row) => row.id)).toEqual(['live-1', 'history-2']);
    expect(filterProjectGroups(groups, 'older')[0].sessions.map((row) => row.id)).toEqual(['history-2']);
  });

  it('routes live and history rows to their existing destinations', () => {
    const groups = buildProjectGroups([], live, history, []);
    expect(sessionTargetRoute('/work/aio', groups[0].sessions[0])).toEqual([
      '/projects', '/work/aio', 'sessions', 'live-1',
    ]);
    expect(sessionTargetRoute('/work/aio', groups[0].sessions[1])).toEqual([
      '/history', 'history-2',
    ]);
    expect(newSessionNavigation('/work/aio')).toEqual({ commands: ['/new-session'], queryParams: { dir: '/work/aio' } });
    expect(newSessionNavigation()).toEqual({ commands: ['/new-session'] });
  });
});
```

- [x] **Step 2: Run the view-model test and confirm it fails**

```bash
../../node_modules/.bin/vitest run --config vitest.config.ts src/app/features/projects/project-list.view-model.spec.ts
```

Expected: FAIL because `project-list.view-model.ts` does not exist.

- [x] **Step 3: Implement the pure view model**

Define:

```ts
export interface ProjectListGroup {
  project: MobileProjectDto;
  sessions: MobileSessionRowView[];
}

export interface NavigationTarget {
  commands: string[];
  queryParams?: { dir: string };
}
```

`mergeProjects()` must:

1. Seed by project key from the live snapshot.
2. Add a live instance once per ID.
3. Add history only when `history.live && history.instanceId` does not match a live ID.
4. Add empty recent directories.
5. Recalculate `sessionCount` from the deduplicated session set instead of adding counts from multiple sources.
6. Sort busy projects first, then projects with sessions, then empty directories; within a tier sort newest first.

`buildProjectGroups()` maps live sessions through `displayStatusLabel`, `needsAttention`, `isWorkingOrLooping`, and status values. History rows use `tone: 'history'`, `statusLabel: archived ? 'archived' : 'past'`, and `live: false`.

`filterProjectGroups()` trims and lowercases the query. A project-name match returns the full group; otherwise it returns only matching session name/provider/model rows and drops empty non-matching groups.

- [x] **Step 4: Replace the component's inline merge computation with the helper**

`ProjectsComponent` should derive:

```ts
protected readonly groups = computed(() => buildProjectGroups(
  this.gateway.snapshot()?.projects ?? [],
  this.gateway.snapshot()?.instances ?? [],
  this.gateway.historySessions(),
  this.recentDirs(),
));
```

Remove `historyByProject`, `mergedProjects`, and duplicate inline live/history mapping. Do not change navigation markup in this task.

- [x] **Step 5: Run the targeted test and typecheck**

```bash
../../node_modules/.bin/vitest run --config vitest.config.ts src/app/features/projects/project-list.view-model.spec.ts
npm run typecheck
```

Expected: view-model tests PASS and typecheck exits 0.

---

### Task 3: Codex-Style Inline Projects Home

**Files:**
- Create: `apps/mobile/src/app/features/projects/projects.component.spec.ts`
- Modify: `apps/mobile/src/app/features/projects/projects.component.ts`
- Consume: shared primitives from Task 1 and project view model from Task 2.

**Interfaces:**
- Consumes: `ProjectListGroup`, `newSessionNavigation()`, `sessionTargetRoute()`.
- Produces: local `expandedProjectKeys: WritableSignal<Set<string>>`, `searchQuery`, `menuOpen`, `initialDisclosureApplied`, `renderedGroups`, and `rowPressActive` state.
- Preserves: `setPause()`, History routing, host routing, chronological organization mode.

- [x] **Step 1: Write the failing rendered-home test**

Use TestBed with signal-backed mocks. The test must render one project and one session, verify the project begins expanded, verify the per-project compose button's accessible name, click it, and assert the existing query-param route.

```ts
import '@angular/compiler';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import { ProjectsComponent } from './projects.component';

it('expands sessions inline and creates a session in the selected project', async () => {
  const navigate = vi.fn();
  const snapshot = signal({
    hostName: 'MacBook-Pro.local', serverTime: 1,
    projects: [{ key: '/work/aio', path: '/work/aio', name: 'ai-orchestrator', sessionCount: 1, busyCount: 1, pendingApprovalCount: 0, lastActivity: 10 }],
    instances: [{ id: 's1', displayName: 'Polish Harness Mobile UX', status: 'busy', provider: 'codex', model: 'gpt-5.6', workingDirectory: '/work/aio', projectName: 'ai-orchestrator', createdAt: 1, lastActivity: 10, pendingApprovalCount: 0, hasUnreadCompletion: false }],
    prompts: [], pause: { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 },
  });
  await TestBed.configureTestingModule({
    imports: [ProjectsComponent],
    providers: [
      provideZonelessChangeDetection(),
      { provide: Router, useValue: { navigate } },
      { provide: HostStore, useValue: { activeHost: signal({ name: 'MacBook-Pro.local' }) } },
      { provide: GatewayClient, useValue: {
        snapshot, state: signal('connected'), online: signal(true), prompts: signal([]),
        pause: signal({ isPaused: false }), historySessions: signal([]),
        recentDirs: vi.fn().mockResolvedValue([]), setPause: vi.fn(),
      } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(ProjectsComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Polish Harness Mobile UX');
  const compose = fixture.nativeElement.querySelector('[aria-label="New session in ai-orchestrator"]') as HTMLButtonElement;
  compose.click();
  expect(navigate).toHaveBeenCalledWith(['/new-session'], { queryParams: { dir: '/work/aio' } });
});
```

- [x] **Step 2: Run the component test and verify the current home fails it**

```bash
../../node_modules/.bin/vitest run --config vitest.config.ts src/app/features/projects/projects.component.spec.ts
```

Expected: FAIL because sessions are not rendered inline and the per-project compose button is absent.

- [x] **Step 3: Replace the home template**

Build this hierarchy using `MobileHeaderComponent`, `MobileIconComponent`, and `MobileSessionRowComponent`:

```html
<section class="projects-screen">
  <app-mobile-header [title]="'Harness'" [subtitle]="hostSubtitle()">
    <button mobileHeaderLeading class="mobile-icon-button" type="button" (click)="toHosts()" aria-label="Hosts">
      <app-mobile-icon name="menu" />
    </button>
    <button mobileHeaderTrailing class="mobile-icon-button" type="button" (click)="menuOpen.set(!menuOpen())" aria-label="More options">
      <app-mobile-icon name="more" />
    </button>
  </app-mobile-header>

  <h1 class="projects-title">Projects</h1>
  @for (group of visibleGroups(); track group.project.key) {
    <article class="project-group">
      <div class="project-row">
        <button type="button" class="project-disclosure" (click)="toggleProject(group.project.key)" [attr.aria-expanded]="isExpanded(group.project.key)">
          <app-mobile-icon name="folder" />
          <span>{{ group.project.name }}</span>
          <app-mobile-icon name="chevron-down" />
        </button>
        <button type="button" class="mobile-icon-button" (click)="newSessionInProject(group.project.path, $event)" [attr.aria-label]="'New session in ' + group.project.name">
          <app-mobile-icon name="compose" />
        </button>
      </div>
      @if (isExpanded(group.project.key) || searchQuery().trim()) {
        <div class="project-sessions">
          @for (session of group.sessions; track session.id) {
            <app-mobile-session-row [row]="session" (activate)="openSession(group.project.key, session)" />
          }
        </div>
      }
    </article>
  }

  <div class="mobile-bottom-dock">
    <label class="dock-search">
      <app-mobile-icon name="search" />
      <input type="search" aria-label="Search sessions" placeholder="Search Sessions" [value]="searchQuery()" (input)="updateSearch($event)" />
    </label>
    <button type="button" class="dock-new" (click)="newSession()"><app-mobile-icon name="compose" />New</button>
  </div>
</section>
```

The menu must contain By project, Chronological, Pause/Resume, History, and Hosts. A full-screen transparent menu scrim dismisses it. Remove the rollup pill row and detached floating button.

When offline with cached groups, keep the groups visible and show `Offline` in the centred host subtitle; disable both compose actions with `aria-describedby` pointing to a short recovery message. When offline without groups, render `Connection unavailable` plus a `Manage hosts` action instead of an empty Projects heading.

- [x] **Step 4: Implement stable disclosure and search signals**

On first non-empty `groups()` result, initialize the expanded set with every group that has sessions. Never reinitialize it after live updates. `visibleGroups` uses `filterProjectGroups()`. `newSessionInProject()` calls `event.stopPropagation()` and routes using `newSessionNavigation(path)`.

Prevent live resorting under an active finger: project/session pressable containers set `rowPressActive` on `pointerdown`/`touchstart` and clear it on `pointerup`, `pointercancel`, and `touchend`. An effect copies `groups()` into `renderedGroups` only while `rowPressActive` is false; if an update arrives during a press, hold the newest value in `pendingGroups` and apply it on release. Search filters `renderedGroups`, so interaction locking never changes gateway data.

- [x] **Step 5: Run project tests and mobile compilation**

```bash
../../node_modules/.bin/vitest run --config vitest.config.ts src/app/features/projects/project-list.view-model.spec.ts src/app/features/projects/projects.component.spec.ts
npm run typecheck
npm run build
```

Expected: both project test files PASS, typecheck exits 0, and Angular production build completes.

---

### Task 4: Composer-Led New Session Screen

**Files:**
- Create: `apps/mobile/src/app/features/new-session/new-session.presentation.ts`
- Create: `apps/mobile/src/app/features/new-session/new-session.presentation.spec.ts`
- Create: `apps/mobile/src/app/features/new-session/new-session.component.spec.ts`
- Modify: `apps/mobile/src/app/features/new-session/new-session.component.ts`
- Modify: `apps/mobile/src/app/shared/model-sheet.component.ts`

**Interfaces:**
- Produces: `providerDisplayName()`, `sessionPlanSummary()`, `canStartSession()`, `shouldPresentDirectorySheet()`.
- Adds local signals: `directorySheetOpen`, `settingsSheetOpen`, `attachmentSheetOpen`.
- Preserves: `selectedDir`, `provider`, `model`, `plan`, `firstPrompt`, `attachments`, draft persistence, and `GatewayClient.createInstance()` payload.

- [x] **Step 1: Write failing pure presentation tests**

```ts
import { describe, expect, it } from 'vitest';
import { canStartSession, providerDisplayName, sessionPlanSummary, shouldPresentDirectorySheet } from './new-session.presentation';

describe('new session presentation', () => {
  it('summarizes the host-resolved model and reasoning', () => {
    expect(sessionPlanSummary({ provider: 'codex', providerLabel: 'Codex', model: 'gpt-5.6', modelLabel: 'GPT-5.6', reasoningEffort: 'extra_high', reasoningEffortLabel: 'Extra High' })).toBe('GPT-5.6 · Extra High');
  });
  it('uses readable provider labels and only opens the directory sheet for global New', () => {
    expect(providerDisplayName('auto')).toBe('Auto');
    expect(providerDisplayName('copilot')).toBe('Copilot');
    expect(shouldPresentDirectorySheet('', ['/work/aio'])).toBe(true);
    expect(shouldPresentDirectorySheet('/work/aio', ['/work/aio'])).toBe(false);
  });
  it('requires an online host, directory, and non-busy state but allows an empty prompt', () => {
    expect(canStartSession({ online: true, directory: '/work/aio', busy: false })).toBe(true);
    expect(canStartSession({ online: false, directory: '/work/aio', busy: false })).toBe(false);
  });
});
```

- [x] **Step 2: Run the presentation test and verify failure**

```bash
../../node_modules/.bin/vitest run --config vitest.config.ts src/app/features/new-session/new-session.presentation.spec.ts
```

Expected: FAIL because the presentation module is absent.

- [x] **Step 3: Implement the pure helpers**

`sessionPlanSummary()` returns `[modelLabel || 'Default model', reasoningEffortLabel].filter(Boolean).join(' · ')`. `canStartSession()` returns `online && directory.trim().length > 0 && !busy`. `shouldPresentDirectorySheet()` returns true only when there is no preset directory and at least one directory was loaded.

- [x] **Step 4: Write failing component tests for preset and global flows**

Configure TestBed with mocks for `GatewayClient`, `HostStore`, `DraftStore`, `ImageAttachmentService`, `VoiceInputService`, `HapticsService`, and `Router`. Cover these two cases:

1. Setting input `dir` to `/work/aio` renders `ai-orchestrator`, does not open the directory dialog, and focuses the `Ask Harness` composer.
2. Global New loads recent directories, presents `role="dialog"` labelled `Working directory`, selecting `/work/aio` closes it, and submitting calls:

```ts
expect(createInstance).toHaveBeenCalledWith({
  workingDirectory: '/work/aio',
  provider: 'auto',
  model: undefined,
  initialPrompt: 'Polish mobile UX',
  attachments: undefined,
});
```

Then assert navigation to `['/projects', '/work/aio', 'sessions', 'created-1']`.

- [x] **Step 5: Replace the form layout with context selectors and composer**

The component root is a full-height flex column. Use a circular back control at the top, an expanding spacer, then four context controls followed by the composer:

```html
<div class="session-context">
  <button type="button" class="context-selector" (click)="openHosts()"><app-mobile-icon name="host" /><span>{{ hostName() }}</span></button>
  <button type="button" class="context-selector" (click)="directorySheetOpen.set(true)"><app-mobile-icon name="folder" /><span>{{ selectedDirLabel() }}</span></button>
  <button type="button" class="context-selector" (click)="settingsSheetOpen.set(true)"><app-mobile-icon name="provider" /><span>{{ providerDisplay() }}</span></button>
  <button type="button" class="context-selector" (click)="openModelSheet()" [disabled]="provider() === 'auto'"><app-mobile-icon name="settings" /><span>{{ planSummary() }}</span></button>
</div>

<form class="new-session-composer" (submit)="create($event)">
  <textarea #composer rows="1" aria-label="First message" placeholder="Ask Harness" [ngModel]="firstPrompt()" (ngModelChange)="firstPrompt.set($event)" [ngModelOptions]="{ standalone: true }" (paste)="onPaste($event)"></textarea>
  <div class="composer-toolbar">
    <button type="button" class="composer-action" (click)="attachmentSheetOpen.set(true)" aria-label="Add attachment"><app-mobile-icon name="plus" /></button>
    <button type="button" class="composer-action" (click)="settingsSheetOpen.set(true)" aria-label="Session settings"><app-mobile-icon name="settings" /></button>
    <span class="composer-plan">{{ planSummary() }}</span>
    <button type="button" class="composer-action" (click)="toggleDictation()" [attr.aria-label]="listening() ? 'Stop dictation' : 'Dictate'"><app-mobile-icon name="microphone" /></button>
    <button type="submit" class="composer-send" [disabled]="!canCreate()" aria-label="Start session"><app-mobile-icon name="arrow-up" /></button>
  </div>
</form>
```

Change `create()` to accept `Event`, call `preventDefault()`, guard against duplicate/offline creation, and preserve the existing request body exactly. Keep error output adjacent to the composer with `role="alert"`.

- [x] **Step 6: Implement directory, settings, and attachment sheets**

- Directory sheet: recent dirs with folder icon, display name, truncated full path, selected checkmark, retry action on load failure.
- Settings sheet: provider rows for the existing `PROVIDERS` constant. Selecting a provider resets the model exactly as today. Include a Model row that closes settings then opens `ModelSheetComponent` when provider is not Auto.
- Attachment sheet: Photo Library and Paste Image actions, both using existing service methods and closing after action.
- Model sheet: restyle through `MobileSheetComponent`; preserve grouping, default handling, `choose`, `dismiss`, loading, and error APIs.

If host-side session-plan resolution fails, show `Resolution unavailable` plus a Retry button in the settings sheet, retain Auto/default selection, and keep the draft untouched. Retry calls the same `sessionPlan(provider(), model())` request with a new monotonic request token.

- [x] **Step 7: Add deterministic focus behavior**

Use `viewChild<ElementRef<HTMLTextAreaElement>>('composer')` and an effect keyed on `selectedDir()`. If a directory exists and no sheet is open, queue one microtask and call `.focus({ preventScroll: true })`. Global New opens the directory sheet after `recentDirs()` resolves; focus occurs only after selection.

- [x] **Step 8: Run new-session tests and mobile compilation**

```bash
../../node_modules/.bin/vitest run --config vitest.config.ts src/app/features/new-session/new-session.presentation.spec.ts src/app/features/new-session/new-session.component.spec.ts
npm run typecheck
npm run build
```

Expected: all new-session tests PASS, typecheck exits 0, and production build completes.

---

### Task 5: Hosts, Compatibility Sessions, and History Lists

**Files:**
- Create: `apps/mobile/src/app/shared/structural-icon-audit.spec.ts`
- Modify: `apps/mobile/src/app/features/hosts/hosts.component.ts`
- Modify: `apps/mobile/src/app/features/hosts/add-host.component.ts`
- Modify: `apps/mobile/src/app/features/sessions/sessions.component.ts`
- Modify: `apps/mobile/src/app/features/history/history.component.ts`

**Interfaces:**
- Consumes: `MobileHeaderComponent`, `MobileIconComponent`, `MobileSessionRowComponent`.
- Preserves: host selection/pairing, App Lock toggle, session pagination, live/history routing, history grouping.

- [x] **Step 1: Write the failing structural-icon audit**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = [
  'features/hosts/hosts.component.ts',
  'features/hosts/add-host.component.ts',
  'features/projects/projects.component.ts',
  'features/sessions/sessions.component.ts',
  'features/new-session/new-session.component.ts',
  'features/history/history.component.ts',
  'features/history/history-detail.component.ts',
  'features/conversation/conversation.component.ts',
  'features/lock/lock-screen.component.ts',
];

describe('structural icon audit', () => {
  it.each(files)('%s uses vector components instead of structural glyphs', (file) => {
    const source = readFileSync(resolve('src/app', file), 'utf8');
    expect(source).not.toMatch(/[☰🕘🗀🔧📎🔒⛶▶⏸‹›＋]/u);
  });
});
```

- [x] **Step 2: Run the audit and confirm existing glyphs fail**

```bash
../../node_modules/.bin/vitest run --config vitest.config.ts src/app/shared/structural-icon-audit.spec.ts
```

Expected: FAIL for the existing components listed by the test.

- [x] **Step 3: Restyle Hosts and Add Host**

Use `MobileHeaderComponent` and SVG buttons. Keep Hosts as a simple list; move the add action into a labelled circular compose/plus control. Improve the empty state with one instruction paragraph and primary Add Host button. Keep App Lock separated below a semantic `Security` heading. In Add Host, use the `qr` icon, replace the warning glyph with an icon plus text, and keep all current fields and pairing logic unchanged.

- [x] **Step 4: Restyle the compatibility Sessions route**

Use `MobileHeaderComponent` and `MobileSessionRowComponent`. Keep pagination helpers and deep-link behavior. Replace the floating New button with the shared bottom dock's white New action without a search field. Ensure the final row has bottom inset.

- [x] **Step 5: Restyle History**

Use the shared header and session row. Preserve grouping and `when()`. Represent live/archived state through `MobileSessionRowView.tone` and status label. Keep live sessions routed to Conversation and archived sessions to History Detail.

- [x] **Step 6: Run list-surface checks**

```bash
../../node_modules/.bin/vitest run --config vitest.config.ts src/app/shared/structural-icon-audit.spec.ts src/app/features/sessions/sessions.component.spec.ts
npm run typecheck
npm run build
```

Expected: audit and existing sessions tests PASS; typecheck/build exit 0.

---

### Task 6: Conversation and History Transcript Polish

**Files:**
- Modify: `apps/mobile/src/app/features/conversation/conversation.component.ts`
- Modify: `apps/mobile/src/app/features/conversation/conversation.component.scss`
- Modify: `apps/mobile/src/app/features/history/history-detail.component.ts`

**Interfaces:**
- Consumes: `MobileHeaderComponent`, `MobileIconComponent`, shared control styles.
- Preserves: active-view reporting, transcript loading, auto-follow behavior, touch interruption, drafts, attachments, dictation, model change, interrupt, terminate, rename, markdown, and copy behavior.

- [x] **Step 1: Expand the structural audit expectations**

Extend `structural-icon-audit.spec.ts` with exact source-contract assertions while the existing functional transcript tests continue to cover grouping:

```ts
it.each([
  'features/conversation/conversation.component.ts',
  'features/history/history-detail.component.ts',
])('%s labels expandable tool groups', (file) => {
  const source = readFileSync(resolve('src/app', file), 'utf8');
  expect(source).toContain('[attr.aria-label]="toolGroupLabel(item)"');
  expect(source).not.toContain('🔧');
});

it('expresses attachment state with icon plus text', () => {
  const source = readFileSync(
    resolve('src/app/features/conversation/conversation.component.ts'),
    'utf8',
  );
  expect(source).toContain('<app-mobile-icon name="attachment" />');
  expect(source).toContain('Photo attached');
  expect(source).not.toContain('📎');
});
```

Add `toolGroupLabel(item: Extract<DisplayItem, { kind: 'tools' }>): string` to both components, returning `Show N tool call` or `Show N tool calls` from `item.items.length`.

- [x] **Step 2: Replace conversation header and transcript glyphs**

- Use `MobileHeaderComponent` with a circular back button, session title/status subtitle, and More button.
- Replace tool caret characters and wrench emoji with `chevron-down` and `tool` icons.
- Replace the attachment emoji with an `attachment` icon plus `Photo attached` text.
- Replace remove, add, microphone, paste, and send characters/handwritten SVGs with `MobileIconComponent`.
- Preserve every existing handler and accessible label.

- [x] **Step 3: Rebuild only the conversation composer's presentation**

Keep the same `<form>` and send logic. Wrap textarea and toolbar in one rounded raised surface, matching the New Session composer. Place attachment, paste, growing textarea, dictation, and circular send within that surface. Maintain 16px input text, max-height 120px, safe-area padding, disabled/loading states, and attachment thumbnail strip.

- [x] **Step 4: Apply the same transcript chrome to History Detail**

Use the shared header and icon component for back, tool groups, and scroll controls. Preserve internal scrolling and all history logic. Do not add a composer to read-only history.

- [x] **Step 5: Run transcript-related tests and compilation**

```bash
../../node_modules/.bin/vitest run --config vitest.config.ts src/app/shared/structural-icon-audit.spec.ts src/app/shared/transcript-items.spec.ts src/app/shared/mobile-markdown.spec.ts src/app/shared/line-diff.spec.ts
npm run typecheck
npm run build
```

Expected: audit and transcript tests PASS; typecheck/build exit 0.

---

### Task 7: Approval, Model Sheet, Lock Screen, and Global Accessibility Pass

**Files:**
- Modify: `apps/mobile/src/app/features/approval/approval-sheet.component.ts`
- Modify: `apps/mobile/src/app/shared/model-sheet.component.ts`
- Modify: `apps/mobile/src/app/features/lock/lock-screen.component.ts`
- Modify: `apps/mobile/src/styles.scss`
- Modify: `apps/mobile/src/app/shared/mobile-primitives.component.spec.ts`

**Interfaces:**
- Consumes: `MobileSheetComponent`, `MobileIconComponent`, global focus/press tokens.
- Preserves: approval decision payloads/scopes, question answers, model grouping/selection, biometric unlock behavior.

- [x] **Step 1: Add failing accessibility assertions**

Create focused TestBed cases in `mobile-primitives.component.spec.ts`:

```ts
import { signal } from '@angular/core';
import { ApprovalSheetComponent } from '../features/approval/approval-sheet.component';
import { LockScreenComponent } from '../features/lock/lock-screen.component';
import { AppLockService } from '../core/app-lock.service';
import { HapticsService } from '../core/haptics.service';

it('announces the selected approval scope', async () => {
  await TestBed.configureTestingModule({
    imports: [ApprovalSheetComponent],
    providers: [
      provideZonelessChangeDetection(),
      { provide: HapticsService, useValue: { warning: vi.fn(), success: vi.fn(), tap: vi.fn() } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(ApprovalSheetComponent);
  fixture.componentRef.setInput('prompt', {
    id: 'p1', instanceId: 's1', requestId: 'r1', kind: 'permission',
    toolName: 'Bash', title: 'Approval', message: 'Run command', createdAt: 1,
  });
  fixture.detectChanges();
  const once = fixture.nativeElement.querySelector('[data-scope="once"]') as HTMLButtonElement;
  const session = fixture.nativeElement.querySelector('[data-scope="session"]') as HTMLButtonElement;
  expect(once.getAttribute('aria-pressed')).toBe('true');
  expect(session.getAttribute('aria-pressed')).toBe('false');
});

it('uses a vector lock mark and a labelled unlock action', async () => {
  await TestBed.configureTestingModule({
    imports: [LockScreenComponent],
    providers: [
      provideZonelessChangeDetection(),
      { provide: AppLockService, useValue: {
        unlock: vi.fn().mockResolvedValue(true), biometryLabel: signal('Face ID'),
      } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(LockScreenComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('app-mobile-icon')).not.toBeNull();
  expect(fixture.nativeElement.textContent).not.toContain('🔒');
  expect(fixture.nativeElement.querySelector('button')?.textContent).toContain('Unlock with Face ID');
});
```

Also keep a `MobileSheetComponent` assertion that `label="Model picker"` produces `role="dialog" aria-label="Model picker"`. CSS verification for 44px targets and focus rings remains part of the browser/runtime pass because jsdom has no layout engine.

- [x] **Step 2: Restyle Approval Sheet without changing decisions**

Reuse the shared sheet shape/tokens, retain the larger approval-specific z-index, and preserve diff/command/question rendering. Add `data-scope`, `[attr.aria-pressed]="scope() === s"`, and `(click)="scope.set(s)"` to scope buttons. Keep Allow as the single dominant action; keep Deny visually separate and red. Ensure long diffs scroll within a bounded region without hiding actions.

- [x] **Step 3: Finish Model Sheet styling**

Use shared sheet shell, check icon, close icon, 44px rows, selected state, and focus. Preserve `includeDefault`, pinned grouping, family grouping, loading/error, and output contracts.

- [x] **Step 4: Replace the Lock emoji and normalize the primary action**

Import `MobileIconComponent`, render `<app-mobile-icon name="lock" />` at 48px, and use the shared white primary button. Preserve automatic unlock, retry, error handling, and opaque privacy background.

- [x] **Step 5: Run accessibility and full mobile test suites**

```bash
../../node_modules/.bin/vitest run --config vitest.config.ts
npm run typecheck
npm run lint
npm run build
```

Expected: every mobile Vitest file PASS; typecheck, ESLint, and production build exit 0.

---

### Task 8: Real UI Verification and Repository Gates

**Files:**
- Modify and move after success: `docs/superpowers/specs/2026-07-11-harness-mobile-codex-redesign.md` to `docs/superpowers/specs/2026-07-11-harness-mobile-codex-redesign_completed.md`
- Keep uncommitted: `docs/superpowers/plans/2026-07-11-harness-mobile-codex-redesign.md`

**Interfaces:**
- Consumes: completed renderer from Tasks 1-7.
- Produces: current visual evidence, passing mobile gates, root-gate results, and completed spec status.

- [x] **Step 1: Start the mobile dev server**

```bash
npm run start -- --host 127.0.0.1
```

Run from `apps/mobile`. Expected: Angular serves `http://127.0.0.1:4200/` with no compilation errors.

- [x] **Step 2: Verify the phone viewport at 375x812 and 393x852**

Use the in-app browser workflow. At both sizes verify:

1. No horizontal scrolling.
2. Header controls are circular and at least 44px.
3. Project rows expand/collapse without shifting the compose action.
4. Search filters by project and session and reveals matches.
5. The bottom dock does not cover the last row.
6. Per-project New passes its directory; global New opens directory selection.
7. New Session keeps selectors and composer visible above the keyboard-sized viewport.
8. Provider, model, attachment, and directory sheets dismiss and preserve the draft.
9. Offline and creation-error states explain recovery without clearing input.
10. Conversation, History, Hosts, Approval, and Lock share icons, spacing, and touch states.

Capture screenshots under `output/playwright/harness-mobile-redesign/`; do not add them to git.

- [x] **Step 3: Verify landscape, reduced motion, and large text**

At 852x393 confirm the composer and sheets remain operable, context text truncates safely, and the bottom dock does not create nested scrolling. Enable reduced motion and confirm entry animations are removed. Increase browser text scaling where supported and confirm labels wrap or truncate without overlapping controls.

- [x] **Step 4: Attempt iOS runtime verification**

Run:

```bash
xcrun simctl list devices available
```

If the tracked native project can build without the MLKit arm64-simulator limitation, build/install/launch on an available iPhone simulator and capture a screenshot. If MLKit prevents the simulator build, record that exact limitation and rely on the browser viewport plus `npm run build`; do not claim simulator verification.

- [x] **Step 5: Run final mobile gates from `apps/mobile`**

```bash
../../node_modules/.bin/vitest run --config vitest.config.ts
npm run typecheck
npm run lint
npm run build
```

Expected: all commands exit 0.

- [x] **Step 6: Run the root canonical gates**

Run from repository root:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet
```

Expected: all commands exit 0. If a gate fails because of unrelated pre-existing dirty-tree work, preserve the complete command output, prove whether changed mobile files are implicated, and report the failure rather than weakening or skipping the gate.

- [x] **Step 7: Mark the design spec complete only after every applicable check**

Update the status to `COMPLETE` with the exact commands and current results, then use `apply_patch` to move the file to:

```text
docs/superpowers/specs/2026-07-11-harness-mobile-codex-redesign_completed.md
```

Do not rename the implementation plan and do not commit either document.

- [x] **Step 8: Report the requested-item checklist**

The final handoff must explicitly report these nine items: shared visual system, inline project/session home, per-project New, global search/New dock, composer-led New Session, provider/model/directory sheets, remaining-screen polish, mobile verification, and root verification. State the actual status of each; if any item is incomplete, report `X of 9 complete` and the exact remainder.
