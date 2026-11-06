import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import type { UserActionRequest } from '../orchestration/orchestration-handler.types';
import type { SettledUserAction, UserActionEnd } from '../orchestration/user-action-lifecycle';
import type { RequestReceiptMetadata } from '../../shared/utils/request-receipt-message';
import { InputRequestReceiptRecorder, type NativeReply } from './input-request-receipts';

interface Written { instanceId: string; content: string; metadata: RequestReceiptMetadata }

describe('InputRequestReceiptRecorder', () => {
  let written: Written[];
  let yolo: boolean;
  let recorder: InputRequestReceiptRecorder;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    written = [];
    yolo = false;
    recorder = new InputRequestReceiptRecorder({
      writeReceipt: (instanceId, content, metadata) => written.push({ instanceId, content, metadata }),
      isYoloOn: () => yolo,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const lines = () => written.map((entry) => entry.content);

  function ask(type: string, extra: Record<string, unknown> = {}, requestId = 'req-1', instanceId = 'i-1'): void {
    recorder.observeInputRequired({ instanceId, requestId, timestamp: Date.now(), metadata: { type, ...extra } });
  }

  function reply(fields: Partial<NativeReply> = {}, requestId = 'req-1', instanceId = 'i-1'): void {
    try { recorder.beginReply(instanceId, requestId).commit({ response: 'ok', ...fields }); } catch (error) {
      if ((error as { code?: string }).code !== 'INPUT_REQUIRED_NOT_PENDING') throw error;
    }
  }

  describe('a permission the person answered in the window', () => {
    it.each([
      ['once', 'You allowed once: Bash'],
      ['session', 'You allowed for this session: Bash'],
      ['always', 'You always allowed: Bash'],
    ] as const)('says what was allowed and for how long (%s)', (scope, text) => {
      ask('deferred_permission', { tool_name: 'Bash' });

      reply({ decision: { action: 'allow', scope } });

      expect(lines()).toEqual([text]);
      expect(written[0]?.instanceId).toBe('i-1');
      expect(written[0]?.metadata).toEqual({
        audience: 'attention',
        presentationKind: 'request-receipt',
        requestId: 'req-1',
        outcome: 'allowed',
        requestedAt: 1_000_000,
      });
    });

    it('says no when the person said no', () => {
      ask('deferred_permission', { tool_name: 'Bash' });

      reply({ decision: { action: 'deny' } });

      expect(lines()).toEqual(['You said no: Bash']);
      expect(written[0]?.metadata.outcome).toBe('denied');
    });

    it('counts an allow with changes as an allow', () => {
      ask('deferred_permission', { tool_name: 'Bash' });

      reply({ decision: { action: 'modify', scope: 'once' } });

      expect(lines()).toEqual(['You allowed once: Bash']);
    });

    it('says a permission that was always allowed once the rule was really saved', () => {
      ask('permission_denial', { tool_name: 'Edit', path: '/work/a.txt' });

      reply({ decision: { action: 'allow', scope: 'always' }, grant: 'saved' });

      expect(lines()).toEqual(['You always allowed: Edit']);
    });

    it('says nothing when the rule could not be saved, because nothing was allowed', () => {
      ask('permission_denial', { tool_name: 'Edit', path: '/work/a.txt' });

      reply({ decision: { action: 'allow', scope: 'always' }, grant: 'failed' });

      expect(written).toEqual([]);
      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'exited' });
      expect(written).toEqual([]);
    });

    it('says no for a denial the person turned down, and dismissed when there was only OK to press', () => {
      ask('permission_denial', { tool_name: 'Edit' }, 'can-allow');
      ask('permission_denial', { tool_name: 'NotebookEdit' }, 'ok-only');

      reply({}, 'can-allow');
      reply({}, 'ok-only');

      expect(lines()).toEqual(['You said no: Edit', 'You dismissed: NotebookEdit']);
    });

    it('says auto-approve was switched on when the answer turned it on', () => {
      ask('deferred_permission', { tool_name: 'Bash' });

      reply({ decision: { action: 'allow', scope: 'once' }, enabledYolo: true });

      expect(lines()).toEqual(['You switched on auto-approve']);
    });

    it('does not claim an allow when the reply carried no decision', () => {
      ask('deferred_permission', { tool_name: 'Bash' });

      reply({});

      expect(written).toEqual([]);
    });

    it('words an ACP permission answer as typed, and a cancel as a no', () => {
      ask('acp_permission_request', { transport: 'acp', tool_name: 'fetch' }, 'acp-1');
      ask('acp_permission_request', { transport: 'acp', tool_name: 'fetch' }, 'acp-2');

      reply({ response: 'allow_once' }, 'acp-1');
      reply({ response: 'cancel' }, 'acp-2');

      expect(lines()).toEqual(['You answered: allow_once', 'You said no: fetch']);
    });
  });

  describe('a question the person answered', () => {
    it('quotes the answer', () => {
      ask('ask_user_question');

      reply({ response: 'Bun' });

      expect(lines()).toEqual(['You answered: Bun']);
      expect(written[0]?.metadata.outcome).toBe('answered');
    });

    it('keeps only the first 60 characters of a long answer', () => {
      ask('ask_user_question');

      reply({ response: 'a'.repeat(200) });

      expect(lines()).toEqual([`You answered: ${'a'.repeat(60)}…`]);
    });

    it('prefers the person\'s own short summary of a multi-part answer', () => {
      ask('ask_user_question');

      reply({ response: 'Package manager?: Bun\nEditor?: vim', receipt: { kind: 'answered', summary: 'Bun; vim' } });

      expect(lines()).toEqual(['You answered: Bun; vim']);
    });

    it('says the question was skipped', () => {
      ask('acp_elicitation', { transport: 'acp' });

      reply({ response: 'cancel', receipt: { kind: 'skipped' } });

      expect(lines()).toEqual(['You skipped the question']);
    });

    it('never lets a renderer-supplied hint reword an approval', () => {
      ask('deferred_permission', { tool_name: 'Bash' });

      reply({ decision: { action: 'deny' }, receipt: { kind: 'answered', summary: 'You allowed everything' } });

      expect(lines()).toEqual(['You said no: Bash']);
    });
  });

  describe('a request that ended without the person', () => {
    it('says how long nobody answered, and that nothing ran, for an approval', () => {
      ask('deferred_permission', { tool_name: 'Bash' });
      vi.advanceTimersByTime(300_000);

      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'timeout' });

      expect(lines()).toEqual(['No answer in 5 minutes; nothing ran']);
      expect(written[0]?.metadata).toMatchObject({ outcome: 'timeout', subject: 'Bash', presentationKind: 'request-receipt' });
    });

    it('says a question was dropped', () => {
      ask('ask_user_question');
      vi.advanceTimersByTime(60_000);

      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'timeout' });

      expect(lines()).toEqual(['No answer in 1 minute; the question was dropped']);
    });

    it.each([
      ['auto_approved', 'Allowed automatically'],
      ['cancelled', 'Cancelled when the session was stopped'],
      ['exited', 'Cancelled when the session closed'],
      ['decided', 'Answered elsewhere'],
    ] as const)('words %s plainly', (reason, text) => {
      ask('codex_mcp_approval', { toolName: 'fetch' });

      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason });

      expect(lines()).toEqual([text]);
      expect(written[0]?.metadata).toMatchObject({ outcome: reason, subject: 'fetch' });
    });

    it('writes nothing for a request the window never showed', () => {
      recorder.inputResolved({ instanceId: 'i-1', requestId: 'never-seen', reason: 'timeout' });

      expect(written).toEqual([]);
    });

    it('writes nothing for a prompt YOLO hides from the window', () => {
      yolo = true;
      ask('deferred_permission', { tool_name: 'Bash' });

      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'exited' });

      expect(written).toEqual([]);
    });

    it('still tracks a denial or a question while YOLO is on, because the window shows those', () => {
      yolo = true;
      ask('ask_user_question');

      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'exited' });

      expect(lines()).toEqual(['Cancelled when the session closed']);
    });

    it('writes only one line however many times it is told', () => {
      ask('deferred_permission', { tool_name: 'Bash' });

      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'timeout' });
      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'exited' });
      reply({ decision: { action: 'allow', scope: 'once' } });

      expect(written).toHaveLength(1);
    });

    it('treats a reused request id as a new request once the old one has closed', () => {
      ask('deferred_permission', { tool_name: 'Bash' });
      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'timeout' });

      vi.advanceTimersByTime(1);
      ask('deferred_permission', { tool_name: 'Bash' });
      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'cancelled' });

      expect(lines()).toEqual([
        'No answer in time; nothing ran',
        'Cancelled when the session was stopped',
      ]);
    });
  });

  describe('the person\'s own answer coming back as "decided"', () => {
    it('is not reported as answered elsewhere when it arrives while the reply is still being sent', () => {
      ask('ask_user_question');
      const sending = recorder.beginReply('i-1', 'req-1');

      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'decided' });
      sending.commit({ response: 'Bun' });

      expect(lines()).toEqual(['You answered: Bun']);
    });

    it('is ignored when it arrives after the reply finished', () => {
      ask('ask_user_question');
      reply({ response: 'Bun' });

      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'decided' });

      expect(lines()).toEqual(['You answered: Bun']);
    });

    it('is reported as answered elsewhere if the person\'s own reply then failed', () => {
      ask('ask_user_question');
      const sending = recorder.beginReply('i-1', 'req-1');

      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'decided' });
      sending.abort();

      expect(lines()).toEqual(['Answered elsewhere']);
    });

    it('leaves a request waiting when the reply failed and nothing else happened', () => {
      ask('ask_user_question');
      recorder.beginReply('i-1', 'req-1').abort();
      expect(written).toEqual([]);

      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'timeout' });

      expect(lines()).toEqual(['No answer in time; the question was dropped']);
    });

    it('still reports a timeout that wins the race against the reply', () => {
      ask('ask_user_question');
      const sending = recorder.beginReply('i-1', 'req-1');

      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'timeout' });
      sending.commit({ response: 'too late' });

      expect(lines()).toEqual(['No answer in time; the question was dropped']);
    });

    it('does nothing when the reply is for a request it never saw', () => {
      expect(() => recorder.beginReply('i-1', 'never-seen')).toThrow('already closed');

      expect(written).toEqual([]);
    });
  });

  it('does not confuse request/session pairs containing colons', () => {
    ask('ask_user_question', {}, 'b:c', 'a');
    ask('ask_user_question', {}, 'c', 'a:b');
    reply({ response: 'first' }, 'b:c', 'a');
    reply({ response: 'second' }, 'c', 'a:b');
    expect(written.map(row => [row.instanceId, row.content])).toEqual([
      ['a', 'You answered: first'], ['a:b', 'You answered: second'],
    ]);
  });

  it('does not reopen a closed request when the same event is replayed', () => {
    ask('ask_user_question');
    reply({ response: 'Bun' });
    ask('ask_user_question');
    recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'decided' });
    expect(lines()).toEqual(['You answered: Bun']);
  });

  it('refuses a concurrent reply before it can dispatch a second answer', () => {
    ask('ask_user_question');
    const first = recorder.beginReply('i-1', 'req-1');
    expect(() => recorder.beginReply('i-1', 'req-1')).toThrow('already being sent');
    first.commit({ response: 'Bun' });
    expect(lines()).toEqual(['You answered: Bun']);
  });

  describe('the session changing under an open request', () => {
    it('closes open requests as cancelled when the turn is being stopped', () => {
      ask('deferred_permission', { tool_name: 'Bash' });

      recorder.statusChanged('i-1', 'interrupting');

      expect(lines()).toEqual(['Cancelled when the session was stopped']);
    });

    it.each(['terminated', 'failed', 'error', 'cancelled', 'hibernated', 'respawning', 'initializing', 'waking'])(
      'closes open requests as exited when the session is %s',
      (status) => {
        ask('deferred_permission', { tool_name: 'Bash' });

        recorder.statusChanged('i-1', status);

        expect(lines()).toEqual(['Cancelled when the session closed']);
      },
    );

    it('leaves open requests alone for an ordinary status', () => {
      ask('deferred_permission', { tool_name: 'Bash' });

      for (const status of ['busy', 'idle', 'waiting_for_input', 'waiting_for_permission']) {
        recorder.statusChanged('i-1', status);
      }

      expect(written).toEqual([]);
    });

    it('does not close a request whose answer is still being applied', () => {
      ask('permission_denial', { tool_name: 'Edit' });
      const sending = recorder.beginReply('i-1', 'req-1');

      recorder.statusChanged('i-1', 'respawning');
      sending.commit({ response: 'approved', decision: { action: 'allow', scope: 'always' }, grant: 'saved' });

      expect(lines()).toEqual(['You always allowed: Edit']);
    });

    it('only touches the session that changed', () => {
      ask('deferred_permission', { tool_name: 'Bash' }, 'a', 'i-1');
      ask('deferred_permission', { tool_name: 'Bash' }, 'b', 'i-2');

      recorder.statusChanged('i-2', 'terminated');

      expect(written.map((entry) => [entry.instanceId, entry.metadata.requestId])).toEqual([['i-2', 'b']]);
    });

    it('says approvals were allowed automatically when YOLO is switched on, and quietly closes the rest', () => {
      ask('deferred_permission', { tool_name: 'Bash' }, 'approval');
      ask('mcp_elicitation', {}, 'mcp-question');
      ask('ask_user_question', {}, 'question');

      recorder.yoloEnabled('i-1');

      expect(lines()).toEqual(['Allowed automatically']);
      recorder.inputResolved({ instanceId: 'i-1', requestId: 'mcp-question', reason: 'exited' });
      expect(lines()).toEqual(['Allowed automatically']);
      recorder.inputResolved({ instanceId: 'i-1', requestId: 'question', reason: 'exited' });
      expect(lines()).toEqual(['Allowed automatically', 'Cancelled when the session closed']);
    });

    it('forgets everything about a removed session', () => {
      ask('deferred_permission', { tool_name: 'Bash' });

      recorder.forgetInstance('i-1');
      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'timeout' });

      expect(written).toEqual([]);
    });
  });

  describe('a secret card', () => {
    it('says what was saved by its label, never by anything else', () => {
      ask('secret_required', { name: 'github-pat', label: 'GitHub personal access token', purpose: 'Install' });

      recorder.secretHandled({ instanceId: 'i-1', requestId: 'req-1', outcome: 'saved' });

      expect(lines()).toEqual(['You saved: GitHub personal access token']);
      expect(written[0]?.metadata.outcome).toBe('saved');
    });

    it('falls back to the secret\'s name when it has no label', () => {
      ask('secret_required', { name: 'github-pat' });

      recorder.secretHandled({ instanceId: 'i-1', requestId: 'req-1', outcome: 'declined' });

      expect(lines()).toEqual(['You said no: github-pat']);
    });

    it('is not worded as a question or an approval when it ends without the person', () => {
      ask('secret_required', { name: 'github-pat', label: 'GitHub token' });

      recorder.inputResolved({ instanceId: 'i-1', requestId: 'req-1', reason: 'timeout' });

      expect(lines()).toEqual(['No answer in time; the question was dropped']);
    });
  });
});

