import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_SERVICE } from '../../../core/services/clipboard.service';
import { ElectronIpcService } from '../../../core/services/ipc';
import { InstanceStore } from '../../../core/state/instance.store';
import type { HudQuickAction } from '../../../../../shared/types/orchestration-hud.types';
import { ChildDiagnosticBundleModalService } from '../child-diagnostic-bundle.modal.service';
import { QuickActionDispatcherService } from '../quick-action-dispatcher.service';

describe('QuickActionDispatcherService', () => {
  let service: QuickActionDispatcherService;
  const fakeInstanceStore = { setSelectedInstance: vi.fn() };
  const fakeIpc = { invoke: vi.fn() };
  const fakeModal = { open: vi.fn() };
  const fakeClipboard = { copyText: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        QuickActionDispatcherService,
        { provide: InstanceStore, useValue: fakeInstanceStore },
        { provide: ElectronIpcService, useValue: fakeIpc },
        { provide: ChildDiagnosticBundleModalService, useValue: fakeModal },
        { provide: CLIPBOARD_SERVICE, useValue: fakeClipboard },
      ],
    });
    service = TestBed.inject(QuickActionDispatcherService);
  });

  it('focus-child selects the child instance', async () => {
    const action: HudQuickAction = { kind: 'focus-child', childInstanceId: 'child-1' };
    const result = await service.dispatch(action);
    expect(fakeInstanceStore.setSelectedInstance).toHaveBeenCalledWith('child-1');
    expect(result).toEqual({ ok: true });
  });

  it('copy-prompt-hash delegates to ClipboardService', async () => {
    fakeClipboard.copyText.mockResolvedValue({ ok: true });
    const action: HudQuickAction = {
      kind: 'copy-prompt-hash',
      childInstanceId: 'child-1',
      spawnPromptHash: 'abc123',
    };
    const result = await service.dispatch(action);
    expect(fakeClipboard.copyText).toHaveBeenCalledWith('abc123', { label: 'prompt hash' });
    expect(result).toEqual({ ok: true });
  });

  it('copy-prompt-hash returns a reason when the clipboard write fails', async () => {
    fakeClipboard.copyText.mockResolvedValue({ ok: false, reason: 'permission-denied' });
    const action: HudQuickAction = {
      kind: 'copy-prompt-hash',
      childInstanceId: 'child-1',
      spawnPromptHash: 'abc123',
    };
    const result = await service.dispatch(action);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Clipboard');
  });

  it('open-diagnostic-bundle fetches the bundle and opens the modal', async () => {
    const bundle = { childInstanceId: 'child-1' };
    fakeIpc.invoke.mockResolvedValue({ success: true, data: { ok: true, bundle } });
    const action: HudQuickAction = { kind: 'open-diagnostic-bundle', childInstanceId: 'child-1' };
    const result = await service.dispatch(action);
    expect(fakeIpc.invoke).toHaveBeenCalledWith(
      'orchestration:get-child-diagnostic-bundle',
      { childInstanceId: 'child-1' },
    );
    expect(fakeModal.open).toHaveBeenCalledWith(bundle);
    expect(result).toEqual({ ok: true });
  });

  it('summarize-children invokes the orchestration IPC channel', async () => {
    fakeIpc.invoke.mockResolvedValue({ success: true, data: { ok: true } });
    const action: HudQuickAction = { kind: 'summarize-children', parentInstanceId: 'parent-1' };
    const result = await service.dispatch(action);
    expect(fakeIpc.invoke).toHaveBeenCalledWith(
      'orchestration:summarize-children',
      { parentInstanceId: 'parent-1' },
    );
    expect(result).toEqual({ ok: true });
  });
});
