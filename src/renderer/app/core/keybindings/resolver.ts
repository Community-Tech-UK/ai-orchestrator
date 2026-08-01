/**
 * Pure keybinding resolution (WS-C9).
 *
 * Framework-free so "most-specific-context-wins" precedence is directly
 * unit-testable without Angular/DOM. `KeybindingService.handleKeyDown`
 * delegates here instead of the ad-hoc array-order loop it used before —
 * the array order used to decide which of two matching bindings won, which
 * is exactly how a newly-added overlay binding could get silently shadowed
 * by an earlier 'global' entry sharing its key.
 *
 * Context precedence: a binding scoped to the currently-active context
 * (anything other than 'global') is considered BEFORE 'global' bindings,
 * because 'global' bindings are always active regardless of context (see
 * `KeybindingContext` doc comment) and must not out-rank a more specific
 * match by sheer array position.
 */
import type {
  KeyBinding,
  KeybindingContext,
  KeybindingEligibilityState,
  KeybindingWhen,
} from '../../../../shared/types/keybinding.types';
import { matchesKeybindingWhen } from '../../../../shared/types/keybinding.types';

function scopeOf(binding: KeyBinding): KeybindingContext {
  return binding.context ?? 'global';
}

/**
 * Orders `bindings` so context-specific matches for `activeContext` come
 * before 'global' bindings, and drops bindings scoped to a DIFFERENT
 * non-global context entirely (they are simply not eligible right now).
 * Relative order within each group is preserved (stable).
 */
export function orderByContextSpecificity(
  bindings: readonly KeyBinding[],
  activeContext: KeybindingContext,
): KeyBinding[] {
  const specific: KeyBinding[] = [];
  const global: KeyBinding[] = [];
  for (const binding of bindings) {
    const scope = scopeOf(binding);
    if (scope === 'global') {
      global.push(binding);
    } else if (scope === activeContext) {
      specific.push(binding);
    }
    // else: bound to a different, currently-inactive context — not eligible.
  }
  return [...specific, ...global];
}

/**
 * The full resolver: context-ordered bindings, filtered by `when`
 * eligibility against the current UI state. Callers still need to match
 * the actual key combo/sequence (KeyboardEvent-specific, so it stays in
 * KeybindingService) — this is the context+eligibility half.
 */
export function eligibleBindings(
  bindings: readonly KeyBinding[],
  activeContext: KeybindingContext,
  state: KeybindingEligibilityState,
): KeyBinding[] {
  return orderByContextSpecificity(bindings, activeContext).filter((binding) =>
    matchesKeybindingWhen(binding.when as KeybindingWhen[] | undefined, state),
  );
}
