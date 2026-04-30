# t3code usability ideas worth porting into AI Orchestrator

This review only keeps `t3code` ideas that would improve **day-to-day usability** in AI Orchestrator. I skipped backend-only patterns and anything AI Orchestrator already does well enough.

## Best candidates

### 1. Show keyboard shortcuts directly inside command results

**Why it matters:** AI Orchestrator already has a command palette and a keyboard settings page, but shortcut discovery is still separated from the place where users execute commands. `t3code` makes the palette teach the shortcuts while you use it.

**t3code proof**
- `t3code/apps/web/src/components/CommandPaletteResults.tsx`
- `t3code/apps/web/src/keybindings.ts`

**AI Orchestrator today**
- `src/renderer/app/features/overlay/overlay-shell.component.ts`
- `src/renderer/app/features/commands/command-palette.controller.ts`
- `src/renderer/app/core/services/keybinding.service.ts`

**Recommendation:** extend overlay items so commands can optionally render a formatted shortcut label (for example `Cmd+K`, `Ctrl+Shift+P`) beside the badge/detail text. This is a high-value discoverability win with low implementation risk because the formatting logic already exists in `KeybindingService`.

### 2. Upgrade overlay search from plain substring matching to multi-term ranked matching

**Why it matters:** AI Orchestrator uses simple `includes(query)` matching in several search-heavy flows. That works, but it makes real queries less forgiving and less efficient than `t3code`'s normalized multi-term matching.

**t3code proof**
- `t3code/apps/web/src/components/CommandPalette.logic.ts`

**AI Orchestrator today**
- `src/renderer/app/features/commands/command-palette.controller.ts`
- `src/renderer/app/features/models/model-picker.controller.ts`
- `src/renderer/app/features/resume/resume-picker.controller.ts`
- `src/renderer/app/features/prompt-history/prompt-history-search.controller.ts`
- `src/renderer/app/core/state/history.store.ts`

**Recommendation:** introduce one shared search helper for overlay/search surfaces that:
- normalizes whitespace
- splits queries into terms
- scores exact/prefix/term matches higher than generic substring matches
- can be reused across command, model, resume, prompt-history, and history search

This would make the app feel faster and smarter without adding new UI.

### 3. Add `1-9` quick-select for approval and option prompts

**Why it matters:** AI Orchestrator already asks users to approve, reject, or choose options, but those prompts are still mostly pointer-driven. `t3code` turns these moments into near-instant keyboard actions.

**t3code proof**
- `t3code/apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx`

**AI Orchestrator today**
- `src/renderer/app/features/instance-detail/user-action-request.component.ts`

**Recommendation:** when a `select_option` request is open, pressing `1-9` should activate the matching option. This is especially useful for repeated approval loops and multi-agent workflows where users are making many quick decisions in succession.

### 4. Make the history sidebar resizable and persistent

**Why it matters:** AI Orchestrator already persists the main dashboard and file-explorer widths, but the history sidebar is still hard-coded to `350px`. `t3code` handles sidebar resizing in a way that respects both user preference and layout constraints.

**t3code proof**
- `t3code/apps/web/src/components/AppSidebarLayout.tsx`

**AI Orchestrator today**
- `src/renderer/app/features/history/history-sidebar.component.ts`
- `src/renderer/app/core/services/view-layout.service.ts`

**Recommendation:** reuse the existing layout persistence pattern and add a persisted width for the history sidebar with sensible min/max bounds. This would help on both small windows and ultra-wide displays.

### 5. Replace ad hoc localStorage parsing with one validated persistence layer

**Why it matters:** AI Orchestrator persists a lot of useful UI state, but most of it is hydrated with manual `JSON.parse` + shape checks + silent fallback. `t3code` has a cleaner pattern: one storage helper, typed reads/writes, and safer migration behavior.

**t3code proof**
- `t3code/apps/web/src/hooks/useLocalStorage.ts`
- `t3code/apps/web/src/uiStateStore.ts`

**AI Orchestrator today**
- `src/renderer/app/core/services/view-layout.service.ts`
- `src/renderer/app/features/instance-list/history-rail.service.ts`
- `src/renderer/app/core/state/agent.store.ts`
- `src/renderer/app/core/services/new-session-draft.service.ts`

**Recommendation:** create a shared renderer storage utility with:
- typed decode/encode
- versioned keys
- migration hooks
- central validation for persisted shapes

This is mostly a reliability improvement, but it directly affects usability because corrupted or stale state stops layouts, drafts, pins, and preferences from restoring correctly.

### 6. Wire a real clipboard feedback layer, ideally anchored near the copy source

**Why it matters:** `t3code` gives immediate copy feedback exactly where the user clicked. AI Orchestrator has the beginnings of a shared clipboard feedback system, but I did not find an app-level provider for it, so copy feedback looks inconsistent depending on the component.

**t3code proof**
- `t3code/apps/web/src/components/chat/MessageCopyButton.tsx`
- `t3code/apps/web/src/hooks/useCopyToClipboard.ts`

**AI Orchestrator today**
- `src/renderer/app/core/services/clipboard.service.ts`
- `src/renderer/app/core/services/clipboard-toast.token.ts`
- `src/renderer/app/features/instance-detail/output-stream.component.ts`

**Recommendation:** add a concrete renderer-level `CLIPBOARD_TOAST` provider and prefer anchored success/error feedback for copy actions in message streams, verification results, code search results, and token/config copy buttons.

## Lower priority / already covered well enough

These exist in `t3code`, but AI Orchestrator already has comparable support, so they are not worth prioritizing from this review:

- **Settings sidebar structure**: AI Orchestrator already has a strong full-page settings nav in `src/renderer/app/features/settings/settings.component.ts`.
- **Context-aware keybindings**: AI Orchestrator already supports context and `when` logic in `src/renderer/app/core/services/keybinding.service.ts`.
- **Draft autosave with unload flush**: AI Orchestrator already does this in `src/renderer/app/core/services/new-session-draft.service.ts`.
- **Resizable main sidebar/file explorer**: AI Orchestrator already persists these through `src/renderer/app/core/services/view-layout.service.ts`.

## Suggested implementation order

1. **Shortcut labels in overlays**
2. **Multi-term ranked search**
3. **`1-9` quick-select for option prompts**
4. **History sidebar resize persistence**
5. **Clipboard toast provider + anchored feedback**
6. **Shared validated storage utility**
