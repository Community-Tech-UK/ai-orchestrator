/**
 * The order a run works its items in (`plan_queue_items.sort_key`).
 *
 * The key is a fixed-width string, so plain string comparison in SQL (`ORDER BY sort_key`) gives the order:
 * source priority first (Urgent, High, Medium, Low, then none), then the source's own order, then the order the
 * items were discovered in. Re-prioritising an item rewrites its key and never touches `created_at`, which stays
 * the time the item was created.
 *
 * Rows written before the column existed hold '' and sort first, together, in `created_at` order. That is the
 * order they always had, so no existing run changes order.
 */

/** Linear's priorities: 0 is "no priority" and sorts after Low. Markdown has none. */
export const PRIORITY_NONE = 0;
const WIDTH = 6;
const LAST_PRIORITY_RANK = 9;

export interface SortKeyParts {
  /** 1 (most urgent) to 4, or `PRIORITY_NONE`. */
  priority?: number;
  /** The source's own order among items of the same priority; 0 when it has none. */
  sourceOrder?: number;
  /** Position in discovery order. */
  discoveryIndex: number;
}

function fixed(value: number, name: string): string {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 10 ** WIDTH) throw new Error(`Invalid sort key ${name}: ${value}`);
  return String(value).padStart(WIDTH, '0');
}

export function buildSortKey(parts: SortKeyParts): string {
  const priority = parts.priority ?? PRIORITY_NONE;
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > LAST_PRIORITY_RANK) throw new Error(`Invalid sort key priority: ${priority}`);
  // "No priority" ranks after every real priority.
  const rank = priority === PRIORITY_NONE ? LAST_PRIORITY_RANK : priority;
  return `${rank}.${fixed(parts.sourceOrder ?? 0, 'source order')}.${fixed(parts.discoveryIndex, 'discovery index')}`;
}
