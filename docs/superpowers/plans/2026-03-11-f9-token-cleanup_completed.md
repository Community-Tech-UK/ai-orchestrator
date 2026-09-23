# F9: Visual System Token Cleanup Plan

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](../../plans/2026-09-23-outstanding-plans-sweep_plan_completed.md)): COMPLETE.** Memory/operation/overlay tokens live in `src/renderer/styles/_theme.scss` (retuned values). `memory-browser`/`memory-stats` use the tokens, `settings` and the sidebar SCSS have none of the listed literals, and `compaction-indicator.component.ts` was deleted in `9a204d7a`.


> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add missing CSS token categories (memory types, operation status, overlays) to `styles.scss` and replace hardcoded color values across components with design token references.

**Architecture:** The design token system in `src/renderer/styles.scss` defines CSS custom properties on `:root` (dark theme), duplicated in BOTH `[data-theme='light']` AND `@media (prefers-color-scheme: light)` (light theme). All three blocks must be updated. Components should reference `var(--token-name)` instead of hardcoded hex/rgba values. This plan adds three missing token groups and replaces hardcoded values across ~6 component files.

**Tech Stack:** SCSS, CSS custom properties, Angular component styles.

---

## Chunk 1: Add Missing Token Categories

### Task 1: Add Memory Type Indicator Tokens

**Files:**
- Modify: `src/renderer/styles.scss` (`:root` section, approx line 77 after status colors)

- [ ] **Step 1: Add memory type tokens to dark theme**

After the `--status-initializing` line (line 77), add:

```scss
  // Memory type indicators
  --memory-episodic: #3b82f6;
  --memory-procedural: #10b981;
  --memory-semantic: #f59e0b;
  --memory-short-term: #8b5cf6;
  --memory-long-term: #ec4899;
  --memory-unknown: #6b7280;
  --memory-episodic-alpha: rgba(59, 130, 246, 0.15);
  --memory-procedural-alpha: rgba(16, 185, 129, 0.15);
  --memory-semantic-alpha: rgba(245, 158, 11, 0.15);
  --memory-short-term-alpha: rgba(139, 92, 246, 0.15);
  --memory-long-term-alpha: rgba(236, 72, 153, 0.15);
  --memory-unknown-alpha: rgba(107, 114, 128, 0.15);
```

- [ ] **Step 2: Add memory type tokens to BOTH light theme blocks**

Add to the `[data-theme='light']` section (~line 175) AND the `@media (prefers-color-scheme: light)` section (~line 193). Both blocks must be updated for consistency.

```scss
  // Memory type indicators (same hues, work in both themes)
  --memory-episodic: #3b82f6;
  --memory-procedural: #10b981;
  --memory-semantic: #f59e0b;
  --memory-short-term: #8b5cf6;
  --memory-long-term: #ec4899;
  --memory-unknown: #6b7280;
  --memory-episodic-alpha: rgba(59, 130, 246, 0.12);
  --memory-procedural-alpha: rgba(16, 185, 129, 0.12);
  --memory-semantic-alpha: rgba(245, 158, 11, 0.12);
  --memory-short-term-alpha: rgba(139, 92, 246, 0.12);
  --memory-long-term-alpha: rgba(236, 72, 153, 0.12);
  --memory-unknown-alpha: rgba(107, 114, 128, 0.12);
```

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/styles.scss
git commit -m "feat(f9): add memory type indicator design tokens"
```

---

### Task 2: Add Operation Status and Overlay Tokens

**Files:**
- Modify: `src/renderer/styles.scss` (`:root` and light theme sections)

- [ ] **Step 1: Add operation status tokens to dark theme**

After the memory type tokens (added in Task 1), add:

```scss
  // Operation status colors
  --operation-add: #10b981;
  --operation-update: #3b82f6;
  --operation-delete: #ef4444;
  --operation-noop: #6b7280;

  // Overlay variants
  --overlay-dark-light: rgba(0, 0, 0, 0.2);
  --overlay-dark-medium: rgba(0, 0, 0, 0.5);
  --overlay-dark-strong: rgba(0, 0, 0, 0.8);
```

- [ ] **Step 2: Add the same tokens to BOTH light theme blocks**

Add to `[data-theme='light']` AND `@media (prefers-color-scheme: light)`.

```scss
  // Operation status colors
  --operation-add: #16a34a;
  --operation-update: #2563eb;
  --operation-delete: #dc2626;
  --operation-noop: #6b7280;

  // Overlay variants
  --overlay-dark-light: rgba(0, 0, 0, 0.1);
  --overlay-dark-medium: rgba(0, 0, 0, 0.3);
  --overlay-dark-strong: rgba(0, 0, 0, 0.6);
```

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/styles.scss
git commit -m "feat(f9): add operation status and overlay design tokens"
```

---

## Chunk 2: Replace Hardcoded Values in Components

### Task 3: Replace Hardcoded Memory Colors in memory-browser.component.ts

**Files:**
- Modify: `src/renderer/app/features/memory/memory-browser.component.ts` (lines ~497-525, also ~537-538, ~677-683)

