import { createHash } from 'node:crypto';

// How a tool call's arguments and result are hashed for loop detection. Split out of
// `adapter-runtime-event-bridge.ts` to keep that file under its size ceiling.

/**
 * LT-061: top-level argument field names that, by convention, carry
 * human-facing narration attached to a tool call rather than data the tool
 * acts on — e.g. Anthropic's Bash tool `description`, documented as "shown
 * to the user before the command is executed" and not consumed by the
 * shell. CLIs vary this text between otherwise-identical calls (a polling
 * loop's Nth "(N/8)" caption), which would otherwise make every call hash
 * differently and defeat `repeat-no-progress`/`ping-pong` in
 * `doom-loop-detector.ts`.
 *
 * Deliberately scoped by FIELD NAME across every tool and provider, not by
 * tool name or provider: a denylist keyed to e.g. `toolName === 'Bash'`
 * rots the moment a different tool or CLI adds its own annotation field
 * under a different name. This still needs a new entry for a genuinely
 * novel field-name convention, but no longer needs one per tool or
 * provider.
 *
 * Safe against masking a *substantive* field that happens to share one of
 * these names (e.g. some tool's `description` being its actual payload):
 * both detectors additionally require the tool *result* to match/stay
 * stable across the repeated calls (see `checkRepeatNoProgress` /
 * `isAlternatingStableWindow`), and a call whose real effect lives in one
 * of these fields will almost always produce a different result each time,
 * so it will not falsely collapse into "no progress".
 */
const ARGS_HASH_IGNORED_ANNOTATION_FIELDS = new Set([
  'description',
  'reason',
  'rationale',
  'explanation',
  'justification',
  'summary',
  'note',
  'thought',
]);

/**
 * Drop top-level `ARGS_HASH_IGNORED_ANNOTATION_FIELDS` keys before hashing
 * tool_use arguments for loop detection. Leaves non-object values (and
 * `argsSummary`, computed separately from the untouched arguments) alone.
 */
export function stripAnnotationFieldsForHash(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([key]) => !ARGS_HASH_IGNORED_ANNOTATION_FIELDS.has(key),
  );
  const stripped = Object.fromEntries(entries);
  // ACP wraps operative arguments in rawInput. Its captions have the same
  // meaning as top-level captions from other adapters.
  if (typeof stripped['kind'] === 'string' && stripped['rawInput']
    && typeof stripped['rawInput'] === 'object' && !Array.isArray(stripped['rawInput'])) {
    stripped['rawInput'] = Object.fromEntries(Object.entries(stripped['rawInput']).filter(
      ([key]) => !ARGS_HASH_IGNORED_ANNOTATION_FIELDS.has(key),
    ));
  }
  return stripped;
}

/** sha256 hex digest (first 16 chars) — matches the pattern in loop-invoker-capture.ts. */
export function hashStable(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Deterministic JSON serialization (sorted keys) so equal values hash equal regardless of key order. */
export function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(sortJsonKeys(value));
  } catch {
    return String(value);
  }
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJsonKeys(child)]),
  );
}
