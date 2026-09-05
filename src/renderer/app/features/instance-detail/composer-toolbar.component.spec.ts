/**
 * ComposerToolbarComponent spec
 *
 * Tests:
 *   1. Ring percentage is computed correctly from contextUsage (used/total).
 *   2. Ring percentage caps at 100 when used > total.
 *   3. Ring shows 0% when no contextUsage is provided.
 *   4. ringDash encodes the correct arc lengths.
 *   5. ringTitle reflects token counts.
 *   6. onPickerSelectionChange calls ipc.changeModel with the selected model
 *      (reasoning omitted → backend preserves current effort).
 *   7. onPickerSelectionChange passes the picked reasoning level when set.
 *   8. onPickerSelectionChange is a no-op when model is null.
 */

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ComposerToolbarComponent,
  deriveComposerPickerSelection,
  shouldHydrateComposerPickerSelection,
} from './composer-toolbar.component';
import { InstanceIpcService } from '../../core/services/ipc';
import { InstanceStore } from '../../core/state/instance.store';
import { ToastService } from '../../core/services/toast.service';
import type { ContextUsage } from '../../core/state/instance/instance.types';
import type {
  InstanceRuntimeSummary,
  ModelRuntimeTarget,
} from '../../../../shared/types/local-model-runtime.types';

// Stub out OrchestrationIpcService — we only care about changeModel.
const ipcStub = {
  changeModel: vi.fn().mockResolvedValue({ success: true }),
};

const toastStub = {
  show: vi.fn(),
};

// Override signal-input getters (vitest does not run the Angular compiler).
function overrideInputs(
  c: ComposerToolbarComponent,
  overrides: {
    instanceId?: string;
    contextUsage?: ContextUsage;
    provider?: string;
    currentModel?: string;
  },
): void {
  const w = c as unknown as Record<string, unknown>;
  if ('instanceId' in overrides) w['instanceId'] = () => overrides.instanceId;
  if ('contextUsage' in overrides) w['contextUsage'] = () => overrides.contextUsage;
  if ('provider' in overrides) w['provider'] = () => overrides.provider;
  if ('currentModel' in overrides) w['currentModel'] = () => overrides.currentModel;
}

/**
 * A usage the provider actually reported. `occupancyReported` is what separates
 * a measurement from the placeholder every instance is seeded with (LT-018) —
 * these tests are all about real numbers, so it belongs here.
 */
function makeUsage(used: number, total: number): ContextUsage {
  return {
    used,
    total,
    percentage: total > 0 ? (used / total) * 100 : 0,
    occupancyReported: true,
  };
}

/** The seeded placeholder: numbers present, but nothing has reported yet. */
function makeUnreportedUsage(total = 200_000): ContextUsage {
  return { used: 0, total, percentage: 0 };
}

/**
 * LT-034: a provider that reports only cumulative turn spend (Copilot/ACP,
 * Gemini, non-resident Claude, Codex exec). The numbers are real; they are just
 * not context-window occupancy.
 */
function makeAggregateUsage(spend: number, total = 200_000): ContextUsage {
  return {
    used: spend,
    total,
    percentage: Math.min((spend / total) * 100, 100),
    occupancyReported: true,
    occupancyIsAggregate: true,
    cumulativeTokens: spend,
  };
}

