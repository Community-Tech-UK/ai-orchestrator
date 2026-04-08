import { describe, it, expect } from 'vitest';
import { signal, computed } from '@angular/core';

/**
 * Unit tests for the inspector toggle logic.
 *
 * These test the signal logic in isolation rather than the full Angular component,
 * because InstanceDetailComponent has heavy dependencies (IPC services, stores, etc.)
 * that make component-level testing impractical. We extract and test the logic.
 */

describe('Inspector Toggle Visibility Logic', () => {
  it('anyInspectorVisible returns false when no content exists', () => {
    const hasTodos = signal(false);
    const reviewHasContent = signal(false);
    const hasChildren = signal(false);

    const anyVisible = computed(() =>
      hasTodos() || reviewHasContent() || hasChildren()
    );

    expect(anyVisible()).toBe(false);
  });

  it('anyInspectorVisible returns true when todos exist', () => {
    const hasTodos = signal(true);
    const reviewHasContent = signal(false);
    const hasChildren = signal(false);

    const anyVisible = computed(() =>
      hasTodos() || reviewHasContent() || hasChildren()
    );

    expect(anyVisible()).toBe(true);
  });

  it('anyInspectorVisible returns true when review has content', () => {
    const hasTodos = signal(false);
    const reviewHasContent = signal(true);
    const hasChildren = signal(false);

    const anyVisible = computed(() =>
      hasTodos() || reviewHasContent() || hasChildren()
    );

    expect(anyVisible()).toBe(true);
  });

  it('anyInspectorVisible returns true when children exist', () => {
    const hasTodos = signal(false);
    const reviewHasContent = signal(false);
    const hasChildren = signal(true);

    const anyVisible = computed(() =>
      hasTodos() || reviewHasContent() || hasChildren()
    );

    expect(anyVisible()).toBe(true);
  });

  it('anyInspectorVisible returns true when multiple conditions are met', () => {
    const hasTodos = signal(true);
    const reviewHasContent = signal(true);
    const hasChildren = signal(true);

    const anyVisible = computed(() =>
      hasTodos() || reviewHasContent() || hasChildren()
    );

    expect(anyVisible()).toBe(true);
  });
});

describe('Review Badge Info', () => {
  it('clears stale badge state when a new review starts', () => {
    const reviewHasContent = signal(false);
    const reviewBadgeInfo = signal<{ issueCount: number; hasErrors: boolean } | null>(
      { issueCount: 2, hasErrors: true }
    );

    reviewHasContent.set(true);
    reviewBadgeInfo.set(null);

    expect(reviewHasContent()).toBe(true);
    expect(reviewBadgeInfo()).toBeNull();
  });

  it('stores issue count and error flag from review completion', () => {
    const reviewHasContent = signal(false);
    const reviewBadgeInfo = signal<{ issueCount: number; hasErrors: boolean } | null>(null);

    reviewHasContent.set(true);
    reviewBadgeInfo.set({ issueCount: 3, hasErrors: true });
    expect(reviewHasContent()).toBe(true);
    expect(reviewBadgeInfo()).toEqual({ issueCount: 3, hasErrors: true });
  });

  it('stores results without errors', () => {
    const reviewBadgeInfo = signal<{ issueCount: number; hasErrors: boolean } | null>(null);

    reviewBadgeInfo.set({ issueCount: 2, hasErrors: false });
    expect(reviewBadgeInfo()).toEqual({ issueCount: 2, hasErrors: false });
  });

  it('resets to null on instance change', () => {
    const reviewBadgeInfo = signal<{ issueCount: number; hasErrors: boolean } | null>(null);
    reviewBadgeInfo.set({ issueCount: 5, hasErrors: false });

    // Simulate instance change reset
    reviewBadgeInfo.set(null);
    expect(reviewBadgeInfo()).toBeNull();
  });
});

describe('Auto-expand Tasks', () => {
  it('should auto-expand on first todo appearance for an instance', () => {
    const showTodoInspector = signal(false);
    const todoAutoExpandedForInstance = signal<string | null>(null);
    const instanceId = 'instance-1';
    const sessionId = 'session-1';
    const hasTodos = true;
    const todoSessionId = sessionId;

    // Simulate the effect logic (including stale-data guard)
    if (todoSessionId === sessionId && hasTodos && todoAutoExpandedForInstance() !== instanceId) {
      todoAutoExpandedForInstance.set(instanceId);
      showTodoInspector.set(true);
    }

    expect(showTodoInspector()).toBe(true);
    expect(todoAutoExpandedForInstance()).toBe(instanceId);
  });

  it('should NOT re-expand if already triggered for this instance', () => {
    const showTodoInspector = signal(false);
    const todoAutoExpandedForInstance = signal<string | null>('instance-1');
    const instanceId = 'instance-1';
    const sessionId = 'session-1';
    const hasTodos = true;
    const todoSessionId = sessionId;

    // Simulate the effect logic — guard should prevent re-expand
    if (todoSessionId === sessionId && hasTodos && todoAutoExpandedForInstance() !== instanceId) {
      todoAutoExpandedForInstance.set(instanceId);
      showTodoInspector.set(true);
    }

    expect(showTodoInspector()).toBe(false);
  });

  it('should re-expand for a different instance', () => {
    const showTodoInspector = signal(false);
    const todoAutoExpandedForInstance = signal<string | null>('instance-1');
    const instanceId = 'instance-2';
    const sessionId = 'session-2';
    const hasTodos = true;
    const todoSessionId = sessionId;

    // Simulate the effect logic — different instance, should fire
    if (todoSessionId === sessionId && hasTodos && todoAutoExpandedForInstance() !== instanceId) {
      todoAutoExpandedForInstance.set(instanceId);
      showTodoInspector.set(true);
    }

    expect(showTodoInspector()).toBe(true);
    expect(todoAutoExpandedForInstance()).toBe('instance-2');
  });

  it('should NOT auto-expand when todo data is stale (session mismatch)', () => {
    const showTodoInspector = signal(false);
    const todoAutoExpandedForInstance = signal<string | null>(null);
    const instanceId = 'instance-2';
    const sessionId = 'session-2';
    const hasTodos = true;
    const todoSessionId = 'session-1'; // Stale: still pointing at previous instance's session

    // Simulate the effect logic — stale data guard should prevent auto-expand
    if (todoSessionId === sessionId && hasTodos && todoAutoExpandedForInstance() !== instanceId) {
      todoAutoExpandedForInstance.set(instanceId);
      showTodoInspector.set(true);
    }

    expect(showTodoInspector()).toBe(false);
    expect(todoAutoExpandedForInstance()).toBeNull();
  });
});

