import { describe, expect, it } from 'vitest';
import { LinearCallError } from './linear-errors';
import { LINEAR_MAX_PAGES, readAllLinearPages, toLinearPage, type LinearPage } from './linear-paging';

function pagesOf(pages: string[][]): (cursor: string | undefined) => Promise<LinearPage<string>> {
  return async (cursor) => {
    const index = cursor === undefined ? 0 : Number(cursor);
    const nextCursor = index + 1 < pages.length ? String(index + 1) : undefined;
    return { items: pages[index], nextCursor };
  };
}

describe('reading every page', () => {
  it('joins three pages in order and passes each cursor back', async () => {
    const seen: (string | undefined)[] = [];
    const read = pagesOf([['a', 'b'], ['c'], ['d', 'e']]);
    const items = await readAllLinearPages(async (cursor) => {
      seen.push(cursor);
      return read(cursor);
    });
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(seen).toEqual([undefined, '1', '2']);
  });

  it('returns one page when there is no cursor', async () => {
    expect(await readAllLinearPages(pagesOf([['only']]))).toEqual(['only']);
  });

  it('fails when the cursor repeats, and never returns the partial list', async () => {
    const result = readAllLinearPages(async () => ({ items: ['x'], nextCursor: 'same' }));
    await expect(result).rejects.toMatchObject({ code: 'unexpected-result' });
    await expect(result).rejects.toThrow('same page');
  });

  it('fails when a cursor comes back after other pages', async () => {
    const cursors = ['a', 'b', 'a'];
    let at = 0;
    await expect(readAllLinearPages(async () => ({ items: ['x'], nextCursor: cursors[at++] }))).rejects.toThrow('same page');
  });

  it('fails after 40 pages instead of reading on', async () => {
    let reads = 0;
    const result = readAllLinearPages(async () => ({ items: ['x'], nextCursor: `page-${++reads}` }));
    await expect(result).rejects.toMatchObject({ code: 'unexpected-result' });
    expect(reads).toBe(LINEAR_MAX_PAGES);
  });

  it('reads exactly 40 pages when the 40th is the last', async () => {
    const pages = Array.from({ length: LINEAR_MAX_PAGES }, (_, index) => [`p${index}`]);
    expect(await readAllLinearPages(pagesOf(pages))).toHaveLength(LINEAR_MAX_PAGES);
  });

  it('refuses a result that says there is more but gives no cursor', () => {
    expect(() => toLinearPage(['a'], { hasNextPage: true })).toThrow(LinearCallError);
    expect(toLinearPage(['a'], { hasNextPage: true, cursor: 'next' })).toEqual({ items: ['a'], nextCursor: 'next' });
    expect(toLinearPage(['a'], { hasNextPage: false, cursor: 'ignored' }).nextCursor).toBeUndefined();
  });
});
