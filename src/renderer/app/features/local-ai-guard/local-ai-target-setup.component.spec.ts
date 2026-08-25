import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalAiDiscoveredEndpoint,
  LocalAiProbeResult,
  LocalAiTargetConfig,
  LocalAiTarget,
} from '../../../../shared/types/local-ai-guard.types';
import { LOCAL_AI_TARGET_NUMERIC_LIMITS } from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { LocalAiTargetSetupComponent } from './local-ai-target-setup.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './local-ai-target-setup.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './local-ai-target-setup.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('local-ai-target-setup.component.html')) return Promise.resolve(template);
  if (url.endsWith('local-ai-target-setup.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function endpoint(): LocalAiDiscoveredEndpoint {
  return {
    identity: {
      location: { type: 'worker', nodeId: 'worker-1' },
      provider: 'ollama',
      endpointId: 'ollama',
      baseUrl: 'http://192.168.1.20:11434',
    },
    label: 'Studio worker',
    models: ['qwen3:8b', 'qwen3:14b'],
    healthy: true,
  };
}

function validation(): LocalAiProbeResult[] {
  return [
    ['worker', true],
    ['endpoint', true],
    ['model', true],
    ['inference', true],
  ].map(([layer, ok], index) => ({
    targetId: 'validation',
    layer: layer as LocalAiProbeResult['layer'],
    checkType: layer === 'inference' ? 'functional' : 'lightweight',
    ok: ok as boolean,
    required: true,
    affectedRoles: ['compression'],
    checkedAt: 1_000 + index,
    durationMs: 10 + index,
    evidence: {},
  }));
}

describe('LocalAiTargetSetupComponent', () => {
  const store = {
    discoveries: vi.fn(() => [endpoint()]),
    operationKey: vi.fn(() => null),
    operationError: vi.fn(() => null),
    loadInventory: vi.fn(async () => undefined),
    validateTarget: vi.fn(async () => validation()),
    createTarget: vi.fn(async (_config: LocalAiTargetConfig) => undefined),
    updateTarget: vi.fn(async (
      _targetId: string,
      _patch: Partial<LocalAiTargetConfig>,
    ) => undefined),
    knownTarget: vi.fn((_targetId: string) => null as LocalAiTarget | null),
  };
  let fixture: ComponentFixture<LocalAiTargetSetupComponent>;

  beforeEach(async () => {
    vi.clearAllMocks();
    await TestBed.configureTestingModule({
      imports: [LocalAiTargetSetupComponent],
      providers: [{ provide: LocalAiGuardStore, useValue: store }],
    }).compileComponents();
    fixture = TestBed.createComponent(LocalAiTargetSetupComponent);
    fixture.detectChanges();
  });

  it('starts a new target with a ready-to-test recommended setup and explains the locked action', () => {
    click('Configure Studio worker');

    expect(fixture.nativeElement.textContent).toContain('Recommended setup');
    expect(fixture.nativeElement.textContent).toContain('Review setup');
    expect(fixture.nativeElement.textContent).toContain('Test endpoint');
    expect(fixture.nativeElement.textContent).toContain('Enrol and monitor');
    expect(selectInput('Canary model').value).toBe('qwen3:8b');
    expect(numberInput('Canary timeout (seconds)').value).toBe('120');
    expect(numberInput('Latency warning (milliseconds)').value).toBe('60000');
    for (const role of [
      'Compression',
      'Memory distillation',
      'Web extraction',
      'Title generation',
      'Routing classification',
      'Approval scoring',
      'Approval adjudication',
      'Loop scoring',
      'Retrieval hypothesis',
      'Branch scoring',
      'Sub-query execution',
      'Output verification',
    ]) {
      expect(checkboxInput(role).checked).toBe(true);
    }
    expect((fixture.nativeElement.querySelector('details.advanced-settings') as HTMLDetailsElement).open)
      .toBe(false);
    expect(button('Test endpoint').disabled).toBe(false);
    expect(button('Enrol target').disabled).toBe(true);
    expect(fixture.nativeElement.textContent).toContain(
      'Test the endpoint to unlock enrolment.',
    );
  });

  it('keeps discovery read-only until validation and enrolment are explicitly submitted', async () => {
    expect(fixture.nativeElement.textContent).toContain('Unmanaged');
    expect(store.createTarget).not.toHaveBeenCalled();

    click('Configure Studio worker');
    setCheckbox('Expected model qwen3:8b', true);
    selectValue('Canary model', 'qwen3:8b');
    setCheckbox('Compression', true);
    click('Test endpoint');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(store.validateTarget).toHaveBeenCalledOnce();
    for (const label of ['Worker', 'Endpoint', 'Model', 'Canary']) {
      expect(fixture.nativeElement.querySelector(`[data-validation-layer="${label.toLowerCase()}"]`))
        .not.toBeNull();
    }
    expect(button('Enrol target').disabled).toBe(false);

    click('Enrol target');
    await fixture.whenStable();
    expect(store.createTarget).toHaveBeenCalledOnce();
    const config = store.createTarget.mock.calls[0]?.[0] as LocalAiTargetConfig;
    expect(config.expectedModels).toEqual([{ modelId: 'qwen3:8b', required: true }]);
    expect(config.canary.model).toBe('qwen3:8b');
    expect(config.routingRoles).toHaveLength(12);
  });

  it('validates an unchanged configuration once and invalidates validation after edits', async () => {
    click('Configure Studio worker');
    setCheckbox('Expected model qwen3:8b', true);
    selectValue('Canary model', 'qwen3:8b');
    setCheckbox('Compression', true);

    click('Test endpoint');
    await fixture.whenStable();
    fixture.detectChanges();
    click('Test endpoint');
    await fixture.whenStable();
    expect(store.validateTarget).toHaveBeenCalledOnce();

    setCheckbox('Expected model qwen3:14b', true);
    selectValue('Canary model', 'qwen3:14b');
    fixture.detectChanges();
    expect(button('Enrol target').disabled).toBe(true);
    click('Test endpoint');
    await fixture.whenStable();
    expect(store.validateTarget).toHaveBeenCalledTimes(2);
  });

  it('enforces safe cadence bounds and guards automatic repair behind explicit opt-in', () => {
    click('Configure Studio worker');
    setNumber('Endpoint check interval (seconds)', 5);
    setNumber('Canary interval (minutes)', 120);
    setCheckbox('Automatic repair', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Endpoint checks must be between 30 seconds and 15 minutes.',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Canary checks must be between 2 and 60 minutes.',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Automatic repair may restart only a named, supported local service.',
    );
    expect(button('Test endpoint').disabled).toBe(true);
    expect(numberInput('Endpoint check interval (seconds)')).toMatchObject({
      min: '30',
      max: '900',
    });
    expect(numberInput('Maximum automatic repair attempts')).toMatchObject({
      min: '1',
      max: '5',
    });
  });

  it('enforces shared minimum-context boundaries in component state despite native validation bypass', async () => {
    click('Configure Studio worker');
    setCheckbox('Expected model qwen3:8b', true);
    selectValue('Canary model', 'qwen3:8b');
    setCheckbox('Compression', true);
    const context = numberInput('qwen3:8b minimum context length');
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;

    expect(form.noValidate).toBe(true);
    expect(context.min).toBe(String(LOCAL_AI_TARGET_NUMERIC_LIMITS.minContextLength.min));
    expect(context.max).toBe(String(LOCAL_AI_TARGET_NUMERIC_LIMITS.minContextLength.max));

    setNumber('qwen3:8b minimum context length', 100_000_001);
    expect(context.getAttribute('aria-invalid')).toBe('true');
    expect(fixture.nativeElement.textContent).toContain(
      'Minimum context length must be a whole number between 1 and 100000000.',
    );
    expect(button('Test endpoint').disabled).toBe(true);
    expect(button('Enrol target').disabled).toBe(true);
    form.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(store.validateTarget).not.toHaveBeenCalled();

    for (const value of [1, 100_000_000]) {
      setNumber('qwen3:8b minimum context length', value);
      expect(context.getAttribute('aria-invalid')).toBeNull();
      expect(button('Test endpoint').disabled).toBe(false);
    }

    for (const value of [0, 1.5]) {
      setNumber('qwen3:8b minimum context length', value);
      expect(context.getAttribute('aria-invalid')).toBe('true');
      expect(button('Test endpoint').disabled).toBe(true);
    }

    updateModelContextWithRawValue('qwen3:8b', 'NaN');
    expect(context.getAttribute('aria-invalid')).toBe('true');
    expect(button('Test endpoint').disabled).toBe(true);
  });

  it('blocks enrolment when validation reports insufficient required model context', async () => {
    store.validateTarget.mockResolvedValueOnce(validation().map((result) =>
      result.layer === 'model'
        ? {
            ...result,
            ok: false,
            required: true,
            failureCode: 'insufficient-context',
            evidence: {
              loadedModels: ['qwen3:8b'],
              availableContextLength: 4_096,
              insufficientContextModels: ['qwen3:8b'],
            },
          }
        : result));
    click('Configure Studio worker');
    setCheckbox('Expected model qwen3:8b', true);
    selectValue('Canary model', 'qwen3:8b');
    setCheckbox('Compression', true);

    click('Test endpoint');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-validation-layer="model"]')?.textContent)
      .toContain('Needs attention');
    expect(fixture.nativeElement.querySelector('.enrolment-steps li:nth-child(2)')
      ?.getAttribute('data-state')).toBe('failed');
    expect(button('Enrol target').disabled).toBe(true);
    expect(store.createTarget).not.toHaveBeenCalled();
  });

  it('persists role ownership for an optional expected model', async () => {
    click('Configure Studio worker');
    for (const role of [
      'Memory distillation',
      'Web extraction',
      'Routing classification',
      'Approval scoring',
      'Approval adjudication',
      'Loop scoring',
      'Retrieval hypothesis',
      'Branch scoring',
      'Sub-query execution',
      'Output verification',
    ]) {
      setCheckbox(role, false);
    }
    setCheckbox('Expected model qwen3:14b', true);
    selectValue('Canary model', 'qwen3:8b');
    setCheckbox('Compression', true);
    setCheckbox('Title generation', true);
    setCheckbox('qwen3:14b required', false);
    setCheckbox('qwen3:14b uses Compression', false);

    click('Test endpoint');
    await fixture.whenStable();
    fixture.detectChanges();
    click('Enrol target');
    await fixture.whenStable();

    const config = store.createTarget.mock.calls[0]?.[0] as LocalAiTargetConfig;
    expect(config.expectedModels).toContainEqual({
      modelId: 'qwen3:14b',
      required: false,
      routingRoles: ['titleGeneration'],
    });
  });

  it('uses the existing typed update path when editing instead of creating a duplicate target', async () => {
    fixture.componentRef.setInput('editingTargetId', 'target-1');
    fixture.componentRef.setInput('editingEndpoint', {
      ...endpoint(),
      enrolledTargetId: 'target-1',
    });
    fixture.detectChanges();
    setCheckbox('Expected model qwen3:8b', true);
    selectValue('Canary model', 'qwen3:8b');
    setCheckbox('Compression', true);
    click('Test changes');
    await fixture.whenStable();
    fixture.detectChanges();
    click('Save changes');
    await fixture.whenStable();

    expect(store.updateTarget).toHaveBeenCalledOnce();
    expect(store.updateTarget.mock.calls[0]?.[0]).toBe('target-1');
    expect(store.createTarget).not.toHaveBeenCalled();
  });

  it('hydrates every persisted editable value and preserves it in an unchanged edit', async () => {
    const persisted: LocalAiTarget = {
      lifecycle: 'paused',
      ...endpoint().identity,
      expectedModels: [
        { modelId: 'qwen3:8b', required: false, minContextLength: 16_384 },
        { modelId: 'qwen3:14b', required: true },
      ],
      canary: { model: 'qwen3:14b', timeoutMs: 45_000, intervalMs: 900_000 },
      endpointCheckIntervalMs: 90_000,
      freshnessLimitMs: 180_000,
      warningLatencyMs: 3_200,
      routingRoles: ['compression', 'titleGeneration'],
      fallbackPolicy: 'require-confirmation',
      slotFallbackPolicies: { compression: 'defer-locally' },
      confirmAboveInputTokens: 8_000,
      dailyFallbackBudgetUsd: 1.25,
      incidentFallbackBudgetUsd: 0.4,
      recovery: { automatic: true, maxAttempts: 4, cooldownMs: 720_000 },
      id: 'target-1',
      label: 'Studio worker',
      createdAt: 100,
      updatedAt: 200,
      pausedUntil: 50_000,
    };
    fixture.componentRef.setInput('editingTargetId', 'target-1');
    fixture.componentRef.setInput('editingEndpoint', {
      ...endpoint(),
      enrolledTargetId: 'target-1',
    });
    fixture.componentRef.setInput('editingTarget', persisted);
    fixture.componentRef.setInput('editingLifecycle', 'paused');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Ask before paid fallback · Automatic repair on',
    );

    click('Test changes');
    await fixture.whenStable();
    fixture.detectChanges();
    click('Save changes');
    await fixture.whenStable();

    expect(store.updateTarget).toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({
        expectedModels: persisted.expectedModels,
        canary: persisted.canary,
        endpointCheckIntervalMs: 90_000,
        freshnessLimitMs: 180_000,
        warningLatencyMs: 3_200,
        routingRoles: persisted.routingRoles,
        fallbackPolicy: 'require-confirmation',
        slotFallbackPolicies: persisted.slotFallbackPolicies,
        confirmAboveInputTokens: 8_000,
        dailyFallbackBudgetUsd: 1.25,
        incidentFallbackBudgetUsd: 0.4,
        recovery: persisted.recovery,
      }),
    );
  });

  it('shows a legacy out-of-policy model context without silently replacing or validating it', () => {
    const persisted: LocalAiTarget = {
      lifecycle: 'enrolled',
      ...endpoint().identity,
      expectedModels: [
        { modelId: 'qwen3:8b', required: true, minContextLength: 100_000_001 },
      ],
      canary: { model: 'qwen3:8b', timeoutMs: 30_000, intervalMs: 600_000 },
      endpointCheckIntervalMs: 60_000,
      freshnessLimitMs: 120_000,
      warningLatencyMs: 2_000,
      routingRoles: ['compression'],
      fallbackPolicy: 'notify-and-allow',
      slotFallbackPolicies: {},
      recovery: { automatic: false, maxAttempts: 2, cooldownMs: 60_000 },
      id: 'target-legacy',
      label: 'Studio worker',
      createdAt: 100,
      updatedAt: 200,
    };
    fixture.componentRef.setInput('editingTargetId', persisted.id);
    fixture.componentRef.setInput('editingEndpoint', {
      ...endpoint(),
      enrolledTargetId: persisted.id,
    });
    fixture.componentRef.setInput('editingTarget', persisted);
    fixture.detectChanges();

    const context = numberInput('qwen3:8b minimum context length');
    expect(context.value).toBe('100000001');
    expect(context.getAttribute('aria-invalid')).toBe('true');
    expect(fixture.nativeElement.textContent).toContain(
      'Minimum context length must be a whole number between 1 and 100000000.',
    );
    expect(button('Test changes').disabled).toBe(true);
    expect(button('Save changes').disabled).toBe(true);
    expect(store.validateTarget).not.toHaveBeenCalled();
    expect(store.updateTarget).not.toHaveBeenCalled();
  });

  function buttons(): HTMLButtonElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );
  }

  function button(label: string): HTMLButtonElement {
    const match = buttons().find((candidate) => candidate.textContent?.trim() === label);
    if (!match) throw new Error(`Missing button: ${label}`);
    return match;
  }

  function click(label: string): void {
    button(label).click();
    fixture.detectChanges();
  }

  function setCheckbox(label: string, checked: boolean): void {
    const input = checkboxInput(label);
    input.checked = checked;
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  function selectValue(label: string, value: string): void {
    const select = selectInput(label);
    select.value = value;
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  function setNumber(label: string, value: number): void {
    const input = numberInput(label);
    input.value = String(value);
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function updateModelContextWithRawValue(modelId: string, value: string): void {
    const component = fixture.componentInstance as unknown as {
      updateModelContext: (candidate: string, event: Event) => void;
    };
    component.updateModelContext(modelId, {
      target: { value },
    } as unknown as Event);
    fixture.detectChanges();
  }

  function numberInput(label: string): HTMLInputElement {
    return fixture.nativeElement.querySelector(
      `input[aria-label="${label}"]`,
    ) as HTMLInputElement;
  }

  function checkboxInput(label: string): HTMLInputElement {
    return fixture.nativeElement.querySelector(
      `input[aria-label="${label}"]`,
    ) as HTMLInputElement;
  }

  function selectInput(label: string): HTMLSelectElement {
    return fixture.nativeElement.querySelector(
      `select[aria-label="${label}"]`,
    ) as HTMLSelectElement;
  }
});
