import { describe, expect, it } from 'vitest';
import { remoteContextDetails } from '../../../remote-node/instance-interaction-schemas';

describe('Copilot numeric worker context contract', () => {
  it('carries measured counters and strips bodies from the worker projection', () => {
    expect(remoteContextDetails({ used: 10, content: 'SYNTHETIC_PRIVATE_BODY', copilotUsage: {
      premiumRequests: 15, compactions: 1, postCompactionTokens: 950, tokenLimit: 1000, message: 'SYNTHETIC_PRIVATE_BODY',
    } })).toEqual({ copilotUsage: { premiumRequests: 15, compactions: 1, postCompactionTokens: 950, tokenLimit: 1000 } });
  });
  it('accepts older workers without billing evidence and refuses invalid measured counters', () => {
    expect(remoteContextDetails({ cumulativeTokens: 100 })).toEqual({ cumulativeTokens: 100 });
    expect(remoteContextDetails({ copilotUsage: { premiumRequests: '15', compactions: 1 } })).toEqual({});
  });
});
