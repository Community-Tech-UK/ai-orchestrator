import { describe, it, expect, vi } from 'vitest';
import {
  buildFileMenuItems,
  getSelectedTextInItem,
  withSelectionItem,
} from './output-stream-context-menu';
import type { ContextMenuItem } from '../../shared/components/context-menu/context-menu.component';
import type { LinkedFileTarget } from './output-stream.types';

/**
 * Unit tests for the transcript's right-click context menu builders.
 *
 * The headline behavior: right-clicking a highlighted fragment of a message
 * offers to copy just that fragment, not the whole message.
 */

interface StubSelectionOptions {
  text: string;
  isCollapsed?: boolean;
  /** Containers the selection's single range reports as intersecting. */
  intersects?: unknown[];
  rangeCount?: number;
}

function stubSelection({
  text,
  isCollapsed = false,
  intersects,
  rangeCount = 1,
}: StubSelectionOptions): Selection {
  const range = {
    intersectsNode: (node: unknown) => (intersects ? intersects.includes(node) : true),
  };
  return {
    isCollapsed,
    rangeCount,
    getRangeAt: () => range,
    toString: () => text,
  } as unknown as Selection;
}

/** A right-click target nested inside the given transcript item element. */
function stubEventTarget(container: unknown): EventTarget {
  return { closest: (selector: string) => (selector === '.transcript-item' ? container : null) } as unknown as EventTarget;
}

describe('getSelectedTextInItem', () => {
  const container = { id: 'transcript-item' };

  it('returns the selected text when the selection is inside the clicked item', () => {
    const text = 'git commit -am "feat: thing"';
    expect(
      getSelectedTextInItem(stubEventTarget(container), stubSelection({ text, intersects: [container] })),
    ).toBe(text);
  });

  it('preserves leading whitespace so code-block indentation survives the copy', () => {
    const text = '    const indented = true;';
    expect(
      getSelectedTextInItem(stubEventTarget(container), stubSelection({ text, intersects: [container] })),
    ).toBe(text);
  });

  it('returns "" when there is no selection', () => {
    expect(getSelectedTextInItem(stubEventTarget(container), null)).toBe('');
  });

  it('returns "" for a collapsed caret', () => {
    expect(
      getSelectedTextInItem(stubEventTarget(container), stubSelection({ text: '', isCollapsed: true })),
    ).toBe('');
  });

  it('returns "" when the selection is whitespace only', () => {
    expect(
      getSelectedTextInItem(stubEventTarget(container), stubSelection({ text: '   \n ', intersects: [container] })),
    ).toBe('');
  });

  it('returns "" when the selection lives in a different transcript item', () => {
    const otherContainer = { id: 'other' };
    expect(
      getSelectedTextInItem(
        stubEventTarget(container),
        stubSelection({ text: 'elsewhere', intersects: [otherContainer] }),
      ),
    ).toBe('');
  });

  it('returns "" when the click was not inside a transcript item', () => {
    expect(
      getSelectedTextInItem(stubEventTarget(null), stubSelection({ text: 'anything' })),
    ).toBe('');
  });
});

describe('withSelectionItem', () => {
  const baseItems: ContextMenuItem[] = [
    { label: 'Copy message', action: vi.fn() },
    { label: 'Fork from here', divider: true, action: vi.fn() },
  ];

  it('leaves the menu untouched when nothing is selected', () => {
    expect(withSelectionItem('', baseItems, vi.fn())).toEqual(baseItems);
  });

  it('prepends "Copy selection" and divides it from the existing items', () => {
    const result = withSelectionItem('selected', baseItems, vi.fn());

    expect(result.map((i) => i.label)).toEqual([
      'Copy selection',
      'Copy message',
      'Fork from here',
    ]);
    expect(result[0].divider).toBeUndefined();
    expect(result[1].divider).toBe(true);
  });

  it('does not mutate the items it was given', () => {
    withSelectionItem('selected', baseItems, vi.fn());

    expect(baseItems[0].divider).toBeUndefined();
  });

  it('copies the text captured at menu-build time, not the live selection', () => {
    const copySelection = vi.fn();
    const result = withSelectionItem('captured at open', baseItems, copySelection);

    result[0].action();

    expect(copySelection).toHaveBeenCalledWith('captured at open');
  });

  it('returns a lone "Copy selection" entry when there are no other items', () => {
    const result = withSelectionItem('selected', [], vi.fn());

    expect(result.map((i) => i.label)).toEqual(['Copy selection']);
  });
});

describe('buildFileMenuItems', () => {
  const localTarget: LinkedFileTarget = {
    rawPath: 'src/app.ts',
    resolvedPath: '/repo/src/app.ts',
    displayPath: 'src/app.ts',
    canUseLocalFileActions: true,
  };

  it('labels the file-manager entry with the supplied system label', () => {
    const items = buildFileMenuItems(localTarget, 'Finder', {
      copyPath: vi.fn(),
      copyFile: vi.fn(),
      openInFileManager: vi.fn(),
    });

    expect(items.map((i) => i.label)).toEqual(['Copy path', 'Copy file', 'Open in Finder']);
    expect(items.every((i) => !i.disabled)).toBe(true);
  });

  it('disables the file-touching entries when local file actions are unavailable', () => {
    const items = buildFileMenuItems(
      { ...localTarget, canUseLocalFileActions: false },
      'Finder',
      { copyPath: vi.fn(), copyFile: vi.fn(), openInFileManager: vi.fn() },
    );

    // Copying the path text still works for a remote instance's files.
    expect(items[0].disabled).toBeUndefined();
    expect(items[1].disabled).toBe(true);
    expect(items[2].disabled).toBe(true);
  });

  it('wires each entry to its own action', () => {
    const actions = {
      copyPath: vi.fn(),
      copyFile: vi.fn(),
      openInFileManager: vi.fn(),
    };
    const items = buildFileMenuItems(localTarget, 'Finder', actions);

    items.forEach((i) => i.action());

    expect(actions.copyPath).toHaveBeenCalledTimes(1);
    expect(actions.copyFile).toHaveBeenCalledTimes(1);
    expect(actions.openInFileManager).toHaveBeenCalledTimes(1);
  });
});
