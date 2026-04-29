import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '../../../../shared/types/settings.types';
import { SettingsIpcService } from '../services/ipc/settings-ipc.service';
import { SettingsStore } from './settings.store';

interface MockMql {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  fireChange(matches: boolean): void;
}

function makeMockMql(initialMatches = false): MockMql {
  const listeners: ((event: MediaQueryListEvent) => void)[] = [];
  return {
    matches: initialMatches,
    addEventListener: vi.fn((_event: 'change', listener: (event: MediaQueryListEvent) => void) => {
      listeners.push(listener);
    }),
    removeEventListener: vi.fn((_event: 'change', listener: (event: MediaQueryListEvent) => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    }),
    fireChange(matches: boolean): void {
      this.matches = matches;
      listeners.forEach((listener) => listener({ matches } as MediaQueryListEvent));
    },
  };
}

describe('SettingsStore system theme listener', () => {
  let mql: MockMql;
  let store: SettingsStore;

  beforeEach(() => {
    mql = makeMockMql();
    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn(() => mql),
      configurable: true,
    });
    document.documentElement.removeAttribute('data-theme');

    TestBed.configureTestingModule({
      providers: [
        {
          provide: SettingsIpcService,
          useValue: {
            updateSettings: vi.fn().mockResolvedValue({ success: true }),
            setSetting: vi.fn().mockResolvedValue({ success: true }),
            getSettings: vi.fn().mockResolvedValue({ success: true, data: DEFAULT_SETTINGS }),
            onSettingsChanged: vi.fn(() => () => undefined),
          },
        },
      ],
    });
    store = TestBed.inject(SettingsStore);
  });

  function flushEffects(): void {
    TestBed.tick();
  }

  it('attaches a change listener when theme switches to system', async () => {
    await store.update({ theme: 'system' });
    flushEffects();

    expect(mql.addEventListener).toHaveBeenCalledTimes(1);
  });

  it('detaches when theme switches to an explicit mode', async () => {
    await store.update({ theme: 'system' });
    flushEffects();
    await store.update({ theme: 'dark' });
    flushEffects();

    expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('re-attaches when switching back to system', async () => {
    await store.update({ theme: 'system' });
    flushEffects();
    await store.update({ theme: 'light' });
    flushEffects();
    await store.update({ theme: 'system' });
    flushEffects();

    expect(mql.addEventListener).toHaveBeenCalledTimes(2);
  });

  it('updates data-theme on OS change while system mode is active', async () => {
    await store.update({ theme: 'system' });
    flushEffects();

    mql.fireChange(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    mql.fireChange(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('ignores OS changes after switching to an explicit mode', async () => {
    await store.update({ theme: 'system' });
    flushEffects();
    await store.update({ theme: 'light' });
    flushEffects();

    mql.fireChange(true);

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('_resetForTesting removes the listener', async () => {
    await store.update({ theme: 'system' });
    flushEffects();

    store._resetForTesting();

    expect(mql.removeEventListener).toHaveBeenCalled();
  });
});