describe('ComposerToolbarComponent', () => {
  let component: ComposerToolbarComponent;

  beforeEach(async () => {
    ipcStub.changeModel.mockClear();
    ipcStub.changeModel.mockResolvedValue({ success: true });
    toastStub.show.mockClear();

    await TestBed.configureTestingModule({
      imports: [ComposerToolbarComponent],
      providers: [
        { provide: InstanceStore, useValue: {} },
        { provide: InstanceIpcService, useValue: ipcStub },
        { provide: ToastService, useValue: toastStub },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(ComposerToolbarComponent);
    component = fixture.componentInstance;

    // Provide minimal required inputs before ngOnInit runs.
    overrideInputs(component, {
      instanceId: 'inst-1',
      provider: 'claude',
      currentModel: 'claude-opus-4-5',
    });
  });

  // ── 1. Ring percentage from contextUsage ──────────────────────────────────

  it('computes ringPct as (used / total) * 100', () => {
    overrideInputs(component, { contextUsage: makeUsage(50_000, 200_000) });
    expect(component.ringPct()).toBeCloseTo(25, 1);
  });

  it('computes ringPct as 75% when used = 3/4 of total', () => {
    overrideInputs(component, { contextUsage: makeUsage(150_000, 200_000) });
    expect(component.ringPct()).toBeCloseTo(75, 1);
  });

  // ── 2. Ring caps at 100% ──────────────────────────────────────────────────

  it('caps ringPct at 100 when used exceeds total', () => {
    overrideInputs(component, { contextUsage: makeUsage(250_000, 200_000) });
    expect(component.ringPct()).toBe(100);
  });

  // ── 3. Ring shows 0% when contextUsage is absent ─────────────────────────

  it('returns 0 for ringPct when contextUsage is undefined', () => {
    overrideInputs(component, { contextUsage: undefined });
    expect(component.ringPct()).toBe(0);
  });

  it('returns 0 for ringPct when total is 0', () => {
    overrideInputs(component, { contextUsage: makeUsage(0, 0) });
    expect(component.ringPct()).toBe(0);
  });

  // ── 3b. Unreported occupancy is unknown, not zero (LT-018) ───────────────

  /**
   * Copilot (ACP) reports no usage at all, so its bar sat at a confident 0 %
   * for the whole session — indistinguishable from an empty context. The
   * numbers are seeded, so the only way to tell is this flag.
   */
  it('shows no-data rather than 0% when the provider has not reported occupancy', () => {
    overrideInputs(component, { contextUsage: makeUnreportedUsage() });
    expect(component.ringPct()).toBe(0);
    expect(component.ringTitle()).toBe('Context window: no data');
  });

  it('shows a real percentage once the provider reports', () => {
    overrideInputs(component, { contextUsage: makeUsage(50_000, 200_000) });
    expect(component.ringTitle()).toContain('25% used');
    expect(component.ringTitle()).not.toContain('no data');
  });

  /**
   * The tooltip alone does not fix LT-018. The ring's *visible* label is the one
   * number the user actually reads, and it renders off `ringPct()`, which
   * returns 0 for an unknown occupancy — indistinguishable from a genuine 0 %.
   * `occupancyKnown()` is what the template must gate that label on.
   */
  it('does not claim a numeric percentage on the visible ring label when occupancy is unknown', () => {
    overrideInputs(component, { contextUsage: makeUnreportedUsage() });
    expect(component.occupancyKnown()).toBe(false);
  });

  it('does claim the visible percentage once the provider has reported', () => {
    overrideInputs(component, { contextUsage: makeUsage(50_000, 200_000) });
    expect(component.occupancyKnown()).toBe(true);
  });

  it('treats a zero-width context window as unknown, not as 0%', () => {
    overrideInputs(component, { contextUsage: makeUsage(0, 0) });
    expect(component.occupancyKnown()).toBe(false);
    expect(component.ringPct()).toBe(0);
  });

  // ── 4. ringDash encodes correct arc lengths ───────────────────────────────

  it('encodes full ring when pct is 100', () => {
    overrideInputs(component, { contextUsage: makeUsage(200_000, 200_000) });
    const CIRCUMFERENCE = 2 * Math.PI * 8;
    const [used, gap] = component.ringDash().split(' ').map(Number);
    expect(used).toBeCloseTo(CIRCUMFERENCE, 1);
    expect(gap).toBeCloseTo(0, 1);
  });

  it('encodes zero ring when pct is 0', () => {
    overrideInputs(component, { contextUsage: undefined });
    const [used, gap] = component.ringDash().split(' ').map(Number);
    expect(used).toBeCloseTo(0, 1);
    expect(gap).toBeCloseTo(2 * Math.PI * 8, 1);
  });

  // ── 5. ringTitle includes token counts ───────────────────────────────────

  it('includes used/total token counts in ringTitle', () => {
    overrideInputs(component, { contextUsage: makeUsage(100_000, 200_000) });
    const title = component.ringTitle();
    expect(title).toContain('50%');
    expect(title).toContain('100,000');
    expect(title).toContain('200,000');
  });

  it('shows no-data message when contextUsage is absent', () => {
    overrideInputs(component, { contextUsage: undefined });
    expect(component.ringTitle()).toBe('Context window: no data');
  });

  // ── 6. onPickerSelectionChange calls ipc.changeModel ─────────────────────

  it('calls changeModel with the selected model, its provider, and no forced effort', async () => {
    await component.onPickerSelectionChange({
      provider: 'claude',
      model: 'claude-3-5-sonnet',
      reasoning: null,
    });

    // reasoning omitted (undefined) so the backend preserves current effort
    // rather than the old `medium` downgrade. The provider travels with every
    // request so cross-provider picks actually swap the session's CLI.
    expect(ipcStub.changeModel).toHaveBeenCalledWith(
      'inst-1',
      'claude-3-5-sonnet',
      undefined,
      undefined,
      'claude',
    );
  });

  it('passes the target provider for a cross-provider pick', async () => {
    await component.onPickerSelectionChange({
      provider: 'codex',
      model: 'gpt-5.5',
      reasoning: null,
    });

    expect(ipcStub.changeModel).toHaveBeenCalledWith(
      'inst-1',
      'gpt-5.5',
      undefined,
      undefined,
      'codex',
    );
  });

  // ── 7. onPickerSelectionChange passes picked reasoning level ─────────────

  it('calls changeModel with reasoning effort from the selection when provided', async () => {
    await component.onPickerSelectionChange({
      provider: 'claude',
      model: 'claude-3-7-sonnet',
      reasoning: 'high',
    });

    expect(ipcStub.changeModel).toHaveBeenCalledWith(
      'inst-1',
      'claude-3-7-sonnet',
      'high',
      undefined,
      'claude',
    );
  });

  // ── 8. Null model still sends when a provider is picked (backend falls
  //       back to the remembered per-provider default) ─────────────────────

  it('sends a provider-only request when the model is null', async () => {
    await component.onPickerSelectionChange({ provider: 'codex', model: null, reasoning: null });

    expect(ipcStub.changeModel).toHaveBeenCalledWith(
      'inst-1',
      undefined,
      undefined,
      undefined,
      'codex',
    );
  });

  it('ignores an incomplete local-model pick (no runtime target)', async () => {
    await component.onPickerSelectionChange({ provider: 'local-model', model: null, reasoning: null });

    expect(ipcStub.changeModel).not.toHaveBeenCalled();
  });

  it('passes a local-model runtime target through changeModel', async () => {
    const modelRuntimeTarget: ModelRuntimeTarget = {
      kind: 'local-model',
      source: 'worker-node',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen',
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
    };

    await component.onPickerSelectionChange({
      provider: 'local-model',
      model: modelRuntimeTarget.selectorId,
      reasoning: null,
      modelRuntimeTarget,
    });

    expect(ipcStub.changeModel).toHaveBeenCalledWith(
      'inst-1',
      'qwen',
      undefined,
      modelRuntimeTarget,
    );
  });

  // ── 9. Picker gating — busy states queue on the backend, so only terminal
  //       states disable the picker ─────────────────────────────────────────

  it('allows the picker when the instance is waiting for user input', () => {
    overrideInputs(component, {});
    (component as unknown as Record<string, unknown>)['instanceStatus'] = () => 'waiting_for_input';
    expect(component.modelSwitchDisabledReason()).toBeUndefined();
  });

  it('keeps the picker enabled while the instance is processing (change is queued)', () => {
    overrideInputs(component, {});
    (component as unknown as Record<string, unknown>)['instanceStatus'] = () => 'processing';
    expect(component.modelSwitchDisabledReason()).toBeUndefined();
  });

  it('disables the picker for terminal states', () => {
    overrideInputs(component, {});
    (component as unknown as Record<string, unknown>)['instanceStatus'] = () => 'terminated';
    expect(component.modelSwitchDisabledReason()).toContain('live session');
  });

  it('labels a queued change and cancels it via the live config', async () => {
    const w = component as unknown as Record<string, unknown>;
    w['desiredRuntime'] = () => ({ provider: 'codex', model: 'gpt-5.5' });
    expect(component.desiredRuntimeLabel()).toBe('Codex · gpt-5.5');

    await component.cancelPendingChange();
    expect(ipcStub.changeModel).toHaveBeenCalledWith(
      'inst-1',
      'claude-opus-4-5',
      undefined,
      undefined,
      'claude',
    );
  });

  it('exposes Local Models in the live picker for runtime-target switching', () => {
    expect(component.pickerProviders).toContain('local-model');
  });

  // ── 10. A rejected swap must not leave the picker lying about the runtime ──

  it('rolls the picker back to the live runtime and toasts when the change is rejected', async () => {
    // Regression: this component talks to IPC directly and used to discard the
    // response, while the re-seed effect deliberately refuses to clobber an
    // in-flight pick. A rejected swap therefore left the picker reading
    // "Codex · gpt-5.5" on a session still running Claude, with no error shown.
    ipcStub.changeModel.mockResolvedValueOnce({
      success: false,
      error: { message: 'Cannot switch provider: the Codex CLI is not installed.' },
    });

    await component.onPickerSelectionChange({ provider: 'codex', model: 'gpt-5.5', reasoning: null });

    expect(component.pickerSelection()).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-5',
      reasoning: null,
    });
    expect(toastStub.show).toHaveBeenCalledWith(
      'Cannot switch provider: the Codex CLI is not installed.',
      'error',
    );
  });

  it('keeps the picked selection when the backend accepts (or queues) the change', async () => {
    await component.onPickerSelectionChange({ provider: 'codex', model: 'gpt-5.5', reasoning: null });

    expect(component.pickerSelection()).toEqual({
      provider: 'codex',
      model: 'gpt-5.5',
      reasoning: null,
    });
    expect(toastStub.show).not.toHaveBeenCalled();
  });
});

// Regression for the cross-instance leak: the live composer is a single reused
// node whose instance inputs swap when switching sessions. Seeding the picker
// once (the old ngOnInit) leaked the previous instance's selection — e.g. a
// Cursor pick surfacing as "Cursor · Auto" on a Claude session. The component
// now re-seeds via an effect keyed on instanceId(); that effect delegates to
// `deriveComposerPickerSelection`, which is unit-tested here directly (the
// vitest setup runs without the Angular compiler, so effect/CD flushing isn't
// available — see overrideInputs above).
describe('deriveComposerPickerSelection', () => {
  const localRuntimeSummary: InstanceRuntimeSummary = {
    kind: 'local-model',
    label: 'qwen on windows-pc',
    nodeId: 'node-win',
    nodeName: 'windows-pc',
    source: 'worker-node',
    endpointProvider: 'ollama',
    endpointId: 'ollama',
    modelId: 'qwen',
    selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
  };

  it('derives the picker selection from a Cursor instance', () => {
    expect(deriveComposerPickerSelection('cursor', 'composer-2.5')).toEqual({
      provider: 'cursor',
      model: 'composer-2.5',
      reasoning: null,
    });
  });

  it('derives a different selection for a Claude instance (no leak from a prior call)', () => {
    expect(deriveComposerPickerSelection('claude', 'opus')).toEqual({
      provider: 'claude',
      model: 'opus',
      reasoning: null,
    });
  });

  it('maps ollama to the claude picker tab', () => {
    expect(deriveComposerPickerSelection('ollama', 'llama3').provider).toBe('claude');
  });

  it('uses null model when the instance has no model yet', () => {
    expect(deriveComposerPickerSelection('cursor', undefined).model).toBeNull();
  });

  it('defaults reasoning to null when not provided (provider default)', () => {
    expect(deriveComposerPickerSelection('claude', 'opus').reasoning).toBeNull();
  });

  it('carries the instance reasoning effort through so the picker reflects it', () => {
    // Regression: the live composer is the only reasoning UI for an instance.
    // Hardcoding reasoning:null here made the picker always show the provider
    // default (Claude "High"), masking a real Max/Extra and snapping a just-
    // applied pick back to the default.
    expect(deriveComposerPickerSelection('claude', 'opus', 'max')).toEqual({
      provider: 'claude',
      model: 'opus',
      reasoning: 'max',
    });
    expect(deriveComposerPickerSelection('claude', 'opus', 'xhigh').reasoning).toBe('xhigh');
  });

  it('maps local-model runtime summaries to the local-model picker tab', () => {
    expect(
      deriveComposerPickerSelection('claude', 'opus', 'max', localRuntimeSummary),
    ).toEqual({
      provider: 'local-model',
      model: 'lm://worker-node/node-win/ollama/ollama/qwen',
      reasoning: null,
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        nodeId: 'node-win',
        nodeName: 'windows-pc',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
        selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
      },
    });
  });
});