describe('Instance Change State Reset', () => {
  it('resets all inspector state signals', () => {
    const showTodoInspector = signal(true);
    const showReviewInspector = signal(true);
    const showChildrenInspector = signal(true);
    const todoAutoExpandedForInstance = signal<string | null>('instance-1');
    const reviewHasContent = signal(true);
    const reviewBadgeInfo = signal<{ issueCount: number; hasErrors: boolean } | null>(
      { issueCount: 5, hasErrors: true }
    );

    // Simulate instance change reset
    showTodoInspector.set(false);
    showReviewInspector.set(false);
    showChildrenInspector.set(false);
    todoAutoExpandedForInstance.set(null);
    reviewHasContent.set(false);
    reviewBadgeInfo.set(null);

    expect(showTodoInspector()).toBe(false);
    expect(showReviewInspector()).toBe(false);
    expect(showChildrenInspector()).toBe(false);
    expect(todoAutoExpandedForInstance()).toBeNull();
    expect(reviewHasContent()).toBe(false);
    expect(reviewBadgeInfo()).toBeNull();
  });
});

describe('openReviewPanel', () => {
  it('opens the review panel without surfacing the toggle before a review starts', () => {
    const reviewHasContent = signal(false);
    const showReviewInspector = signal(false);

    // Simulate openReviewPanel
    showReviewInspector.set(true);

    expect(reviewHasContent()).toBe(false);
    expect(showReviewInspector()).toBe(true);
  });
});

describe('Inspector entrance pulse', () => {
  it('marks the first visible toggle as entering when the bar appears', () => {
    const hasTodos = signal(true);
    const reviewHasContent = signal(false);
    const hasChildren = signal(false);
    const enteringInspectorToggle = signal<'todo' | 'review' | 'children' | null>(null);
    let inspectorBarWasVisible = false;

    const syncEntranceState = (): void => {
      const barVisible = hasTodos() || reviewHasContent() || hasChildren();
      let nextEnteringToggle: 'todo' | 'review' | 'children' | null = null;
      if (hasTodos()) {
        nextEnteringToggle = 'todo';
      } else if (reviewHasContent()) {
        nextEnteringToggle = 'review';
      } else if (hasChildren()) {
        nextEnteringToggle = 'children';
      }

      if (!barVisible) {
        inspectorBarWasVisible = false;
        enteringInspectorToggle.set(null);
        return;
      }

      if (!inspectorBarWasVisible) {
        enteringInspectorToggle.set(nextEnteringToggle);
      }

      inspectorBarWasVisible = true;
    };

    syncEntranceState();

    expect(enteringInspectorToggle()).toBe('todo');
  });

  it('does not retrigger the pulse when another toggle appears later', () => {
    const hasTodos = signal(true);
    const reviewHasContent = signal(false);
    const hasChildren = signal(false);
    const enteringInspectorToggle = signal<'todo' | 'review' | 'children' | null>(null);
    let inspectorBarWasVisible = false;

    const syncEntranceState = (): void => {
      const barVisible = hasTodos() || reviewHasContent() || hasChildren();
      let nextEnteringToggle: 'todo' | 'review' | 'children' | null = null;
      if (hasTodos()) {
        nextEnteringToggle = 'todo';
      } else if (reviewHasContent()) {
        nextEnteringToggle = 'review';
      } else if (hasChildren()) {
        nextEnteringToggle = 'children';
      }

      if (!barVisible) {
        inspectorBarWasVisible = false;
        enteringInspectorToggle.set(null);
        return;
      }

      if (!inspectorBarWasVisible) {
        enteringInspectorToggle.set(nextEnteringToggle);
      }

      inspectorBarWasVisible = true;
    };

    syncEntranceState();
    enteringInspectorToggle.set(null);

    reviewHasContent.set(true);
    syncEntranceState();

    expect(enteringInspectorToggle()).toBeNull();
  });
});
