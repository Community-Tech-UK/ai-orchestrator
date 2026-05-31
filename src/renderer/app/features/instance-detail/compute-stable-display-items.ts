/**
 * Reference-stable display items for the chat transcript.
 *
 * Ported from t3code's `computeStableMessagesTimelineRows` pattern: when state
 * recomputes the row list, walk the new rows and keep each one's previous object
 * reference if its content has not changed. Downstream OnPush components then see
 * stable input references and skip change detection for rows that didn't change,
 * and when nothing changed at all we return the exact same array so the template
 * `@for` and any dependent `computed()` short-circuit entirely.
 *
 * Divergence from the original pattern (deliberate, see DisplayItemProcessor):
 * t3code rebuilds its rows immutably on every update, so two recomputes always
 * produce distinct objects and a per-field `===` comparison is meaningful. Our
 * `DisplayItemProcessor` does the opposite for performance: it reuses the same
 * `DisplayItem` object across recomputes and mutates it in place
 *   - tool-group growth: `toolMessages.push(...)` (same array reference)
 *   - system-event-group growth: `systemEvents = [...]`, `groupPreview = ...`
 *   - header recomputation: `showHeader` / `repeatCount` / `bufferIndex`
 * When the previous reference and the new value are the same object, a per-field
 * `===` comparison can never see the mutation (it compares a field to itself) and
 * we would return a stale array, hiding live updates. So instead of comparing two
 * objects we compare a content *signature* captured on the previous call against a
 * freshly computed one. The signature folds in array lengths and per-object
 * identity tokens, so in-place mutations flip it.
 */

import type { DisplayItem } from './display-item-processor.service';

/**
 * State carried between calls so we can preserve object references for rows whose
 * content has not changed.
 *
 * `byId` maps each item's id to the canonical reference for that id (whichever
 * object the consumer is currently rendering). `signatures` maps each id to the
 * content signature captured for that canonical reference. `result` is the most
 * recently returned array; when nothing changed we hand back the exact same array
 * so dependent signals short-circuit.
 */
export interface StableDisplayItemsState {
  byId: Map<string, DisplayItem>;
  signatures: Map<string, string>;
  result: DisplayItem[];
}

export const EMPTY_STABLE_DISPLAY_ITEMS_STATE: StableDisplayItemsState = {
  byId: new Map(),
  signatures: new Map(),
  result: [],
};

/**
 * Given a freshly-computed list of display items and the previous stable state,
 * return a new state where each row keeps its old reference if its content has not
 * changed. If no row changed and the list length is identical, return the exact
 * previous state (same maps, same array reference).
 *
 * Pure function. No side effects. Safe to call inside `computed()`.
 */
export function computeStableDisplayItems(
  items: DisplayItem[],
  previous: StableDisplayItemsState,
): StableDisplayItemsState {
  if (items.length === 0 && previous.result.length === 0) {
    return previous;
  }

  const byId = new Map<string, DisplayItem>();
  const signatures = new Map<string, string>();
  let anyChanged = items.length !== previous.result.length;

  const result = items.map((item, index) => {
    const signature = displayItemSignature(item);
    const previousItem = previous.byId.get(item.id);
    const unchanged =
      previousItem !== undefined && previous.signatures.get(item.id) === signature;
    const nextItem = unchanged ? previousItem : item;

    byId.set(item.id, nextItem);
    signatures.set(item.id, signature);

    if (!anyChanged && (!unchanged || previous.result[index] !== nextItem)) {
      anyChanged = true;
    }
    return nextItem;
  });

  return anyChanged ? { byId, signatures, result } : previous;
}

/**
 * True when two display items would render identically. Two items count as
 * unchanged when they share the same id and type and every render-affecting field
 * is reference-equal (or, for the arrays the processor grows, has the same length
 * and tail element). This mirrors the per-field `===` intent of the original
 * pattern; it is exported for direct use and is exercised per-variant by the
 * tests.
 *
 * Note: because the comparison is reference-based, "content-equal" means the
 * compared fields are the *same* objects, not merely deep-equal. That matches how
 * `DisplayItemProcessor` works: it reuses field references for rows whose content
 * has not changed, so equal content always implies equal references here.
 */
export function isDisplayItemUnchanged(a: DisplayItem, b: DisplayItem): boolean {
  if (a.id !== b.id || a.type !== b.type) {
    return false;
  }
  return displayItemSignature(a) === displayItemSignature(b);
}

/**
 * Per-object identity tokens. Lets a string signature encode "did this object
 * reference change" without reading the (potentially large) object contents.
 * A WeakMap keeps this leak-free: tokens vanish when their objects are collected.
 */
