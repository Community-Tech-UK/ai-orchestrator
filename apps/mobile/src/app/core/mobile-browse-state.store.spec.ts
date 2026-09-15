import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { HostStore } from './host-store';
import { MobileBrowseStateStore, safeBrowseReturnRoute } from './mobile-browse-state.store';

describe('mobile browse state', () => {
  it('allows only known same-host browse origins with direct-entry fallbacks', () => {
    expect(safeBrowseReturnRoute({ mobileBrowseOrigin: { hostId: 'host-a', route: '/history' } }, 'host-a')).toBe('/history');
    expect(safeBrowseReturnRoute({ mobileBrowseOrigin: { hostId: 'host-a', route: '/history' } }, 'host-b')).toBe('/projects');
    expect(safeBrowseReturnRoute({ mobileBrowseOrigin: { hostId: 'host-a', route: 'https://example.invalid' } }, 'host-a')).toBe('/projects');
    expect(safeBrowseReturnRoute(null, 'host-a', '/history')).toBe('/history');
    expect(safeBrowseReturnRoute({ mobileBrowseOrigin: { hostId: null, route: '/history' } }, null)).toBe('/projects');
  });

  it('restores independent host and browse-page state without leaking mutable disclosure arrays', () => {
    const activeHost = signal({ id: 'host-a' });
    TestBed.configureTestingModule({ providers: [{ provide: HostStore, useValue: { activeHost } }] });
    const store = TestBed.inject(MobileBrowseStateStore);
    const state = { ...store.read('/projects'), query: 'needle', filter: 'attention' as const, expandedKeys: ['/work/example'], showAllKeys: ['/work/example'], scrollTop: 900 };
    store.save('/projects', state);
    state.expandedKeys.push('not saved');
    expect(store.read('/projects').expandedKeys).toEqual(['/work/example']);
    expect(store.read('/history').query).toBe('');
    activeHost.set({ id: 'host-b' });
    expect(store.read('/projects').query).toBe('');
    expect(store.returnRoute(store.navigationState('/history'))).toBe('/history');
    activeHost.set({ id: 'host-a' });
    expect(store.read('/projects')).toMatchObject({ query: 'needle', scrollTop: 900, filter: 'attention' });
  });
});
