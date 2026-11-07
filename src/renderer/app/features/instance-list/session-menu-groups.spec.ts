import { describe, expect, it, vi } from 'vitest';
import { groupSessionCopyActions } from './session-menu-groups';

const item = (id: string, extra: object = {}) => ({ id, label: id, action: vi.fn(), ...extra });

describe('groupSessionCopyActions', () => {
  it('folds every copy action into one entry and keeps the close action last', () => {
    const grouped = groupSessionCopyActions([
      item('rename'), item('copy-transcript', { divider: true }), item('copy-session-id'),
      item('open-finder', { divider: true }), item('terminate', { divider: true, danger: true }),
    ]);
    expect(grouped.map(entry => entry.id)).toEqual(['rename', 'open-finder', 'copy', 'terminate']);
    expect(grouped[2]!.children!.map(entry => entry.id)).toEqual(['copy-transcript', 'copy-session-id']);
    expect(grouped[2]!.children!.some(entry => entry.divider)).toBe(false);
  });

  it('leaves a menu with a single copy action as it is', () => {
    const items = [item('rename'), item('copy-session-id')];
    expect(groupSessionCopyActions(items)).toEqual(items);
  });
});
