/**
 * Reads every page of one of Linear's list tools. It never hands back a partial list as if it were whole: a cursor
 * that does not move, or a list longer than the page limit, is an error.
 */
import { LinearCallError } from './linear-errors';

export const LINEAR_MAX_PAGES = 40;

export interface LinearPage<T> {
  items: readonly T[];
  /** The cursor for the next page; undefined when this was the last page. */
  nextCursor: string | undefined;
}

/** Turns a list tool's result into a page; a result that says there is more but gives no cursor is an error. */
export function toLinearPage<T>(
  items: readonly T[],
  fields: { hasNextPage: boolean; cursor?: string | null },
): LinearPage<T> {
  if (!fields.hasNextPage) return { items, nextCursor: undefined };
  if (!fields.cursor)
    throw new LinearCallError('unexpected-result', 'Linear said there are more results but gave no way to read them.');
  return { items, nextCursor: fields.cursor };
}

export async function readAllLinearPages<T>(
  readPage: (cursor: string | undefined) => Promise<LinearPage<T>>,
  maxPages: number = LINEAR_MAX_PAGES,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const page = await readPage(cursor);
    items.push(...page.items);
    if (page.nextCursor === undefined) return items;
    if (seen.has(page.nextCursor) || page.nextCursor === cursor)
      throw new LinearCallError('unexpected-result', 'Linear gave the same page of results twice.');
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new LinearCallError('unexpected-result', `Linear's list is longer than ${maxPages} pages, so Harness stopped reading it.`);
}
