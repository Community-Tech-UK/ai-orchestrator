import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerToolbarComponent } from './composer-toolbar.component';
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import type { UnifiedSelection } from '../models/model-selection.types';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import { ToastService } from '../../core/services/toast.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { HistoryPreviewSessionService } from './history-preview-session.service';

describe('Composer model feedback (rendered picker and host)', () => {
  let fixture: ComponentFixture<ComposerToolbarComponent>;
  const changeModel = vi.fn();
  const show = vi.fn();
  const selected: UnifiedSelection = { kind: 'reasoning', provider: 'codex', modelId: 'gpt-6-astra', level: 'high' };

  beforeEach(() => {
    vi.resetAllMocks();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [ComposerToolbarComponent], providers: [
      { provide: InstanceIpcService, useValue: { changeModel } },
      { provide: InstanceStore, useValue: {} },
      { provide: ToastService, useValue: { show } },
    ] });
    fixture = TestBed.createComponent(ComposerToolbarComponent);
    fixture.componentRef.setInput('instanceId', 'real-1');
    fixture.componentRef.setInput('instanceStatus', 'idle');
    fixture.componentRef.setInput('provider', 'codex');
    fixture.componentRef.setInput('currentModel', 'gpt-5.6-sol');
    fixture.detectChanges();
  });
  afterEach(() => { fixture.destroy(); vi.useRealTimers(); });

  async function choose(selection = selected): Promise<void> {
    const picker = fixture.debugElement.query(By.directive(CompactModelPickerComponent)).componentInstance as {
      onUnifiedSelect(selection: UnifiedSelection): Promise<void>;
    };
    await picker.onUnifiedSelect(selection);
    fixture.detectChanges();
  }
  const status = () => (fixture.nativeElement.querySelector('.compact-picker__status') as HTMLElement | null)?.textContent ?? '';

  it('stores a closed-preview choice and announces when it will apply without live IPC', async () => {
    fixture.componentRef.setInput('instanceId', 'history-preview:history-a');
    fixture.detectChanges();
    await choose();
    expect(changeModel).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(status()).toMatch(/Will use .*astra.* when resumed/i);
    expect(status()).not.toContain('Switched');
    expect(fixture.nativeElement.querySelector('.compact-picker__label--model').textContent).toMatch(/astra/i);
    expect(fixture.nativeElement.querySelector('.compact-picker__status').getAttribute('role')).toBe('status');
  });

  it('keeps a choice tied to its history entry across navigation', async () => {
    fixture.componentRef.setInput('instanceId', 'history-preview:history-a');
    fixture.detectChanges();
    await choose();
    fixture.componentRef.setInput('instanceId', 'history-preview:history-b');
    fixture.detectChanges();
    expect(status()).toBe('');
    expect(fixture.componentInstance.pickerSelection()?.model).toBe('gpt-5.6-sol');
    fixture.componentRef.setInput('instanceId', 'history-preview:history-a');
    fixture.detectChanges();
    expect(fixture.componentInstance.pickerSelection()?.model).toBe('gpt-6-astra');
    expect(status()).toContain('when resumed');
  });

  it('shows applying, then confirmed success only after the backend answers', async () => {
    let resolve!: (response: IpcResponse) => void;
    changeModel.mockReturnValue(new Promise<IpcResponse>(done => { resolve = done; }));
    await choose();
    expect(status()).toBe('Applying model change…');
    expect(status()).not.toContain('Switched');
    resolve({ success: true, data: { id: 'real-1', provider: 'codex', currentModel: 'gpt-6-astra' } });
    await vi.waitFor(() => { fixture.detectChanges(); expect(status()).toMatch(/Switched to .*astra/i); });
  });

  it('settles feedback when backend state events arrive before the IPC response', async () => {
    let resolve!: (response: IpcResponse) => void;
    changeModel.mockReturnValue(new Promise<IpcResponse>(done => { resolve = done; }));
    await choose();
    fixture.componentRef.setInput('currentModel', 'gpt-6-astra');
    fixture.componentRef.setInput('currentReasoningEffort', 'medium');
    fixture.detectChanges();
    resolve({ success: true, data: { id: 'real-1', provider: 'codex', currentModel: 'gpt-6-astra', reasoningEffort: 'medium' } });
    await vi.waitFor(() => { fixture.detectChanges(); expect(status()).toMatch(/Switched to .*astra/i); });
  });

  it('rolls back a rejection without leaving any success pill', async () => {
    changeModel.mockResolvedValue({ success: false, error: { message: 'Model unavailable' } });
    await choose();
    await vi.waitFor(() => { fixture.detectChanges(); expect(status()).toBe(''); });
    expect(show).toHaveBeenCalledWith('Model unavailable', 'error');
    expect(status()).toBe('');
    expect(fixture.componentInstance.pickerSelection()?.model).toBe('gpt-5.6-sol');
    expect(fixture.nativeElement.textContent).not.toContain('Switched');
  });

  it('reports a queued change without claiming it has switched', async () => {
    changeModel.mockResolvedValue({ success: true, data: { id: 'real-1', provider: 'codex', currentModel: 'gpt-5.6-sol', desiredRuntime: { provider: 'codex', model: 'gpt-6-astra' } } });
    await choose();
    await vi.waitFor(() => { fixture.detectChanges(); expect(status()).toContain('queued'); });
    expect(status()).not.toContain('Switched');
  });

  it('handles a thrown IPC failure and keeps it out of other sessions after navigation', async () => {
    changeModel.mockRejectedValueOnce(new Error('Disconnected'));
    await choose();
    await vi.waitFor(() => { fixture.detectChanges(); expect(status()).toBe(''); });
    expect(show).toHaveBeenCalledWith('Disconnected', 'error');
    expect(status()).toBe('');
    show.mockClear();
    let resolve!: (response: IpcResponse) => void;
    changeModel.mockReturnValue(new Promise<IpcResponse>(done => { resolve = done; }));
    await choose();
    fixture.componentRef.setInput('instanceId', 'real-2');
    fixture.detectChanges();
    resolve({ success: false, error: { message: 'Old session error' } });
    await Promise.resolve();
    fixture.detectChanges();
    expect(show).not.toHaveBeenCalled();
    expect(status()).toBe('');
  });

  it('shares preview selection with the continuation service', async () => {
    fixture.componentRef.setInput('instanceId', 'history-preview:history-a');
    fixture.detectChanges();
    await choose();
    expect(TestBed.inject(HistoryPreviewSessionService).selection('history-a')).toEqual({
      provider: 'codex', model: 'gpt-6-astra', reasoning: 'high',
    });
  });
});
