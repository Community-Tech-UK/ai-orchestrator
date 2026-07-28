import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { AuxiliaryLlmSlot } from '../../../../shared/types/auxiliary-llm.types';
import type {
  LocalAiDiscoveredEndpoint,
  LocalAiFallbackPolicy,
  LocalAiHealthLayer,
  LocalAiProbeResult,
  LocalAiTargetConfig,
  LocalAiTargetLifecycle,
  LocalAiTargetPatch,
  LocalAiTarget,
} from '../../../../shared/types/local-ai-guard.types';
import { LOCAL_AI_TARGET_NUMERIC_LIMITS } from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';

interface SetupForm {
  expectedModels: string[];
  expectedModelRules: LocalAiTargetConfig['expectedModels'];
  canaryModel: string;
  endpointIntervalSeconds: number;
  canaryIntervalMinutes: number;
  canaryTimeoutSeconds: number;
  freshnessSeconds: number;
  warningLatencyMs: number;
  routingRoles: AuxiliaryLlmSlot[];
  fallbackPolicy: LocalAiFallbackPolicy;
  slotFallbackPolicies: LocalAiTargetConfig['slotFallbackPolicies'];
  confirmAboveInputTokens?: number;
  dailyFallbackBudgetUsd?: number;
  incidentFallbackBudgetUsd?: number;
  automaticRepair: boolean;
  maxAttempts: number;
  cooldownMinutes: number;
}

interface RoleOption {
  value: AuxiliaryLlmSlot;
  label: string;
}

interface ValidationLayer {
  id: 'worker' | 'endpoint' | 'model' | 'canary';
  label: string;
  result?: LocalAiProbeResult;
}

const ROLE_OPTIONS: readonly RoleOption[] = [
  { value: 'compression', label: 'Compression' },
  { value: 'memoryDistillation', label: 'Memory distillation' },
  { value: 'webExtract', label: 'Web extraction' },
  { value: 'titleGeneration', label: 'Title generation' },
  { value: 'routingClassification', label: 'Routing classification' },
  { value: 'approvalScoring', label: 'Approval scoring' },
  { value: 'loopScoring', label: 'Loop scoring' },
  { value: 'retrievalHypothesis', label: 'Retrieval hypothesis' },
  { value: 'branchScoring', label: 'Branch scoring' },
  { value: 'subQueryExecution', label: 'Sub-query execution' },
  { value: 'verifyOutputSummary', label: 'Output verification' },
];

const DEFAULT_FORM: SetupForm = {
  expectedModels: [],
  expectedModelRules: [],
  canaryModel: '',
  endpointIntervalSeconds: 60,
  canaryIntervalMinutes: 10,
  canaryTimeoutSeconds: 30,
  freshnessSeconds: 120,
  warningLatencyMs: 2_000,
  routingRoles: [],
  fallbackPolicy: 'notify-and-allow',
  slotFallbackPolicies: {},
  automaticRepair: false,
  maxAttempts: 2,
  cooldownMinutes: 5,
};

