import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';

import type {
  VoiceProviderStatus,
  VoiceStatus,
} from '@contracts/schemas/voice';
import type {
  AppSettings,
  VoiceSttRoutingMode,
} from '../../../../shared/types/settings.types';
import { VoiceIpcService } from '../../core/services/ipc/voice-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';

const ROUTING_MODES: readonly { value: VoiceSttRoutingMode; label: string }[] = [
  { value: 'auto', label: 'Auto (this device, worker, OpenAI)' },
  { value: 'this-device', label: 'This device' },
  { value: 'worker-node', label: 'Worker GPU' },
  { value: 'cloud', label: 'OpenAI cloud' },
  { value: 'this-device-or-cloud', label: 'This device or OpenAI' },
];

const MIN_SEGMENT_MS = 1_000;
const MAX_SEGMENT_MS = 30_000;

@Component({
  selector: 'app-voice-settings-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="voice-tab">
      <section class="card">
        <div class="card-head">
          <div>
            <h3 class="section-title">Speech to text</h3>
            <p class="section-desc">Local-first transcription route and health.</p>
          </div>
          <button
            type="button"
            class="btn"
            [disabled]="loadingStatus()"
            (click)="refreshStatus()"
          >
            {{ loadingStatus() ? 'Refreshing...' : 'Refresh' }}
          </button>
        </div>

        @if (statusError(); as error) {
          <div class="error-banner">{{ error }}</div>
        }

        @if (activeTranscriptionProvider(); as provider) {
          <div class="active-provider">
            <div>
              <div class="active-label">{{ provider.label }}</div>
              <div class="field-hint">{{ privacyLabel(provider) }}</div>
            </div>
            <div class="badge-row">
              @if (provider.location) {
                <span class="status-badge" data-tone="info">{{ locationLabel(provider) }}</span>
              }
              @if (provider.latencyClass) {
                <span class="status-badge" data-tone="info">{{ latencyLabel(provider) }}</span>
              }
              <span class="status-badge" [attr.data-tone]="provider.available ? 'ok' : 'error'">
                {{ provider.available ? 'Available' : 'Unavailable' }}
              </span>
            </div>
          </div>
        } @else {
          <div class="empty-state">
            <div class="active-label">No speech-to-text provider active</div>
            @if (status()?.unavailableReason; as reason) {
              <div class="field-hint">{{ reason }}</div>
            }
          </div>
        }

        @if (localSttEmptyState()) {
          <div class="setup-callout">
            <strong>No local STT engine detected</strong>
            <span>Start speaches on a worker node or a whisper.cpp endpoint on this device.</span>
          </div>
        }
      </section>

      <section class="card">
        <h3 class="section-title">Routing</h3>

        <div class="field-row">
          <div>
            <label class="field-label" for="voice-local-stt-enabled">Use local STT</label>
            <div class="field-hint">When off, local routing is skipped and cloud routing must be available.</div>
          </div>
          <input
            id="voice-local-stt-enabled"
            name="voice-local-stt-enabled"
            type="checkbox"
            [checked]="settingsStore.get('voiceLocalSttEnabled')"
            (change)="onBooleanSettingChange('voiceLocalSttEnabled', $event)"
          />
        </div>

        <div class="field-row">
          <div>
            <label class="field-label" for="voice-routing-mode">Provider location</label>
            <div class="field-hint">Controls how new voice sessions choose STT.</div>
          </div>
          <select
            id="voice-routing-mode"
            name="voice-routing-mode"
            [value]="settingsStore.get('voiceSttRoutingMode')"
            (change)="onRoutingModeChange($event)"
          >
            @for (mode of routingModes; track mode.value) {
              <option [value]="mode.value">{{ mode.label }}</option>
            }
          </select>
        </div>

        <div class="field-grid">
          <label class="form-field">
            <span class="field-label">Worker node id</span>
            <input
              name="voice-worker-node-id"
              type="text"
              class="field-input"
              placeholder="Auto"
              [value]="settingsStore.get('voiceLocalSttWorkerNodeId')"
              (change)="onTextSettingChange('voiceLocalSttWorkerNodeId', $event)"
            />
          </label>

          <label class="form-field">
            <span class="field-label">Model</span>
            <input
              name="voice-local-stt-model"
              type="text"
              class="field-input"
              placeholder="distil-large-v3"
              [value]="settingsStore.get('voiceLocalSttModel')"
              (change)="onTextSettingChange('voiceLocalSttModel', $event)"
            />
          </label>

          <label class="form-field">
            <span class="field-label">Language</span>
            <input
              name="voice-local-stt-language"
              type="text"
              class="field-input"
              maxlength="16"
              [value]="settingsStore.get('voiceLocalSttLanguage')"
              (change)="onTextSettingChange('voiceLocalSttLanguage', $event)"
            />
          </label>

          <label class="form-field">
            <span class="field-label">Max segment ms</span>
            <input
              name="voice-max-segment-ms"
              type="number"
              class="field-input"
              min="1000"
              max="30000"
              step="500"
              [value]="settingsStore.get('voiceLocalSttMaxSegmentMs')"
              (change)="onMaxSegmentMsChange($event)"
            />
          </label>
        </div>
      </section>

      <section class="card">
        <h3 class="section-title">This device endpoint</h3>
        <p class="section-desc">Loopback OpenAI-compatible STT endpoint on this Mac.</p>

        <div class="field-grid">
          <label class="form-field wide">
            <span class="field-label">Endpoint URL</span>
            <input
              name="voice-this-device-endpoint"
              type="url"
              class="field-input"
              placeholder="http://127.0.0.1:8080"
              [value]="settingsStore.get('voiceThisDeviceSttEndpointUrl')"
              (change)="onTextSettingChange('voiceThisDeviceSttEndpointUrl', $event)"
            />
          </label>

          <label class="form-field">
            <span class="field-label">API key env var</span>
            <input
              name="voice-this-device-api-key-env"
              type="text"
              class="field-input"
              placeholder="LOCAL_STT_API_KEY"
              [value]="settingsStore.get('voiceThisDeviceSttApiKeyEnv')"
              (change)="onTextSettingChange('voiceThisDeviceSttApiKeyEnv', $event)"
            />
          </label>
        </div>
      </section>

      <section class="card">
        <h3 class="section-title">Provider status</h3>
        <div class="provider-list">
          @for (provider of sttProviders(); track provider.id) {
            <article class="provider-row">
              <div>
                <div class="provider-title">{{ provider.label }}</div>
                <div class="field-hint">{{ privacyLabel(provider) }}</div>
                @if (provider.reason) {
                  <div class="provider-reason">{{ provider.reason }}</div>
                }
                @if (provider.requiresSetup) {
                  <div class="provider-setup">{{ provider.requiresSetup }}</div>
                }
              </div>
              <div class="badge-row">
                @if (provider.active) {
                  <span class="status-badge" data-tone="ok">Active</span>
                }
                @if (provider.location) {
                  <span class="status-badge" data-tone="info">{{ locationLabel(provider) }}</span>
                }
                @if (provider.latencyClass) {
                  <span class="status-badge" data-tone="info">{{ latencyLabel(provider) }}</span>
                }
                <span class="status-badge" [attr.data-tone]="provider.available ? 'ok' : 'error'">
                  {{ provider.available ? 'Online' : 'Offline' }}
                </span>
              </div>
            </article>
          } @empty {
            <p class="empty">No STT providers reported yet.</p>
          }
        </div>
      </section>
    </div>
  `,
  styleUrl: './voice-settings-tab.component.scss',
})
export class VoiceSettingsTabComponent implements OnInit {
  protected readonly settingsStore = inject(SettingsStore);
  private readonly voiceIpc = inject(VoiceIpcService);

  protected readonly routingModes = ROUTING_MODES;
  protected readonly status = signal<VoiceStatus | null>(null);
  protected readonly loadingStatus = signal(false);
  protected readonly statusError = signal<string | null>(null);

  protected readonly sttProviders = computed(() =>
    this.status()?.providers.filter((provider) => provider.capabilities.includes('stt')) ?? []
  );
  protected readonly activeTranscriptionProvider = computed(() => {
    const current = this.status();
    const activeId = current?.activeTranscriptionProviderId;
    return this.sttProviders().find((provider) => provider.id === activeId || provider.active) ?? null;
  });
  protected readonly localSttEmptyState = computed(() => {
    const local = this.sttProviders().find((provider) => provider.id === 'local-whisper');
    return Boolean(local && !local.available);
  });

  ngOnInit(): void {
    void this.refreshStatus();
  }

  async refreshStatus(): Promise<void> {
    this.loadingStatus.set(true);
    this.statusError.set(null);
    try {
      this.status.set(await this.voiceIpc.getStatus());
    } catch (error) {
      this.statusError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loadingStatus.set(false);
    }
  }

  protected onRoutingModeChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as VoiceSttRoutingMode;
    void this.persistSetting('voiceSttRoutingMode', value);
  }

  protected onBooleanSettingChange(key: 'voiceLocalSttEnabled', event: Event): void {
    void this.persistSetting(key, (event.target as HTMLInputElement).checked);
  }

  protected onTextSettingChange(
    key: 'voiceLocalSttWorkerNodeId'
      | 'voiceLocalSttModel'
      | 'voiceLocalSttLanguage'
      | 'voiceThisDeviceSttEndpointUrl'
      | 'voiceThisDeviceSttApiKeyEnv',
    event: Event,
  ): void {
    void this.persistSetting(key, (event.target as HTMLInputElement).value.trim());
  }

  protected onMaxSegmentMsChange(event: Event): void {
    const raw = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(raw)) return;
    const next = Math.min(MAX_SEGMENT_MS, Math.max(MIN_SEGMENT_MS, Math.round(raw)));
    void this.persistSetting('voiceLocalSttMaxSegmentMs', next);
  }

  protected locationLabel(provider: VoiceProviderStatus): string {
    if (provider.location === 'this-device') return 'This device';
    if (provider.location === 'worker-node') return 'Worker node';
    if (provider.location === 'cloud') return 'OpenAI cloud';
    return 'Unknown';
  }

  protected latencyLabel(provider: VoiceProviderStatus): string {
    if (provider.latencyClass === 'live') return 'Live';
    if (provider.latencyClass === 'near-realtime') return 'Near realtime';
    return 'Unknown latency';
  }

  protected privacyLabel(provider: VoiceProviderStatus): string {
    if (provider.location === 'this-device') return 'Audio stays on this Mac';
    if (provider.location === 'worker-node') return 'Audio stays on your machines';
    if (provider.location === 'cloud' || provider.privacy === 'provider-cloud') {
      return 'Audio is sent to the provider cloud';
    }
    return 'Local processing';
  }

  private async persistSetting<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ): Promise<void> {
    try {
      await this.settingsStore.set(key, value);
      await this.refreshStatus();
    } catch (error) {
      this.statusError.set(error instanceof Error ? error.message : String(error));
    }
  }
}
