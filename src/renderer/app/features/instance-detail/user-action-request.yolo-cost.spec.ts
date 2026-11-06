import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcFacadeService } from '../../core/services/ipc';
import { RuntimeChangePreviewIpcService } from '../../core/services/ipc/runtime-change-preview-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import { UserActionRequestComponent } from './user-action-request.component';

const template = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'user-action-request.component.html'), 'utf8');
await resolveComponentResources(url => Promise.resolve(url.endsWith('user-action-request.component.html') ? template : ''));

const note = {
  kind: 'auto-approve', text: 'Changing auto-approve starts a new session with a short summary; the rest does not carry over.',
  carriedTokens: 8_600, droppedTokens: 221_400, resendTokens: null, large: true,
};

for (const type of ['deferred_permission', 'codex_mcp_approval']) {
  describe(`permission card YOLO cost: ${type}`, () => {
    let fixture: ComponentFixture<UserActionRequestComponent>;
    const selected = signal<string | null>('inst-a');
    const runtime = signal({ id: 'inst-a', sessionId: 'session-a', providerSessionId: 'session-a', restartEpoch: 0,
      provider: 'codex', currentModel: 'model-placeholder', status: 'waiting-for-input', yoloMode: false,
      contextUsage: { used: 230_000 } });
    const preview = vi.fn();
    const respond = vi.fn();
    const toggle = vi.fn();
    let resolved: (payload: { requestId: string }) => void;

    beforeEach(async () => {
      selected.set('inst-a');
      runtime.update(value => ({ ...value, sessionId: 'session-a', yoloMode: false }));
      preview.mockReset().mockResolvedValue(note);
      respond.mockReset().mockResolvedValue({ success: true, data: { yoloMode: true } });
      toggle.mockReset().mockResolvedValue({ success: true });
      await TestBed.configureTestingModule({
        imports: [UserActionRequestComponent],
        providers: [
          { provide: RuntimeChangePreviewIpcService, useValue: { preview } },
          { provide: InstanceStore, useValue: { getInstance: () => runtime(), clearPendingApprovals: vi.fn(),
            decrementPendingApproval: vi.fn(), setLocalYoloMode: vi.fn() } },
          { provide: IpcFacadeService, useValue: {
            listUserActionRequestsForInstance: vi.fn().mockResolvedValue({ success: true, data: [] }),
            onUserActionRequest: () => vi.fn(), onInputRequired: () => vi.fn(),
            onInputRequiredResolved: (callback: typeof resolved) => { resolved = callback; return vi.fn(); },
            respondToInputRequired: respond, toggleYoloMode: toggle,
          } },
        ],
      }).compileComponents();
      fixture = TestBed.createComponent(UserActionRequestComponent);
      (fixture.componentInstance as unknown as { instanceId: () => string | null }).instanceId = selected;
      fixture.detectChanges();
      await settle();
      fixture.componentInstance.pendingRequests.set([{
        id: 'permission-a', instanceId: 'inst-a', requestType: 'input_required', title: 'Permission', message: 'Allow operation?',
        createdAt: 1, permissionMetadata: { type, tool_use_id: 'tool-placeholder' },
      }]);
      fixture.detectChanges();
      await settle();
    });

    async function settle(): Promise<void> {
      for (let i = 0; i < 3; i++) { await Promise.resolve(); fixture.detectChanges(); }
    }
    function click(selector: string): void {
      (fixture.nativeElement.querySelector(selector) as HTMLButtonElement).click();
      fixture.detectChanges();
    }
    function noAction(): void {
      expect(respond).not.toHaveBeenCalled();
      expect(toggle).not.toHaveBeenCalled();
    }
    function appliedOnce(): void {
      if (type === 'deferred_permission') {
        expect(respond).toHaveBeenCalledExactlyOnceWith('inst-a', 'permission-a', expect.any(String), undefined,
          'allow', 'once', { type, tool_use_id: 'tool-placeholder', enableYolo: true });
        expect(toggle).not.toHaveBeenCalled();
      } else {
        expect(toggle).toHaveBeenCalledExactlyOnceWith('inst-a');
        expect(respond).not.toHaveBeenCalled();
      }
    }

    it('shows cost before the click, holds a large change, and does nothing on cancel', async () => {
      expect(fixture.nativeElement.querySelector('.yolo-cost-note')?.textContent).toContain(note.text);
      expect(preview).toHaveBeenCalledWith('inst-a', { model: 'model-placeholder', yoloMode: true });
      noAction();
      click('.btn-yolo'); await settle();
      expect(fixture.nativeElement.querySelector('app-runtime-change-confirm')?.textContent).toContain(note.text);
      noAction();
      click('.runtime-confirm__no'); await settle();
      noAction();
      expect(fixture.componentInstance.pendingRequests()).toHaveLength(1);
    });

    it('applies only after yes and only once', async () => {
      click('.btn-yolo'); await settle(); noAction();
      click('.runtime-confirm__yes'); await settle(); appliedOnce();
    });

    it('applies a small change without the large confirmation', async () => {
      preview.mockResolvedValue({ ...note, large: false });
      click('.btn-yolo'); await settle(); appliedOnce();
    });

    it('keeps the action available when the preview is unavailable', async () => {
      preview.mockResolvedValue(null);
      click('.btn-yolo'); await settle(); appliedOnce();
    });

    it.each(['switch', 'resolved', 'session', 'replacement', 'destroy'])(
      'ignores a click preview that arrives after %s', async change => {
        let answer!: (value: typeof note | null) => void;
        preview.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
        click('.btn-yolo');
        if (change === 'switch') selected.set('inst-b');
        if (change === 'resolved') resolved({ requestId: 'permission-a' });
        if (change === 'session') runtime.update(value => ({ ...value, sessionId: 'session-b' }));
        if (change === 'replacement') fixture.componentInstance.pendingRequests.update(requests => [{ ...requests[0] }]);
        if (change === 'destroy') fixture.destroy(); else fixture.detectChanges();
        answer(null);
        if (change !== 'destroy') await settle(); else await Promise.resolve();
        noAction();
      });

    it('cannot confirm a request that settled while the question was open', async () => {
      click('.btn-yolo'); await settle();
      const yes = fixture.nativeElement.querySelector('.runtime-confirm__yes') as HTMLButtonElement;
      resolved({ requestId: 'permission-a' });
      yes.click(); await settle(); noAction();
    });

    it('cannot confirm after a session replacement or enable YOLO twice during a slow preview', async () => {
      click('.btn-yolo'); await settle();
      const yes = fixture.nativeElement.querySelector('.runtime-confirm__yes') as HTMLButtonElement;
      runtime.update(value => ({ ...value, sessionId: 'session-b' }));
      yes.click(); await settle(); noAction();
    });

    it.each(['secret_required', 'ask_user_question', 'permission_denial'])(
      'never uses YOLO to answer %s', async metadataType => {
        const request = { ...fixture.componentInstance.pendingRequests()[0], permissionMetadata: { type: metadataType } };
        fixture.componentInstance.pendingRequests.set([request]);
        fixture.detectChanges(); await settle();
        preview.mockClear();
        await fixture.componentInstance.onEnableYolo(request);
        expect(preview).not.toHaveBeenCalled(); noAction();
      });

    it('does not show a stale pre-click sentence in a replacement session', async () => {
      let answer!: (value: typeof note) => void;
      preview.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
      runtime.update(value => ({ ...value, sessionId: 'session-new' }));
      fixture.detectChanges();
      selected.set('inst-b'); fixture.detectChanges();
      answer(note); await settle();
      expect(fixture.nativeElement.textContent).not.toContain(note.text);
      noAction();
    });
  });
}
