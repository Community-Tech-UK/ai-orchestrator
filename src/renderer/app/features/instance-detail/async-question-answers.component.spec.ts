import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import { InstanceStore } from '../../core/state/instance/instance.store';
import { AsyncQuestionAnswersComponent } from './async-question-answers.component';
import type { AsyncAnswerTarget } from './async-question';

function question(questions: unknown, extra: Record<string, unknown> = {}): OutputMessage {
  return {
    id: 'q1',
    timestamp: 1,
    type: 'assistant',
    content: 'question text',
    metadata: { asyncUserInput: true, questions, ...extra },
  } as OutputMessage;
}

describe('AsyncQuestionAnswersComponent', () => {
  const queue = signal<{ message: string }[]>([]);
  const status = signal<string | undefined>('busy');
  const supersededBy = signal<string | undefined>(undefined);
  // Default: the session is busy, so the store queues the reply (the real
  // sendInput behaviour for a busy instance).
  const sendInput = vi.fn(async (_instanceId: string, message: string) => {
    queue.update((current) => [...current, { message }]);
  });
  const store = {
    sendInput,
    getMessageQueue: vi.fn(() => queue()),
    // Only 'inst-1' is a live instance; a chat id is not a store key.
    getInstance: vi.fn((id: string) => (id !== 'inst-1' || status() === undefined
      ? undefined
      : { status: status(), supersededBy: supersededBy() })),
  };
  let fixture: ComponentFixture<AsyncQuestionAnswersComponent>;

  async function render(
    message: OutputMessage,
    transcript: OutputMessage[] = [message],
    host: { instanceId?: string; target?: AsyncAnswerTarget | null } = {},
  ): Promise<HTMLElement> {
    fixture = TestBed.createComponent(AsyncQuestionAnswersComponent);
    fixture.componentRef.setInput('message', message);
    fixture.componentRef.setInput('instanceId', host.instanceId ?? 'inst-1');
    fixture.componentRef.setInput('transcript', transcript);
    if (host.target !== undefined) fixture.componentRef.setInput('target', host.target);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function sendButton(root: HTMLElement): HTMLButtonElement | null {
    return root.querySelector<HTMLButtonElement>('button.aq__send');
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    queue.set([]);
    status.set('busy');
    supersededBy.set(undefined);
    await TestBed.configureTestingModule({
      imports: [AsyncQuestionAnswersComponent],
      providers: [{ provide: InstanceStore, useValue: store }],
    }).compileComponents();
  });

  it('preselects the recommended option and queues it as the reply while Codex is busy', async () => {
    const root = await render(question([{ title: 'Keep writes blocked?', options: ['Keep blocked', 'Allow'] }]));
    const radios = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map((radio) => radio.parentElement?.textContent?.trim())).toEqual(['Keep blocked', 'Allow', 'Other']);
    expect(radios[0].checked).toBe(true);

    sendButton(root)!.click();
    await settle();

    expect(sendInput).toHaveBeenCalledWith('inst-1', 'Answer to your question:\n\nQ: Keep writes blocked?\nA: Keep blocked');
    expect(sendButton(root)).toBeNull();
    expect(root.querySelector('fieldset')!.disabled).toBe(true);
    expect(root.textContent).toContain('Answer queued');
  });

  it('sends at once when idle and shows the reply once it is echoed into the transcript', async () => {
    const message = question([{ title: 'Keep writes blocked?', options: ['Yes', 'No'] }]);
    status.set('idle');
    // Real immediate send: optimistic busy, then main echoes the user bubble.
    sendInput.mockImplementationOnce(async () => { status.set('busy'); });
    const root = await render(message);
    sendButton(root)!.click();
    await settle();
    expect(root.textContent).toContain('Sending');
    expect(sendButton(root)).toBeNull();

    fixture.componentRef.setInput('transcript', [message, {
      id: 'u1', timestamp: 2, type: 'user', content: 'Answer to your question:\n\nQ: Keep writes blocked?\nA: Yes',
    } as OutputMessage]);
    await settle();
    expect(root.textContent).toContain('Your reply is in the conversation below');
  });

  it('stays locked while a queued reply moves from the queue into the conversation', async () => {
    const message = question([{ title: 'Keep writes blocked?', options: ['Yes', 'No'] }]);
    const root = await render(message);
    sendButton(root)!.click();
    await settle();
    expect(root.textContent).toContain('Answer queued');

    // Drain: the entry leaves the queue and the send marks the session busy in
    // the same tick, before main echoes the bubble.
    status.set('idle');
    queue.set([]);
    status.set('busy');
    await settle();
    expect(sendButton(root)).toBeNull();
    expect(root.querySelector('fieldset')!.disabled).toBe(true);
    expect(root.textContent).not.toContain('Not sent');
  });

  it('re-enables sending when a terminal session refuses the reply', async () => {
    status.set('terminated');
    sendInput.mockImplementationOnce(async () => undefined);
    const root = await render(question([{ title: 'Keep writes blocked?', options: ['Yes', 'No'] }]));
    sendButton(root)!.click();
    await settle();

    expect(root.textContent).not.toContain('Your reply is in the conversation');
    expect(root.textContent).toContain('Not sent');
    expect(sendButton(root)!.disabled).toBe(false);
    expect(root.querySelector('fieldset')!.disabled).toBe(false);
  });

  it('re-enables sending when an idle send fails permanently', async () => {
    status.set('idle');
    // Permanent failure: busy is reverted to idle and nothing is echoed or queued.
    sendInput.mockImplementationOnce(async () => { status.set('busy'); status.set('idle'); });
    const root = await render(question([{ title: 'Keep writes blocked?', options: ['Yes', 'No'] }]));
    sendButton(root)!.click();
    await settle();
    expect(root.textContent).toContain('Not sent');
    expect(sendButton(root)!.disabled).toBe(false);
  });

  it('offers no send on a session an edit-and-resend replaced', async () => {
    status.set('superseded');
    supersededBy.set('inst-2');
    const root = await render(question([{ title: 'Keep writes blocked?', options: ['Yes', 'No'] }]));
    expect(root.querySelector('form')).toBeNull();
    expect(root.textContent).toContain('Answer in the new session');
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('offers no controls in a history preview, which has no live session behind it', async () => {
    status.set(undefined);
    const root = await render(question([{ title: 'Keep writes blocked?', options: ['Yes', 'No'] }]));
    expect(root.querySelector('form')).toBeNull();
    expect(root.textContent?.trim()).toBe('');
  });

  it('in a chat, reads the live instance from the target and sends through the host', async () => {
    const message = question([{ title: 'Keep writes blocked?', options: ['Yes', 'No'] }]);
    const chatSend = vi.fn(async () => undefined);
    // The transcript is keyed by chat id, which is not a live store key.
    expect((await render(message, [message], { instanceId: 'chat-1' })).querySelector('form')).toBeNull();

    const root = await render(message, [message], {
      instanceId: 'chat-1',
      target: { instanceId: 'inst-1', send: chatSend },
    });
    sendButton(root)!.click();
    await settle();

    expect(chatSend).toHaveBeenCalledWith('Answer to your question:\n\nQ: Keep writes blocked?\nA: Yes');
    expect(sendInput).not.toHaveBeenCalled();
    // Busy chat instance, no echo yet: stays locked rather than inviting a second send.
    expect(sendButton(root)).toBeNull();
    expect(root.textContent).toContain('Sending');
  });

  it('sends the chosen option for each of several questions', async () => {
    const root = await render(question([
      { title: 'Data?', options: ['Catalogue only', 'With history'] },
      { title: 'Envs?', options: ['Synthetic', 'Real'] },
    ]));
    const second = root.querySelectorAll<HTMLInputElement>('fieldset')[1].querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
    second.click();
    fixture.detectChanges();

    sendButton(root)!.click();
    await settle();

    expect(sendInput).toHaveBeenCalledWith(
      'inst-1',
      'Answers to your questions:\n\nQ: Data?\nA: Catalogue only\n\nQ: Envs?\nA: Real',
    );
  });

  it('requires text for Other and for free-text-only questions', async () => {
    const root = await render(question([{ title: 'Why?', options: null }]));
    expect(root.querySelectorAll('input[type="radio"]').length).toBe(0);
    expect(sendButton(root)!.disabled).toBe(true);

    const text = root.querySelector<HTMLInputElement>('input.aq__text')!;
    text.value = 'Because of LT-029';
    text.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(sendButton(root)!.disabled).toBe(false);

    sendButton(root)!.click();
    await settle();
    expect(sendInput).toHaveBeenCalledWith('inst-1', 'Answer to your question:\n\nQ: Why?\nA: Because of LT-029');
  });

  it('addresses a subagent question for relay through the root session', async () => {
    const root = await render(question([{ title: 'Branch?', options: ['main'] }], { subagentLabel: '/root/reviewer' }));
    sendButton(root)!.click();
    await settle();
    expect(sendInput).toHaveBeenCalledWith(
      'inst-1',
      'Answer for subagent /root/reviewer, please pass it on:\n\nQ: Branch?\nA: main',
    );
  });

  it('stays open after an unrelated follow-up but closes for this question\'s own reply', async () => {
    const message = question([{ title: 'Keep writes blocked?', options: ['Yes', 'No'] }]);
    const followUp = { id: 'u1', timestamp: 2, type: 'user', content: 'also check module X' } as OutputMessage;
    const open = await render(message, [message, followUp]);
    expect(sendButton(open)).not.toBeNull();
    expect(open.querySelector('fieldset')!.disabled).toBe(false);

    const reply = { id: 'u2', timestamp: 3, type: 'user', content: 'Answer to your question:\n\nQ: Keep writes blocked?\nA: No' } as OutputMessage;
    const closed = await render(message, [message, followUp, reply]);
    expect(sendButton(closed)).toBeNull();
    expect(closed.textContent).toContain('Your reply is in the conversation below');
  });

  it('renders nothing when the message carries no usable questions', async () => {
    const root = await render(question(undefined));
    expect(root.querySelector('form')).toBeNull();
  });
});
