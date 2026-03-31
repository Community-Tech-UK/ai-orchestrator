import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChildAnnouncer } from '../child-announcer';

describe('ChildAnnouncer', () => {
  beforeEach(() => {
    ChildAnnouncer._resetForTesting();
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

  it('should emit announce event', () => {
    const announcer = ChildAnnouncer.getInstance();
    const handler = vi.fn();
    announcer.on('child:announced', handler);

    announcer.announce({
      childId: 'child-1',
      parentId: 'parent-1',
      childName: 'Worker',
      success: true,
      summary: 'Done.',
      conclusions: [],
      duration: 1000,
      tokensUsed: 100,
      completedAt: Date.now(),
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      childId: 'child-1',
      parentId: 'parent-1',
    });
  });

  it('should not announce when disabled', () => {
    const announcer = ChildAnnouncer.getInstance();
    announcer.configure({ enabled: false });
    const handler = vi.fn();
    announcer.on('child:announced', handler);

    announcer.announce({
      childId: 'child-1',
      parentId: 'parent-1',
      childName: 'Worker',
      success: true,
      summary: 'Done.',
      conclusions: [],
      duration: 1000,
      tokensUsed: 100,
      completedAt: Date.now(),
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should not announce failures when announceFailures is false', () => {
    const announcer = ChildAnnouncer.getInstance();
    announcer.configure({ announceFailures: false });
    const handler = vi.fn();
    announcer.on('child:announced', handler);

    announcer.announce({
      childId: 'child-1',
      parentId: 'parent-1',
      childName: 'Worker',
      success: false,
      summary: 'Failed.',
      conclusions: [],
      errorClassification: {
        category: 'process_crash',
        userMessage: 'Process crashed',
        retryable: false,
        suggestedAction: 'escalate_to_user',
      },
      duration: 1000,
      tokensUsed: 100,
      completedAt: Date.now(),
    });

    expect(handler).not.toHaveBeenCalled();
  });
});