@Component({
  selector: 'app-local-ai-target-setup',
  standalone: true,
  templateUrl: './local-ai-target-setup.component.html',
  styleUrl: './local-ai-target-setup.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocalAiTargetSetupComponent {
  protected readonly store = inject(LocalAiGuardStore);

  readonly editingTargetId = input<string | null>(null);
  readonly editingEndpoint = input<LocalAiDiscoveredEndpoint | null>(null);
  readonly editingTarget = input<LocalAiTarget | null>(null);
  readonly editingLifecycle = input<LocalAiTargetLifecycle>('enrolled');
  readonly saved = output<void>();
  readonly cancelled = output<void>();

  protected readonly roleOptions = ROLE_OPTIONS;
  protected readonly limits = LOCAL_AI_TARGET_NUMERIC_LIMITS;
  protected readonly selectedEndpoint = signal<LocalAiDiscoveredEndpoint | null>(null);
  protected readonly form = signal<SetupForm>({ ...DEFAULT_FORM });
  protected readonly validationResults = signal<LocalAiProbeResult[] | null>(null);
  protected readonly announcement = signal('');
  private readonly modelContextInputErrors = signal<Record<string, string>>({});
  private lastValidationFingerprint = '';
  private appliedEditingTargetId = '';

  protected readonly isEditing = computed(() => this.editingTargetId() !== null);
  protected readonly isBusy = computed(() => this.store.operationKey() !== null);
  protected readonly endpointIntervalError = computed(() => {
    const value = this.form().endpointIntervalSeconds;
    return !Number.isInteger(value)
      || value < this.limits.endpointCheckIntervalMs.min / 1_000
      || value > this.limits.endpointCheckIntervalMs.max / 1_000
      ? 'Endpoint checks must be between 30 seconds and 15 minutes.'
      : null;
  });
  protected readonly canaryIntervalError = computed(() => {
    const value = this.form().canaryIntervalMinutes;
    return !Number.isInteger(value)
      || value < this.limits.canaryIntervalMs.min / 60_000
      || value > this.limits.canaryIntervalMs.max / 60_000
      ? 'Canary checks must be between 2 and 60 minutes.'
      : null;
  });
  protected readonly canSave = computed(() => {
    const results = this.validationResults();
    return Boolean(
      results
      && results.length > 0
      && results.every((result) => !result.required || result.ok)
      && this.formValid()
      && this.lastValidationFingerprint === this.configFingerprint(),
    );
  });
  protected readonly formValid = computed(() => {
    const endpoint = this.selectedEndpoint();
    const value = this.form();
    return Boolean(
      endpoint
      && value.expectedModels.length > 0
      && value.expectedModelRules.length === value.expectedModels.length
      && value.expectedModelRules.every((rule) =>
        value.expectedModels.includes(rule.modelId)
        && this.modelContextError(rule.modelId) === null)
      && value.canaryModel
      && value.expectedModels.includes(value.canaryModel)
      && value.routingRoles.length > 0
      && !this.endpointIntervalError()
      && !this.canaryIntervalError()
      && this.integerInRange(
        value.canaryTimeoutSeconds,
        this.limits.canaryTimeoutMs.min / 1_000,
        this.limits.canaryTimeoutMs.max / 1_000,
      )
      && this.integerInRange(
        value.freshnessSeconds,
        this.limits.freshnessLimitMs.min / 1_000,
        this.limits.freshnessLimitMs.max / 1_000,
      )
      && this.integerInRange(
        value.warningLatencyMs,
        this.limits.warningLatencyMs.min,
        this.limits.warningLatencyMs.max,
      )
      && (value.confirmAboveInputTokens === undefined || this.integerInRange(
        value.confirmAboveInputTokens,
        this.limits.confirmAboveInputTokens.min,
        this.limits.confirmAboveInputTokens.max,
      ))
      && (value.dailyFallbackBudgetUsd === undefined || this.numberInRange(
        value.dailyFallbackBudgetUsd,
        this.limits.fallbackBudgetUsd.min,
        this.limits.fallbackBudgetUsd.max,
      ))
      && (value.incidentFallbackBudgetUsd === undefined || this.numberInRange(
        value.incidentFallbackBudgetUsd,
        this.limits.fallbackBudgetUsd.min,
        this.limits.fallbackBudgetUsd.max,
      ))
      && this.integerInRange(
        value.maxAttempts,
        this.limits.recoveryMaxAttempts.min,
        this.limits.recoveryMaxAttempts.max,
      )
      && this.integerInRange(
        value.cooldownMinutes,
        this.limits.recoveryCooldownMs.min / 60_000,
        this.limits.recoveryCooldownMs.max / 60_000,
      )
    );
  });
  protected readonly validationLayers = computed<ValidationLayer[]>(() => {
    const results = this.validationResults() ?? [];
    const resultFor = (layer: LocalAiHealthLayer) =>
      results.find((result) => result.layer === layer);
    return [
      { id: 'worker', label: 'Worker', result: resultFor('worker') },
      { id: 'endpoint', label: 'Endpoint', result: resultFor('endpoint') },
      { id: 'model', label: 'Model', result: resultFor('model') },
      { id: 'canary', label: 'Canary', result: resultFor('inference') },
    ];
  });

  constructor() {
    effect(() => {
      const targetId = this.editingTargetId();
      const endpoint = this.editingEndpoint();
      if (!targetId || !endpoint || targetId === this.appliedEditingTargetId) return;
      this.appliedEditingTargetId = targetId;
      this.chooseEndpoint(endpoint, this.editingTarget());
    });
  }

  protected async refreshDiscovery(): Promise<void> {
    await this.store.loadInventory();
    this.announcement.set(
      this.store.operationError()
        ? 'Endpoint discovery could not be completed.'
        : 'Endpoint discovery refreshed.',
    );
  }

  protected chooseEndpoint(
    endpoint: LocalAiDiscoveredEndpoint,
    persisted: LocalAiTarget | null = null,
  ): void {
    this.selectedEndpoint.set(endpoint);
    this.modelContextInputErrors.set({});
    const defaultModel = endpoint.models[0] ?? '';
    this.form.set(persisted ? this.formFromTarget(persisted) : {
      ...DEFAULT_FORM,
      expectedModels: defaultModel ? [defaultModel] : [],
      expectedModelRules: defaultModel ? [{ modelId: defaultModel, required: true }] : [],
      canaryModel: defaultModel,
    });
    this.invalidateValidation();
  }

  protected close(): void {
    this.selectedEndpoint.set(null);
    this.validationResults.set(null);
    this.cancelled.emit();
  }

  protected toggleExpectedModel(modelId: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const current = this.form();
    const expectedModels = checked
      ? [...new Set([...current.expectedModels, modelId])]
      : current.expectedModels.filter((candidate) => candidate !== modelId);
    if (!checked) {
      this.clearModelContextInputError(modelId);
    }
    this.patchForm({
      expectedModels,
      expectedModelRules: expectedModels.map((candidate) =>
        current.expectedModelRules.find((rule) => rule.modelId === candidate)
        ?? { modelId: candidate, required: true }),
      canaryModel: expectedModels.includes(current.canaryModel)
        ? current.canaryModel
        : expectedModels[0] ?? '',
    });
  }

  protected toggleRole(role: AuxiliaryLlmSlot, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const current = this.form().routingRoles;
    this.patchForm({
      routingRoles: checked
        ? [...new Set([...current, role])]
        : current.filter((candidate) => candidate !== role),
    });
  }

  protected updateCanary(event: Event): void {
    this.patchForm({ canaryModel: (event.target as HTMLSelectElement).value });
  }

  protected updateFallbackPolicy(event: Event): void {
    this.patchForm({
      fallbackPolicy: (event.target as HTMLSelectElement).value as LocalAiFallbackPolicy,
    });
  }

  protected updateNumber(field: keyof SetupForm, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    this.patchForm({ [field]: value });
  }

  protected updateAutomaticRepair(event: Event): void {
    this.patchForm({ automaticRepair: (event.target as HTMLInputElement).checked });
  }

  protected updateOptionalNumber(
    field: 'confirmAboveInputTokens' | 'dailyFallbackBudgetUsd' | 'incidentFallbackBudgetUsd',
    event: Event,
  ): void {
    const raw = (event.target as HTMLInputElement).value.trim();
    if (!raw) {
      this.patchForm({ [field]: undefined });
      return;
    }
    const value = Number(raw);
    if (Number.isFinite(value)) this.patchForm({ [field]: value });
  }

  protected updateModelRequired(modelId: string, event: Event): void {
    const required = (event.target as HTMLInputElement).checked;
    this.patchForm({
      expectedModelRules: this.form().expectedModelRules.map((rule) =>
        rule.modelId === modelId ? { ...rule, required } : rule),
    });
  }

  protected updateModelContext(modelId: string, event: Event): void {
    const raw = (event.target as HTMLInputElement).value.trim();
    const contextLength = raw ? Number(raw) : undefined;
    if (
      contextLength !== undefined
      && !this.integerInRange(
        contextLength,
        this.limits.minContextLength.min,
        this.limits.minContextLength.max,
      )
    ) {
      this.modelContextInputErrors.update((errors) => ({
        ...errors,
        [modelId]: this.modelContextRangeError(),
      }));
      this.invalidateValidation();
      return;
    }
    this.clearModelContextInputError(modelId);
    this.patchForm({
      expectedModelRules: this.form().expectedModelRules.map((rule) => {
        if (rule.modelId !== modelId) return rule;
        const next = { ...rule };
        if (contextLength === undefined) delete next.minContextLength;
        else next.minContextLength = contextLength;
        return next;
      }),
    });
  }

  protected updateSlotFallbackPolicy(role: AuxiliaryLlmSlot, event: Event): void {
    const policy = (event.target as HTMLSelectElement).value;
    const next = { ...this.form().slotFallbackPolicies };
    if (!policy) delete next[role];
    else next[role] = policy as LocalAiFallbackPolicy;
    this.patchForm({ slotFallbackPolicies: next });
  }

  protected roleLabel(role: AuxiliaryLlmSlot): string {
    return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
  }

  protected modelContextError(modelId: string): string | null {
    const inputError = this.modelContextInputErrors()[modelId];
    if (inputError) return inputError;
    const contextLength = this.form().expectedModelRules
      .find((rule) => rule.modelId === modelId)?.minContextLength;
    return contextLength === undefined
      || this.integerInRange(
        contextLength,
        this.limits.minContextLength.min,
        this.limits.minContextLength.max,
      )
      ? null
      : this.modelContextRangeError();
  }

  protected async validate(): Promise<void> {
    if (!this.formValid() || this.isBusy()) return;
    const fingerprint = this.configFingerprint();
    if (fingerprint === this.lastValidationFingerprint && this.validationResults()) return;
    const results = await this.store.validateTarget(this.buildConfig());
    if (!results) {
      this.announcement.set('Endpoint validation could not be completed.');
      return;
    }
    this.lastValidationFingerprint = fingerprint;
    this.validationResults.set(results);
    const passed = results.every((result) => !result.required || result.ok);
    this.announcement.set(
      passed
        ? 'Validation passed. The target is ready to save.'
        : 'Validation found a required check that needs attention.',
    );
  }

  protected async save(): Promise<void> {
    if (!this.canSave() || this.isBusy()) return;
    const targetId = this.editingTargetId();
    const result = targetId
      ? await this.store.updateTarget(targetId, this.buildPatch())
      : await this.store.createTarget(this.buildConfig());
    if (!result && this.store.operationError()) {
      this.announcement.set('Target settings could not be saved.');
      return;
    }
    this.announcement.set(targetId ? 'Target changes saved.' : 'Target enrolled.');
    this.saved.emit();
  }

  protected modelChecked(modelId: string): boolean {
    return this.form().expectedModels.includes(modelId);
  }

  protected roleChecked(role: AuxiliaryLlmSlot): boolean {
    return this.form().routingRoles.includes(role);
  }

  protected safeOperationError(): string | null {
    return this.store.operationError()
      ? 'The Local AI Guard operation could not be completed. Try again.'
      : null;
  }

  private patchForm(patch: Partial<SetupForm>): void {
    this.form.update((current) => ({ ...current, ...patch }));
    this.invalidateValidation();
  }

  private invalidateValidation(): void {
    this.validationResults.set(null);
    this.lastValidationFingerprint = '';
  }

  private clearModelContextInputError(modelId: string): void {
    this.modelContextInputErrors.update((errors) => {
      if (!(modelId in errors)) return errors;
      const next = { ...errors };
      delete next[modelId];
      return next;
    });
  }

  private modelContextRangeError(): string {
    const { min, max } = this.limits.minContextLength;
    return `Minimum context length must be a whole number between ${min} and ${max}.`;
  }

  private buildConfig(): LocalAiTargetConfig {
    const endpoint = this.selectedEndpoint();
    if (!endpoint) throw new Error('No Local AI endpoint selected');
    const value = this.form();
    return {
      lifecycle: this.editingLifecycle(),
      ...endpoint.identity,
      expectedModels: value.expectedModels.map((modelId) =>
        value.expectedModelRules.find((rule) => rule.modelId === modelId)
        ?? { modelId, required: true }),
      canary: {
        model: value.canaryModel,
        timeoutMs: Math.round(value.canaryTimeoutSeconds * 1_000),
        intervalMs: Math.round(value.canaryIntervalMinutes * 60_000),
      },
      endpointCheckIntervalMs: Math.round(value.endpointIntervalSeconds * 1_000),
      freshnessLimitMs: Math.round(value.freshnessSeconds * 1_000),
      warningLatencyMs: Math.round(value.warningLatencyMs),
      routingRoles: value.routingRoles,
      fallbackPolicy: value.fallbackPolicy,
      slotFallbackPolicies: value.slotFallbackPolicies,
      ...(value.confirmAboveInputTokens === undefined
        ? {} : { confirmAboveInputTokens: value.confirmAboveInputTokens }),
      ...(value.dailyFallbackBudgetUsd === undefined
        ? {} : { dailyFallbackBudgetUsd: value.dailyFallbackBudgetUsd }),
      ...(value.incidentFallbackBudgetUsd === undefined
        ? {} : { incidentFallbackBudgetUsd: value.incidentFallbackBudgetUsd }),
      recovery: {
        automatic: value.automaticRepair,
        maxAttempts: Math.round(value.maxAttempts),
        cooldownMs: Math.round(value.cooldownMinutes * 60_000),
      },
    };
  }

  private buildPatch(): LocalAiTargetPatch {
    const {
      location: _location,
      provider: _provider,
      endpointId: _endpointId,
      ...patch
    } = this.buildConfig();
    return patch;
  }

  private configFingerprint(): string {
    try {
      return JSON.stringify(this.buildConfig());
    } catch {
      return '';
    }
  }

  private formFromTarget(target: LocalAiTarget): SetupForm {
    return {
      expectedModels: target.expectedModels.map((model) => model.modelId),
      expectedModelRules: target.expectedModels.map((model) => ({ ...model })),
      canaryModel: target.canary.model,
      endpointIntervalSeconds: target.endpointCheckIntervalMs / 1_000,
      canaryIntervalMinutes: target.canary.intervalMs / 60_000,
      canaryTimeoutSeconds: target.canary.timeoutMs / 1_000,
      freshnessSeconds: target.freshnessLimitMs / 1_000,
      warningLatencyMs: target.warningLatencyMs,
      routingRoles: [...target.routingRoles],
      fallbackPolicy: target.fallbackPolicy,
      slotFallbackPolicies: { ...target.slotFallbackPolicies },
      ...(target.confirmAboveInputTokens === undefined
        ? {} : { confirmAboveInputTokens: target.confirmAboveInputTokens }),
      ...(target.dailyFallbackBudgetUsd === undefined
        ? {} : { dailyFallbackBudgetUsd: target.dailyFallbackBudgetUsd }),
      ...(target.incidentFallbackBudgetUsd === undefined
        ? {} : { incidentFallbackBudgetUsd: target.incidentFallbackBudgetUsd }),
      automaticRepair: target.recovery.automatic,
      maxAttempts: target.recovery.maxAttempts,
      cooldownMinutes: target.recovery.cooldownMs / 60_000,
    };
  }

  private integerInRange(value: number, min: number, max: number): boolean {
    return Number.isSafeInteger(value) && value >= min && value <= max;
  }

  private numberInRange(value: number, min: number, max: number): boolean {
    return Number.isFinite(value) && value >= min && value <= max;
  }
}
