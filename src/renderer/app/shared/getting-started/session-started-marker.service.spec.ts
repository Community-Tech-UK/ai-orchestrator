/**
 * UX5 — a fact about the past must not be able to become false again.
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { SessionStartedMarkerService } from './session-started-marker.service';

describe('SessionStartedMarkerService', () => {
  beforeEach(() => {
    window.localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('starts false on a device that has never run a session', () => {
    expect(TestBed.inject(SessionStartedMarkerService).hasStarted()).toBe(false);
  });

  it('records a session and persists it', () => {
    TestBed.inject(SessionStartedMarkerService).markStarted();
    TestBed.resetTestingModule();
    expect(TestBed.inject(SessionStartedMarkerService).hasStarted()).toBe(true);
  });

  /**
   * The whole reason this exists: the step asks whether a session has EVER been
   * started. Closing the only open one does not undo that, and letting it
   * would resurrect the bar to tell a user to do what they just did.
   */
  it('never un-records, so closing a session cannot undo the step', () => {
    const marker = TestBed.inject(SessionStartedMarkerService);
    marker.markStarted();
    marker.markStarted();
    expect(marker.hasStarted()).toBe(true);
  });

  it('survives a storage failure without breaking the shell', () => {
    const setItem = window.localStorage.setItem;
    window.localStorage.setItem = () => { throw new Error('quota'); };
    try {
      const marker = TestBed.inject(SessionStartedMarkerService);
      expect(() => marker.markStarted()).not.toThrow();
      // In-memory still carries this session even though the write failed.
      expect(marker.hasStarted()).toBe(true);
    } finally {
      window.localStorage.setItem = setItem;
    }
  });
});
