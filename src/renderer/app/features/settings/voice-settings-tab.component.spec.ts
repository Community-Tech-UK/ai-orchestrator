import {
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceStatus } from '@contracts/schemas/voice';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../shared/types/settings.types';
import { VoiceIpcService } from '../../core/services/ipc/voice-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';
import { VoiceSettingsTabComponent } from './voice-settings-tab.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(specDirectory, './voice-settings-tab.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('voice-settings-tab.component.scss')) {
    return Promise.resolve(styles);
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function makeStatus(overrides: Partial<VoiceStatus> = {}): VoiceStatus {
  return {
    available: true,
    keySource: 'missing',
    canConfigureTemporaryKey: true,
    activeTranscriptionProviderId: 'local-whisper',
    activeTtsProviderId: 'local-macos-say',
    providers: [
      {
        id: 'local-whisper',
        label: 'Local Whisper STT',
        source: 'local',
        capabilities: ['stt'],
        available: true,
        configured: true,
        active: true,
        privacy: 'local',
        location: 'worker-node',
        latencyClass: 'near-realtime',
      },
      {
        id: 'openai-realtime',
        label: 'OpenAI Realtime STT',
        source: 'cloud',
        capabilities: ['stt'],
        available: true,
        configured: true,
        active: false,
        privacy: 'provider-cloud',
        location: 'cloud',
        latencyClass: 'live',
      },
      {
        id: 'local-macos-say',
        label: 'macOS Local Voice',
        source: 'local',
        capabilities: ['tts'],
        available: true,
        configured: true,
        active: true,
        privacy: 'local',
      },
    ],
    ...overrides,
  };
}

describe('VoiceSettingsTabComponent', () => {
  let fixture: ComponentFixture<VoiceSettingsTabComponent>;
  let settings: AppSettings;
  let settingsStore: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
  let voiceIpc: {
    getStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    settings = { ...DEFAULT_SETTINGS };
    settingsStore = {
      get: vi.fn((key: keyof AppSettings) => settings[key]),
      set: vi.fn(async (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => {
        settings = { ...settings, [key]: value };
      }),
    };
    voiceIpc = {
      getStatus: vi.fn(async () => makeStatus()),
    };

    TestBed.configureTestingModule({
      imports: [VoiceSettingsTabComponent],
      providers: [
        { provide: SettingsStore, useValue: settingsStore },
        { provide: VoiceIpcService, useValue: voiceIpc },
      ],
    });
    await TestBed.compileComponents();

    fixture = TestBed.createComponent(VoiceSettingsTabComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('renders active STT location, privacy, and latency labels from voice status', () => {
    const text = fixture.nativeElement.textContent as string;

    expect(voiceIpc.getStatus).toHaveBeenCalledOnce();
    expect(text).toContain('Local Whisper STT');
    expect(text).toContain('Worker node');
    expect(text).toContain('Near realtime');
    expect(text).toContain('Audio stays on your machines');
  });

  it('shows the local STT empty state when no local engine is detected', async () => {
    voiceIpc.getStatus.mockResolvedValueOnce(makeStatus({
      available: false,
      activeTranscriptionProviderId: undefined,
      unavailableReason: 'Speech-to-text provider is unavailable.',
      providers: [
        {
          id: 'local-whisper',
          label: 'Local Whisper STT',
          source: 'local',
          capabilities: ['stt'],
          available: false,
          configured: false,
          active: false,
          privacy: 'local',
          latencyClass: 'near-realtime',
          location: 'this-device',
          reason: 'No local STT backend is available.',
          requiresSetup: 'Start speaches on a worker node.',
        },
      ],
    }));

    await fixture.componentInstance.refreshStatus();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No local STT engine detected');
  });

  it('persists routing and worker pin changes through SettingsStore', async () => {
    const routingSelect = fixture.nativeElement.querySelector(
      'select[name="voice-routing-mode"]'
    ) as HTMLSelectElement;
    routingSelect.value = 'worker-node';
    routingSelect.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    const workerInput = fixture.nativeElement.querySelector(
      'input[name="voice-worker-node-id"]'
    ) as HTMLInputElement;
    workerInput.value = 'win-stt';
    workerInput.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    expect(settingsStore.set).toHaveBeenCalledWith('voiceSttRoutingMode', 'worker-node');
    expect(settingsStore.set).toHaveBeenCalledWith('voiceLocalSttWorkerNodeId', 'win-stt');
  });

  it('persists this-device endpoint, model, language, and segment cap settings', async () => {
    const endpoint = fixture.nativeElement.querySelector(
      'input[name="voice-this-device-endpoint"]'
    ) as HTMLInputElement;
    endpoint.value = 'http://127.0.0.1:8080';
    endpoint.dispatchEvent(new Event('change'));

    const model = fixture.nativeElement.querySelector(
      'input[name="voice-local-stt-model"]'
    ) as HTMLInputElement;
    model.value = 'distil-large-v3';
    model.dispatchEvent(new Event('change'));

    const language = fixture.nativeElement.querySelector(
      'input[name="voice-local-stt-language"]'
    ) as HTMLInputElement;
    language.value = 'en';
    language.dispatchEvent(new Event('change'));

    const maxSegment = fixture.nativeElement.querySelector(
      'input[name="voice-max-segment-ms"]'
    ) as HTMLInputElement;
    maxSegment.value = '3500';
    maxSegment.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    expect(settingsStore.set).toHaveBeenCalledWith(
      'voiceThisDeviceSttEndpointUrl',
      'http://127.0.0.1:8080'
    );
    expect(settingsStore.set).toHaveBeenCalledWith('voiceLocalSttModel', 'distil-large-v3');
    expect(settingsStore.set).toHaveBeenCalledWith('voiceLocalSttLanguage', 'en');
    expect(settingsStore.set).toHaveBeenCalledWith('voiceLocalSttMaxSegmentMs', 3500);
  });
});
