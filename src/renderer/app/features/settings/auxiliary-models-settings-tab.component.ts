/**
 * Auxiliary Models Settings Tab
 *
 * Lets users enable/disable the auxiliary LLM routing layer, choose a routing
 * mode, probe custom endpoints, inspect discovered candidates, and test-fire a
 * generate call against a slot.
 *
 * Reorganised (2026-08-28 settings UX remediation, Task 6) into four
 * task-based sections rendered by the shared `SettingsSectionTabsComponent`:
 * Overview (everyday enablement/routing + a compact endpoint-health summary),
 * Models (quick/quality tier defaults), Slots (per-slot overrides and test
 * tools), and Advanced (full endpoint discovery + the custom endpoint
 * probe). All setting keys, IPC calls, and per-slot semantics are unchanged
 * from the previous single-page layout — this is presentation only.
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
import {
  DEFAULT_SLOT_TIERS,
  type AuxiliaryLlmCandidate,
  type AuxiliaryLlmDecision,
  type AuxiliaryLlmSlot,
  type AuxiliaryLlmSlotConfig,
  type AuxiliaryLlmSlotConfigMap,
} from '../../../../shared/types/auxiliary-llm.types';
import type { SettingsSectionTab } from './settings-navigation';
import { SettingsSectionTabsComponent } from './ui/settings-section-tabs.component';

/** The four task-based sections this tab is organised around. */
export type AuxiliaryModelsSection = 'overview' | 'models' | 'slots' | 'advanced';

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
  'approvalAdjudication',
  'loopScoring',
  'retrievalHypothesis',
  'branchScoring',
  'subQueryExecution',
  'verifyOutputSummary',
];

const PROVIDERS = ['ollama', 'openai-compatible'] as const;

/**
 * Slots actually consumed by a feature in normal operation. Slots NOT listed
 * here are testable (the Test button still routes through them) but nothing
 * calls them during real work, so the UI flags them "not yet active".
 */
const WIRED_SLOTS = new Set<AuxiliaryLlmSlot>([
  'compression',
  'memoryDistillation',
  'webExtract',
  'titleGeneration',
  'loopScoring',
  'approvalScoring',
  'approvalAdjudication',
  'routingClassification',
  'retrievalHypothesis',
  'branchScoring',
  'subQueryExecution',
  'verifyOutputSummary',
]);

/** Inline test state for a single slot row. */
interface SlotTestState {
  testing: boolean;
  text: string | null;
  decision: AuxiliaryLlmDecision | null;
  error: string | null;
}

