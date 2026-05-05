import { describe, expect, it } from 'vitest';
import {
  OperatorListProjectsPayloadSchema,
  OperatorRescanProjectsPayloadSchema,
  OperatorRunIdPayloadSchema,
  OperatorSendMessagePayloadSchema,
} from '../operator.schemas';

describe('operator schemas', () => {
  it('accepts list-projects filters with a bounded limit', () => {
    expect(OperatorListProjectsPayloadSchema.parse({
      query: 'AI Orchestrator',
      limit: 25,
    })).toEqual({
      query: 'AI Orchestrator',
      limit: 25,
    });
  });

  it('accepts rescan roots and source toggles', () => {
    expect(OperatorRescanProjectsPayloadSchema.parse({
      roots: ['/Users/suas/work'],
      includeRecent: true,
      includeActiveInstances: false,
      includeConversationLedger: true,
    })).toEqual({
      roots: ['/Users/suas/work'],
      includeRecent: true,
      includeActiveInstances: false,
      includeConversationLedger: true,
    });
  });

  it('rejects blank operator messages', () => {
    expect(() => OperatorSendMessagePayloadSchema.parse({ text: '' })).toThrow();
  });

  it('accepts operator run-id control payloads', () => {
    expect(OperatorRunIdPayloadSchema.parse({ runId: 'run-1' })).toEqual({
      runId: 'run-1',
    });
    expect(() => OperatorRunIdPayloadSchema.parse({ runId: '' })).toThrow();
  });
});
