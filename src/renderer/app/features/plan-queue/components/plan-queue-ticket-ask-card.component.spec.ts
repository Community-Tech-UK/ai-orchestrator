import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TICKET_ASK_ALREADY_ANSWERED, TICKET_ASK_CHANGED_AGAIN, type PlanQueueTicketAskView } from '@contracts/schemas/plan-queue';
import { PlanQueueIpcService } from '../../../core/services/ipc/plan-queue-ipc.service';
import { PlanQueueTicketAskCardComponent } from './plan-queue-ticket-ask-card.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-ticket-ask-card.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-ticket-ask-card.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-ticket-ask-card.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-ticket-ask-card.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const HOSTILE = '<img src="https://example.test/x.png"> and <script>window.hacked = true</script>\nsecond line';
const HASH = 'h'.repeat(64);

const CHANGED_OPTIONS = [
  { id: 'use-now', label: 'Use the ticket as it is now' },
  { id: 'keep-approved', label: 'Carry on with the version I approved' },
  { id: 'stop', label: 'Stop work on this ticket' },
];

function view(overrides: Partial<PlanQueueTicketAskView> = {}): PlanQueueTicketAskView {
  return {
    itemId: 'item-1', identifier: 'ORC-12', kind: 'changed', askHash: HASH, openedAt: 5,
    approved: { title: 'Fix the login page', text: 'ORC-12: Fix the login page\n\nDescription:\nOld words', hash: 'a'.repeat(64), approvedAt: 1_700_000_000_000 },
    held: { title: 'Fix the login page', text: 'ORC-12: Fix the login page\n\nDescription:\nNew words', hash: HASH, changed: ['description'], newCommentAuthors: [] },
    options: CHANGED_OPTIONS,
    ...overrides,
  };
}

