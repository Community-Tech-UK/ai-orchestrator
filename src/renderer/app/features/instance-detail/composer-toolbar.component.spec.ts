/**
 * ComposerToolbarComponent spec
 *
 * Tests:
 *   1. Ring percentage is computed correctly from contextUsage (used/total).
 *   2. Ring percentage caps at 100 when used > total.
 *   3. Ring shows 0% when no contextUsage is provided.
 *   4. ringDash encodes the correct arc lengths.
 *   5. ringTitle reflects token counts.
 *   6. selectedEffort defaults to 'medium' and updates on click.
 *   7. effortChange output fires when effort is clicked.
 *   8. onEffortClick calls ipc.changeModel with the correct reasoning effort.
 *   9. onPickerSelectionChange calls ipc.changeModel with the selected model.
 *  10. onPickerSelectionChange is a no-op when model is null.
 */

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerToolbarComponent } from './composer-toolbar.component';
import { InstanceIpcService } from '../../core/services/ipc';
import type { ContextUsage } from '../../core/state/instance/instance.types';

// Stub out OrchestrationIpcService — we only care about changeModel.
const ipcStub = {
  changeModel: vi.fn().mockResolvedValue({ success: true }),
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

function makeUsage(used: number, total: number): ContextUsage {
  return { used, total, percentage: total > 0 ? (used / total) * 100 : 0 };
}

describe('ComposerToolbarComponent', () => {
  let component: ComposerToolbarComponent;

  beforeEach(async () => {
    ipcStub.changeModel.mockClear();

    await TestBed.configureTestingModule({
      imports: [ComposerToolbarComponent],
      providers: [
        { provide: InstanceIpcService, useValue: ipcStub },
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

  // ── 6. selectedEffort defaults + updates ─────────────────────────────────

  it('defaults selectedEffort to medium', () => {
    expect(component.selectedEffort()).toBe('medium');
  });

  it('updates selectedEffort when onEffortClick is called', async () => {
    await component.onEffortClick('high');
    expect(component.selectedEffort()).toBe('high');
  });

  it('updates selectedEffort back to low', async () => {
    await component.onEffortClick('low');
    expect(component.selectedEffort()).toBe('low');
  });

  // ── 7. effortChange output fires ─────────────────────────────────────────

  it('emits effortChange when effort is clicked', async () => {
    const emitted: string[] = [];
    component.effortChange.subscribe((v) => emitted.push(v));

    await component.onEffortClick('high');

    expect(emitted).toContain('high');
  });

  // ── 8. onEffortClick calls ipc.changeModel with correct reasoningEffort ───

  it('calls changeModel with "high" effort when high is clicked', async () => {
    // Seed a model via pendingSelection so IPC is called.
    component.pendingSelection.set({ provider: 'claude', model: 'claude-opus-4-5', reasoning: null });

    await component.onEffortClick('high');

    expect(ipcStub.changeModel).toHaveBeenCalledWith('inst-1', 'claude-opus-4-5', 'high');
  });

  it('calls changeModel with "low" effort when low is clicked', async () => {
    component.pendingSelection.set({ provider: 'claude', model: 'claude-sonnet-4-5', reasoning: null });

    await component.onEffortClick('low');

    expect(ipcStub.changeModel).toHaveBeenCalledWith('inst-1', 'claude-sonnet-4-5', 'low');
  });

  it('does not call changeModel when no model is known', async () => {
    // Clear everything
    component.pendingSelection.set(null);
    overrideInputs(component, { currentModel: undefined });

    await component.onEffortClick('high');

    expect(ipcStub.changeModel).not.toHaveBeenCalled();
  });

  // ── 9. onPickerSelectionChange calls ipc.changeModel ─────────────────────

  it('calls changeModel with the selected model', async () => {
    await component.onPickerSelectionChange({
      provider: 'claude',
      model: 'claude-3-5-sonnet',
      reasoning: null,
    });

    expect(ipcStub.changeModel).toHaveBeenCalledWith(
      'inst-1',
      'claude-3-5-sonnet',
      'medium', // default effort
    );
  });

  it('calls changeModel with reasoning effort from the selection when provided', async () => {
    await component.onPickerSelectionChange({
      provider: 'claude',
      model: 'claude-3-7-sonnet',
      reasoning: 'high',
    });

    expect(ipcStub.changeModel).toHaveBeenCalledWith('inst-1', 'claude-3-7-sonnet', 'high');
  });

  // ── 10. onPickerSelectionChange is no-op when model is null ──────────────

  it('does not call changeModel when picker selection has null model', async () => {
    await component.onPickerSelectionChange({ provider: 'claude', model: null, reasoning: null });

    expect(ipcStub.changeModel).not.toHaveBeenCalled();
  });
});
