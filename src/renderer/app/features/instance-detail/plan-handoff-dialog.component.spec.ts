import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanHandoffDialogComponent } from './plan-handoff-dialog.component';
import { PlanModeIpcService } from '../../core/services/ipc/plan-mode-ipc.service';
import { InstanceStateService } from '../../core/state/instance/instance-state.service';
import { ToastService } from '../../core/services/toast.service';

await resolveComponentResources((url) => {
  if (url.endsWith('.scss') || url.endsWith('.css')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('PlanHandoffDialogComponent', () => {
  const preview = vi.fn();
  const start = vi.fn();
  const setSelectedInstance = vi.fn();
  const toastShow = vi.fn();
  let launcher: HTMLButtonElement;

  beforeEach(() => {
    launcher = document.createElement('button');
    launcher.textContent = 'Build in a new session';
    document.body.append(launcher);
    launcher.focus();
    preview.mockReset().mockResolvedValue({ success: true, data: {
      planText: '1. Build the export screen.', truncated: false, source: 'assistant',
      planningContextTokens: 142_000, planTokensEstimate: 8,
      provider: 'claude', model: 'claude-sonnet-4-6', canStart: true,
    } });
    start.mockReset().mockResolvedValue({ success: true, data: { newInstanceId: 'build-1' } });
    setSelectedInstance.mockReset();
    toastShow.mockReset();
    TestBed.configureTestingModule({ providers: [
      { provide: PlanModeIpcService, useValue: { previewPlanHandoff: preview, startPlanHandoff: start } },
      { provide: InstanceStateService, useValue: { setSelectedInstance } },
      { provide: ToastService, useValue: { show: toastShow } },
    ] });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    launcher.remove();
  });

  async function render() {
    const fixture = TestBed.createComponent(PlanHandoffDialogComponent);
    fixture.componentRef.setInput('sourceId', 'plan-1');
    document.body.append(fixture.nativeElement);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('shows editable plan and planning context, then selects the new build session', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('142,000');
    expect(root.textContent).toContain('Same as planning');
    const textarea = root.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toContain('export screen');
    textarea.value = 'Edited approved plan';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const button = Array.from(root.querySelectorAll('button'))
      .find((item) => item.textContent?.includes('Start new session'))!;
    button.click();
    await fixture.whenStable();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'plan-1', planText: 'Edited approved plan',
    }));
    expect(setSelectedInstance).toHaveBeenCalledWith('build-1');
    expect(toastShow).toHaveBeenCalledWith('Building in a new session.', 'success');
  });

  it.each([
    ['null', null],
    ['absent', undefined],
  ])('leaves the planning-conversation figure out when main reports it as %s (R5M3)', async (_label, tokens) => {
    preview.mockResolvedValue({ success: true, data: {
      planText: '1. Build the export screen.', truncated: false, source: 'assistant',
      planningContextTokens: tokens, planTokensEstimate: 8,
      provider: 'claude', model: 'claude-sonnet-4-6', canStart: true,
    } });
    const fixture = await render();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('It gets only the plan below (about 7 tokens)');
    expect(text).toContain('starts by re-reading the files the plan names');
    expect(text).not.toContain('whole planning conversation');
    expect(text).not.toMatch(/about 0 tokens/);
  });

  it('prevents a start with no plan text', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    const textarea = root.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const button = Array.from(root.querySelectorAll('button'))
      .find((item) => item.textContent?.includes('Start new session')) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
  function key(target: Element, key: string, shiftKey = false): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  function action(fixture: ComponentFixture<PlanHandoffDialogComponent>, text: string): HTMLButtonElement {
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'))
      .find(button => button.textContent?.trim() === text)!;
  }

  async function openPicker(fixture: ComponentFixture<PlanHandoffDialogComponent>) {
    const chip = fixture.nativeElement.querySelector('.compact-picker__chip') as HTMLButtonElement;
    chip.focus();
    chip.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const panel = document.querySelector('.model-picker-panel') as HTMLElement;
    expect(panel).toBeTruthy();
    return { chip, panel };
  }

  it('enters the dialog before preview resolves and wraps Tab in both directions', async () => {
    let finish!: (value: unknown) => void;
    preview.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const fixture = TestBed.createComponent(PlanHandoffDialogComponent);
    fixture.componentRef.setInput('sourceId', 'plan-1');
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const first = root.querySelector('textarea')!;
    expect(document.activeElement).toBe(first);
    finish({ success: true, data: {
      planText: 'Build the screen', provider: 'claude', model: 'sonnet', canStart: true,
    } });
    await fixture.whenStable();
    fixture.detectChanges();
    const last = action(fixture, 'Start new session');
    last.focus();
    expect(key(last, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(key(first, 'Tab', true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it.each(['Cancel', 'Escape', 'destroy'])('restores the launcher and releases Tab on %s', async (method) => {
    const fixture = await render();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    if (method === 'Cancel') action(fixture, 'Cancel').click();
    if (method === 'Escape') {
      expect(key(fixture.nativeElement.querySelector('textarea'), 'Escape').defaultPrevented).toBe(true);
    }
    if (method === 'destroy') fixture.destroy();
    expect(document.activeElement).toBe(launcher);
    expect(closed).toHaveBeenCalledTimes(method === 'destroy' ? 0 : 1);
    expect(key(launcher, 'Tab').defaultPrevented).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps focus in the portalled picker and uses separate Escapes for picker and modal', async () => {
    const fixture = await render();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    const { chip, panel } = await openPicker(fixture);
    expect((fixture.nativeElement as HTMLElement).contains(panel)).toBe(false);
    expect(panel.contains(document.activeElement)).toBe(true);
    const controls = Array.from(panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input, select:not([disabled])',
    ));
    const first = controls[0];
    const last = controls.at(-1)!;
    last.focus();
    expect(key(last, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(key(first, 'Tab', true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    expect(key(last, 'Escape').defaultPrevented).toBe(true);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.querySelector('.model-picker-panel')).toBeNull();
    expect(document.activeElement).toBe(chip);
    expect(closed).not.toHaveBeenCalled();
    key(chip, 'Escape');
    expect(closed).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(launcher);
  });

  it('releases both traps when destroyed with its picker open', async () => {
    const fixture = await render();
    await openPicker(fixture);
    fixture.destroy();
    expect(document.activeElement).toBe(launcher);
    expect(key(launcher, 'Tab').defaultPrevented).toBe(false);
  });

  it('consumes busy Escape without closing, guards duplicate start, and restores before navigation', async () => {
    const fixture = await render();
    let finish!: (value: unknown) => void;
    start.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    const nextInput = document.createElement('input');
    document.body.append(nextInput);
    setSelectedInstance.mockImplementationOnce(() => {
      expect(document.activeElement).toBe(launcher);
      nextInput.focus();
    });
    const button = action(fixture, 'Start new session');
    button.click();
    button.click();
    fixture.detectChanges();
    expect(action(fixture, 'Cancel').disabled).toBe(true);
    const backgroundKeydown = vi.fn();
    document.addEventListener('keydown', backgroundKeydown);
    try {
      expect(key(fixture.nativeElement.querySelector('textarea'), 'Escape').defaultPrevented).toBe(true);
      expect(backgroundKeydown).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener('keydown', backgroundKeydown);
    }
    finish({ success: true, data: { newInstanceId: 'build-1' } });
    await fixture.whenStable();
    expect(closed).toHaveBeenCalledOnce();
    expect(setSelectedInstance).toHaveBeenCalledWith('build-1');
    expect(document.activeElement).toBe(nextInput);
    fixture.destroy();
    expect(document.activeElement).toBe(nextInput);
    expect(key(nextInput, 'Tab').defaultPrevented).toBe(false);
    nextInput.remove();
  });

  it('keeps focus after a failed start and retries the edited plan/model with the same key', async () => {
    const fixture = await render();
    start.mockResolvedValueOnce({ success: false, error: { message: 'Retry build' } });
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Edited approved plan';
    textarea.dispatchEvent(new Event('input'));
    fixture.componentInstance.onSelectionChange({ provider: 'claude', model: 'opus', reasoning: null });
    fixture.detectChanges();
    action(fixture, 'Start new session').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Retry build');
    expect((fixture.nativeElement as HTMLElement).contains(document.activeElement)).toBe(true);
    const payload = start.mock.calls[0][0];
    expect(payload).toEqual(expect.objectContaining({
      instanceId: 'plan-1', planText: 'Edited approved plan', model: 'opus',
      idempotencyKey: expect.any(String),
    }));
    action(fixture, 'Start new session').click();
    await fixture.whenStable();
    expect(start.mock.calls[1][0]).toEqual(payload);
  });

});
