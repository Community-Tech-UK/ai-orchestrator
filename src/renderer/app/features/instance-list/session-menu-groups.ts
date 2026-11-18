import type { ContextMenuItem } from '../../shared/components/context-menu/context-menu.component';

/** Everyday session actions stay at the top level; the copy actions share one folded entry. The close action stays last. */
export function groupSessionCopyActions(items: readonly ContextMenuItem[]): ContextMenuItem[] {
  const copies = items.filter(item => item.id?.startsWith('copy-')).map(item => ({ ...item, divider: false }));
  if (copies.length < 2) return [...items];
  const rest = items.filter(item => !item.id?.startsWith('copy-'));
  return [
    ...rest.filter(item => !item.danger),
    { id: 'copy', label: 'Copy', divider: true, action: () => undefined, children: copies },
    ...rest.filter(item => item.danger),
  ];
}

/**
 * The Menu key and Shift+F10 raise a `contextmenu` event with `button === -1`; a right click reports 2. Only the
 * keyboard case moves focus into the menu, so a pointer user's focus stays where it was.
 */
export function contextMenuOpenedByKeyboard(event: Pick<MouseEvent, 'button'>): boolean {
  return event.button === -1;
}
