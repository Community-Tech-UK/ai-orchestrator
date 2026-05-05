import { describe, expect, it } from 'vitest';
import {
  OperatorCancelRunPayloadSchema,
  OperatorGetRunPayloadSchema,
  OperatorGetThreadPayloadSchema,
  OperatorListProjectsPayloadSchema,
  OperatorListRunsPayloadSchema,
  OperatorRescanProjectsPayloadSchema,
  OperatorRetryRunPayloadSchema,
  OperatorSendMessagePayloadSchema,
} from '../operator.schemas';

describe('operator IPC schemas', () => {
  it('validates thread, list, and message payloads', () => {
    expect(OperatorGetThreadPayloadSchema.parse({})).toEqual({});
    expect(OperatorListRunsPayloadSchema.parse({ limit: 25 })).toEqual({ limit: 25 });
    expect(OperatorListProjectsPayloadSchema.parse({ limit: 10 })).toEqual({ limit: 10 });
    expect(OperatorSendMessagePayloadSchema.parse({
      text: '  coordinate all active projects  ',
      metadata: { source: 'test' },
    })).toEqual({
      text: 'coordinate all active projects',
      metadata: { source: 'test' },
    });
  });

  it('validates run mutation payloads', () => {
    expect(OperatorGetRunPayloadSchema.parse({ runId: 'run_1' })).toEqual({ runId: 'run_1' });
    expect(OperatorCancelRunPayloadSchema.parse({ runId: 'run_1' })).toEqual({ runId: 'run_1' });
    expect(OperatorRetryRunPayloadSchema.parse({ runId: 'run_1' })).toEqual({ runId: 'run_1' });
  });

  it('validates project rescan payloads', () => {
    expect(OperatorRescanProjectsPayloadSchema.parse({})).toEqual({});
    expect(OperatorRescanProjectsPayloadSchema.parse({ roots: ['/Users/me/work'] })).toEqual({
      roots: ['/Users/me/work'],
    });
  });
});
