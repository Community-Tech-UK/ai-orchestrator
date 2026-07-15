import { describe, expect, it } from 'vitest';
import type { ProviderEventCaptureRecord } from '../../src/main/conversation-ledger/provider-event-capture.types';
import {
  replayAdapterEventFixture,
  type AdapterEventFixtureRecord,
} from '../../src/main/providers/provider-event-fixture-replay';
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
    expect(files.fixtureJsonl).toContain('[omitted-session-body]');
    expect(files.goldenJsonl).toContain('[omitted-session-body]');
  });

  it('builds golden events from the scrubbed replay input, not runtime-only output metadata', () => {
    const files = buildProviderFixtureFiles([
      {
        eventId: 'event-3',
        provider: 'claude',
        instanceId: 'instance-1',
        sessionId: null,
        sequence: 2,
        createdAt: 3,
        event: {
          kind: 'output',
          content: 'hello',
          messageType: 'assistant',
          messageId: 'message-3',
          timestamp: 3,
          metadata: { adapterGeneration: 2, turnId: 'turn-1' },
        },
        raw: {
          source: 'adapter-event:output',
          payload: {
            id: 'message-3',
            timestamp: 3,
            type: 'assistant',
            content: 'hello',
          },
        },
      },
    ] satisfies ProviderEventCaptureRecord[]);

    const fixture = readJsonLines<AdapterEventFixtureRecord>(files.fixtureJsonl);
    const golden = readJsonLines<unknown>(files.goldenJsonl);

    expect(replayAdapterEventFixture(fixture).map(({ event }) => event)).toEqual(golden);
    expect(files.goldenJsonl).not.toContain('adapterGeneration');
  });

  it('excludes non-replayable provenance from both fixture and golden streams', () => {
    expect(() => buildProviderFixtureFiles([
      {
        eventId: 'event-4',
        provider: 'claude',
        instanceId: 'instance-1',
        sessionId: null,
        sequence: 3,
        createdAt: 4,
        event: { kind: 'output', content: 'fallback output' },
        raw: { source: 'instance-output', payload: { content: 'fallback output' } },
      },
    ] satisfies ProviderEventCaptureRecord[])).toThrow(
      'No replayable adapter-event captures remain after sanitization',
    );
  });

  it('removes session bodies, session identifiers, paths, and secrets from exported fixtures', () => {
    const files = buildProviderFixtureFiles([
      {
        eventId: 'event-private',
        provider: 'claude',
        instanceId: 'instance-private',
        sessionId: 'session-private',
        sequence: 4,
        createdAt: 4,
        event: { kind: 'output', content: 'private response' },
        raw: {
          source: 'adapter-event:output',
          payload: {
            id: 'message-private',
            type: 'assistant',
            content: 'private response from /private/workspace',
            metadata: {
              sessionId: 'session-private',
              command: 'cat /private/workspace/secret.txt',
              apiKey: 'sk-abcdefghijklmnopqrst',
            },
          },
        },
      },
    ] satisfies ProviderEventCaptureRecord[]);

    expect(files.fixtureJsonl).toContain('[omitted-session-body]');
    expect(files.fixtureJsonl).toContain('<redacted-id>');
    expect(files.fixtureJsonl).toContain('<redacted-path>');
    expect(files.fixtureJsonl).toContain('<redacted-secret>');
    expect(files.fixtureJsonl).not.toContain('private response');
    expect(files.fixtureJsonl).not.toContain('/private/workspace');
    expect(files.fixtureJsonl).not.toContain('session-private');
    expect(files.fixtureJsonl).not.toContain('message-private');
  });
});

function readJsonLines<T>(text: string): T[] {
  return text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as T);
}
