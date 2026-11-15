import { describe, expect, it, vi } from 'vitest';
import { watcherMenuItems } from './session-watcher-menu';

describe('watcherMenuItems', () => {
  it.each(['flag-only', 'planned-work', 'clear-choices', 'own-suggestions'])('offers the switch, ticked, when the setting is %s and the session is not muted', (level) => {
    const [item, ...rest] = watcherMenuItems({ id: 'a', provider: 'claude', parentId: null }, level, vi.fn());
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ id: 'keep-session-going', label: 'Keep this session going without me', checked: true });
  });

  it.each(['codex', 'gemini', 'copilot'])('offers nothing on a %s session, which the watcher never looks at', (provider) => {
    expect(watcherMenuItems({ id: 'a', provider, parentId: null } as Parameters<typeof watcherMenuItems>[0], 'own-suggestions', vi.fn())).toEqual([]);
  });

  it('offers nothing on a helper agent, which the watcher never looks at', () => {
    expect(watcherMenuItems({ id: 'a', provider: 'claude', parentId: 'parent' }, 'own-suggestions', vi.fn())).toEqual([]);
  });

  it('offers nothing while the setting is off', () => {
    expect(watcherMenuItems({ id: 'a', provider: 'claude', parentId: null }, 'off', vi.fn())).toEqual([]);
  });

  it('shows a muted session unticked', () => {
    expect(watcherMenuItems({ id: 'a', provider: 'claude', parentId: null, watcherMuted: true }, 'planned-work', vi.fn())[0]?.checked).toBe(false);
  });

  it('mutes a session that is being kept going, and unmutes one that is muted', () => {
    const setMuted = vi.fn();
    void watcherMenuItems({ id: 'a', provider: 'claude', parentId: null }, 'planned-work', setMuted)[0]?.action();
    expect(setMuted).toHaveBeenLastCalledWith('a', true);
    void watcherMenuItems({ id: 'b', provider: 'claude', parentId: null, watcherMuted: true }, 'planned-work', setMuted)[0]?.action();
    expect(setMuted).toHaveBeenLastCalledWith('b', false);
  });
});
