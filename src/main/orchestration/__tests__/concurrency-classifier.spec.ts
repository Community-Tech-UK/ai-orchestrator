import { describe, expect, it } from 'vitest';
import {
  classifyOperationSafety,
  scheduleOperations,
  type OperationDescriptor,
} from '../concurrency-classifier';

describe('classifyOperationSafety', () => {
  it('read operations are concurrent', () => {
    expect(classifyOperationSafety({ type: 'read', target: '/foo' })).toBe('concurrent');
  });

  it('analysis operations are concurrent', () => {
    expect(classifyOperationSafety({ type: 'analysis' })).toBe('concurrent');
  });

  it('write operations need target check', () => {
    expect(classifyOperationSafety({ type: 'write', target: '/foo' })).toBe('needs_target_check');
  });

  it('git operations need target check', () => {
    expect(classifyOperationSafety({ type: 'git', target: '/repo' })).toBe('needs_target_check');
  });

  it('shell operations need target check', () => {
    expect(classifyOperationSafety({ type: 'shell', target: '/dir' })).toBe('needs_target_check');
  });

  it('unknown type defaults to exclusive', () => {
    expect(classifyOperationSafety({ type: 'unknown' as any })).toBe('exclusive');
  });

  it('write without target is exclusive', () => {
    expect(classifyOperationSafety({ type: 'write' })).toBe('exclusive');
  });
});

describe('scheduleOperations', () => {
  it('all concurrent ops go in one batch', () => {
    const ops: OperationDescriptor[] = [
      { type: 'read', target: '/a' },
      { type: 'analysis' },
      { type: 'read', target: '/b' },
    ];
    const batches = scheduleOperations(ops);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it('non-overlapping writes go in one batch', () => {
    const ops: OperationDescriptor[] = [
      { type: 'write', target: '/a' },
      { type: 'write', target: '/b' },
      { type: 'write', target: '/c' },
    ];
    const batches = scheduleOperations(ops);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it('overlapping writes go in separate batches', () => {
    const ops: OperationDescriptor[] = [
      { type: 'write', target: '/a' },
      { type: 'write', target: '/a' },
    ];
    const batches = scheduleOperations(ops);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(1);
  });

  it('mixed concurrent and exclusive ops are batched correctly', () => {
    const ops: OperationDescriptor[] = [
      { type: 'read', target: '/a' },
      { type: 'write', target: '/a' },
      { type: 'analysis' },
    ];
    const batches = scheduleOperations(ops);
    // Read + analysis concurrent in first batch, write to /a in second
    expect(batches.length).toBeGreaterThanOrEqual(2);
  });

  it('targetless writes each get their own batch', () => {
    const ops: OperationDescriptor[] = [
      { type: 'write' },
      { type: 'write' },
    ];
    const batches = scheduleOperations(ops);
    expect(batches).toHaveLength(2);
  });

  it('empty input returns empty batches', () => {
    expect(scheduleOperations([])).toEqual([]);
  });
});
