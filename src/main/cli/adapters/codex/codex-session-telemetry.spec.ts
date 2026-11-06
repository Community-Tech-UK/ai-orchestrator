import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionThreadCreditsRecord, SessionTurnShareRecord } from '../../../core/system/session-policy-log';

const log = vi.hoisted(() => ({ shares: [] as unknown[], credits: [] as unknown[], fail: false }));
vi.mock('../../../core/system/session-policy-log', () => ({
  recordSessionTurnShare: (record: unknown) => { if (log.fail) throw new Error('disk full'); log.shares.push(record); },
  recordSessionThreadCredits: (record: unknown) => { log.credits.push(record); },
}));

import { publishSessionThreadCredits, publishSessionTurnShare } from './codex-session-telemetry';

const share = { event: 'turn-share', provider: 'codex', threadId: 't', turnId: 'x', revision: 0, sessionKind: 'chat', rootTokens: 1, helperTokens: 0, totalTokens: 1, helperShare: 0, wrapUpDelivered: false, stopRequested: false } as SessionTurnShareRecord;
const credits = { event: 'thread-credits', provider: 'codex', threadId: 't', sessionKind: 'chat', estimatedUsageCreditsMicros: 5, estimatedUsageUsdMicros: null, totalTokens: null, groups: [] } as SessionThreadCreditsRecord;

describe('Codex session telemetry publishing', () => {
  beforeEach(() => { log.shares.length = 0; log.credits.length = 0; log.fail = false; });

  it('writes the log where the adapter runs and also emits the record for a worker node to forward', () => {
    const adapter = new EventEmitter();
    const seen: unknown[] = [];
    adapter.on('session_turn_share', (record) => seen.push(record));
    adapter.on('session_thread_credits', (record) => seen.push(record));
    publishSessionTurnShare(adapter, share);
    publishSessionThreadCredits(adapter, credits);
    expect(log.shares).toEqual([share]);
    expect(log.credits).toEqual([credits]);
    expect(seen).toEqual([share, credits]);
  });

  it('never lets a failing log write or a throwing listener break the turn or the shutdown', () => {
    const adapter = new EventEmitter();
    adapter.on('session_thread_credits', () => { throw new Error('listener bug'); });
    log.fail = true;
    expect(() => publishSessionTurnShare(adapter, share)).not.toThrow();
    expect(() => publishSessionThreadCredits(adapter, credits)).not.toThrow();
  });
});