- [ ] **Step 1: Find and replace all hardcoded memory type colors**

Search for hardcoded hex values in CSS-in-JS / inline styles throughout the component. These appear in the component's `styles` array as CSS property values (e.g., `color: #3b82f6;` or `background: #3b82f6;`).

Replace using the token mapping:
- `#3b82f6` → `var(--memory-episodic)`
- `#10b981` → `var(--memory-procedural)`
- `#f59e0b` → `var(--memory-semantic)`
- `#8b5cf6` → `var(--memory-short-term)`
- `#ec4899` → `var(--memory-long-term)`
- `#6b7280` → `var(--memory-unknown)`

Also check for these colors in:
- Score relevance/confidence text colors (~lines 537-538)
- Score fill backgrounds (~lines 677-683)

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/features/memory/memory-browser.component.ts
git commit -m "refactor(f9): use memory type tokens in memory-browser component"
```

---

### Task 4: Replace Hardcoded Memory Colors in memory-stats.component.ts

**Files:**
- Modify: `src/renderer/app/features/memory/memory-stats.component.ts` (lines ~352-357, ~384-390, ~428-432, ~486-489)

- [ ] **Step 1: Replace memory type colors (lines ~428-432)**

Same mapping as Task 3.

- [ ] **Step 2: Replace token-segment and legend-color backgrounds**

Also check lines ~352-357 (`.token-segment.short-term` / `.long-term` backgrounds) and ~384-390 (`.legend-color.short-term` / `.long-term` backgrounds). Replace with `var(--memory-short-term)` and `var(--memory-long-term)` respectively.

- [ ] **Step 3: Replace operation status colors (lines ~486-489)**

Replace:
- add color → `var(--operation-add)`
- update color → `var(--operation-update)`
- delete color → `var(--operation-delete)`
- noop color → `var(--operation-noop)`

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/features/memory/memory-stats.component.ts
git commit -m "refactor(f9): use memory and operation tokens in memory-stats component"
```

---

### Task 5: Replace Hardcoded Overlay Values

**Files:**
- Modify: `src/renderer/app/features/settings/settings.component.ts` (line ~167)
- Modify: `src/renderer/app/features/context/compaction-indicator.component.ts` (line ~377)

- [ ] **Step 1: Replace overlay in settings.component.ts**

Find `rgba(0, 0, 0, 0.5)` (or equivalent) and replace with `var(--overlay-dark-medium)`.

- [ ] **Step 2: Replace box-shadow overlay in compaction-indicator.component.ts**

Find `rgba(0, 0, 0, 0.2)` in a `box-shadow` property (~line 377) and replace with `var(--overlay-dark-light)`. Note this is inside a `box-shadow` value, not a standalone `background`.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app/features/settings/settings.component.ts src/renderer/app/features/context/compaction-indicator.component.ts
git commit -m "refactor(f9): use overlay tokens instead of hardcoded rgba values"
```

---

### Task 6: Replace Hardcoded Values in Sidebar Components

**Files:**
- Modify: `src/renderer/app/features/dashboard/sidebar-header.component.scss` (lines ~11, ~57-58, ~81)
- Modify: `src/renderer/app/features/dashboard/sidebar-footer.component.scss` (lines ~8, ~23-24)
- Modify: `src/renderer/app/features/dashboard/dashboard.component.scss` (line ~69)

- [ ] **Step 1: Replace in sidebar-header.component.scss**

- Line ~11: `rgba(255,255,255,0.05)` → `var(--bg-hover)` (or create a `--bg-glass-subtle` if more precise)
- Lines ~57-58: `rgba(255,255,255,0.025)` → `rgba(255, 255, 255, 0.025)` — keep as-is if no exact token match, or use `var(--bg-hover)` with lower opacity
- Line ~81: `color: #10100d` → `color: var(--text-primary)`

- [ ] **Step 2: Replace in sidebar-footer.component.scss**

- Line ~8: `rgba(8,12,11,0.82)` → `var(--bg-primary)` with opacity, or `rgba(var(--bg-primary-rgb, 8, 12, 11), 0.82)` — if no RGB token exists, keep as-is but add a comment noting it should track `--bg-primary`
- Lines ~23-24: `rgba(255,255,255,0.03)` → use `var(--bg-hover)` if close enough

- [ ] **Step 3: Replace in dashboard.component.scss**

- Line ~69: `rgba(8,13,12,0.88)` → `var(--bg-secondary)` (the closest token for sidebar background)

- [ ] **Step 4: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/features/dashboard/sidebar-header.component.scss \
       src/renderer/app/features/dashboard/sidebar-footer.component.scss \
       src/renderer/app/features/dashboard/dashboard.component.scss
git commit -m "refactor(f9): replace hardcoded colors in sidebar and dashboard with design tokens"
```

---

### Task 7: Final Verification

- [ ] **Step 1: Run full typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 3: Visual check in dev mode**

Run: `npm run dev`
Expected: No visual regressions — colors should look identical since tokens use the same values.
