import { describe, expect, it } from 'vitest';
import { VOICE_CHANNELS } from '../voice.channels';

describe('VOICE_CHANNELS', () => {
  it('declares local segmented STT channels in the voice domain', () => {
    expect(VOICE_CHANNELS.VOICE_LOCAL_STT_CHUNK).toBe('voice:local-stt:chunk');
    expect(VOICE_CHANNELS.VOICE_LOCAL_STT_EVENT).toBe('voice:local-stt:event');
  });

  it('uses unique string channel names within the voice domain', () => {
    const values = Object.values(VOICE_CHANNELS);

    expect(new Set(values).size).toBe(values.length);
    expect(values.every((value) => value.startsWith('voice:'))).toBe(true);
  });
});
