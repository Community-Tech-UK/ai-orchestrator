/**
 * Keybinding registry validation (WS-C9).
 *
 * The "cannot silently steal a binding" guarantee: this module is the single
 * place that decides whether a set of KeyBindings is safe to ship or accept
 * as a user override. It combines three checks:
 *
 * 1. Same-scope conflicts (`detectKeybindingConflicts`, existing/Task 13):
 *    two bindings in the SAME context resolve to the same key sequence, or
 *    one leader sequence is a strict prefix of another in the same context.
 * 2. Cross-context ("global overlap") conflicts, new here: a `context:
 *    'global'` binding is ALWAYS active (see KeybindingService.handleKeyDown
 *    — a binding only needs to match the current context when its OWN
 *    context is non-global), so it silently competes with any non-global
 *    binding that shares its key while that context is active. Two bindings
 *    that would both be eligible at the same time for the same key are
 *    flagged even though `detectKeybindingConflicts` treats them as
 *    different scopes.
 * 3. Reserved-key violations (`reserved-keys.ts`): a binding claims a
 *    platform combo AIO does not use today and must not silently claim.
 */
import type { KeyBinding, KeyCombo } from '../../../../shared/types/keybinding.types';
import {
  detectKeybindingConflicts,
  normalizeSequence,
  type KeybindingConflict,
} from '../services/keybinding-conflicts';
import { findReservedCombo, type KeybindingPlatform } from './reserved-keys';

export interface ReservedKeyViolation {
  readonly actionId: string;
  readonly key: string;
  readonly reason: string;
}

export interface RegistryValidationResult {
  readonly conflicts: readonly KeybindingConflict[];
  readonly crossContextConflicts: readonly KeybindingConflict[];
  readonly reservedViolations: readonly ReservedKeyViolation[];
  readonly isSafe: boolean;
}

function scopeOf(binding: KeyBinding): string {
  return binding.context ?? 'global';
}

function comboSetOf(binding: KeyBinding): string {
  return normalizeSequence(binding.keys);
}

/**
 * Flags bindings that would both be eligible for the same key sequence at
 * the same time because one of them is `context: 'global'` (always active)
 * and the other is a different, non-global context. Same-context pairs are
 * left to `detectKeybindingConflicts`, which already covers them.
 */
export function detectCrossContextConflicts(bindings: readonly KeyBinding[]): KeybindingConflict[] {
  const byCombo = new Map<string, KeyBinding[]>();
  for (const binding of bindings) {
    const combo = comboSetOf(binding);
    const list = byCombo.get(combo) ?? [];
    list.push(binding);
    byCombo.set(combo, list);
  }

  const out: KeybindingConflict[] = [];
  for (const [combo, group] of byCombo) {
    const globals = group.filter((b) => scopeOf(b) === 'global');
    const scoped = group.filter((b) => scopeOf(b) !== 'global');
    if (globals.length === 0 || scoped.length === 0) continue;
    // Distinct scoped contexts present alongside a global claim on this key.
    const scopedContexts = new Set(scoped.map(scopeOf));
    for (const context of scopedContexts) {
      const ids = [
        ...globals.map((b) => b.id),
        ...scoped.filter((b) => scopeOf(b) === context).map((b) => b.id),
      ].sort();
      out.push({ key: combo, scope: `global×${context}`, actionIds: ids });
    }
  }
  return out.sort((a, b) => (a.scope + a.key).localeCompare(b.scope + b.key));
}

function comboList(keys: KeyBinding['keys']): KeyCombo[] {
  return Array.isArray(keys) ? keys : [keys];
}

export function detectReservedKeyViolations(
  bindings: readonly KeyBinding[],
  platform: KeybindingPlatform,
): ReservedKeyViolation[] {
  const out: ReservedKeyViolation[] = [];
  for (const binding of bindings) {
    for (const combo of comboList(binding.keys)) {
      const reserved = findReservedCombo(combo, platform);
      if (reserved) {
        out.push({ actionId: binding.id, key: normalizeSequence(combo), reason: reserved.reason });
      }
    }
  }
  return out;
}

export function validateKeybindingRegistry(
  bindings: readonly KeyBinding[],
  platform: KeybindingPlatform,
): RegistryValidationResult {
  const conflicts = detectKeybindingConflicts(bindings);
  const crossContextConflicts = detectCrossContextConflicts(bindings);
  const reservedViolations = detectReservedKeyViolations(bindings, platform);
  return {
    conflicts,
    crossContextConflicts,
    reservedViolations,
    isSafe: conflicts.length === 0 && crossContextConflicts.length === 0 && reservedViolations.length === 0,
  };
}

/**
 * Dev-time guard: logs (never throws — a bad registry must not crash the
 * running app) when the shipped or customized binding set is unsafe. The
 * hard gate is the unit test asserting `isSafe` for `DEFAULT_KEYBINDINGS`
 * (keybinding-registry.spec.ts) — this is the runtime companion so a
 * regression is also visible immediately in a dev console.
 */
export function assertRegistryIsSafe(
  bindings: readonly KeyBinding[],
  platform: KeybindingPlatform,
): RegistryValidationResult {
  const result = validateKeybindingRegistry(bindings, platform);
  if (!result.isSafe) {
     
    console.error('[keybindings] registry is unsafe — a binding may silently steal another:', result);
  }
  return result;
}

/** Human-readable reason for the FIRST validation issue an override introduces, or `null` if safe. */
export function describeFirstViolation(result: RegistryValidationResult): string | null {
  if (result.reservedViolations.length > 0) {
    const v = result.reservedViolations[0];
    return `"${v.key}" is reserved (${v.reason}) and cannot be bound to ${v.actionId}.`;
  }
  if (result.crossContextConflicts.length > 0) {
    const c = result.crossContextConflicts[0];
    return `"${c.key}" would conflict across contexts (${c.scope}) for: ${c.actionIds.join(', ')}.`;
  }
  if (result.conflicts.length > 0) {
    const c = result.conflicts[0];
    return `"${c.key}" already conflicts in ${c.scope} for: ${c.actionIds.join(', ')}.`;
  }
  return null;
}