describe('PlanQueueTicketAskCardComponent', () => {
  let fixture: ComponentFixture<PlanQueueTicketAskCardComponent>;
  const ticketAskRead = vi.fn();
  const ticketAskAnswer = vi.fn();

  async function settle(): Promise<void> {
    for (let pass = 0; pass < 4; pass++) {
      await fixture.whenStable();
      fixture.detectChanges();
    }
  }

  async function open(ask: PlanQueueTicketAskView | null, itemTitle: string | null = 'ORC-12 Fix the login page'): Promise<void> {
    ticketAskRead.mockResolvedValue({ success: true, data: { ask } });
    fixture = TestBed.createComponent(PlanQueueTicketAskCardComponent);
    fixture.componentRef.setInput('itemId', 'item-1');
    fixture.componentRef.setInput('itemTitle', itemTitle);
    fixture.componentRef.setInput('refreshKey', 1);
    fixture.detectChanges();
    await settle();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const text = (): string => el().textContent ?? '';
  const answerButton = (id: string): HTMLButtonElement => el().querySelector<HTMLButtonElement>(`button[data-option="${id}"]`)!;
  const changeLine = (): string => el().querySelector('.pq-ticket-ask-change')?.textContent ?? '';

  beforeEach(() => {
    ticketAskRead.mockReset();
    ticketAskAnswer.mockReset();
    TestBed.configureTestingModule({
      imports: [PlanQueueTicketAskCardComponent],
      providers: [{ provide: PlanQueueIpcService, useValue: { ticketAskRead, ticketAskAnswer } }],
    });
  });

  it('shows the ticket, what changed, both versions and the three answers with what each does', async () => {
    await open(view());
    expect(ticketAskRead).toHaveBeenCalledWith('item-1');
    expect(el().querySelector('h3')?.textContent).toBe('ORC-12 Fix the login page');
    expect(changeLine()).toBe('The description changed.');
    expect(text()).toContain('Only you see this. No AI has read it.');
    const versions = Array.from(el().querySelectorAll('.pq-ticket-ask-version'));
    expect(versions.map((version) => version.querySelector('h4')?.textContent)).toEqual(['What you approved', 'What Linear says now']);
    expect(versions[0].querySelector('.pq-ticket-ask-plain')?.textContent).toContain('Old words');
    expect(versions[1].querySelector('.pq-ticket-ask-plain')?.textContent).toContain('New words');
    const answers = Array.from(el().querySelectorAll('.pq-ticket-ask-answer')).map((row) => Array.from(row.children, (part) => part.textContent?.trim()).join(' '));
    expect(answers).toEqual([
      'Use the ticket as it is now The worker will be told the ticket changed.',
      'Carry on with the version I approved Harness will not ask about this change again.',
      'Stop work on this ticket This ticket will be set aside, or skipped if its work has not started.',
    ]);
  });

  it.each([
    ['the title', ['title'], [], 'The title changed.'],
    ['the title and the description', ['title', 'description'], [], 'The title changed. The description changed.'],
    ['a new comment', ['comments'], ['Raf'], 'A new comment from Raf.'],
    ['two new comments by two people', ['comments'], ['Raf', 'Sam'], 'New comments from Raf and Sam.'],
    ['a comment with no author', ['comments'], [null], 'A new comment from an unknown author.'],
    ['an edited or deleted comment', ['comments'], [], 'The comments changed.'],
    ['the description and a new comment', ['description', 'comments'], ['Raf'], 'The description changed. A new comment from Raf.'],
  ] as const)('says in one line what changed: %s', async (_name, changed, authors, expected) => {
    const base = view();
    await open(view({ held: { ...base.held!, changed: [...changed], newCommentAuthors: [...authors] } }));
    expect(changeLine()).toBe(expected);
  });

  it('says a ticket was removed, offers only stopping or leaving it waiting, and shows no text', async () => {
    await open(view({ kind: 'gone', approved: null, held: null, options: [{ id: 'stop', label: 'Stop work on this ticket' }, { id: 'leave-waiting', label: 'Leave it waiting' }] }));
    expect(changeLine()).toBe('This ticket was removed from Linear or moved out of its project.');
    expect(el().querySelector('.pq-ticket-ask-version')).toBeNull();
    expect(Array.from(el().querySelectorAll('button')).map((button) => button.textContent?.trim())).toEqual(['Stop work on this ticket', 'Leave it waiting']);
    expect(el().querySelector('h3')?.textContent).toBe('ORC-12 Fix the login page');
  });

  it('says when the approved text was cleared, and shows only the current version', async () => {
    await open(view({ kind: 'cleared', approved: null, held: { ...view().held!, changed: [] }, options: [CHANGED_OPTIONS[0], CHANGED_OPTIONS[2]] }));
    expect(changeLine()).toContain('The text you approved was deleted');
    expect(Array.from(el().querySelectorAll('.pq-ticket-ask-version h4')).map((heading) => heading.textContent)).toEqual(['What Linear says now']);
    expect(text()).toContain('This text becomes the version you approved.');
  });

  it('says when what James approved cannot be confirmed', async () => {
    await open(view({ kind: 'unconfirmed', approved: null, held: null, options: [{ id: 'stop', label: 'Stop work on this ticket' }, { id: 'leave-waiting', label: 'Leave it waiting' }] }));
    expect(changeLine()).toBe('Harness cannot confirm what you approved for this ticket.');
  });

  it('shows both versions as plain text, with no image or script element', async () => {
    const base = view();
    await open(view({
      approved: { ...base.approved!, text: HOSTILE },
      held: { ...base.held!, text: HOSTILE },
    }));
    const plain = Array.from(el().querySelectorAll('.pq-ticket-ask-plain'));
    expect(plain).toHaveLength(2);
    expect(plain[0].textContent).toBe(HOSTILE);
    expect(plain[1].textContent).toBe(HOSTILE);
    expect(el().querySelector('img')).toBeNull();
    expect(el().querySelector('script')).toBeNull();
    expect(el().querySelector('a')).toBeNull();
    expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it.each(CHANGED_OPTIONS.map((option) => [option.id] as const))('sends the answer %s with the question it was shown, and closes the card', async (optionId) => {
    await open(view());
    ticketAskAnswer.mockResolvedValue({ success: true, data: null });
    answerButton(optionId).click();
    await settle();
    expect(ticketAskAnswer).toHaveBeenCalledTimes(1);
    expect(ticketAskAnswer).toHaveBeenCalledWith({ itemId: 'item-1', optionId, askHash: HASH });
    expect(text()).toContain('This question has been answered.');
    expect(el().querySelector('.pq-ticket-ask-version')).toBeNull();
    expect(el().querySelector('button')).toBeNull();
  });

  it('keeps the card open after "Leave it waiting" and says nothing starts', async () => {
    await open(view({ kind: 'gone', approved: null, held: null, options: [{ id: 'stop', label: 'Stop work on this ticket' }, { id: 'leave-waiting', label: 'Leave it waiting' }] }));
    ticketAskAnswer.mockResolvedValue({ success: true, data: null });
    answerButton('leave-waiting').click();
    await settle();
    expect(ticketAskAnswer).toHaveBeenCalledWith({ itemId: 'item-1', optionId: 'leave-waiting', askHash: HASH });
    expect(text()).toContain('Left waiting. Nothing starts until you answer.');
    expect(answerButton('stop')).not.toBeNull();
  });

  it('reloads the card and says the ticket changed again when the answer is refused as out of date', async () => {
    await open(view());
    const newer = view({ askHash: 'n'.repeat(64), held: { ...view().held!, text: 'ORC-12: Fix the login page\n\nDescription:\nNewer words', hash: 'n'.repeat(64) } });
    ticketAskAnswer.mockResolvedValue({ success: false, error: { message: TICKET_ASK_CHANGED_AGAIN } });
    ticketAskRead.mockResolvedValue({ success: true, data: { ask: newer } });
    answerButton('use-now').click();
    await settle();
    expect(ticketAskRead).toHaveBeenCalledTimes(2);
    expect(text()).toContain('The ticket changed again. Read the new version below.');
    expect(text()).toContain('Newer words');
    expect(text()).not.toContain('New words');
    // The next answer carries the newer question's hash.
    ticketAskAnswer.mockResolvedValue({ success: true, data: null });
    answerButton('keep-approved').click();
    await settle();
    expect(ticketAskAnswer).toHaveBeenLastCalledWith({ itemId: 'item-1', optionId: 'keep-approved', askHash: 'n'.repeat(64) });
  });

  it('shows the question as answered when it was already closed', async () => {
    await open(view());
    ticketAskAnswer.mockResolvedValue({ success: false, error: { message: TICKET_ASK_ALREADY_ANSWERED } });
    ticketAskRead.mockResolvedValue({ success: true, data: { ask: null } });
    answerButton('stop').click();
    await settle();
    expect(text()).toContain('This question has been answered.');
  });

  it('shows another refusal in the main process\'s words and keeps the answers', async () => {
    await open(view());
    ticketAskAnswer.mockResolvedValue({ success: false, error: { message: 'That answer is not offered for this question.' } });
    answerButton('stop').click();
    await settle();
    expect(el().querySelector('[role="alert"]')?.textContent).toBe('That answer is not offered for this question.');
    expect(el().querySelectorAll('button')).toHaveLength(3);
    expect(ticketAskRead).toHaveBeenCalledTimes(1);
  });

  it('sends one answer when a button is pressed twice before the first returns', async () => {
    await open(view());
    let finish!: (value: unknown) => void;
    ticketAskAnswer.mockImplementation(() => new Promise((done) => { finish = done; }));
    answerButton('use-now').click();
    fixture.detectChanges();
    expect(answerButton('use-now').disabled).toBe(true);
    answerButton('use-now').click();
    answerButton('stop').click();
    expect(ticketAskAnswer).toHaveBeenCalledTimes(1);
    finish({ success: true, data: null });
    await settle();
  });

  it('shows a failed read in the main process\'s words, with no answers', async () => {
    ticketAskRead.mockResolvedValue({ success: false, error: { message: 'This job has no Linear ticket.' } });
    fixture = TestBed.createComponent(PlanQueueTicketAskCardComponent);
    fixture.componentRef.setInput('itemId', 'item-1');
    fixture.detectChanges();
    await settle();
    expect(el().querySelector('[role="alert"]')?.textContent).toBe('This job has no Linear ticket.');
    expect(el().querySelector('button')).toBeNull();
  });

  it('reads again when the job\'s row changes', async () => {
    await open(view());
    const replaced = view({ askHash: 'r'.repeat(64) });
    ticketAskRead.mockResolvedValue({ success: true, data: { ask: replaced } });
    fixture.componentRef.setInput('refreshKey', 2);
    await settle();
    expect(ticketAskRead).toHaveBeenCalledTimes(2);
    ticketAskAnswer.mockResolvedValue({ success: true, data: null });
    answerButton('stop').click();
    await settle();
    expect(ticketAskAnswer).toHaveBeenCalledWith({ itemId: 'item-1', optionId: 'stop', askHash: 'r'.repeat(64) });
  });

  it('holds the text in the card only: a new card for the same ticket reads again and shows what that read returned', async () => {
    await open(view());
    expect(text()).toContain('New words');
    fixture.destroy();
    await open(view({ held: { ...view().held!, text: 'ORC-12: Fix the login page\n\nDescription:\nOther words' } }));
    expect(ticketAskRead).toHaveBeenCalledTimes(2);
    expect(text()).toContain('Other words');
    expect(text()).not.toContain('New words');
    fixture.destroy();
    await open(null);
    expect(ticketAskRead).toHaveBeenCalledTimes(3);
    expect(text()).not.toContain('Other words');
    expect(text()).toContain('This question has been answered.');
  });

  it('uses no ids or raw words on the card', async () => {
    await open(view());
    for (const raw of ['jamesOnly', 'askHash', 'use-now', 'keep-approved', HASH, 'changed:', 'MCP']) expect(text()).not.toContain(raw);
  });
});
