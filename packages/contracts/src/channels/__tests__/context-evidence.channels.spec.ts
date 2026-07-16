import { describe, expect, it } from 'vitest';
import { CONTEXT_EVIDENCE_CHANNELS } from '../context-evidence.channels';

describe('CONTEXT_EVIDENCE_CHANNELS', () => {
  it('defines the exact generated request and push channels', () => {
    expect(CONTEXT_EVIDENCE_CHANNELS).toEqual({
      CONTEXT_EVIDENCE_LIST: 'context-evidence:list',
      CONTEXT_EVIDENCE_GET_CARD: 'context-evidence:get-card',
      CONTEXT_EVIDENCE_SEARCH: 'context-evidence:search',
      CONTEXT_EVIDENCE_READ: 'context-evidence:read',
      CONTEXT_EVIDENCE_COMPARE: 'context-evidence:compare',
      CONTEXT_EVIDENCE_VERIFY: 'context-evidence:verify',
      CONTEXT_EVIDENCE_GET_METRICS: 'context-evidence:get-metrics',
      CONTEXT_EVIDENCE_STATE_CHANGED: 'context-evidence:state-changed',
    });
  });
});
