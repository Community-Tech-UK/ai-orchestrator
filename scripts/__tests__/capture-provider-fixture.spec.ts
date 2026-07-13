import { describe, expect, it } from 'vitest';
import type { ProviderEventCaptureRecord } from '../../src/main/conversation-ledger/provider-event-capture.types';
import { buildProviderFixtureFiles } from '../capture-provider-fixture';

describe('capture-provider-fixture', () => {
  it('converts captured raw provenance into sanitized adapter-event fixture and golden JSONL', () => {
    const files = buildProviderFixtureFiles([
      {
        eventId: 'event-1',
        provider: 'claude',
        instanceId: 'instance-1',
        sessionId: null,
        sequence: 0,
        createdAt: 1,
        event: { kind: 'status', status: 'busy' },
        raw: { source: 'adapter-event:status', payload: 'busy' },
      },
      {
        eventId: 'event-2',
        provider: 'claude',
        instanceId: 'instance-1',
        sessionId: null,
        sequence: 1,
        createdAt: 2,
        event: { kind: 'output', content: 'token=sk-abcdefghijklmnopqrst' },
        raw: {
          source: 'adapter-event:output',
          payload: { content: 'token=sk-abcdefghijklmnopqrst' },
        },
      },
    ] satisfies ProviderEventCaptureRecord[]);

    expect(files.fixtureJsonl).toContain('{"name":"status","args":["busy"]}');
    expect(files.fixtureJsonl).toContain('<redacted-secret>');
    expect(files.goldenJsonl).toContain('<redacted-secret>');
  });
});