let nextRefToken = 1;
const refTokens = new WeakMap<object, number>();

function refToken(value: unknown): number {
  if (value === null || typeof value !== 'object') {
    return 0;
  }
  let token = refTokens.get(value);
  if (token === undefined) {
    token = nextRefToken++;
    refTokens.set(value, token);
  }
  return token;
}

/**
 * Compact, comparable snapshot of the fields that decide how a row renders.
 *
 * Object-valued fields the processor *replaces* on change (message,
 * renderedMessage, response, ...) are folded in as identity tokens, so a new
 * object flips the signature. Arrays the processor *grows in place*
 * (toolMessages) or *reassigns* (systemEvents) also contribute their length and
 * tail-element token, so growth is detected even though the surrounding
 * DisplayItem object is reused. The branches mirror DisplayItem's `type`
 * discriminator; the exhaustiveness check fails to compile if a new variant is
 * added without a branch here.
 */
function displayItemSignature(item: DisplayItem): string {
  switch (item.type) {
    case 'message':
      return [
        'message',
        item.id,
        refToken(item.message),
        item.message?.attachments?.length ?? 0,
        item.message?.failedImages?.length ?? 0,
        refToken(item.renderedMessage),
        item.showHeader ?? '',
        item.repeatCount ?? '',
        item.timestamp ?? '',
      ].join('|');

    case 'plan-update': {
      const plan = item.planUpdate;
      return [
        'plan-update',
        item.id,
        item.timestamp ?? '',
        plan?.totalCount ?? 0,
        plan?.pendingCount ?? 0,
        plan?.inProgressCount ?? 0,
        plan?.completedCount ?? 0,
        plan?.cancelledCount ?? 0,
        plan?.unknownCount ?? 0,
        plan?.entries.map((entry) => [
          entry.content,
          entry.statusKind,
          entry.statusLabel,
          entry.priorityKind,
          entry.priorityLabel ?? '',
        ].join('~')).join('||') ?? '',
      ].join('|');
    }

    case 'tool-group': {
      const tools = item.toolMessages;
      const last = tools && tools.length > 0 ? tools[tools.length - 1] : undefined;
      return [
        'tool-group',
        item.id,
        refToken(tools),
        tools?.length ?? 0,
        refToken(last),
      ].join('|');
    }

    case 'thought-group':
      return [
        'thought-group',
        item.id,
        refToken(item.thinking),
        item.thinking?.length ?? 0,
        refToken(item.thoughts),
        item.thoughts?.length ?? 0,
        refToken(item.response),
        item.response?.attachments?.length ?? 0,
        item.response?.failedImages?.length ?? 0,
        refToken(item.renderedResponse),
        item.showHeader ?? '',
      ].join('|');

    case 'work-cycle': {
      // Recurse into children so a child's in-place change (e.g. a header
      // toggle) flips the wrapper signature too. wrapForDisplay() reslices the
      // children array on every recompute, so a plain array-reference compare
      // would never stabilise a work-cycle; the per-child signatures do.
      const children = item.children ?? [];
      return [
        'work-cycle',
        item.id,
        item.groupAction ?? '',
        item.groupPreview ?? '',
        children.length,
        children.map(displayItemSignature).join('~'),
      ].join('|');
    }

    case 'system-event-group':
      // groupPreview is free-form (derived from event content), so it goes last:
      // a stray '|' inside it then cannot shift any preceding field boundary.
      return [
        'system-event-group',
        item.id,
        item.groupLabel ?? '',
        item.systemEvents?.length ?? 0,
        refToken(item.systemEvents),
        item.groupPreview ?? '',
      ].join('|');

    case 'interrupt-boundary': {
      // reason is free-form, so it goes last (see system-event-group note).
      const boundary = item.interruptBoundary;
      return [
        'interrupt-boundary',
        item.id,
        boundary?.phase ?? '',
        boundary?.outcome ?? '',
        boundary?.at ?? '',
        boundary?.fallbackMode ?? '',
        boundary?.reason ?? '',
      ].join('|');
    }

    case 'compaction-summary': {
      // reason is free-form, so it goes last (see system-event-group note).
      const summary = item.compactionSummary;
      return [
        'compaction-summary',
        item.id,
        summary?.beforeCount ?? '',
        summary?.afterCount ?? '',
        summary?.tokensReclaimed ?? '',
        summary?.fallbackMode ?? '',
        summary?.at ?? '',
        summary?.reason ?? '',
      ].join('|');
    }

    default: {
      const exhaustive: never = item.type;
      return String(exhaustive);
    }
  }
}
