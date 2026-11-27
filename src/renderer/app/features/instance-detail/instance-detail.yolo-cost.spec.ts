import { EnvironmentInjector, createEnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeChangeCostNote } from '../../../../shared/utils/runtime-change-cost';
import { RuntimeChangePreviewIpcService } from '../../core/services/ipc/runtime-change-preview-ipc.service';
import { ConfirmService } from '../../shared/confirm/confirm.service';
import { InstanceDetailComponent } from './instance-detail.component';
import { RuntimeChangePreviewController } from './runtime-change-preview.controller';

const large = (text: string): RuntimeChangeCostNote => ({
  kind: 'auto-approve', text, resendTokens: 300_000, carriedTokens: null, droppedTokens: null, large: true,
});

/** Settles the preview and question promises chained behind a click. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('enabling auto-approve asks with the cost sentence, bound to the session', () => {
  const preview = vi.fn<(instanceId: string, request: unknown) => Promise<RuntimeChangeCostNote | null>>();
  let confirmService: ConfirmService;

  beforeEach(() => {
    preview.mockReset();
    TestBed.configureTestingModule({ providers: [{ provide: RuntimeChangePreviewIpcService, useValue: { preview } }] });
    confirmService = TestBed.inject(ConfirmService);
  });

  /** The component's own injector, which provides the controller and is destroyed when the screen closes. */
  function build() {
    const injector = createEnvironmentInjector([RuntimeChangePreviewController], TestBed.inject(EnvironmentInjector));
    const runtimeChange = injector.get(RuntimeChangePreviewController);
    runtimeChange.bind('session|epoch-1');
    const toggleYoloMode = vi.fn(async () => undefined);
    let toggling = false;
    const isTogglingYolo = Object.assign(() => toggling, { set: (value: boolean) => { toggling = value; } });
    const component: InstanceDetailComponent = Object.assign(Object.create(InstanceDetailComponent.prototype), {
      instance: () => ({ id: 'session', status: 'idle', yoloMode: false, currentModel: 'gpt-5.5', desiredRuntime: { provider: 'codex', model: 'gpt-6' } }),
      yoloCostNote: () => null, // the background lookup has not landed
      isTogglingYolo,
      runtimeChange,
      confirmService,
      store: { toggleYoloMode },
    });
    return { component, toggleYoloMode, runtimeChange, injector };
  }

  function holdPreview(): (note: RuntimeChangeCostNote | null) => void {
    let answer!: (note: RuntimeChangeCostNote | null) => void;
    preview.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    return (note) => answer(note);
  }

  it('waits for the sentence, shows it in the question and applies only after a yes', async () => {
    const answer = holdPreview();
    const { component, toggleYoloMode } = build();

    const click = component.onToggleYolo();
    await settle();
    expect(preview).toHaveBeenCalledWith('session', expect.objectContaining({ yoloMode: true, model: 'gpt-6', provider: 'codex' }));
    expect(confirmService.pending()).toBeNull();

    answer(large('This re-reads about 300K tokens at full price.'));
    await settle();
    expect(confirmService.pending()?.message).toContain('This re-reads about 300K tokens at full price.');
    expect(toggleYoloMode).not.toHaveBeenCalled();

    confirmService.resolve(true);
    await click;
    expect(toggleYoloMode).toHaveBeenCalledWith('session');
  });

  it('ignores a second click while the sentence is loading, so no stale question can flip it back off', async () => {
    const answer = holdPreview();
    const { component, toggleYoloMode } = build();

    const first = component.onToggleYolo();
    await component.onToggleYolo();
    expect(preview).toHaveBeenCalledTimes(1);

    answer(large('Large.'));
    await settle();
    confirmService.resolve(true);
    await first;
    expect(toggleYoloMode).toHaveBeenCalledTimes(1);
    expect(confirmService.pending()).toBeNull();

    // The flag is released afterwards, so a later click works again.
    preview.mockResolvedValueOnce(large('Large.'));
    const later = component.onToggleYolo();
    await settle();
    confirmService.resolve(true);
    await later;
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it('does not apply when the question is answered no', async () => {
    preview.mockResolvedValueOnce(large('Large.'));
    const { component, toggleYoloMode } = build();
    const click = component.onToggleYolo();
    await settle();
    confirmService.resolve(false);
    await click;
    expect(toggleYoloMode).not.toHaveBeenCalled();
  });

  it('withdraws the open question and drops the yes when the session is replaced', async () => {
    preview.mockResolvedValueOnce(large('Large.'));
    const { component, toggleYoloMode, runtimeChange } = build();
    const click = component.onToggleYolo();
    await settle();
    expect(confirmService.pending()).not.toBeNull();

    runtimeChange.bind('session|epoch-2');
    expect(confirmService.pending()).toBeNull();
    confirmService.resolve(true); // a late click on a button that is no longer there
    await click;
    expect(toggleYoloMode).not.toHaveBeenCalled();
    expect(component.isTogglingYolo()).toBe(false);
  });

  it('never asks when the session is replaced while the sentence is loading', async () => {
    const answer = holdPreview();
    const { component, toggleYoloMode, runtimeChange } = build();
    const click = component.onToggleYolo();
    await settle();

    runtimeChange.bind('another-session');
    answer(large('Large.'));
    await click;
    expect(confirmService.pending()).toBeNull();
    expect(toggleYoloMode).not.toHaveBeenCalled();
  });

  it('withdraws the open question and drops the yes when the screen closes', async () => {
    preview.mockResolvedValueOnce(large('Large.'));
    const { component, toggleYoloMode, injector } = build();
    const click = component.onToggleYolo();
    await settle();
    expect(confirmService.pending()).not.toBeNull();

    injector.destroy();
    expect(confirmService.pending()).toBeNull();
    await click;
    expect(toggleYoloMode).not.toHaveBeenCalled();
  });

  it('leaves another caller\'s question in place when its own is withdrawn', async () => {
    const other = confirmService.confirm({ message: 'Something else?', confirmLabel: 'Yes' });
    preview.mockResolvedValueOnce(large('Large.'));
    const { component, toggleYoloMode, runtimeChange } = build();
    const click = component.onToggleYolo();
    await settle();

    runtimeChange.bind('session|epoch-2');
    await click;
    expect(confirmService.pending()?.message).toBe('Something else?');
    confirmService.resolve(true);
    await expect(other).resolves.toBe(true);
    expect(toggleYoloMode).not.toHaveBeenCalled();
  });
});