@Component({
  selector: 'app-auxiliary-models-settings-tab',
  standalone: true,
  imports: [FormsModule, SettingsSectionTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './auxiliary-models-settings-tab.component.html',
  styleUrl: './auxiliary-models-settings-tab.component.scss',
})
export class AuxiliaryModelsSettingsTabComponent implements OnInit {
  private readonly ipc = inject(AuxiliaryLlmIpcService);
  protected readonly settingsStore = inject(SettingsStore);

  protected readonly activeSection = signal<AuxiliaryModelsSection>('overview');
  protected readonly sectionTabs: SettingsSectionTab[] = [
    { id: 'overview', label: 'Overview', panelId: 'panel-overview' },
    { id: 'models', label: 'Models', panelId: 'panel-models' },
    { id: 'slots', label: 'Slots', panelId: 'panel-slots' },
    { id: 'advanced', label: 'Advanced', panelId: 'panel-advanced' },
  ];

  onSectionChange(id: string): void {
    this.activeSection.set(id as AuxiliaryModelsSection);
  }

  /** Lets Overview's "View endpoint details" action jump straight to Advanced. */
  protected goToSection(section: AuxiliaryModelsSection): void {
    this.activeSection.set(section);
  }

  protected readonly routingModes = ROUTING_MODES;
  protected readonly slots = SLOTS;
  protected readonly providers = PROVIDERS;

  protected isSlotWired(slot: AuxiliaryLlmSlot): boolean {
    return WIRED_SLOTS.has(slot);
  }

  protected readonly candidates = signal<AuxiliaryLlmCandidate[]>([]);
  protected readonly loadingCandidates = signal(false);
  protected readonly candidateError = signal<string | null>(null);

  protected probeProvider = 'ollama';
  protected probeBaseUrl = '';
  protected probeApiKeyEnv = '';
  protected readonly probing = signal(false);
  protected readonly probeResult = signal<boolean | null>(null);
  protected readonly probeError = signal<string | null>(null);

  protected readonly slotTests = signal<Partial<Record<AuxiliaryLlmSlot, SlotTestState>>>({});

  protected slotTest(slot: AuxiliaryLlmSlot): SlotTestState | undefined {
    return this.slotTests()[slot];
  }

  private setSlotTest(slot: AuxiliaryLlmSlot, patch: Partial<SlotTestState>): void {
    this.slotTests.update((m) => {
      const prev = m[slot] ?? { testing: false, text: null, decision: null, error: null };
      return { ...m, [slot]: { ...prev, ...patch } };
    });
  }

  /** Parsed slot config map from persisted settings (reactive). */
  protected readonly slotConfigs = computed<Partial<AuxiliaryLlmSlotConfigMap>>(() => {
    try {
      return JSON.parse(this.settingsStore.get('auxiliaryLlmSlotsJson')) as Partial<AuxiliaryLlmSlotConfigMap>;
    } catch {
      return {};
    }
  });

  /**
   * Flat, de-duplicated list of model ids offered in the per-slot dropdown.
   * Sourced from discovered endpoint candidates (including remote worker-node
   * LM Studio / Ollama models) plus any model already pinned to a slot — so a
   * configured model still shows even when its endpoint isn't currently visible.
   */
  protected readonly availableModels = computed<string[]>(() => {
    const ids = new Set<string>();
    for (const c of this.candidates()) {
      for (const m of c.models) ids.add(m.id);
    }
    const slots = this.slotConfigs();
    for (const slot of this.slots) {
      const model = slots[slot]?.model;
      if (model) ids.add(model);
    }
    return Array.from(ids).sort();
  });

  /** Endpoint-health counts shown in Overview's compact summary. */
  protected readonly onlineCandidateCount = computed(
    () => this.candidates().filter((c) => c.healthy).length,
  );
  protected readonly offlineCandidateCount = computed(
    () => this.candidates().length - this.onlineCandidateCount(),
  );

  /**
   * Human-readable "what will Quick/Quality actually resolve to" feedback for
   * the Models section — mirrors the auto-pick label already shown per slot,
   * but for the tier model itself rather than a slot's effective model.
   */
  protected effectiveTierModelLabel(
    key: 'auxiliaryLlmQuickModel' | 'auxiliaryLlmQualityModel',
  ): string {
    const explicit = this.settingsStore.get(key);
    if (explicit) return explicit;
    const auto = this.availableModels()[0];
    return auto ? `Auto → ${auto}` : 'Auto (no candidates yet)';
  }

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

  protected dailySpendCapInputValue(): string {
    const cap = this.settingsStore.get('auxiliaryLlmDailySpendCapUsd');
    return cap === null || cap === undefined ? '' : String(cap);
  }

  onDailySpendCapChange(event: Event): void {
    const raw = (event.target as HTMLInputElement).value.trim();
    if (raw === '') {
      void this.settingsStore.set('auxiliaryLlmDailySpendCapUsd', null);
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    void this.settingsStore.set('auxiliaryLlmDailySpendCapUsd', value);
  }

  onRoutingClassificationChange(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    void this.settingsStore.set('auxiliaryLlmRoutingClassificationEnabled', checked);
  }

  /** Whether a slot is allowed to fall back to the main/cloud model. Defaults to true. */
  protected frontierFallbackEnabled(slot: AuxiliaryLlmSlot): boolean {
    return this.slotConfigs()[slot]?.allowFrontierFallback ?? true;
  }

  /** Currently pinned model-override id for a slot ('' = auto/tier). */
  protected slotModel(slot: AuxiliaryLlmSlot): string {
    return this.slotConfigs()[slot]?.model ?? '';
  }

  /**
   * Effective tier for a slot: the explicit configured tier, or the name-based
   * default the router applies when none is set — so the dropdown reflects what
   * the backend actually does rather than showing a misleading "None".
   */
  protected slotTier(slot: AuxiliaryLlmSlot): string {
    return this.slotConfigs()[slot]?.tier ?? DEFAULT_SLOT_TIERS[slot] ?? '';
  }

  /**
   * Human-readable model this slot will resolve to: an explicit override, else
   * the configured tier model, else an auto-pick label. (The exact auto-picked
   * id is shown by the Test button, which reports the real routing decision.)
   */
  protected effectiveSlotModelLabel(slot: AuxiliaryLlmSlot): string {
    const cfg = this.slotConfigs()[slot];
    if (cfg?.model) return cfg.model;
    const tier = cfg?.tier ?? DEFAULT_SLOT_TIERS[slot];
    if (tier === 'quick') {
      const m = this.settingsStore.get('auxiliaryLlmQuickModel');
      return m ? `${m} (quick)` : 'Auto · quick (smallest)';
    }
    if (tier === 'quality') {
      const m = this.settingsStore.get('auxiliaryLlmQualityModel');
      return m ? `${m} (quality)` : 'Auto · quality (largest)';
    }
    return 'Auto (first available)';
  }

  /** Persist the quick/quality tier model id. */
  onTierModelChange(
    key: 'auxiliaryLlmQuickModel' | 'auxiliaryLlmQualityModel',
    event: Event,
  ): void {
    const value = (event.target as HTMLSelectElement).value;
    void this.settingsStore.set(key, value);
  }

  onSlotTierChange(slot: AuxiliaryLlmSlot, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const slots = this.slotConfigs();
    const existing = slots[slot];
    if (!existing) return; // unknown/missing slot config — nothing to update
    const nextSlot: AuxiliaryLlmSlotConfig = { ...existing };
    if (value === 'quick' || value === 'quality') {
      nextSlot.tier = value;
    } else {
      delete nextSlot.tier;
    }
    const next: AuxiliaryLlmSlotConfigMap = {
      ...(slots as AuxiliaryLlmSlotConfigMap),
      [slot]: nextSlot,
    };
    void this.settingsStore.set('auxiliaryLlmSlotsJson', JSON.stringify(next));
  }

  onSlotModelChange(slot: AuxiliaryLlmSlot, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const slots = this.slotConfigs();
    const existing = slots[slot];
    if (!existing) return; // unknown/missing slot config — nothing to update
    const nextSlot: AuxiliaryLlmSlotConfig = { ...existing };
    if (value) {
      nextSlot.model = value;
    } else {
      delete nextSlot.model; // 'Auto' — fall back to first available model
    }
    const next: AuxiliaryLlmSlotConfigMap = {
      ...(slots as AuxiliaryLlmSlotConfigMap),
      [slot]: nextSlot,
    };
    void this.settingsStore.set('auxiliaryLlmSlotsJson', JSON.stringify(next));
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
    this.setSlotTest(slot, { testing: true, text: null, decision: null, error: null });
    try {
      const resp = await this.ipc.testGenerate({ slot });
      if (!resp.success) {
        this.setSlotTest(slot, { error: resp.error?.message ?? 'Test generate failed' });
        return;
      }
      this.setSlotTest(slot, {
        text: resp.data?.text ?? '(empty)',
        decision: resp.data?.decision ?? null,
      });
    } catch (err) {
      this.setSlotTest(slot, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.setSlotTest(slot, { testing: false });
    }
  }
}
