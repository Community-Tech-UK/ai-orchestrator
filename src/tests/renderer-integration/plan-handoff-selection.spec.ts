import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanHandoffDialogComponent } from '../../renderer/app/features/instance-detail/plan-handoff-dialog.component';
import { PlanModeIpcService } from '../../renderer/app/core/services/ipc/plan-mode-ipc.service';
import { InstanceStateService } from '../../renderer/app/core/state/instance/instance-state.service';
import { ToastService } from '../../renderer/app/core/services/toast.service';
import { ChatStore } from '../../renderer/app/core/state/chat.store';
import { DynamicModelCatalogService } from '../../renderer/app/features/models/dynamic-model-catalog.service';
import { UnifiedCatalogStore } from '../../renderer/app/features/models/unified-catalog.store';
import { ModelUsageMemoryService } from '../../renderer/app/features/models/model-usage-memory.service';
import { ModelFavoritesService } from '../../renderer/app/features/models/model-favorites.service';
import { PlanBuildHandoff } from '../../main/instance/plan-handoff/plan-build-handoff';
import { _resetInstanceCreateIdempotencyCacheForTesting } from '../../main/ipc/handlers/instance-create-idempotency';
import type { Instance } from '../../shared/types/instance.types';
import type { PickerProvider } from '../../renderer/app/features/models/compact-model-picker.types';

vi.mock('../../main/logging/logger', () => ({ getLogger: () => ({ warn: vi.fn() }) }));

await resolveComponentResources(() => Promise.resolve(''));

