import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ focused: false, platform: 'darwin', setBadgeCount: vi.fn(() => true), setBadge: vi.fn(), setOverlayIcon: vi.fn(), listeners: new Map<string, () => void>() }));
vi.mock('electron', () => ({
  app: { setBadgeCount: mocks.setBadgeCount, dock: { setBadge: mocks.setBadge }, on: vi.fn((name, fn) => mocks.listeners.set(name, fn)), removeListener: vi.fn((name) => mocks.listeners.delete(name)) },
  BrowserWindow: { getFocusedWindow: () => mocks.focused ? {} : null },
  nativeImage: { createFromBitmap: vi.fn(() => 'dot') },
}));
import { AttentionBadge, getAttentionBadge } from './attention-badge';

describe('AttentionBadge', () => {
  beforeEach(() => { mocks.focused = false; vi.clearAllMocks(); mocks.setBadgeCount.mockReturnValue(true); });
  afterEach(() => AttentionBadge._resetForTesting());
  it('shows the count in the background and reapplies zero on focus then count on blur', () => {
    const badge = getAttentionBadge(); badge.setCount(3);
    expect(mocks.setBadgeCount).toHaveBeenLastCalledWith(3);
    mocks.focused = true; mocks.listeners.get('browser-window-focus')?.();
    expect(mocks.setBadgeCount).toHaveBeenLastCalledWith(0);
    mocks.focused = false; mocks.listeners.get('browser-window-blur')?.();
    expect(mocks.setBadgeCount).toHaveBeenLastCalledWith(3);
  });
  it('falls back to the macOS Dock badge when badge permission is unavailable', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    mocks.setBadgeCount.mockReturnValue(false);
    getAttentionBadge().setCount(3); expect(mocks.setBadge).toHaveBeenCalledWith('3');
    getAttentionBadge().setCount(0); expect(mocks.setBadge).toHaveBeenLastCalledWith('');
    vi.unstubAllGlobals();
  });
  it('uses a Windows taskbar dot with count in the accessible description and clears it', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const badge = getAttentionBadge(); badge.setWindowProvider(() => ({ setOverlayIcon: mocks.setOverlayIcon, isDestroyed: () => false }) as never);
    badge.setCount(3); expect(mocks.setOverlayIcon).toHaveBeenLastCalledWith('dot', '3 things need you');
    mocks.focused = true; mocks.listeners.get('browser-window-focus')?.();
    expect(mocks.setOverlayIcon).toHaveBeenLastCalledWith(null, '');
    vi.unstubAllGlobals();
  });
});
