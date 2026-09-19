/**
 * Settings responsive viewport binding.
 *
 * Extracted from `SettingsComponent` to keep it under the repo's LOC ratchet.
 * Wires `MediaQueryList` listeners for the compact-nav (≤900px) and
 * Help-drawer (≤1180px) breakpoints into the four transient viewport
 * signals the shell reads. Cleanup is registered on the given `DestroyRef`.
 * Guarded for hosts without `matchMedia` (older test doubles / non-browser
 * environments) — the signals simply stay at their initial `false` value.
 */

import type { DestroyRef, WritableSignal } from '@angular/core';

/** Compact-nav breakpoint: in-flow rail stays 56px-equivalent below this width. */
export const SETTINGS_COMPACT_NAV_QUERY = '(max-width: 900px)';
/** Help-rail breakpoint: persistent Help rail is hidden below this width. */
export const SETTINGS_HELP_DRAWER_QUERY = '(max-width: 1180px)';

export interface SettingsViewportSignals {
  readonly compactViewport: WritableSignal<boolean>;
  readonly compactNavOpen: WritableSignal<boolean>;
  readonly helpDrawerMode: WritableSignal<boolean>;
  readonly helpDrawerOpen: WritableSignal<boolean>;
}

/**
 * Bind the compact-nav and Help-drawer media queries to the given signals.
 * Leaving a breakpoint closes its transient overlay signal, but never
 * touches the persisted desktop `navCollapsed`/`helpCollapsed` preferences —
 * those remain the component's own concern.
 */
export function bindSettingsViewportMediaQueries(
  signals: SettingsViewportSignals,
  destroyRef: DestroyRef,
): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return;
  }

  const compactMql = window.matchMedia(SETTINGS_COMPACT_NAV_QUERY);
  const helpDrawerMql = window.matchMedia(SETTINGS_HELP_DRAWER_QUERY);

  const syncCompact = (): void => {
    const compact = compactMql.matches;
    signals.compactViewport.set(compact);
    if (!compact) {
      signals.compactNavOpen.set(false);
    }
  };
  const syncHelpDrawer = (): void => {
    const drawerMode = helpDrawerMql.matches;
    signals.helpDrawerMode.set(drawerMode);
    if (!drawerMode) {
      signals.helpDrawerOpen.set(false);
    }
  };

  syncCompact();
  syncHelpDrawer();
  compactMql.addEventListener('change', syncCompact);
  helpDrawerMql.addEventListener('change', syncHelpDrawer);
  destroyRef.onDestroy(() => {
    compactMql.removeEventListener('change', syncCompact);
    helpDrawerMql.removeEventListener('change', syncHelpDrawer);
  });
}
