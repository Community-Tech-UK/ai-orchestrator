import { describe, expect, it } from 'vitest';
import { asUnknownRecord, isRawCliPayload, toRawCliPayload } from './claude-cli-adapter.types';

describe('Claude CLI payload decoders', () => {
  it('accepts objects with a string type as RawCliPayload', () => {
    expect(isRawCliPayload({ type: 'assistant', content: 'hi' })).toBe(true);
    expect(isRawCliPayload({ type: 1 })).toBe(false);
    expect(isRawCliPayload(['assistant'])).toBe(false);
    expect(asUnknownRecord(null)).toBeNull();
    expect(asUnknownRecord({ type: 'error' })).toEqual({ type: 'error' });
  });

  it('falls back to a typed payload when the stream value is malformed', () => {
    expect(toRawCliPayload({ type: 'result', result: 'ok' }).type).toBe('result');
    expect(toRawCliPayload('not-an-object', 'assistant')).toEqual({ type: 'assistant' });
  });
});
