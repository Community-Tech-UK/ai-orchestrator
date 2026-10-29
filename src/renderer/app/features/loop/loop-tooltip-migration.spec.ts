import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoopRunSummaryPayload } from '@contracts/schemas/loop';
import { LoopStore } from '../../core/state/loop.store';
import { LoopIpcService } from '../../core/services/ipc/loop-ipc.service';
import { RendererPollSchedulerService } from '../../core/services/renderer-poll-scheduler.service';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { LoopToggleComponent } from './loop-toggle.component';
import { LoopPastRunsPanelComponent } from './loop-past-runs-panel.component';
import { LoopPanelOpenerService } from './loop-panel-opener.service';

function focus(element: HTMLElement): void {
  const matches = element.matches.bind(element);
  vi.spyOn(element, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
  element.focus();
}
afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });

describe('Loop switch keyboard explanations', () => {
  function render(active = false) {
    TestBed.configureTestingModule({ providers: [{ provide: LoopStore, useValue: {
      ensureWired: vi.fn(), activeForChat: () => () => active ? { id: 'loop' } : undefined,
    } }] });
    const fixture = TestBed.createComponent(LoopToggleComponent);
    fixture.componentRef.setInput('chatId', 'chat');
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    return { fixture, input };
  }
  it('keeps the no-folder switch focusable, explains why, and blocks label and keyboard activation', () => {
    const { fixture, input } = render();
    const opened = vi.fn(); fixture.componentInstance.openConfig.subscribe(opened);
    expect(input.disabled).toBe(false);
    expect(input.getAttribute('aria-disabled')).toBe('true');
    focus(input); fixture.detectChanges();
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Pick a working folder to enable Loop Mode');
    input.click(); (fixture.nativeElement.querySelector('label') as HTMLLabelElement).click();
    input.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(opened).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[title]')).toBeNull();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
  it('still lets a running loop stop when no working folder is selected', () => {
    const { fixture, input } = render(true);
    const stopped = vi.fn(); fixture.componentInstance.stopRequested.subscribe(stopped);
    input.click(); expect(stopped).toHaveBeenCalledOnce();
    expect(input.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('Past loop prompt reasons', () => {
  function render(initialPrompt: string, running: boolean) {
    const run = { id: 'run', chatId: 'chat', initialPrompt, iterationPrompt: null, status: 'completed', endedAt: 2,
      startedAt: 1, totalIterations: 1, totalTokens: 0, totalCostCents: 0 } as LoopRunSummaryPayload;
    const copyText = vi.fn(); const open = vi.fn();
    TestBed.configureTestingModule({ providers: [
      { provide: LoopStore, useValue: { ensureWired: vi.fn(), refreshHistory: vi.fn(), runsForChat: () => signal([run]), activeForChat: () => () => undefined } },
      { provide: LoopIpcService, useValue: {} }, { provide: CLIPBOARD_SERVICE, useValue: { copyText } },
      { provide: LoopPanelOpenerService, useValue: { open } },
      { provide: RendererPollSchedulerService, useValue: { register: () => () => undefined } },
    ] });
    const fixture = TestBed.createComponent(LoopPastRunsPanelComponent);
    fixture.componentRef.setInput('chatId', 'chat'); fixture.componentRef.setInput('loopRunning', running);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.past-runs-toggle') as HTMLButtonElement).click(); fixture.detectChanges();
    const buttons: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('button'));
    return { fixture, copyText, open, buttons };
  }
  it.each([['', false, 'No prompt recorded for this run'], ['goal', true, 'A loop is already running for this chat — stop it first']] as const)(
    'explains a lasting Reattempt restriction (%s, %s) on focus and prevents opening a loop', (prompt, running, reason) => {
      const { fixture, open, buttons } = render(prompt, running);
      const button = buttons.find(element => element.textContent?.trim() === 'Reattempt')!;
      expect(button.disabled).toBe(false); expect(button.getAttribute('aria-disabled')).toBe('true');
      focus(button); fixture.detectChanges(); expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(reason);
      button.click(); expect(open).not.toHaveBeenCalled();
      expect(fixture.nativeElement.querySelector('[title]')).toBeNull();
    });
  it('explains why an unavailable prompt cannot be copied without skipping keyboard focus', () => {
    const { fixture, copyText, buttons } = render('', false);
    const button = buttons.find(element => element.textContent?.trim() === 'Copy')!;
    expect(button.disabled).toBe(false); expect(button.getAttribute('aria-disabled')).toBe('true');
    focus(button); fixture.detectChanges(); expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('No prompt recorded for this run');
    button.click(); expect(copyText).not.toHaveBeenCalled();
  });
});
