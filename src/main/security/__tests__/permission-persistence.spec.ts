import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PermissionDecisionStore } from '../permission-decision-store.js';

describe('PermissionDecisionStore', () => {
  let store: PermissionDecisionStore;
  let mockRun: ReturnType<typeof vi.fn>;
  let mockAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRun = vi.fn();
    mockAll = vi.fn().mockReturnValue([]);
    const mockDb = {
      prepare: vi.fn().mockReturnValue({ run: mockRun, all: mockAll }),
    };
    store = new PermissionDecisionStore(mockDb as never);
  });

  it('should record a permission decision', () => {
    store.record({
      instanceId: 'inst-1',
      scope: 'file_write',
      resource: '/tmp/test.txt',
      action: 'allow',
      decidedBy: 'user',
      toolName: 'Write',
      decidedAt: '2026-04-04T10:00:00Z',
    });

    expect(mockRun).toHaveBeenCalledWith(
      'inst-1',       // instance_id
      'file_write',   // scope
      '/tmp/test.txt', // resource
      'allow',        // action
      'user',         // decided_by
      null,           // rule_id
      null,           // reason
      'Write',        // tool_name
      0,              // is_cached
      '2026-04-04T10:00:00Z' // decided_at
    );
  });

  it('should query decisions by instance', () => {
    store.getByInstance('inst-1');
    expect(mockAll).toHaveBeenCalledWith('inst-1');
  });

  it('should handle errors gracefully on record', () => {
    const errorDb = {
      prepare: vi.fn().mockImplementation(() => { throw new Error('DB error'); }),
    };
    const errorStore = new PermissionDecisionStore(errorDb as never);

    // Should not throw
    expect(() => errorStore.record({
      instanceId: 'inst-1',
      scope: 'file_write',
      resource: '/tmp/test.txt',
      action: 'allow',
      decidedAt: '2026-04-04T10:00:00Z',
    })).not.toThrow();
  });

  it('should return empty array on query error', () => {
    const errorDb = {
      prepare: vi.fn().mockImplementation(() => { throw new Error('DB error'); }),
    };
    const errorStore = new PermissionDecisionStore(errorDb as never);

    const result = errorStore.getByInstance('inst-1');
    expect(result).toEqual([]);
  });

  it('should map isCached boolean to integer', () => {
    store.record({
      instanceId: 'inst-1',
      scope: 'tool_use',
      resource: 'Bash',
      action: 'allow',
      isCached: true,
      decidedAt: '2026-04-04T10:00:00Z',
    });

    expect(mockRun).toHaveBeenCalledWith(
      'inst-1',
      'tool_use',
      'Bash',
      'allow',
      null,
      null,
      null,
      null,
      1,    // isCached=true maps to 1
      '2026-04-04T10:00:00Z'
    );
  });
});
