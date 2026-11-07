import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceStore } from '../state/instance.store';
import { SessionNavigator } from './session-navigator.service';

describe('SessionNavigator', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('selects the session before navigating home from a secondary page', () => {
    const calls: string[] = [];
    const setSelectedInstance = vi.fn((id) => calls.push(id));
    const navigate = vi.fn(() => { calls.push('/'); return Promise.resolve(true); });
    TestBed.configureTestingModule({ providers: [
      { provide: InstanceStore, useValue: { setSelectedInstance } }, { provide: Router, useValue: { navigate } },
    ] });
    TestBed.inject(SessionNavigator).openSession('a');
    expect(calls).toEqual(['a', '/']); expect(navigate).toHaveBeenCalledWith(['/']);
  });
});
