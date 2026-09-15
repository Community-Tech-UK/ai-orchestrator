import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { MobileQueuedMessageDto } from '../../core/models';
import { ComposerQueueComponent } from './composer-queue.component';

const MESSAGES: MobileQueuedMessageDto[] = [
  { id: 'first', message: 'First paragraph\n\nSecond paragraph\n\n' + 'Full preview '.repeat(20), hasAttachments: true, enqueuedAt: 1, attempts: 3, error: 'Provider unavailable' },
  { id: 'second', message: 'Second message', hasAttachments: false, enqueuedAt: 2, attempts: 0 },
  { id: 'third', message: 'Third message', hasAttachments: false, enqueuedAt: 3, attempts: 0 },
];

async function setup() {
  const fixture = TestBed.createComponent(ComposerQueueComponent);
  const pending = signal<string | null>(null);
  Object.defineProperty(fixture.componentInstance, 'messages', { value: signal(MESSAGES) });
  Object.defineProperty(fixture.componentInstance, 'pendingId', { value: pending });
  await fixture.whenStable();
  const element = fixture.nativeElement as HTMLElement;
  return { fixture, element, pending };
}

describe('ComposerQueueComponent', () => {
  it('expands the count to full ordered previews with attachment and blocked status', async () => {
    const { fixture, element } = await setup();
    const toggle = element.querySelector<HTMLButtonElement>('.queue-head')!;
    expect(toggle.textContent).toContain('3');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(element.querySelectorAll('.queue-row')).toHaveLength(0);
    expect(element.textContent).toContain('Queue blocked');
    toggle.click();
    await fixture.whenStable();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rows = [...element.querySelectorAll('.queue-row')];
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelector('.queue-text')?.textContent).toBe(MESSAGES[0].message);
    expect(rows[0].textContent).toContain('Attachments included');
    expect(rows[0].textContent).toContain('Failed');
    expect(rows[1].textContent).toContain('Waiting for message 1');
    expect(rows[2].textContent).toContain('Waiting for message 1');
    expect(element.textContent).toContain('Return the first message to your draft or remove it');
  });

  it('offers separate return and remove events and disables every competing action while pending', async () => {
    const { fixture, element, pending } = await setup();
    const returned = vi.fn();
    const removed = vi.fn();
    fixture.componentInstance.cancelMessage.subscribe(returned);
    fixture.componentInstance.removeMessage.subscribe(removed);
    element.querySelector<HTMLButtonElement>('.queue-head')!.click();
    await fixture.whenStable();
    const actions = [...element.querySelectorAll<HTMLButtonElement>('.queue-actions button')];
    expect(actions).toHaveLength(6);
    actions[0].click();
    expect(returned).toHaveBeenCalledWith(MESSAGES[0]);
    expect(removed).not.toHaveBeenCalled();
    actions[1].click();
    expect(removed).toHaveBeenCalledWith(MESSAGES[0]);
    pending.set('first');
    await fixture.whenStable();
    expect(actions.every((button) => button.disabled)).toBe(true);
    for (const button of actions) button.click();
    expect(returned).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(element.textContent).toContain('Updating queue');
  });
});
