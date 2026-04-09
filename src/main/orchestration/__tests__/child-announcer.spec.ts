import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ChildAnnouncer } from '../child-announcer';
import type { ChildAnnouncement } from '../../../shared/types/child-announce.types';

function makeAnnouncement(overrides: Partial<ChildAnnouncement> = {}): ChildAnnouncement {
  return {
    childId: 'child-1',
    parentId: 'parent-1',
    childName: 'Worker',
    success: true,
    summary: 'Done.',
    conclusions: [],
    duration: 1000,
    tokensUsed: 100,
    completedAt: Date.now(),
    ...overrides,
  };
}

describe('ChildAnnouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ChildAnnouncer._resetForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should be a singleton', () => {
    const a = ChildAnnouncer.getInstance();
    const b = ChildAnnouncer.getInstance();
    expect(a).toBe(b);
  });

  it('should format a success announcement as a user message', () => {
    const announcer = ChildAnnouncer.getInstance();
    const message = announcer.formatAnnouncement({
      childId: 'child-1',
      parentId: 'parent-1',
      childName: 'Code Reviewer',
      success: true,
      summary: 'Found 3 issues in the auth module.',
      conclusions: ['SQL injection in login handler', 'Missing rate limiting'],
      duration: 12000,
      tokensUsed: 5000,
      completedAt: Date.now(),
    });

    expect(message).toContain('Code Reviewer');
    expect(message).toContain('completed successfully');
    expect(message).toContain('Found 3 issues');
    expect(message).toContain('SQL injection');
  });

  it('should format a failure announcement with error classification', () => {
    const announcer = ChildAnnouncer.getInstance();
    const message = announcer.formatAnnouncement({
      childId: 'child-2',
      parentId: 'parent-1',
      childName: 'Build Agent',
      success: false,
      summary: 'Build failed due to type errors.',
      conclusions: [],
      errorClassification: {
        category: 'task_failure',
        userMessage: 'TypeScript compilation failed with 5 errors',
        retryable: true,
        suggestedAction: 'retry',
      },
      duration: 30000,
      tokensUsed: 8000,
      completedAt: Date.now(),
    });

    expect(message).toContain('Build Agent');
    expect(message).toContain('failed');
    expect(message).toContain('TypeScript compilation');
    expect(message).toContain('Suggested action: retry');
  });

  it('should truncate summary to maxSummaryLength', () => {
    const announcer = ChildAnnouncer.getInstance();
    announcer.configure({ maxSummaryLength: 50 });
    const longSummary = 'A'.repeat(200);
    const message = announcer.formatAnnouncement({
      childId: 'child-3',
      parentId: 'parent-1',
      childName: 'Worker',
      success: true,
      summary: longSummary,
      conclusions: [],
      duration: 1000,
      tokensUsed: 100,
      completedAt: Date.now(),
    });

    // The summary portion should be truncated
    expect(message.length).toBeLessThan(longSummary.length + 200);
  });

  // ============================================
  // Batching behavior
  // ============================================

  describe('batching', () => {
    it('should batch announcements within the debounce window', () => {
      const announcer = ChildAnnouncer.getInstance();
      const handler = vi.fn();
      announcer.on('child:announced', handler);

      // Two children finish 500ms apart — within default 1500ms window
      announcer.announce(makeAnnouncement({ childId: 'c1', childName: 'First' }));
      vi.advanceTimersByTime(500);
      announcer.announce(makeAnnouncement({ childId: 'c2', childName: 'Second' }));

      // Not emitted yet (debounce restarted)
      expect(handler).not.toHaveBeenCalled();

      // After debounce window elapses
      vi.advanceTimersByTime(1500);

      expect(handler).toHaveBeenCalledOnce();
      const [parentId, announcements, message] = handler.mock.calls[0];
      expect(parentId).toBe('parent-1');
      expect(announcements).toHaveLength(2);
      expect(message).toContain('2 children completed');
      expect(message).toContain('First');
      expect(message).toContain('Second');
    });

    it('should emit separately for different parents', () => {
      const announcer = ChildAnnouncer.getInstance();
      const handler = vi.fn();
      announcer.on('child:announced', handler);

      announcer.announce(makeAnnouncement({ childId: 'c1', parentId: 'p1' }));
      announcer.announce(makeAnnouncement({ childId: 'c2', parentId: 'p2' }));

      vi.advanceTimersByTime(2000);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[0][0]).toBe('p1');
      expect(handler.mock.calls[1][0]).toBe('p2');
    });

    it('should force-flush at batchMaxWaitMs even if children keep arriving', () => {
      const announcer = ChildAnnouncer.getInstance();
      announcer.configure({ batchWindowMs: 2000, batchMaxWaitMs: 5000 });
      const handler = vi.fn();
      announcer.on('child:announced', handler);

      // Keep adding children every 1s — debounce keeps resetting
      for (let i = 0; i < 10; i++) {
        announcer.announce(makeAnnouncement({ childId: `c${i}` }));
        vi.advanceTimersByTime(1000);
      }

      // batchMaxWaitMs (5000) should have triggered a flush by now
      // First batch flushed at ~5s with children c0–c4
      expect(handler).toHaveBeenCalled();
      const firstBatchSize = handler.mock.calls[0][1].length;
      expect(firstBatchSize).toBeGreaterThanOrEqual(3);

      // Flush remaining
      vi.advanceTimersByTime(5000);
      expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('should emit single announcement without batched header', () => {
      const announcer = ChildAnnouncer.getInstance();
      const handler = vi.fn();
      announcer.on('child:announced', handler);

      announcer.announce(makeAnnouncement({ childId: 'c1', childName: 'Solo Worker' }));
      vi.advanceTimersByTime(2000);

      expect(handler).toHaveBeenCalledOnce();
      const [, announcements, message] = handler.mock.calls[0];
      expect(announcements).toHaveLength(1);
      // Single announcement uses original format, not batch format
      expect(message).not.toContain('children completed');
      expect(message).toContain('Solo Worker');
      expect(message).toContain('completed successfully');
    });

    it('should emit immediately when batching is disabled', () => {
      const announcer = ChildAnnouncer.getInstance();
      announcer.configure({ batchWindowMs: 0 });
      const handler = vi.fn();
      announcer.on('child:announced', handler);

      announcer.announce(makeAnnouncement({ childId: 'c1' }));
      // No timer advance needed — emitted synchronously
      expect(handler).toHaveBeenCalledOnce();

      announcer.announce(makeAnnouncement({ childId: 'c2' }));
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should support manual flush', () => {
      const announcer = ChildAnnouncer.getInstance();
      const handler = vi.fn();
      announcer.on('child:announced', handler);

      announcer.announce(makeAnnouncement({ childId: 'c1' }));
      announcer.announce(makeAnnouncement({ childId: 'c2' }));

      expect(handler).not.toHaveBeenCalled();
      announcer.flush('parent-1');

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][1]).toHaveLength(2);
      expect(announcer.pendingCount).toBe(0);
    });

    it('should support flushAll', () => {
      const announcer = ChildAnnouncer.getInstance();
      const handler = vi.fn();
      announcer.on('child:announced', handler);

      announcer.announce(makeAnnouncement({ childId: 'c1', parentId: 'p1' }));
      announcer.announce(makeAnnouncement({ childId: 'c2', parentId: 'p2' }));
      announcer.announce(makeAnnouncement({ childId: 'c3', parentId: 'p1' }));

      announcer.flushAll();

      expect(handler).toHaveBeenCalledTimes(2); // one per parent
      expect(announcer.pendingCount).toBe(0);
    });
  });

  // ============================================
  // Staleness
  // ============================================

  describe('staleness', () => {
    it('should drop stale announcements', () => {
      const announcer = ChildAnnouncer.getInstance();
      announcer.configure({ staleThresholdMs: 60_000 });
      const handler = vi.fn();
      announcer.on('child:announced', handler);

      // Announcement completed 2 minutes ago
      announcer.announce(makeAnnouncement({
        childId: 'stale-1',
        completedAt: Date.now() - 120_000,
      }));

      vi.advanceTimersByTime(2000);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should keep fresh announcements', () => {
      const announcer = ChildAnnouncer.getInstance();
      announcer.configure({ staleThresholdMs: 60_000 });
      const handler = vi.fn();
      announcer.on('child:announced', handler);

      // Announcement just completed
      announcer.announce(makeAnnouncement({
        childId: 'fresh-1',
        completedAt: Date.now(),
      }));

      vi.advanceTimersByTime(2000);
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // ============================================
  // Config guards
  // ============================================

  it('should not announce when disabled', () => {
    const announcer = ChildAnnouncer.getInstance();
    announcer.configure({ enabled: false });
    const handler = vi.fn();
    announcer.on('child:announced', handler);

    announcer.announce(makeAnnouncement());
    vi.advanceTimersByTime(5000);

    expect(handler).not.toHaveBeenCalled();
  });

  it('should not announce failures when announceFailures is false', () => {
    const announcer = ChildAnnouncer.getInstance();
    announcer.configure({ announceFailures: false });
    const handler = vi.fn();
    announcer.on('child:announced', handler);

    announcer.announce(makeAnnouncement({
      success: false,
      errorClassification: {
        category: 'process_crash',
        userMessage: 'Process crashed',
        retryable: false,
        suggestedAction: 'escalate_to_user',
      },
    }));

    vi.advanceTimersByTime(5000);
    expect(handler).not.toHaveBeenCalled();
  });

  // ============================================
  // Batch formatting
  // ============================================

  describe('formatBatchedAnnouncement', () => {
    it('should format multiple announcements with counts', () => {
      const announcer = ChildAnnouncer.getInstance();
      const message = announcer.formatBatchedAnnouncement([
        makeAnnouncement({ childId: 'c1', childName: 'Reviewer', success: true, summary: 'All good' }),
        makeAnnouncement({ childId: 'c2', childName: 'Builder', success: false, summary: 'Build failed' }),
      ]);

      expect(message).toContain('2 children completed');
      expect(message).toContain('1 succeeded');
      expect(message).toContain('1 failed');
      expect(message).toContain('Reviewer');
      expect(message).toContain('Builder');
    });
  });
});