describe('shouldHydrateComposerPickerSelection', () => {
  const cursorComposer = deriveComposerPickerSelection('cursor', 'composer-2.5');
  const cursorAuto = deriveComposerPickerSelection('cursor', 'auto');
  const cursorUnknown = deriveComposerPickerSelection('cursor', undefined);

  it('hydrates when the picker still has a null model placeholder', () => {
    expect(
      shouldHydrateComposerPickerSelection(
        { provider: 'cursor', model: null, reasoning: null },
        cursorComposer,
      ),
    ).toBe(true);
  });

  it('hydrates when the picker still shows the auto sentinel', () => {
    expect(
      shouldHydrateComposerPickerSelection(
        { provider: 'cursor', model: 'auto', reasoning: null },
        cursorComposer,
      ),
    ).toBe(true);
  });

  it('does not hydrate when the user already picked a concrete model', () => {
    expect(
      shouldHydrateComposerPickerSelection(
        { provider: 'cursor', model: 'gpt-5.3-codex', reasoning: null },
        cursorComposer,
      ),
    ).toBe(false);
  });

  it('does not hydrate when derived model is still auto or unknown', () => {
    expect(
      shouldHydrateComposerPickerSelection(
        { provider: 'cursor', model: null, reasoning: null },
        cursorAuto,
      ),
    ).toBe(false);
    expect(
      shouldHydrateComposerPickerSelection(
        { provider: 'cursor', model: null, reasoning: null },
        cursorUnknown,
      ),
    ).toBe(false);
  });
});

