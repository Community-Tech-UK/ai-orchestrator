import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { choiceFor, RequestReceiptStore, RECEIPT_LIFETIME_MS } from './user-input-request.receipts';
import type { UserActionRequest } from './user-action-request.types';

function approval(id: string, tool = 'Bash', instanceId = 'inst-1'): UserActionRequest {
  return {
    id,
    instanceId,
    requestType: 'input_required',
    title: 'Permission Required',
    message: 'Allow it?',
    createdAt: 1,
    permissionMetadata: { type: 'deferred_permission', tool_name: tool },
  };
}

function question(id: string, instanceId = 'inst-1'): UserActionRequest {
  return {
    id,
    instanceId,
    requestType: 'input_required',
    title: 'Agent has a question',
    message: 'Which one?',
    createdAt: 1,
    permissionMetadata: { type: 'acp_elicitation' },
  };
}

describe('RequestReceiptStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves a line for what the person chose', () => {
    const store = new RequestReceiptStore();
    store.shown(approval('r1'));
    store.chose('r1', { kind: 'allowed', scope: 'once', tool: 'Bash' }, 'inst-1');
    expect(store.forSession('inst-1').map((receipt) => receipt.text)).toEqual(['You allowed once: Bash']);
  });

  it('shows a session only its own receipts', () => {
    const store = new RequestReceiptStore();
    store.shown(approval('r1', 'Bash', 'inst-1'));
    store.shown(approval('r2', 'Edit', 'inst-2'));
    store.chose('r1', { kind: 'denied', tool: 'Bash' }, 'inst-1');
    store.chose('r2', { kind: 'denied', tool: 'Edit' }, 'inst-2');
    expect(store.forSession('inst-2').map((receipt) => receipt.text)).toEqual(['You said no: Edit']);
    expect(store.forSession(null)).toEqual([]);
  });

  it('keeps colliding request ids independent across sessions', () => {
    const store = new RequestReceiptStore();
    store.shown(question('shared', 'inst-1'));
    store.shown(question('shared', 'inst-2'));
    store.closed('shared', 'timeout', 'inst-2');
    store.chose('shared', { kind: 'answered', answer: 'Bun' }, 'inst-1');
    expect(store.forSession('inst-1').map(row => row.text)).toEqual(['You answered: Bun']);
    expect(store.forSession('inst-2').map(row => row.text)).toEqual(['No answer in time; the question was dropped']);
  });

  it('says how long an approval waited, measured here, and that nothing ran', () => {
    const store = new RequestReceiptStore();
    store.shown(approval('r1'));
    vi.advanceTimersByTime(300_000);
    store.closed('r1', 'timeout', 'inst-1');
    expect(store.forSession('inst-1')[0]).toMatchObject({
      text: 'No answer in 5 minutes; nothing ran',
      subject: 'Bash',
    });
  });

  it('words a timed-out question as dropped, not as something that ran', () => {
    const store = new RequestReceiptStore();
    store.shown(question('q1'));
    vi.advanceTimersByTime(60_000);
    store.closed('q1', 'timeout', 'inst-1');
    expect(store.forSession('inst-1')[0].text).toBe('No answer in 1 minute; the question was dropped');
  });

  it.each([
    ['decided', 'Answered elsewhere'],
    ['exited', 'Cancelled when the session closed'],
    ['cancelled', 'Cancelled when the session was stopped'],
    ['auto_approved', 'Allowed automatically'],
  ] as const)('words a %s close', (reason, text) => {
    const store = new RequestReceiptStore();
    store.shown(question('q1'));
    store.closed('q1', reason, 'inst-1');
    expect(store.forSession('inst-1')[0].text).toBe(text);
  });

  it('keeps one receipt per request, whichever way it closed first', () => {
    const store = new RequestReceiptStore();
    store.shown(approval('r1'));
    store.chose('r1', { kind: 'allowed', scope: 'session', tool: 'Bash' }, 'inst-1');
    store.closed('r1', 'decided', 'inst-1');
    store.shown(approval('r2'));
    store.closed('r2', 'timeout', 'inst-1');
    store.chose('r2', { kind: 'denied', tool: 'Bash' }, 'inst-1');
    expect(store.forSession('inst-1').map((receipt) => receipt.requestId).sort()).toEqual(['r1', 'r2']);
    expect(store.forSession('inst-1').find((receipt) => receipt.requestId === 'r1')?.text).toBe('You allowed for this session: Bash');
    expect(store.forSession('inst-1').find((receipt) => receipt.requestId === 'r2')?.text).toBe('No answer in time; nothing ran');
  });

  it('starts afresh when an adapter reuses a request id after the first one closed', () => {
    const store = new RequestReceiptStore();
    store.shown(approval('acp_permission:1'));
    store.closed('acp_permission:1', 'timeout', 'inst-1');
    vi.advanceTimersByTime(30_000);
    store.shown({ ...approval('acp_permission:1', 'Edit'), createdAt: Date.now() });
    vi.advanceTimersByTime(120_000);
    store.closed('acp_permission:1', 'decided', 'inst-1');
    expect(store.forSession('inst-1').map((receipt) => receipt.text)).toEqual([
      'Answered elsewhere',
      'No answer in time; nothing ran',
    ]);
    expect(store.forSession('inst-1')[0].subject).toBe('Edit');
  });

  it('ignores a request it never saw', () => {
    const store = new RequestReceiptStore();
    store.closed('ghost', 'timeout', 'inst-1');
    store.chose('ghost', { kind: 'skipped' }, 'inst-1');
    expect(store.forSession('inst-1')).toEqual([]);
  });

  it('measures the wait from the first time a request was shown, not a repeat', () => {
    const store = new RequestReceiptStore();
    store.shown(approval('r1'));
    vi.advanceTimersByTime(120_000);
    store.shown(approval('r1'));
    vi.advanceTimersByTime(60_000);
    store.closed('r1', 'timeout', 'inst-1');
    expect(store.forSession('inst-1')[0].text).toBe('No answer in 3 minutes; nothing ran');
  });

  it('keeps only the three newest receipts for a session', () => {
    const store = new RequestReceiptStore();
    for (const id of ['a', 'b', 'c', 'd']) {
      store.shown(question(id));
      store.closed(id, 'decided', 'inst-1');
      vi.advanceTimersByTime(1);
    }
    expect(store.forSession('inst-1').map((receipt) => receipt.requestId)).toEqual(['d', 'c', 'b']);
  });

  it('lets a receipt expire and be dismissed', () => {
    const store = new RequestReceiptStore();
    store.shown(question('q1'));
    store.closed('q1', 'decided', 'inst-1');
    store.shown(question('q2'));
    store.closed('q2', 'decided', 'inst-1');
    store.dismiss(store.forSession('inst-1').find((receipt) => receipt.requestId === 'q1')!.id);
    expect(store.forSession('inst-1').map((receipt) => receipt.requestId)).toEqual(['q2']);
    vi.advanceTimersByTime(RECEIPT_LIFETIME_MS);
    expect(store.forSession('inst-1')).toEqual([]);
  });

  it('can still explain a request after its card was dropped, when the reason arrives late', () => {
    const store = new RequestReceiptStore();
    store.shown(approval('r1'));
    // The card is gone (a stale reply dropped it); the reason shows up afterwards.
    vi.advanceTimersByTime(60_000);
    store.closed('r1', 'timeout', 'inst-1');
    expect(store.forSession('inst-1')[0].text).toBe('No answer in 1 minute; nothing ran');
  });

  it.each(['before', 'after'] as const)('replaces temporary feedback when durable history arrives %s acknowledgement', order => {
    const store = new RequestReceiptStore();
    store.shown(question('q1'));
    const message = { type: 'system', content: 'You answered: Bun', metadata: {
      presentationKind: 'request-receipt', requestId: 'q1', requestedAt: 1, outcome: 'answered', audience: 'attention',
    } };
    if (order === 'after') store.chose('q1', { kind: 'answered', answer: 'Bun' }, 'inst-1');
    store.observeHistory('inst-1', [message, message]);
    store.chose('q1', { kind: 'answered', answer: 'Bun' }, 'inst-1');
    expect(store.forSession('inst-1')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    store.shown(question('q1'));
    store.closed('q1', 'decided', 'inst-1');
    expect(store.forSession('inst-1')).toEqual([]);
  });

  it('deduplicates a replayed receipt after a renderer reload but permits a new generation', () => {
    const store = new RequestReceiptStore();
    store.observeHistory('inst-1', [{ type: 'system', content: 'You answered: Bun', metadata: {
      presentationKind: 'request-receipt', requestId: 'q1', requestedAt: 1,
    } }]);
    store.shown(question('q1'));
    store.closed('q1', 'decided', 'inst-1');
    expect(store.forSession('inst-1')).toEqual([]);
    store.shown({ ...question('q1'), createdAt: 2 });
    store.chose('q1', { kind: 'answered', answer: 'NPM' }, 'inst-1');
    expect(store.forSession('inst-1').map(row => row.text)).toEqual(['You answered: NPM']);
  });

  it('stops its timers when the app shuts the store down', () => {
    const store = new RequestReceiptStore();
    store.shown(question('q1'));
    store.closed('q1', 'decided', 'inst-1');
    store.ngOnDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('choiceFor', () => {
  const base = { id: 'r1', instanceId: 'inst-1', title: 'Title', message: 'Message', createdAt: 1 } as const;

  it('reads an allow or a no on a Claude or Codex approval', () => {
    const held: UserActionRequest = {
      ...base,
      requestType: 'input_required',
      permissionMetadata: { type: 'deferred_permission', tool_name: 'Bash' },
    };
    expect(choiceFor(held, { approved: true, scope: 'session' })).toEqual({ kind: 'allowed', scope: 'session', tool: 'Bash' });
    expect(choiceFor(held, { approved: true })).toEqual({ kind: 'allowed', scope: 'once', tool: 'Bash' });
    expect(choiceFor(held, { approved: false })).toEqual({ kind: 'denied', tool: 'Bash' });
    expect(choiceFor(held, { approved: false, acknowledgedOnly: true })).toEqual({ kind: 'dismissed', tool: 'Bash' });
  });

  it('quotes what was typed into an ACP permission box instead of guessing what it meant', () => {
    const acp: UserActionRequest = {
      ...base,
      requestType: 'input_required',
      permissionMetadata: { type: 'acp_permission_request', transport: 'acp' },
    };
    expect(choiceFor(acp, { approved: true, reply: 'allow' })).toEqual({ kind: 'answered', answer: 'allow' });
    expect(choiceFor(acp, { approved: false, reply: 'cancel' })).toEqual({ kind: 'denied', tool: undefined });
  });

  it('reads an answer or a skip on a question', () => {
    const asked: UserActionRequest = { ...base, requestType: 'input_required', permissionMetadata: { type: 'acp_elicitation' } };
    expect(choiceFor(asked, { approved: true, reply: 'Bun' })).toEqual({ kind: 'answered', answer: 'Bun' });
    expect(choiceFor(asked, { approved: false })).toEqual({ kind: 'skipped' });
  });

  it('reads the orchestrator tool-permission picker as an allow or a no, from the option id', () => {
    const picker: UserActionRequest = {
      ...base,
      requestType: 'select_option',
      options: [{ id: 'allow_session', label: 'Allow for session' }, { id: 'deny_once', label: 'Deny once' }],
      context: { permission: { scope: 'tool_use', resource: 'read_file' } },
    };
    expect(choiceFor(picker, { approved: true, reply: 'allow_session' })).toEqual({ kind: 'allowed', scope: 'session', tool: 'read_file' });
    expect(choiceFor(picker, { approved: true, reply: 'deny_once' })).toEqual({ kind: 'denied', tool: 'read_file' });
  });

  it('reads a pick from an orchestrator choice card by its label, and any other text as an answer', () => {
    const choice: UserActionRequest = { ...base, requestType: 'select_option', options: [{ id: 'a', label: 'Alpha' }] };
    expect(choiceFor(choice, { approved: true, reply: 'a' })).toEqual({ kind: 'chose', label: 'Alpha' });
    expect(choiceFor(choice, { approved: true, reply: 'Something else' })).toEqual({ kind: 'answered', answer: 'Something else' });
  });

  it('reads an orchestrator confirmation by its title', () => {
    const confirm: UserActionRequest = { ...base, requestType: 'switch_mode', title: 'Switch to Plan Mode' };
    expect(choiceFor(confirm, { approved: true })).toEqual({ kind: 'approved', what: 'Switch to Plan Mode' });
    expect(choiceFor(confirm, { approved: false })).toEqual({ kind: 'declined', what: 'Switch to Plan Mode' });
  });
});
