import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalDraft } from '../../core/approval-presentation.store';
import type { MobilePromptDto } from '../../core/models';
import { ApprovalSheetComponent } from './approval-sheet.component';

const PROMPT: MobilePromptDto = { id: 'p', instanceId: 's', requestId: 'r', kind: 'permission', title: 'Review action', message: 'A requested action', createdAt: 0 };

function render(prompt: MobilePromptDto, pending = false) {
  // The Vitest transform does not register Angular signal-input metadata. Supply
  // signal values directly, retaining the real component template and handlers.
  // The shared native sheet has independent modal/focus tests.
  TestBed.overrideComponent(ApprovalSheetComponent, { set: { imports: [], schemas: [NO_ERRORS_SCHEMA] } });
  const fixture = TestBed.createComponent(ApprovalSheetComponent);
  const promptValue = signal(prompt);
  const draft = signal<ApprovalDraft>({ scope: 'session', answers: { 0: 'Keep this answer' } });
  const pendingValue = signal(pending);
  const values = { prompt: promptValue, draft, pending: pendingValue, error: signal<string | null>('Decision rejected') };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(fixture.componentInstance, key, { value });
  fixture.detectChanges();
  return { fixture, draft, promptValue, pendingValue, element: fixture.nativeElement as HTMLElement };
}

describe('ApprovalSheetComponent', () => {
  it.each([
    PROMPT,
    { ...PROMPT, kind: 'user-action' as const, requestType: 'select_option' as const, options: [{ id: 'one', label: 'One' }] },
    { ...PROMPT, kind: 'user-action' as const, requestType: 'ask_questions' as const, questions: ['What next?'] },
    { ...PROMPT, kind: 'user-action' as const, requestType: 'confirm' as const },
  ])('renders scoped failures and Open session for $kind / $requestType', (prompt) => {
    const { element } = render(prompt);
    expect(element.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(element.querySelector('[role="alert"]')?.textContent).toBe('Decision rejected');
    expect(Array.from(element.querySelectorAll('button')).some((button) => button.textContent?.includes('Open session'))).toBe(true);
  });

  it('announces the actual selected scope and emits the unchanged permission scope', () => {
    const { fixture, element } = render(PROMPT);
    const decide = vi.fn();
    fixture.componentInstance.decision.subscribe(decide);
    expect(element.querySelector('[data-scope="session"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(element.querySelector('[data-scope="session"]')?.textContent).toBe('This session');
    element.querySelector<HTMLButtonElement>('.allow')?.click();
    expect(decide).toHaveBeenCalledWith({ action: 'allow', scope: 'session' });
  });

  it('disables submission while sending and retains the answer across snapshots', () => {
    const prompt = { ...PROMPT, kind: 'user-action' as const, requestType: 'ask_questions' as const, questions: ['What next?'] };
    const { fixture, element, promptValue, pendingValue } = render(prompt, true);
    const decide = vi.fn();
    fixture.componentInstance.decision.subscribe(decide);
    const send = element.querySelector<HTMLButtonElement>('.allow');
    expect(send?.disabled).toBe(true);
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Sending');
    send?.click();
    expect(decide).not.toHaveBeenCalled();
    promptValue.set({ ...prompt });
    pendingValue.set(false);
    fixture.detectChanges();
    expect(element.querySelector('textarea')?.value).toBe('Keep this answer');
    send?.click();
    expect(decide).toHaveBeenCalledWith({ action: 'allow', scope: 'once', response: '{"What next?":"Keep this answer"}' });
  });

  it('renders the full supplied change past the bounded preview', () => {
    const content = Array.from({ length: 450 }, (_, index) => `line ${index}`).join('\n');
    const { element } = render({ ...PROMPT, toolName: 'Write', toolInput: { file_path: 'preview.ts', content } });
    const details = element.querySelector('details');
    expect(details?.querySelector('summary')?.textContent).toBe('Full available change');
    expect(details?.querySelector('pre')?.textContent).toBe(content);
    expect(element.querySelector('.diff')?.textContent).not.toContain('line 449');
  });
});
