/**
 * Auxiliary Models Settings Tab
 *
 * Lets users enable/disable the auxiliary LLM routing layer, choose a routing
 * mode, probe custom endpoints, inspect discovered candidates, and test-fire a
 * generate call against a slot.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuxiliaryLlmIpcService } from '../../core/services/ipc/auxiliary-llm-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';
import type {
  AuxiliaryLlmCandidate,
  AuxiliaryLlmDecision,
  AuxiliaryLlmSlot,
  AuxiliaryLlmSlotConfig,
  AuxiliaryLlmSlotConfigMap,
} from '../../../../shared/types/auxiliary-llm.types';

const ROUTING_MODES = [
  { value: 'local-first', label: 'Local first (prefer Ollama/LAN)' },
  { value: 'cheap-first', label: 'Cheap first (prefer low-cost cloud)' },
  { value: 'manual-only', label: 'Manual only (explicit endpoint per slot)' },
  { value: 'off', label: 'Off (always use main model)' },
] as const;

const SLOTS: AuxiliaryLlmSlot[] = [
  'compression',
  'memoryDistillation',
  'webExtract',
  'titleGeneration',
  'routingClassification',
  'approvalScoring',
  'loopScoring',
];

const PROVIDERS = ['ollama', 'openai-compatible'] as const;

@Component({
  selector: 'app-auxiliary-models-settings-tab',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="aux-tab">
      <!-- Master enable toggle -->
      <div class="card">
        <div class="field-row">
          <div>
            <div class="field-label">Enable auxiliary models</div>
            <div class="field-hint">
              Route helper calls (compression, titles, scoring) to local or cheap
              models instead of the main frontier model.
            </div>
          </div>
          <input
            type="checkbox"
            [checked]="settingsStore.get('auxiliaryLlmEnabled')"
            (change)="onEnabledChange($event)"
          />
        </div>
      </div>

      <!-- Routing mode -->
      <div class="card">
        <div class="field-row">
          <div>
            <div class="field-label">Routing mode</div>
            <div class="field-hint">Controls how the router picks an endpoint for each slot.</div>
          </div>
          <select
            [value]="settingsStore.get('auxiliaryLlmRoutingMode')"
            (change)="onRoutingModeChange($event)"
          >
            @for (mode of routingModes; track mode.value) {
              <option [value]="mode.value">{{ mode.label }}</option>
            }
          </select>
        </div>
      </div>

      <!-- Use this machine's localhost Ollama -->
      <div class="card">
        <div class="field-row">
          <div>
            <div class="field-label">Use this machine's local Ollama</div>
            <div class="field-hint">
              When off, auxiliary routing skips this Mac's localhost Ollama and
              prefers remote worker nodes (e.g. a GPU box). Ollama keeps running
              for other features such as embeddings.
            </div>
          </div>
          <input
            type="checkbox"
            [checked]="settingsStore.get('auxiliaryLlmUseLocalhostOllama')"
            (change)="onUseLocalhostOllamaChange($event)"
          />
        </div>
      </div>

      <!-- Discovered candidates -->
      <div class="card">
        <div class="card-head">
          <div class="section-title">Discovered endpoints</div>
          <button
            type="button"
            class="btn"
            [disabled]="loadingCandidates()"
            (click)="refreshCandidates()"
          >
            {{ loadingCandidates() ? 'Scanning…' : 'Refresh' }}
          </button>
        </div>
        <p class="section-desc">
          Ollama localhost is always probed. Configured endpoints appear here too.
        </p>

        @if (candidateError(); as err) {
          <div class="error-banner">{{ err }}</div>
        }

        @if (candidates().length > 0) {
          @for (c of candidates(); track c.endpoint.id) {
            <div class="card" style="margin-top: 0.5rem;">
              <div class="card-head">
                <div>
                  <span class="candidate-label">{{ c.endpoint.label }}</span>
                  <span class="candidate-url"> &mdash; {{ c.endpoint.baseUrl }}</span>
                </div>
                <span class="health-badge" [attr.data-healthy]="c.healthy">
                  {{ c.healthy ? 'Online' : 'Offline' }}
                </span>
              </div>
              @if (c.reason) {
                <div class="field-hint">{{ c.reason }}</div>
              }
              @if (c.models.length > 0) {
                <ul class="model-list">
                  @for (m of c.models; track m.id) {
                    <li class="model-chip">{{ m.name || m.id }}</li>
                  }
                </ul>
              }
            </div>
          }
        } @else if (!loadingCandidates()) {
          <p class="empty">No candidates yet. Click Refresh to scan.</p>
        }
      </div>

      <!-- Manual endpoint probe -->
      <div class="card">
        <div class="section-title">Probe a custom endpoint</div>
        <p class="section-desc">
          Test reachability of a custom OpenAI-compatible or Ollama endpoint before
          adding it to settings.
        </p>
        <div class="endpoint-form">
          <div class="form-row">
            <label class="field-label" for="probe-provider">Provider</label>
            <select id="probe-provider" [(ngModel)]="probeProvider">
              @for (p of providers; track p) {
                <option [value]="p">{{ p }}</option>
              }
            </select>
          </div>
          <div class="form-row">
            <label class="field-label" for="probe-url">Base URL</label>
            <input
              id="probe-url"
              type="url"
              class="field-input"
              placeholder="http://localhost:11434"
              [(ngModel)]="probeBaseUrl"
            />
          </div>
          <div class="form-row">
            <label class="field-label" for="probe-key-env">API key env var</label>
            <input
              id="probe-key-env"
              type="text"
              class="field-input"
              placeholder="OPENAI_API_KEY"
              [(ngModel)]="probeApiKeyEnv"
            />
          </div>
          <div class="form-actions">
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="probing() || !probeBaseUrl"
              (click)="probeEndpoint()"
            >
              {{ probing() ? 'Probing…' : 'Probe' }}
            </button>
            @if (probeResult() !== null) {
              <span [class]="probeResult() ? 'health-badge' : 'health-badge'"
                    [attr.data-healthy]="probeResult()">
                {{ probeResult() ? 'Reachable' : 'Unreachable' }}
              </span>
            }
            @if (probeError()) {
              <span class="error-banner">{{ probeError() }}</span>
            }
          </div>
        </div>
      </div>

      <!-- Slot table -->
      <div class="card">
        <div class="section-title">Slots</div>
        <p class="section-desc">Each slot routes a specific category of helper call.</p>
        <table class="slot-table">
          <thead>
            <tr>
              <th>Slot</th>
              <th title="When on, this slot may fall back to the main cloud model if no local/cheap model is available. Turn off to keep this slot's content local-only (privacy / hard cost control) — it uses a deterministic local summary instead.">
                Cloud fallback
              </th>
              <th>Test</th>
            </tr>
          </thead>
          <tbody>
            @for (slot of slots; track slot) {
              <tr>
                <td>{{ slot }}</td>
                <td>
                  <input
                    type="checkbox"
                    [checked]="frontierFallbackEnabled(slot)"
                    (change)="onFrontierFallbackChange(slot, $event)"
                    [attr.aria-label]="'Allow cloud fallback for ' + slot"
                  />
                </td>
                <td>
                  <button
                    type="button"
                    class="btn"
                    [disabled]="testingSlot() === slot"
                    (click)="testSlot(slot)"
                  >
                    {{ testingSlot() === slot ? 'Testing…' : 'Test' }}
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
        <p class="field-hint">
          Cloud fallback off = this slot never sends content to the main model;
          if no local model is available it uses a local deterministic summary.
        </p>
      </div>

      <!-- Test output -->
      @if (testResult()) {
        <div class="card">
          <div class="section-title">Test result</div>
          @if (testError()) {
            <div class="error-banner">{{ testError() }}</div>
          } @else {
            <pre class="test-output">{{ testResult() }}</pre>
            @if (testDecision(); as d) {
              <div class="field-hint">
                Routed via <strong>{{ d.source }}</strong> to
                <strong>{{ d.endpointId ?? d.provider }}</strong>
                (model: {{ d.model ?? 'auto' }}) &mdash; {{ d.reason }}
              </div>
            }
          }
        </div>
      }
    </div>
  `,
  styleUrl: './auxiliary-models-settings-tab.component.scss',
})
export class AuxiliaryModelsSettingsTabComponent implements OnInit {
  private readonly ipc = inject(AuxiliaryLlmIpcService);
  protected readonly settingsStore = inject(SettingsStore);

  protected readonly routingModes = ROUTING_MODES;
  protected readonly slots = SLOTS;
  protected readonly providers = PROVIDERS;

  protected readonly candidates = signal<AuxiliaryLlmCandidate[]>([]);
  protected readonly loadingCandidates = signal(false);
  protected readonly candidateError = signal<string | null>(null);

  protected probeProvider = 'ollama';
  protected probeBaseUrl = '';
  protected probeApiKeyEnv = '';
  protected readonly probing = signal(false);
  protected readonly probeResult = signal<boolean | null>(null);
  protected readonly probeError = signal<string | null>(null);

  protected readonly testingSlot = signal<AuxiliaryLlmSlot | null>(null);
  protected readonly testResult = signal<string | null>(null);
  protected readonly testDecision = signal<AuxiliaryLlmDecision | null>(null);
  protected readonly testError = signal<string | null>(null);

  /** Parsed slot config map from persisted settings (reactive). */
  protected readonly slotConfigs = computed<Partial<AuxiliaryLlmSlotConfigMap>>(() => {
    try {
      return JSON.parse(this.settingsStore.get('auxiliaryLlmSlotsJson')) as Partial<AuxiliaryLlmSlotConfigMap>;
    } catch {
      return {};
    }
  });

  ngOnInit(): void {
    void this.refreshCandidates();
  }

  onEnabledChange(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    void this.settingsStore.set('auxiliaryLlmEnabled', checked);
  }

  onUseLocalhostOllamaChange(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    void this.settingsStore.set('auxiliaryLlmUseLocalhostOllama', checked);
  }

  /** Whether a slot is allowed to fall back to the main/cloud model. Defaults to true. */
  protected frontierFallbackEnabled(slot: AuxiliaryLlmSlot): boolean {
    return this.slotConfigs()[slot]?.allowFrontierFallback ?? true;
  }

  onFrontierFallbackChange(slot: AuxiliaryLlmSlot, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const slots = this.slotConfigs();
    const existing = slots[slot];
    if (!existing) return; // unknown/missing slot config — nothing to update
    const next: AuxiliaryLlmSlotConfigMap = {
      ...(slots as AuxiliaryLlmSlotConfigMap),
      [slot]: { ...existing, allowFrontierFallback: checked } as AuxiliaryLlmSlotConfig,
    };
    void this.settingsStore.set('auxiliaryLlmSlotsJson', JSON.stringify(next));
  }

  onRoutingModeChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    void this.settingsStore.set(
      'auxiliaryLlmRoutingMode',
      value as import('../../../../shared/types/settings.types').AppSettings['auxiliaryLlmRoutingMode'],
    );
  }

  async refreshCandidates(): Promise<void> {
    this.loadingCandidates.set(true);
    this.candidateError.set(null);
    try {
      const resp = await this.ipc.listCandidates();
      if (!resp.success) {
        this.candidateError.set(resp.error?.message ?? 'Failed to list candidates');
        return;
      }
      this.candidates.set(resp.data ?? []);
    } catch (err) {
      this.candidateError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loadingCandidates.set(false);
    }
  }

  async probeEndpoint(): Promise<void> {
    this.probing.set(true);
    this.probeResult.set(null);
    this.probeError.set(null);
    try {
      const resp = await this.ipc.probeEndpoint({
        provider: this.probeProvider,
        baseUrl: this.probeBaseUrl,
        apiKeyEnv: this.probeApiKeyEnv || undefined,
      });
      if (!resp.success) {
        this.probeError.set(resp.error?.message ?? 'Probe failed');
        return;
      }
      this.probeResult.set(resp.data?.healthy ?? false);
    } catch (err) {
      this.probeError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.probing.set(false);
    }
  }

  async testSlot(slot: AuxiliaryLlmSlot): Promise<void> {
    this.testingSlot.set(slot);
    this.testResult.set(null);
    this.testDecision.set(null);
    this.testError.set(null);
    try {
      const resp = await this.ipc.testGenerate({ slot });
      if (!resp.success) {
        this.testError.set(resp.error?.message ?? 'Test generate failed');
        this.testResult.set('error');
        return;
      }
      this.testResult.set(resp.data?.text ?? '(empty)');
      this.testDecision.set(resp.data?.decision ?? null);
    } catch (err) {
      this.testError.set(err instanceof Error ? err.message : String(err));
      this.testResult.set('error');
    } finally {
      this.testingSlot.set(null);
    }
  }
}
