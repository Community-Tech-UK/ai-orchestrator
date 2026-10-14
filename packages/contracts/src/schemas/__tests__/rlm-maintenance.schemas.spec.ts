import { describe, expect, it } from 'vitest';
import {
  RlmMaintenanceRequestSchema,
  RlmStorageHealthRequestSchema,
} from '../rlm-maintenance.schemas';

describe('RLM maintenance IPC schemas', () => {
  it('accepts an optional non-empty initiating loop ID', () => {
    expect(RlmMaintenanceRequestSchema.parse({})).toEqual({});
    expect(RlmMaintenanceRequestSchema.parse({ loopRunId: 'loop-123' })).toEqual({
      loopRunId: 'loop-123',
    });
  });

  it('rejects blank loop IDs and renderer-controlled retention fields', () => {
    expect(RlmMaintenanceRequestSchema.safeParse({ loopRunId: '' }).success).toBe(false);
    expect(RlmMaintenanceRequestSchema.safeParse({ retentionDays: 1 }).success).toBe(false);
  });

  it('bounds selected backup names and rejects extra authority', () => {
    expect(RlmMaintenanceRequestSchema.parse({ deleteOldBackups: ['old.db'] })).toEqual({ deleteOldBackups: ['old.db'] });
    expect(RlmMaintenanceRequestSchema.safeParse({ deleteOldBackups: Array(51).fill('old.db') }).success).toBe(false);
    expect(RlmMaintenanceRequestSchema.safeParse({ deleteOldBackups: [''] }).success).toBe(false);
    expect(RlmMaintenanceRequestSchema.safeParse({ deleteOldBackups: ['old.db'], directory: '/tmp' }).success).toBe(false);
  });

  it('requires health requests to have an empty strict payload', () => {
    expect(RlmStorageHealthRequestSchema.parse({})).toEqual({});
    expect(RlmStorageHealthRequestSchema.safeParse({ path: '/tmp/other.db' }).success).toBe(false);
  });
});
