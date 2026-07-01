import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings.types';
import type { VoiceSttRoutingMode } from '../settings.types';

describe('DEFAULT_SETTINGS — local-first voice STT', () => {
  it('defaults STT routing to local-first auto mode with worker pinning available', () => {
    const mode: VoiceSttRoutingMode = DEFAULT_SETTINGS.voiceSttRoutingMode;

    expect(mode).toBe('auto');
    expect(DEFAULT_SETTINGS.voiceLocalSttEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.voiceLocalSttWorkerNodeId).toBe('');
    expect(DEFAULT_SETTINGS.voiceLocalSttModel).toBe('');
    expect(DEFAULT_SETTINGS.voiceLocalSttLanguage).toBe('en');
    expect(DEFAULT_SETTINGS.voiceThisDeviceSttEndpointUrl).toBe('');
    expect(DEFAULT_SETTINGS.voiceThisDeviceSttApiKeyEnv).toBe('');
    expect(DEFAULT_SETTINGS.voiceLocalSttMaxSegmentMs).toBe(5000);
  });

  it('keeps all documented STT routing modes in the public type', () => {
    const modes: VoiceSttRoutingMode[] = [
      'auto',
      'this-device',
      'worker-node',
      'cloud',
      'this-device-or-cloud',
    ];

    expect(modes).toHaveLength(5);
  });
});
