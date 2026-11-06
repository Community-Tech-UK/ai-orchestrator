/**
 * Renders the real OutputStreamComponent with a seeded transcript and checks
 * what appears on the page: the quiet note under each finished turn, the failed
 * edit warning, the "Changed N files" button and the tool group header.
 *
 * Only the two things the component asks the outside world are faked: the
 * session record (so a turn can be busy or idle) and the main-process answer
 * about changed files. Everything else, including the display-item processor
 * and the child components, is the real thing.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnBaselineResult } from '../../../../shared/types/turn-file-changes.types';
import { InstanceIpcService } from '../../core/services/ipc';
import { TurnBaselineIpcService } from '../../core/services/ipc/turn-baseline-ipc.service';
import { InstanceStore } from '../../core/state/instance/instance.store';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import { OutputStreamComponent } from './output-stream.component';
import { RequestReceiptStore } from './user-input-request.receipts';
import { RunFailureStateService } from './run-failure-state.service';
import { POST_CLICK_BLOCK_MS } from '../../shared/tooltip/tooltip-policy';

// The component and several of its children keep their template and styles in
// separate files. Find them by name once, so the real files are what renders.
const resourcePaths = new Map<string, string>();
function indexResources(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) indexResources(full);
    else if (/\.(html|scss|css)$/.test(entry.name)) resourcePaths.set(entry.name, full);
  }
}
indexResources(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));

await resolveComponentResources((url) => {
  const path = resourcePaths.get(basename(url));
  return path
    ? Promise.resolve(readFileSync(path, 'utf8'))
    : Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

let sequence = 0;

function msg(type: OutputMessage['type'], at: number, extra: Partial<OutputMessage> = {}): OutputMessage {
  sequence += 1;
  return { id: `m${sequence}`, timestamp: at, type, content: '', ...extra };
}

const user = (at: number, id: string, content = 'please do it') => msg('user', at, { id, content });
const reply = (at: number, id: string, content = 'Done.') => msg('assistant', at, { id, content });
const bash = (at: number, id: string, command = 'ls') =>
  msg('tool_use', at, { content: 'Using tool', metadata: { name: 'Bash', id, input: { command } } });
const bashDone = (at: number, id: string, extra: Record<string, unknown> = {}) =>
  msg('tool_result', at, { metadata: { name: 'Bash', id, exitCode: 0, status: 'completed', is_error: false, isCheck: false, checkFailed: false, ...extra } });

describe('OutputStreamComponent turn notes', () => {
  interface Session { status: string; workingDirectory: string; executionLocation?: { type: string } }
  const session = signal<Session | undefined>({ status: 'idle', workingDirectory: '/repo' });
  const getTurnFileChanges = vi.fn<(instanceId: string, turnKey: string) => Promise<TurnBaselineResult | null>>();
  let fixture: ComponentFixture<OutputStreamComponent>;
  let host: HTMLElement;

  async function render(messages: OutputMessage[], inputs: Record<string, unknown> = {}): Promise<void> {
    fixture.componentRef.setInput('messages', messages);
    fixture.componentRef.setInput('instanceId', 'inst-1');
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
    await settle();
  }

  async function settle(): Promise<void> {
    for (let pass = 0; pass < 3; pass += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();
    }
  }

  const notes = () => Array.from(host.querySelectorAll('app-turn-summary-row'));
  const text = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

  beforeEach(async () => {
    sequence = 0;
    getTurnFileChanges.mockReset();
    getTurnFileChanges.mockResolvedValue({ state: 'unavailable', reason: 'no-baseline' });
    session.set({ status: 'idle', workingDirectory: '/repo' });
    await TestBed.configureTestingModule({
      imports: [OutputStreamComponent],
      providers: [
        { provide: InstanceStore, useValue: { getInstance: () => session(), setSelectedInstance: vi.fn() } },
        { provide: TurnBaselineIpcService, useValue: { getTurnFileChanges } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(OutputStreamComponent);
    host = fixture.nativeElement as HTMLElement;
  });

  const finishedTurn = () => [
    user(1_000, 'u1'), bash(2_000, 'b1'), bashDone(2_100, 'b1'), reply(13_000, 'r1'),
    user(20_000, 'u2'), reply(21_000, 'r2'),
  ];

  const rowNote = (rowId: string) => host.querySelector(`[data-item-id="${rowId}"] app-turn-summary-row`);

  it('renders a transcript with no note when nothing worth saying happened', async () => {
    await render([user(1_000, 'u1'), reply(2_000, 'r1', 'Hello there.')]);
    expect(text(host)).toContain('Hello there.');
    expect(notes()).toHaveLength(0);
  });

  describe('the note under a finished turn', () => {
    it('sits under the turn\'s last row and says what the turn did', async () => {
      await render(finishedTurn());
      expect(notes()).toHaveLength(1);
      expect(rowNote('msg-r1')).toBeTruthy();
      expect(rowNote('msg-r2')).toBeNull();
      expect(text(rowNote('msg-r1'))).toBe('12 s · ran 1 command');
    });

    it('replaces the tool group\'s old label: the group keeps its expand control only', async () => {
      await render(finishedTurn());
      const group = host.querySelector('app-tool-group')!;
      expect(text(group.querySelector('.tool-label'))).toBe('Tool calls');
      expect(group.querySelector('.tool-failed')).toBeNull();
      expect(text(group)).not.toMatch(/\d+ calls?|characters|externalized/);
    });

    it('counts a failure in both the group and the note, but not a search that found nothing', async () => {
      await render([
        user(1_000, 'u1'),
        bash(2_000, 'b1', 'rg missing src'), bashDone(2_100, 'b1', { exitCode: 1 }),
        bash(3_000, 'b2', 'make'), bashDone(3_100, 'b2', { status: 'failed', is_error: true }),
        reply(13_000, 'r1'),
      ]);
      expect(text(host.querySelector('app-tool-group .tool-failed'))).toBe('1 failed');
      expect(text(rowNote('msg-r1'))).toBe('12 s · ran 2 commands · 1 failed');
    });

    it('still writes the note when tool calls are hidden', async () => {
      await render(finishedTurn(), { showToolMessages: false });
      expect(host.querySelector('app-tool-group')).toBeNull();
      expect(text(rowNote('msg-r1'))).toBe('12 s · ran 1 command');
    });

    it('waits for a turn that is still running, then writes it', async () => {
      session.set({ status: 'busy', workingDirectory: '/repo' });
      await render([user(1_000, 'u1'), bash(2_000, 'b1'), bashDone(2_100, 'b1'), reply(13_000, 'r1')]);
      expect(notes()).toHaveLength(0);

      session.set({ status: 'idle', workingDirectory: '/repo' });
      await settle();
      expect(text(rowNote('msg-r1'))).toBe('12 s · ran 1 command');
    });

    it('works in a view that has no live session record, such as a chat', async () => {
      session.set(undefined);
      await render(finishedTurn());
      expect(text(rowNote('msg-r1'))).toBe('12 s · ran 1 command');
      expect(getTurnFileChanges).not.toHaveBeenCalled();
    });
  });

  describe('the failed-edit warning', () => {
    const editThatFailed = () => [
      msg('tool_use', 2_000, { metadata: { name: 'Edit', id: 'e1', input: { file_path: '/repo/src/a.ts' } } }),
      msg('tool_outcome', 2_100, { content: 'old_string not found', metadata: { tool_use_id: 'e1', is_error: true } }),
    ];

    it('appears under a reply that does not mention the failed edit', async () => {
      await render([user(1_000, 'u1'), ...editThatFailed(), reply(3_000, 'r1', 'All edits applied.')]);
      const warning = text(host.querySelector('.turn-warning'));
      expect(warning).toContain('1 edit failed and was not retried: src/a.ts (the text to change was not found in the file).');
      expect(warning).toContain('Check before trusting the summary.');
    });

    it('does not appear when the turn did not end in a reply, or was interrupted', async () => {
      await render([user(1_000, 'u1'), ...editThatFailed()]);
      expect(host.querySelector('.turn-warning')).toBeNull();

      await render([
        user(5_000, 'u9'), ...editThatFailed(),
        msg('system', 5_500, { content: 'Interrupted — waiting for input' }),
        reply(6_000, 'r9', 'Stopped.'),
      ]);
      expect(host.querySelector('.turn-warning')).toBeNull();
    });
  });

  describe('Changed N files while this reply ran', () => {
    const ready = (overrides: Partial<Extract<TurnBaselineResult, { state: 'ready' }>> = {}): TurnBaselineResult => ({
      state: 'ready', total: 2, truncated: false, baselineCompletedAt: 500, endedAt: 90_000,
      files: [
        { path: 'src/a.ts', status: 'modified', added: 3, deleted: 1 },
        { path: 'src/b.ts', status: 'added', added: 5, deleted: 0 },
      ],
      ...overrides,
    });

    it('shows the real count as a button that asks the host to open the review panel', async () => {
      getTurnFileChanges.mockResolvedValue(ready());
      const requests: { turnKey: string; files: readonly string[] }[] = [];
      fixture.componentInstance.reviewRequested.subscribe((request) => requests.push(request));

      await render(finishedTurn(), { reviewPanelAvailable: true });
      const button = rowNote('msg-r1')!.querySelector('button.changed-btn') as HTMLButtonElement;
      expect(text(button)).toBe('Changed 2 files while this reply ran');
      expect(getTurnFileChanges).toHaveBeenCalledWith('inst-1', 'u1');

      button.click();
      expect(requests).toEqual([{ turnKey: 'u1', files: ['src/a.ts', 'src/b.ts'] }]);
    });

    it('shows the same count as plain text when the host has no review panel to open', async () => {
      getTurnFileChanges.mockResolvedValue(ready());
      await render(finishedTurn());
      expect(host.querySelector('button.changed-btn')).toBeNull();
      expect(text(rowNote('msg-r1')!.querySelector('.changed-line'))).toBe('Changed 2 files while this reply ran');
    });

    it('shows no button when nothing changed or the comparison could not be made', async () => {
      getTurnFileChanges.mockResolvedValue(ready({ total: 0, files: [] }));
      await render(finishedTurn());
      expect(host.querySelector('button.changed-btn')).toBeNull();

      getTurnFileChanges.mockResolvedValue({ state: 'unavailable', reason: 'not-git' });
      await render(finishedTurn().map((message) => ({ ...message, id: `${message.id}b` })));
      expect(host.querySelector('button.changed-btn')).toBeNull();
    });
  });

  describe('rows the note work must not disturb', () => {
    it('still renders compaction markers, restore notices and the legacy summary card', async () => {
      await render([
        user(1_000, 'u1'),
        msg('system', 1_500, {
          content: 'Context compacted',
          metadata: { isCompactionBoundary: true, compactionMarkerId: 'cm1', method: 'native', previousUsage: { percentage: 90 }, newUsage: { percentage: 40 } },
        }),
        msg('system', 1_600, { content: 'Session restored', metadata: { isRestoreNotice: true } }),
        msg('system', 1_700, { content: '', metadata: { kind: 'compaction-summary', reason: 'hard_limit', beforeCount: 10, afterCount: 4, at: 1_700 } }),
        reply(2_000, 'r1', 'Hello there.'),
      ]);
      expect(text(host.querySelector('.compaction-boundary .boundary-label'))).toBe('Context compacted in place (90% → 40%)');
      expect(host.querySelector('.restore-notice')).toBeTruthy();
      const card = text(host.querySelector('.compaction-summary-card'));
      expect(card).toContain('history threshold');
      expect(card).toContain('10 -> 4 messages');
    });

    it('still shows the work-cycle header, thinking and the assistant name', async () => {
      await render([
        user(1_000, 'u1'),
        bash(2_000, 'b1'), bashDone(2_100, 'b1'),
        msg('assistant', 2_200, { id: 'think', content: '', thinking: [{ id: 't', content: 'hmm', format: 'sdk' }] }),
        bash(3_000, 'b2'), bashDone(3_100, 'b2'),
        reply(14_000, 'r1', 'Finished.'),
      ], { provider: 'claude' });
      expect(text(host.querySelector('.work-cycle-header .cycle-summary'))).toBe('1 thought · 2 Bash');
      expect(text(host.querySelector('.work-cycle-header .cycle-duration'))).toBe('1s');
      expect(text(host.querySelector('.message-assistant .message-type, .message .message-type'))).toContain('Claude');
    });

    it('queues recovered context through the compaction marker button', async () => {
      const recover = vi.spyOn(TestBed.inject(InstanceIpcService), 'recoverCompactionContext')
        .mockResolvedValue({ success: true } as never);
      await render([
        user(1_000, 'u1'),
        msg('system', 1_500, { content: 'Context compacted', metadata: { isCompactionBoundary: true, compactionMarkerId: 'cm1' } }),
        reply(2_000, 'r1', 'Hello.'),
      ]);
      const button = host.querySelector('button.boundary-recover-btn') as HTMLButtonElement;
      expect(text(button)).toBe('Recover context');
      button.click();
      await settle();
      expect(recover).toHaveBeenCalledWith('inst-1', 'cm1');
      expect(text(host.querySelector('button.boundary-recover-btn'))).toBe('Queued');
      const queued = host.querySelector('button.boundary-recover-btn') as HTMLButtonElement;
      expect(queued.disabled).toBe(false);
      expect(queued.getAttribute('aria-disabled')).toBe('true');
      const matches = queued.matches.bind(queued);
      vi.spyOn(queued, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
      // A click deliberately suppresses reopening briefly; focus is checked after that policy window.
      await new Promise(resolve => setTimeout(resolve, POST_CLICK_BLOCK_MS + 1));
      queued.dispatchEvent(new FocusEvent('focus'));
      await settle();
      expect(queued.getAttribute('aria-describedby')).toBeTruthy();
      queued.click();
      await settle();
      expect(recover).toHaveBeenCalledTimes(1);
    });
  });

  it('mounts one latest live failure card, and none in a history view', async () => {
    const failure = vi.spyOn(TestBed.inject(RunFailureStateService), 'forInstance').mockReturnValue({
      id: 'failed-latest', at: 4_000,
      presentation: { category: 'network', headline: 'Connection lost', whatToDo: 'Try again.', rawDetail: 'detail' },
    });
    await render([user(1_000, 'u1'), reply(2_000, 'a1'), user(3_000, 'u2'), reply(4_000, 'a2')]);
    expect(host.querySelectorAll('app-run-failure-notice')).toHaveLength(1);
    expect(host.querySelectorAll('[aria-label="Turn stopped"]')).toHaveLength(1);
    expect(failure).toHaveBeenCalledWith('inst-1');
    await render([user(1_000, 'u1'), reply(2_000, 'a1')], { livePromptIndexEnabled: false });
    expect(host.querySelector('app-run-failure-notice')).toBeNull();
  });

  it('keeps error Details closed and text-only, once on each relevant row', async () => {
    const presentation = { category: 'unknown', headline: 'Stopped', whatToDo: 'Retry.', rawDetail: '<img src=x onerror=boom> raw provider detail' };
    await render([
      user(1_000, 'u1'),
      msg('error', 2_000, { content: 'Stopped', metadata: { errorPresentation: presentation } }),
      msg('system', 3_000, { content: 'Restored error', metadata: { errorPresentation: presentation, audience: 'routine' } }),
      reply(4_000, 'r1', 'Reply'),
    ]);
    const details = Array.from(host.querySelectorAll('app-event-error-details details')) as HTMLDetailsElement[];
    expect(details).toHaveLength(2);
    expect(details.every(detail => !detail.open && !detail.querySelector('img'))).toBe(true);
    expect(details[0].querySelector('pre')?.textContent).toBe(presentation.rawDetail);
    expect(host.querySelector('app-system-event-group')).toBeNull();
  });

  it('draws durable request receipts quietly outside routine folds, including old minimal metadata', async () => {
    await render([
      user(1_000, 'u1'),
      msg('system', 2_000, { content: 'You allowed this once.', metadata: { presentationKind: 'request-receipt', requestId: 'request-1', audience: 'routine', subject: 'Read', outcome: 'allow-once', requestedAt: 1_500 } }),
      msg('system', 3_000, { content: 'You answered.', metadata: { presentationKind: 'request-receipt', requestId: 'request-2' } }),
    ]);
    const receipts = host.querySelectorAll('.request-receipt');
    expect(receipts).toHaveLength(2);
    expect(text(receipts[0])).toBe('You allowed this once. (Read)');
    expect(receipts[0].getAttribute('data-request-id')).toBe('request-1');
    expect(text(receipts[1])).toBe('You answered.');
    expect(host.querySelector('.message-system, app-system-event-group')).toBeNull();
  });

  it('lets a durable row supersede local receipt feedback without another visible transcript row', async () => {
    const store = TestBed.inject(RequestReceiptStore);
    store.shown({ id: 'q-local', instanceId: 'inst-1', requestType: 'input_required', title: 'Question',
      message: 'Which one?', createdAt: 1_500, permissionMetadata: { type: 'acp_elicitation' } });
    store.chose('q-local', { kind: 'answered', answer: 'Bun' }, 'inst-1');
    expect(store.forSession('inst-1')).toHaveLength(1);
    const receipt = msg('system', 2_000, { content: 'You answered: Bun', metadata: {
      presentationKind: 'request-receipt', requestId: 'q-local', requestedAt: 1_500,
    } });
    // This is the same handoff the questions worker wires in UserActionRequestComponent.
    store.observeHistory('inst-1', [receipt]);
    await render([user(1_000, 'u1'), receipt]);
    expect(store.forSession('inst-1')).toHaveLength(0);
    expect(host.querySelectorAll('.request-receipt')).toHaveLength(1);
    store.ngOnDestroy();
  });

  it('uses the live provider name for a compaction marker without provider metadata', async () => {
    await render([user(1_000, 'u1'), msg('system', 2_000, {
      content: 'Context compacted', metadata: { isCompactionBoundary: true, method: 'self-managed' },
    })], { provider: 'codex' });
    expect(text(host.querySelector('.boundary-label'))).toContain('Codex compacted its own context');
  });

  it('adds no native title attribute to the note or its button', async () => {
    getTurnFileChanges.mockResolvedValue({
      state: 'ready', total: 1, truncated: false, baselineCompletedAt: 500, endedAt: 90_000,
      files: [{ path: 'a.ts', status: 'modified', added: 1, deleted: 0 }],
    });
    await render(finishedTurn());
    expect(rowNote('msg-r1')!.querySelector('[title]')).toBeNull();
  });
});