/**
 * LT-018 — asserted against the **rendered DOM**, deliberately.
 *
 * The computed-only tests above are not sufficient on their own: a completion
 * review proved they still pass if the template is reverted to an
 * unconditional `{{ ringPct() | number:'1.0-0' }}%`. `ringPct()` returns 0 for
 * an unknown occupancy, so the one number the user actually reads would show a
 * confident "0%" while every assertion stayed green. The label markup is the
 * thing under test here, so it has to be rendered.
 */
describe('ComposerToolbarComponent context ring label (rendered)', () => {
  async function renderWith(contextUsage: ContextUsage): Promise<string> {
    await TestBed.configureTestingModule({
      imports: [ComposerToolbarComponent],
      providers: [
        { provide: InstanceStore, useValue: {} },
        { provide: InstanceIpcService, useValue: ipcStub },
        { provide: ToastService, useValue: toastStub },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(ComposerToolbarComponent);
    fixture.componentRef.setInput('instanceId', 'inst-dom');
    fixture.componentRef.setInput('provider', 'claude');
    fixture.componentRef.setInput('currentModel', 'claude-opus-4-5');
    fixture.componentRef.setInput('contextUsage', contextUsage);
    fixture.detectChanges();

    const label = fixture.nativeElement.querySelector('.ctx-ring__label') as HTMLElement | null;
    return label?.textContent?.trim() ?? '';
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders an en dash, not "0%", when the provider has not reported occupancy', async () => {
    expect(await renderWith(makeUnreportedUsage())).toBe('–');
  });

  it('renders the real percentage once the provider reports', async () => {
    expect(await renderWith(makeUsage(50_000, 200_000))).toBe('25%');
  });

  // ── LT-034: aggregate spend is not occupancy ──────────────────────────────

  it('renders an en dash, not a percentage, for an aggregate-only provider', async () => {
    // The live defect: three one-word Copilot turns rendered "52% used".
    expect(await renderWith(makeAggregateUsage(103_222))).toBe('–');
  });

  it('does not let a large aggregate pin the ring at 100%', async () => {
    expect(await renderWith(makeAggregateUsage(400_000))).toBe('–');
  });
});

describe('ComposerToolbarComponent aggregate occupancy (LT-034)', () => {
  let component: ComposerToolbarComponent;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ComposerToolbarComponent],
      providers: [
        { provide: InstanceStore, useValue: {} },
        { provide: InstanceIpcService, useValue: ipcStub },
        { provide: ToastService, useValue: toastStub },
      ],
    }).compileComponents();
    component = TestBed.createComponent(ComposerToolbarComponent).componentInstance;
    overrideInputs(component, {
      instanceId: 'inst-agg',
      provider: 'claude',
      currentModel: 'claude-opus-4-5',
    });
  });

  it('reports occupancy as unknown even though the provider reported a number', () => {
    overrideInputs(component, { contextUsage: makeAggregateUsage(103_222) });
    expect(component.occupancyKnown()).toBe(false);
    expect(component.ringPct()).toBe(0);
  });

  it('names the number as session spend instead of a context-window percentage', () => {
    overrideInputs(component, { contextUsage: makeAggregateUsage(103_222) });
    const title = component.ringTitle();
    expect(title).toContain('Tokens used this session: 103,222');
    expect(title).toContain('does not report context-window occupancy');
    expect(title).not.toContain('% used');
  });

  it('prefers cumulativeTokens over used when both are present', () => {
    overrideInputs(component, {
      contextUsage: { ...makeAggregateUsage(50_000), cumulativeTokens: 77_777 },
    });
    expect(component.ringTitle()).toContain('77,777');
  });

  it('still says "no data" for an aggregate provider that has reported nothing yet', () => {
    overrideInputs(component, {
      contextUsage: { used: 0, total: 200_000, percentage: 0, occupancyIsAggregate: true },
    });
    expect(component.ringTitle()).toBe('Context window: no data');
  });

  it('leaves a genuine occupancy provider untouched', () => {
    overrideInputs(component, { contextUsage: makeUsage(50_000, 200_000) });
    expect(component.occupancyKnown()).toBe(true);
    expect(component.ringPct()).toBe(25);
    expect(component.ringTitle()).toContain('25% used');
  });
});
