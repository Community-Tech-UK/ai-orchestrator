import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeChangeCostNote } from '../../../../shared/utils/runtime-change-cost';
import { InstanceIpcService } from '../../core/services/ipc';
import { RuntimeChangePreviewIpcService } from '../../core/services/ipc/runtime-change-preview-ipc.service';
import { ProviderAccountIpcService } from '../../core/services/ipc/provider-account-ipc.service';
import { ToastService } from '../../core/services/toast.service';
import { InstanceStore } from '../../core/state/instance.store';
import type { PendingSelection } from '../models/compact-model-picker.types';
import { ComposerToolbarComponent } from './composer-toolbar.component';
import type { RuntimeChangePreviewController } from './runtime-change-preview.controller';
import { HistoryPreviewSessionService } from './history-preview-session.service';
import { resolveContextEvidenceTemplate } from './composer-toolbar-test-resources';

await resolveContextEvidenceTemplate();

const changeModel = vi.fn();
const preview = vi.fn<(instanceId: string, request: unknown) => Promise<RuntimeChangeCostNote | null>>();

const large: RuntimeChangeCostNote = {
  kind: 'model',
  text: 'Switching model restarts this session, and the next message will re-read about 230K tokens at full price.',
  resendTokens: 230_000, carriedTokens: null, droppedTokens: null, large: true,
};
const sel = { provider: 'codex', model: 'gpt-6.1-sol', reasoning: null } as PendingSelection;

