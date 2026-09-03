import { describe, expect, it } from 'vitest';
import {
  isCopilotEvent,
  parseCopilotNdjsonEvent,
  parseCopilotStreamingEvent,
} from './copilot-stream-events';

describe('copilot-stream-events', () => {
  it('accepts objects with a string type', () => {
    expect(isCopilotEvent({ type: 'assistant.message' })).toBe(true);
    expect(isCopilotEvent({ type: 1 })).toBe(false);
    expect(isCopilotEvent(null)).toBe(false);
    expect(isCopilotEvent('assistant.message')).toBe(false);
  });

  it('parses a complete NDJSON assistant delta', () => {
    const event = parseCopilotNdjsonEvent(
      '{"type":"assistant.message_delta","data":{"deltaContent":"hi","messageId":"m1"}}',
    );
    expect(event).toEqual({
      type: 'assistant.message_delta',
      data: { deltaContent: 'hi', messageId: 'm1' },
    });
  });

  it('returns null for non-JSON NDJSON lines', () => {
    expect(parseCopilotNdjsonEvent('not json')).toBeNull();
    expect(parseCopilotNdjsonEvent('')).toBeNull();
  });

  it('accepts a useful partial assistant payload via streaming parse', () => {
    const event = parseCopilotStreamingEvent(
      '{"type":"assistant.message","data":{"content":"hello"',
    );
    expect(event?.type).toBe('assistant.message');
    expect(event?.partial).toBe(true);
    if (event?.type === 'assistant.message') {
      expect(event.data?.content).toBe('hello');
    }
  });

  it('drops a partial payload with no useful text', () => {
    expect(parseCopilotStreamingEvent('{"type":"assistant.message","data":{')).toBeNull();
    expect(parseCopilotStreamingEvent('{"type":"session.idle"')).toBeNull();
  });
});
