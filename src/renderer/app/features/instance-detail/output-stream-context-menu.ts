import type { FailedImageRef } from '../../../../shared/types/instance.types';
import type { ContextMenuItem } from '../../shared/components/context-menu/context-menu.component';
import type { DisplayItem } from './display-item.types';
import type { LinkedFileTarget } from './output-stream.types';

/**
 * Item builders for the transcript's right-click context menu.
 *
 * Right-clicking a message offers "Copy message", which copies the whole
 * message. When the user has highlighted part of a message, they almost always
 * want just that part, so the menu grows a "Copy selection" entry above the
 * existing items.
 */

/** The transcript row that owns a message's context menu. */
const TRANSCRIPT_ITEM_SELECTOR = '.transcript-item';

/**
 * Text selected inside the right-clicked transcript item, or '' when the
 * selection is empty, whitespace-only, or lives in a different item.
 *
 * The caller captures this while the menu is built, because clicking a menu
 * item can collapse the DOM selection before the action runs.
 *
 * Whitespace is preserved in the returned text (a selection inside a code block
 * carries meaningful leading indentation) and only ignored when deciding
 * whether a selection exists at all.
 */
export function getSelectedTextInItem(
  eventTarget: EventTarget | null,
  selection: Selection | null,
): string {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return '';
  }

  const container = (eventTarget as Element | null)?.closest?.(TRANSCRIPT_ITEM_SELECTOR);
  if (!container) {
    return '';
  }

  for (let i = 0; i < selection.rangeCount; i++) {
    if (selection.getRangeAt(i).intersectsNode(container)) {
      const text = selection.toString();
      return text.trim() ? text : '';
    }
  }
  return '';
}

/**
 * Prepend a "Copy selection" entry when the right-click landed on a selection.
 *
 * The following item gains a divider so the selection action reads as its own
 * group ahead of the message/file actions.
 */
export function withSelectionItem(
  selectedText: string,
  items: ContextMenuItem[],
  copySelection: (text: string) => void,
): ContextMenuItem[] {
  if (!selectedText) {
    return items;
  }

  const selectionItem: ContextMenuItem = {
    id: 'copy-selection',
    label: 'Copy selection',
    action: () => copySelection(selectedText),
  };

  const [first, ...rest] = items;
  return first ? [selectionItem, { ...first, divider: true }, ...rest] : [selectionItem];
}

/** Actions backing the menu shown when right-clicking a linked file path. */
export interface LinkedFileMenuActions {
  copyPath: () => void;
  copyFile: () => void;
  openInFileManager: () => void;
}

/**
 * Menu for a linked file path. The file-touching entries are disabled for
 * targets we cannot act on locally (e.g. a remote instance's paths); copying
 * the path itself always works.
 */
export function buildFileMenuItems(
  target: LinkedFileTarget,
  fileManagerLabel: string,
  actions: LinkedFileMenuActions,
): ContextMenuItem[] {
  return [
    { id: 'copy-file-path', label: 'Copy path', action: actions.copyPath },
    {
      id: 'copy-file',
      label: 'Copy file',
      disabled: !target.canUseLocalFileActions,
      action: actions.copyFile,
    },
    {
      id: 'open-file-manager',
      label: `Open in ${fileManagerLabel}`,
      disabled: !target.canUseLocalFileActions,
      action: actions.openInFileManager,
    },
  ];
}

/**
 * Filter the failed-image-card list shown under a message.
 *
 * `unsupported` failures from bare-URL inference (a URL that happens to
 * end in `.png` etc. on its own line) are suppressed: the inference is
 * best-effort, and showing a red error card for every such miss creates
 * UI noise. Explicit `![](url)` markdown image failures are always
 * surfaced. Older persisted messages may not carry `origin`; treat
 * missing origin as `markdown` (keep it visible).
 */
export function visibleFailedImages(failures: readonly FailedImageRef[]): FailedImageRef[] {
  return failures.filter((failure) => {
    if (failure.reason !== 'unsupported') return true;
    return failure.origin !== 'bare';
  });
}

export function buildMessageContextMenuItems(
  item: DisplayItem,
  actions: { copyMessage: () => void; forkFromHere: () => void },
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  const content = item.message?.content || item.response?.content;
  const forkableMessage = item.message ?? item.response;
  const attachments = forkableMessage?.attachments;
  const hasCopyableAttachments =
    Array.isArray(attachments) &&
    attachments.some((a) => typeof a.data === 'string' && a.data.startsWith('data:'));
  if (content || hasCopyableAttachments) {
    items.push({
      label: 'Copy message',
      action: actions.copyMessage,
    });
  }
  if (
    forkableMessage &&
    ['user', 'assistant'].includes(forkableMessage.type) &&
    item.bufferIndex !== undefined
  ) {
    items.push({
      label: 'Fork from here',
      divider: true,
      action: actions.forkFromHere,
    });
  }
  return items;
}