describe('InputRequestReceiptRecorder with orchestrator cards', () => {
  let written: Written[];
  let recorder: InputRequestReceiptRecorder;

  beforeEach(() => {
    written = [];
    recorder = new InputRequestReceiptRecorder({
      writeReceipt: (instanceId, content, metadata) => written.push({ instanceId, content, metadata }),
      isYoloOn: () => false,
    });
  });

  const lines = () => written.map((entry) => entry.content);

  function settle(request: Partial<UserActionRequest>, end: UserActionEnd, waitedMs = 1_000): void {
    const full: UserActionRequest = {
      id: 'uar-1', instanceId: 'i-1', requestType: 'confirm', title: 'Proceed?', message: 'Run it?', createdAt: 5, ...request,
    };
    const settled: SettledUserAction = { request: full, waitedMs, end };
    recorder.userActionSettled(settled);
  }

  const decided = (approved: boolean, selectedOption?: string, via: 'window' | 'typed-reply' | 'elsewhere' = 'window'): UserActionEnd =>
    ({ reason: 'decided', approved, selectedOption, via });

  describe('a tool the person was asked about', () => {
    const picker: Partial<UserActionRequest> = {
      requestType: 'select_option',
      title: 'Tool Permission Required',
      options: [{ id: 'allow_once', label: 'Allow once' }, { id: 'deny_once', label: 'Deny once' }],
      context: { suppressInjectResponse: true, permission: { scope: 'tool_use', resource: 'read_file' } },
    };

    it.each([
      ['allow_once', 'You allowed once: read_file'],
      ['allow_session', 'You allowed for this session: read_file'],
      ['allow_always', 'You always allowed: read_file'],
      ['deny_once', 'You said no: read_file'],
      ['deny_always', 'You said no: read_file'],
    ])('says what %s meant', (selectedOption, text) => {
      settle(picker, decided(true, selectedOption));

      expect(lines()).toEqual([text]);
    });

    it('says no when the reply carried no option', () => {
      settle(picker, decided(false, undefined));

      expect(lines()).toEqual(['You said no: read_file']);
    });

    it('says nothing ran when nobody answered in time', () => {
      settle(picker, { reason: 'timeout' }, 300_000);

      expect(lines()).toEqual(['No answer in 5 minutes; nothing ran']);
      expect(written[0]?.metadata).toMatchObject({ outcome: 'timeout', subject: 'read_file', requestId: 'uar-1', requestedAt: 5 });
    });

    it('says it was cancelled when the turn was stopped', () => {
      settle(picker, { reason: 'cancelled' });

      expect(lines()).toEqual(['Cancelled when the session was stopped']);
    });

    it('says it was cancelled when the session closed', () => {
      settle(picker, { reason: 'exited' });

      expect(lines()).toEqual(['Cancelled when the session closed']);
    });

    it('says it was answered elsewhere when the answer came from another screen', () => {
      settle(picker, decided(true, 'allow_once', 'elsewhere'));

      expect(lines()).toEqual(['Answered elsewhere']);
      expect(written[0]?.metadata).toMatchObject({ outcome: 'decided', subject: 'read_file' });
    });
  });

  describe('a question or confirmation the model raised', () => {
    it('says what was approved or declined, named by the card\'s title', () => {
      settle({ requestType: 'switch_mode', title: 'Switch to Plan Mode' }, decided(true));
      settle({ id: 'uar-2', requestType: 'confirm', title: 'Delete the branch' }, decided(false));
      settle({ id: 'uar-3', requestType: 'approve_action', title: 'Push to origin' }, decided(true, undefined, 'typed-reply'));

      expect(lines()).toEqual(['You approved: Switch to Plan Mode', 'You said no: Delete the branch', 'You approved: Push to origin']);
    });

    it('says which option was chosen, by its label', () => {
      const options = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }];
      settle({ requestType: 'select_option', options }, decided(true, 'b'));

      expect(lines()).toEqual(['You chose: Beta']);
    });

    it('quotes a typed answer that names no option, and says skipped for no answer', () => {
      const options = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }];
      settle({ requestType: 'select_option', options }, decided(true, 'Gamma please'));
      settle({ id: 'uar-2', requestType: 'select_option', options }, decided(false));

      expect(lines()).toEqual(['You answered: Gamma please', 'You skipped the question']);
    });

    it('joins the answers to several questions on one line', () => {
      settle(
        { requestType: 'ask_questions', questions: ['Name?', 'Colour?'] },
        decided(true, JSON.stringify({ 'Name?': 'Ada', 'Colour?': 'green' })),
      );

      expect(lines()).toEqual(['You answered: Ada; green']);
    });

    it('says skipped when the questions were declined, and keeps a plain answer as typed', () => {
      settle({ requestType: 'ask_questions', questions: ['Name?'] }, decided(false));
      settle({ id: 'uar-2', requestType: 'ask_questions', questions: ['Name?'] }, decided(true, 'just Ada'));

      expect(lines()).toEqual(['You skipped the question', 'You answered: just Ada']);
    });

    it('keeps only the first 60 characters of an answer', () => {
      settle({ requestType: 'ask_questions', questions: ['Name?'] }, decided(true, 'b'.repeat(90)));

      expect(lines()).toEqual([`You answered: ${'b'.repeat(60)}…`]);
    });

    it('names the card in the receipt when nobody answered in time', () => {
      settle({ requestType: 'confirm', title: 'Delete the branch' }, { reason: 'exited' });

      expect(lines()).toEqual(['Cancelled when the session closed']);
      expect(written[0]?.metadata.subject).toBe('Delete the branch');
    });
  });

  describe('a secret card', () => {
    const secret: Partial<UserActionRequest> = {
      requestType: 'secret_required',
      title: 'Credential needed',
      secretRequest: { name: 'DEPLOY_TOKEN', label: 'Deployment token', purpose: 'Deploy' },
    };

    it('says what was saved by its label, and never repeats the reference that came with the answer', () => {
      settle(secret, decided(true, 'secret://deploy-token'));

      expect(lines()).toEqual(['You saved: Deployment token']);
      expect(JSON.stringify(written)).not.toContain('secret://');
    });

    it('says no by its label when it was declined', () => {
      settle(secret, decided(false));

      expect(lines()).toEqual(['You said no: Deployment token']);
    });
  });

  it('writes one line for a request however often it is told', () => {
    settle({}, decided(true));
    settle({}, decided(false));
    settle({}, { reason: 'timeout' });

    expect(written).toHaveLength(1);
  });
});
