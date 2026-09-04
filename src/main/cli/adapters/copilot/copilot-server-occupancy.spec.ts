import { describe, expect, it } from 'vitest';
import {
  copilotContextCapabilities,
  copilotLastContextUsage,
} from './copilot-server-occupancy';

describe('copilotContextCapabilities', () => {
  it('advertises current occupancy only while server mode is live', () => {
    expect(copilotContextCapabilities(false).occupancyReporting).toBe('aggregate-only');
    expect(copilotContextCapabilities(true).occupancyReporting).toBe('current');
    expect(copilotContextCapabilities(true).sameThreadContinuation).toBe(false);
  });
});

describe('copilotLastContextUsage', () => {
  it('stays aggregate-only in exec mode even when a sample exists', () => {
    expect(copilotLastContextUsage(false, { used: 80_000, total: 100_000 })).toEqual({
      status: 'unknown',
      reason: 'aggregate-only',
    });
  });

  it('reports not-reported until a positive sample arrives in server mode', () => {
    expect(copilotLastContextUsage(true, null)).toEqual({
      status: 'unknown',
      reason: 'not-reported',
    });
    expect(copilotLastContextUsage(true, { used: 0, total: 100_000 })).toEqual({
      status: 'unknown',
      reason: 'not-reported',
    });
  });

  it('returns a trusted known sample from currentTokens/tokenLimit', () => {
    expect(copilotLastContextUsage(true, {
      used: 80_000,
      total: 100_000,
      conversationTokens: 20_000,
      systemTokens: 10_000,
      toolDefinitionsTokens: 50_000,
    })).toEqual({
      status: 'known',
      used: 80_000,
      total: 100_000,
      source: 'provider-session',
      windowTrusted: true,
      conversationTokens: 20_000,
      systemTokens: 10_000,
      toolDefinitionsTokens: 50_000,
    });
  });

  it('rejects an unusable total', () => {
    expect(copilotLastContextUsage(true, { used: 10, total: 0 })).toEqual({
      status: 'unknown',
      reason: 'invalid-sample',
    });
  });
});