describe('plan handoff source-provider model selection', () => {
  let fixture: ComponentFixture<PlanHandoffDialogComponent>;
  const createInstance = vi.fn(async () => ({ id: 'build-1' }) as Instance);
  const start = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    _resetInstanceCreateIdempotencyCacheForTesting();
    localStorage.clear();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    _resetInstanceCreateIdempotencyCacheForTesting();
    localStorage.clear();
  });

  async function render(provider: PickerProvider, effort: 'low' | 'high' | null = 'high') {
    const source = {
      id: 'plan-1', displayName: 'Planning', agentId: 'plan', provider,
      currentModel: `${provider}-original`, reasoningEffort: effort,
      workingDirectory: '/repo', accountProfileId: 'profile-1',
      copilotAccountProfileId: 'copilot-profile-1',
      planMode: { enabled: true, state: 'planning', planContent: 'Build the export.' },
      outputBuffer: [], executionLocation: { type: 'local' },
    } as unknown as Instance;
    const handoff = new PlanBuildHandoff({
      getInstance: () => source, createInstance, emitSystemNotice: vi.fn(),
    });
    start.mockImplementation(async (input) => {
      const result = await handoff.start({ ...input, sourceId: input.instanceId });
      return { success: result.ok, data: result };
    });
    TestBed.configureTestingModule({ providers: [
      { provide: PlanModeIpcService, useValue: {
        previewPlanHandoff: async () => ({ success: true, data: handoff.preview(source.id) }),
        startPlanHandoff: start,
      } },
      { provide: InstanceStateService, useValue: { setSelectedInstance: vi.fn() } },
      { provide: ToastService, useValue: { show: vi.fn() } },
      { provide: ChatStore, useValue: {} },
      { provide: DynamicModelCatalogService, useValue: { ensureLoaded: vi.fn() } },
      { provide: UnifiedCatalogStore, useValue: {
        ensureLoaded: vi.fn(), lastBuiltAt: signal(null),
        displayModelsForProvider: (p: string) => [
          { id: `${p}-original`, name: `${p} Original`, tier: 'powerful' },
          { id: `${p}-alternate`, name: `${p} Alternate`, tier: 'fast' },
        ],
      } },
      { provide: ModelUsageMemoryService, useValue: { usageByKey: signal({}), record: vi.fn() } },
      { provide: ModelFavoritesService, useValue: { writeFavorites: vi.fn() } },
    ] });
    fixture = TestBed.createComponent(PlanHandoffDialogComponent);
    fixture.componentRef.setInput('sourceId', source.id);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  async function openPicker(root: HTMLElement) {
    root.querySelector<HTMLButtonElement>('.compact-picker__chip')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return document.querySelector('app-model-selection-panel')!;
  }

  function alternateModelButton(panel: Element, provider: PickerProvider) {
    const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>('.model-picker-row__select'))
      .filter((button) => button.querySelector('.model-picker-row__name')?.textContent?.trim() === `${provider} Alternate`);
    expect(buttons).toHaveLength(1);
    return buttons[0];
  }

  async function submit(root: HTMLElement) {
    Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes('Start new session'))!.click();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it.each(['claude', 'codex', 'opencode'] as const)('commits a real %s picker row through to an independent build', async (provider) => {
    const root = await render(provider);
    const panel = await openPicker(root);
    // Exercise rendered provider tab and model row, scoped controller, host and main service.
    const tab = panel.querySelector<HTMLButtonElement>(`[data-provider="${provider}"]`);
    expect(tab).not.toBeNull();
    tab!.click();
    fixture.detectChanges();
    alternateModelButton(panel, provider).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.querySelector('.model-choice')?.textContent).toContain(`${provider}-alternate`);
    await submit(root);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ model: `${provider}-alternate` }));
    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({
      provider, modelOverride: `${provider}-alternate`, parentId: null,
      accountProfileId: 'profile-1', copilotAccountProfileId: 'copilot-profile-1',
      reasoningEffort: 'high', agentId: 'build',
    }));
  });

  it.each(['claude', 'opencode'] as const)('keeps %s Same as planning without an override', async (provider) => {
    const root = await render(provider);
    expect(root.querySelector('.model-choice')?.textContent).toContain('Same as planning');
    await submit(root);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ provider, modelOverride: `${provider}-original` }));
  });

  it('offers only the source provider, including sources outside the default chat provider list', async () => {
    const root = await render('opencode');
    const panel = await openPicker(root);
    expect(Array.from(panel.querySelectorAll('.model-picker-rail [data-provider]')).map((el) => el.getAttribute('data-provider')))
      .toEqual(['opencode']);
    expect(panel.textContent).not.toContain('claude Alternate');
    expect(root.querySelector('.compact-picker__chip')?.textContent).toContain('OpenCode');
  });

  it('returns an alternate choice to Same as planning without a model override', async () => {
    const root = await render('codex');
    const panel = await openPicker(root);
    panel.querySelector<HTMLButtonElement>('[data-provider="codex"]')!.click();
    fixture.detectChanges();
    alternateModelButton(panel, 'codex').click();
    await fixture.whenStable();
    fixture.detectChanges();
    Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Same as planning')!.click();
    fixture.detectChanges();
    expect(root.querySelector('.model-choice')?.textContent).toContain('Same as planning');
    await submit(root);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ modelOverride: 'codex-original' }));
  });

  it.each(['low', 'high', null] as const)('offers only models and truthfully retains inherited effort %s', async effort => {
    const root = await render('claude', effort);
    const expected = effort === null ? 'Provider default' : effort === 'low' ? 'Low' : 'High';
    expect(root.querySelector('.compact-picker__chip')?.textContent).toContain(`Thinking: ${expected}`);
    let panel = await openPicker(root);
    panel.querySelector<HTMLButtonElement>('[data-provider="claude"]')!.click();
    fixture.detectChanges();
    expect(panel.querySelectorAll('.model-picker-row__reasoning')).toHaveLength(0);
    expect(panel.textContent).not.toContain('Reasoning');
    alternateModelButton(panel, 'claude').click();
    await fixture.whenStable(); fixture.detectChanges();
    expect(root.querySelector('.compact-picker__chip')?.textContent).toContain(`Thinking: ${expected}`);
    panel = await openPicker(root);
    expect(panel.textContent).not.toContain('Reasoning');
    // Close the actual overlay before returning to the original model.
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    await submit(root);
    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ modelOverride: 'claude-alternate', reasoningEffort: effort }));
    expect(start.mock.calls[0][0]).not.toHaveProperty('reasoningEffort');
  });
});
