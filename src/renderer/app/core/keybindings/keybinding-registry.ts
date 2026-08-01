/**
 * Keybinding registry — canonical entry point for AIO's keyboard-shortcut
 * system (WS-C9, docs/plans/2026-07-30-sibling-audit-round2_plan.md §WS-C9).
 *
 * The single source of truth for keybindings remains
 * `shared/types/keybinding.types.ts` (`DEFAULT_KEYBINDINGS`,
 * `KeybindingContext`, `KeybindingAction`) — this module does NOT duplicate
 * that data. It documents the context taxonomy, re-exports the registry for
 * convenience, and tracks the long-tail of component-local keyboard
 * handlers found during the WS-C9 survey that are not routed through
 * `KeybindingService`/`ActionDispatchService`.
 */
import { DEFAULT_KEYBINDINGS } from '../../../../shared/types/keybinding.types';
import type { KeyBinding, KeybindingContext } from '../../../../shared/types/keybinding.types';

export type { KeyBinding, KeybindingContext } from '../../../../shared/types/keybinding.types';

/** The canonical registry. Re-exported so `core/keybindings/*` consumers don't reach into `shared/types` directly. */
export const KEYBINDING_REGISTRY: readonly KeyBinding[] = DEFAULT_KEYBINDINGS;

/** Every context defined for the resolver, in most-specific-first documentation order (excluding 'global', which is always active). */
export const KEYBINDING_CONTEXTS: readonly KeybindingContext[] = [
  'overlay',
  'command-palette',
  'instance-list',
  'output',
  'input',
  'global',
];

export const KEYBINDING_CONTEXT_LABELS: Record<KeybindingContext, string> = {
  global: 'Global',
  input: 'Composer / input',
  output: 'Transcript / output',
  'instance-list': 'Instance list',
  'command-palette': 'Command palette',
  overlay: 'Overlay (picker/search)',
};

/**
 * WS-C9 survey inventory (2026-07-31). Grep sweep for
 * `keydown|hotkey|shortcut|metaKey|ctrlKey` across `src/renderer`, minus the
 * keybinding system's own files. Kept as a living comment (not executable
 * data) so future migrations can `grep` this file to find the remaining
 * candidates and their disposition.
 *
 * === Structural widget navigation — correctly left local (not app-wide
 * shortcuts; intrinsic to the widget, reused across many instantiations) ===
 * - features/overlay/overlay-shell.component.ts — Escape/Enter/ArrowUp/Down
 *   list navigation shared by every overlay (command palette, command help,
 *   session/model/resume pickers, prompt-history search). WS-C9 fixed a
 *   double-fire hazard here (see below) but intentionally did NOT move the
 *   navigation itself onto the resolver.
 * - features/instance-list/instance-list.component.ts:1005 — Escape/Home/
 *   End/Tab roving-tabindex list navigation.
 * - shared/menu/nested-menu.component.ts,
 *   shared/components/context-menu/context-menu.component.ts:224 — menu
 *   widget navigation / Escape-to-close.
 * - shared/utils/focus-trap.ts — Tab-cycling inside a trapped dialog.
 * - features/rlm/rlm-context-browser.component.ts:645 — panel-local
 *   Ctrl/Cmd+Enter, Escape, ArrowUp/Down.
 * - Many `(keydown.enter)`/`(keydown.space)` bindings across feature
 *   components activating a `role="button"` div — accessibility pattern,
 *   not a shortcut.
 *
 * === Feature-scoped shortcuts NOT migrated (out of WS-C9 territory or
 * deferred; candidates for a future pass) ===
 * - features/instance-detail/output-stream.component.ts:558 — Cmd/Ctrl+F
 *   (transcript find). instance-detail/* excluded from this workstream.
 * - features/instance-detail/instance-detail.component.ts:584 — Escape,
 *   Cmd/Ctrl+O, Cmd/Ctrl+Shift+V. instance-detail/* excluded.
 * - features/instance-detail/input-panel.component.ts — composer editing
 *   (word-left/right, kill/yank, recall) and `send-message`: already routed
 *   through KeybindingService/ActionDispatchService before WS-C9;
 *   instance-detail/* excluded from further changes here.
 * - features/source-control/source-control-repo-actions.component.ts:144 —
 *   Cmd/Ctrl+Enter to commit. source-control/* excluded from this
 *   workstream.
 * - features/models/model-selection-panel.component.ts:805,1022 — its own
 *   ⌘1..⌘9 quick-select hint labels (`shortcutLabel()`), computed locally
 *   rather than through `KeybindingService`/`ShortcutHintPipe`. Not a
 *   registered binding today (no dispatchable action id), so left alone.
 * - features/chat-search/chat-search-page.component.ts:395,
 *   features/source-control/source-control-diff-viewer.component.ts:326,
 *   features/orchestration/child-diagnostic-bundle.modal.component.ts:31 —
 *   `@HostListener('document:keydown.escape')` local-modal-close pattern,
 *   same shape as the overlay fix below but on pages outside this
 *   workstream's territory.
 *
 * === Migrated / hardened by WS-C9 ===
 * - Overlay open (`toggle-command-palette`, `open-session-picker`,
 *   `open-model-picker`, `open-prompt-history-search`, `resume.openPicker`)
 *   and close (`cancel-operation`, via `dashboard-cancel-operation.ts`) were
 *   already routed through the resolver pre-WS-C9. This workstream found and
 *   fixed a real bug: `OverlayShellComponent`'s own local Escape handling
 *   did not stop propagation, so the bubbling keydown also reached
 *   `KeybindingService`'s document-level listener. Because
 *   `ActionDispatchService`'s eligibility snapshot is refreshed by an
 *   `effect()` (not synchronously with the signal write the overlay's own
 *   handler just made), the still-stale `commandPaletteOpen: true` let
 *   `cancel-operation` re-fire in the SAME keydown dispatch — reading the
 *   now-current (already-false) overlay signals and falling through to
 *   `interruptInstance()`, i.e. dismissing a picker with Escape could
 *   unintentionally interrupt the selected running instance. Fixed by
 *   `stopPropagation()` in `overlay-shell.component.ts`'s Escape handling.
 * - `OverlayShellComponent` now tracks the resolver's `'overlay'` context
 *   (`keybindingService.setContext('overlay')` on open, restored on close),
 *   formalizing overlay as a real context in the taxonomy for future
 *   overlay-scoped bindings.
 */
export const WS_C9_INVENTORY_NOTE =
  'See the file-level comment above for the full WS-C9 keyboard-shortcut survey inventory.';