describe('ComposerToolbarComponent: a large re-read waits for a yes', () => {
  let fixture: ComponentFixture<ComposerToolbarComponent>;
  let component: ComposerToolbarComponent;
  let controller: RuntimeChangePreviewController;

  beforeEach(async () => {
    changeModel.mockReset();
    changeModel.mockResolvedValue({ success: true });
    preview.mockReset();
    await TestBed.configureTestingModule({
      imports: [ComposerToolbarComponent],
      providers: [
        { provide: InstanceStore, useValue: { getInstance: () => undefined } },
        { provide: InstanceIpcService, useValue: { changeModel } },
        { provide: ToastService, useValue: { show: vi.fn() } },
        { provide: ProviderAccountIpcService, useValue: { list: vi.fn().mockResolvedValue({ profiles: [], pools: {} }), previewRoute: vi.fn(), switchSession: vi.fn() } },
        { provide: RuntimeChangePreviewIpcService, useValue: { preview } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ComposerToolbarComponent);
    component = fixture.componentInstance;
    const inputs = component as unknown as Record<string, unknown>;
    inputs['instanceId'] = () => 'inst-1';
    inputs['provider'] = () => 'codex';
    inputs['currentModel'] = () => 'gpt-6-astra';
    controller = (component as unknown as { preview: RuntimeChangePreviewController }).preview;
  });

  it('applies a small or missing sentence at once', async () => {
    preview.mockResolvedValueOnce({ ...large, large: false });
    await component.onPickerSelectionChange(sel);
    preview.mockResolvedValueOnce(null);
    await component.onPickerSelectionChange(sel);
    expect(changeModel).toHaveBeenCalledTimes(2);
    expect(controller.pendingConfirmation()).toBeNull();
  });

  it('holds a large re-read, asking about exactly the change the click would make', async () => {
    preview.mockResolvedValue(large);
    await component.onPickerSelectionChange(sel);
    expect(preview).toHaveBeenCalledWith('inst-1', { model: 'gpt-6.1-sol', provider: 'codex' });
    expect(changeModel).not.toHaveBeenCalled();
    expect(controller.pendingConfirmation()?.text).toBe(large.text);
  });

  it('applies the held change on yes, exactly once', async () => {
    preview.mockResolvedValue(large);
    await component.onPickerSelectionChange(sel);
    controller.confirm('inst-1');
    await vi.waitFor(() => expect(changeModel).toHaveBeenCalledTimes(1));
    expect(changeModel).toHaveBeenCalledWith('inst-1', 'gpt-6.1-sol', undefined, undefined, 'codex');
    controller.confirm('inst-1');
    expect(changeModel).toHaveBeenCalledTimes(1);
  });

  it('drops the held change on no', async () => {
    preview.mockResolvedValue(large);
    await component.onPickerSelectionChange(sel);
    controller.cancel();
    expect(changeModel).not.toHaveBeenCalled();
    expect(controller.pendingConfirmation()).toBeNull();
  });

  it('holds a replay that would leave a large conversation behind, just the same', async () => {
    const replay: RuntimeChangeCostNote = {
      kind: 'provider', resendTokens: null, carriedTokens: 8_600, droppedTokens: 221_400, large: true,
      text: 'Switching provider starts a new session with a short summary of this one; the rest does not carry over.',
    };
    preview.mockResolvedValue(replay);
    await component.onPickerSelectionChange(sel);
    expect(changeModel).not.toHaveBeenCalled();
    expect(controller.pendingConfirmation()?.text).toBe(replay.text);
  });

  it('shows the question in the shared confirm box, and its buttons answer it', async () => {
    preview.mockResolvedValue(large);
    const box = () => fixture.nativeElement.querySelector('app-runtime-change-confirm') as HTMLElement | null;
    const answer = (index: number) => (box()!.querySelectorAll('button')[index] as HTMLButtonElement).click();

    await component.onPickerSelectionChange(sel);
    fixture.detectChanges();
    expect(box()?.textContent).toContain(large.text);

    answer(1); // Keep current
    fixture.detectChanges();
    expect(box()).toBeNull();
    expect(changeModel).not.toHaveBeenCalled();

    await component.onPickerSelectionChange(sel);
    fixture.detectChanges();
    answer(0); // Switch anyway
    await vi.waitFor(() => expect(changeModel).toHaveBeenCalledTimes(1));
  });
});

// Regression: the live composer is a single reused node — switching chats swaps
// its [instanceId] input while the component (and its pending confirmation) live
// on. A yes after the swap must never restart the chat the composer now shows.
describe('ComposerToolbarComponent: a held change belongs to the session it was previewed for', () => {
  async function harness(instanceId: string): Promise<{
    fixture: ComponentFixture<ComposerToolbarComponent>;
    component: ComposerToolbarComponent;
    controller: RuntimeChangePreviewController;
  }> {
    TestBed.resetTestingModule();
    const historySessions = {
      selection: vi.fn().mockReturnValue(null),
      confirmedSelectionForInstance: vi.fn().mockReturnValue(null),
      clearConfirmedSelection: vi.fn(),
      accountChoice: vi.fn().mockReturnValue(null),
      chooseAccount: vi.fn(),
      clearAccountChoice: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [ComposerToolbarComponent],
      providers: [
        { provide: InstanceStore, useValue: { getInstance: () => undefined } },
        { provide: InstanceIpcService, useValue: { changeModel } },
        { provide: ToastService, useValue: { show: vi.fn() } },
        { provide: ProviderAccountIpcService, useValue: { list: vi.fn().mockResolvedValue({ profiles: [], pools: {} }), previewRoute: vi.fn(), switchSession: vi.fn() } },
        { provide: RuntimeChangePreviewIpcService, useValue: { preview } },
        { provide: HistoryPreviewSessionService, useValue: historySessions },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ComposerToolbarComponent);
    fixture.componentRef.setInput('instanceId', instanceId);
    fixture.componentRef.setInput('provider', 'codex');
    fixture.componentRef.setInput('currentModel', 'gpt-6-astra');
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const controller = (component as unknown as { preview: RuntimeChangePreviewController }).preview;
    return { fixture, component, controller };
  }

  beforeEach(() => {
    changeModel.mockReset();
    changeModel.mockResolvedValue({ success: true });
    preview.mockReset();
  });

  it('drops a held change when the composer is re-pointed at another chat', async () => {
    const { fixture, component, controller } = await harness('inst-A');
    preview.mockResolvedValue(large);
    await component.onPickerSelectionChange(sel);
    expect(controller.pendingConfirmation()).not.toBeNull();

    fixture.componentRef.setInput('instanceId', 'inst-B');
    fixture.detectChanges();

    expect(controller.pendingConfirmation()).toBeNull();
    controller.confirm('inst-B');
    await Promise.resolve();
    expect(changeModel).not.toHaveBeenCalled();
  });

  it.each(['provider', 'currentModel', 'currentReasoningEffort', 'accountProfileId', 'runtimeIdentity'] as const)(
    'drops a held change when the same session changes %s', async input => {
      const { fixture, component, controller } = await harness('inst-A');
      preview.mockResolvedValue(large);
      await component.onPickerSelectionChange(sel);
      expect(controller.pendingConfirmation()).not.toBeNull();
      fixture.componentRef.setInput(input, {
        provider: 'claude', currentModel: 'replacement-model', currentReasoningEffort: 'max',
        accountProfileId: 'replacement-account', runtimeIdentity: 'native-replacement:1',
      }[input]);
      fixture.detectChanges();
      expect(controller.pendingConfirmation()).toBeNull();
      controller.confirm('inst-A');
      await Promise.resolve();
      expect(changeModel).not.toHaveBeenCalled();
    },
  );

  it('keeps a legitimate held choice through busy and idle status updates', async () => {
    const { fixture, component, controller } = await harness('inst-A');
    preview.mockResolvedValue(large);
    await component.onPickerSelectionChange(sel);
    fixture.componentRef.setInput('instanceStatus', 'busy');
    fixture.detectChanges();
    fixture.componentRef.setInput('instanceStatus', 'idle');
    fixture.detectChanges();
    expect(controller.pendingConfirmation()?.text).toBe(large.text);
    controller.confirm('inst-A');
    await vi.waitFor(() => expect(changeModel).toHaveBeenCalledOnce());
  });

  it('never applies a preview that lands after the composer was re-pointed at another chat', async () => {
    const { fixture, component } = await harness('inst-A');
    let resolvePreview!: (value: RuntimeChangeCostNote | null) => void;
    preview.mockImplementationOnce(() => new Promise((resolve) => { resolvePreview = resolve; }));
    const pending = component.onPickerSelectionChange(sel);

    fixture.componentRef.setInput('instanceId', 'inst-B');
    fixture.detectChanges();
    resolvePreview({ ...large, large: false });
    await pending;

    expect(changeModel).not.toHaveBeenCalled();
  });
});
