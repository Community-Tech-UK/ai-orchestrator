/**
 * The scripted agent behind a live-test question session.
 *
 * A live test cannot make a real provider ask a question on demand: Harness
 * denies Claude's AskUserQuestion on every launch, Codex only asks in a mode
 * Harness does not start, and OpenCode answers in prose. This peer stands in
 * for the provider's process, so a disposable session raises the same native
 * card a real one would, through the real ACP adapter. It speaks just enough
 * ACP to do that and nothing else: no model, no tools, no files, no network.
 *
 * It has no process id, so the adapter's pid-based kill can never reach a real
 * process. It lives only as long as the adapter that spawned it.
 */

import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

export type LiveTestQuestionScenario = 'choice' | 'free-text' | 'permission';

export const LIVE_TEST_QUESTION_SESSION_ID = 'live-test-question-session';

/**
 * A real agent takes time to act on an answer. Replying at once would end the
 * turn before the adapter has finished handling the answer, so the session's
 * last status would be "busy" and it would never settle.
 */
const ANSWER_LATENCY_MS = 25;

const CHOICE_FORM = {
  mode: 'form',
  sessionId: LIVE_TEST_QUESTION_SESSION_ID,
  toolCallId: 'live-test-choice',
  message: 'Questions',
  requestedSchema: {
    type: 'object',
    properties: {
      colour: {
        type: 'string',
        title: 'Which colour should the fixture use?',
        oneOf: [{ const: 'red', title: 'red' }, { const: 'blue', title: 'blue' }],
      },
    },
  },
};

const FREE_TEXT_FORM = {
  mode: 'form',
  sessionId: LIVE_TEST_QUESTION_SESSION_ID,
  toolCallId: 'live-test-free-text',
  message: 'Questions',
  requestedSchema: {
    type: 'object',
    properties: { name: { type: 'string', title: 'What should the fixture call you?' } },
  },
};

const PERMISSION_REQUEST = {
  sessionId: LIVE_TEST_QUESTION_SESSION_ID,
  toolCall: {
    toolCallId: 'live-test-permission',
    title: 'Run fixture command',
    kind: 'execute',
    rawInput: { command: 'echo live-test-fixture' },
  },
  options: [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ],
};

/** The scenario a prompt asks for. A prompt naming neither of the others gets the exact-choice question. */
export function pickLiveTestQuestionScenario(prompt: string): LiveTestQuestionScenario {
  const text = prompt.toLowerCase();
  if (/free[- ]?text/.test(text)) return 'free-text';
  if (text.includes('permission')) return 'permission';
  return 'choice';
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function promptText(params: unknown): string {
  const blocks = isRecord(params) && Array.isArray(params['prompt']) ? params['prompt'] : [];
  return blocks
    .map((block) => (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : ''))
    .join('\n');
}

export class LiveTestQuestionPeer extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  /** Deliberately absent: there is no process to signal. */
  readonly pid = undefined;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  private buffered = '';
  private nextRequestId = 9000;
  private promptId: string | number | null = null;
  private readonly waiting = new Map<string | number, (response: Json) => void>();

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        this.read(chunk.toString());
        done();
      },
    });
  }

  /** The adapter's own `process.kill()` and the end of its session both land here. */
  kill(): boolean {
    this.close();
    return true;
  }

  close(): void {
    if (this.killed) return;
    this.killed = true;
    this.exitCode = 0;
    this.waiting.clear();
    this.promptId = null;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', 0, null);
    this.emit('close', 0, null);
  }

  private read(chunk: string): void {
    this.buffered += chunk;
    for (let end = this.buffered.indexOf('\n'); end !== -1; end = this.buffered.indexOf('\n')) {
      const line = this.buffered.slice(0, end).trim();
      this.buffered = this.buffered.slice(end + 1);
      if (!line) continue;
      try {
        this.handle(JSON.parse(line) as unknown);
      } catch (error) {
        this.stderr.write(`live-test question peer: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  private send(message: Json): void {
    if (this.killed) return;
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  private handle(message: unknown): void {
    if (!isRecord(message)) return;
    const id = message['id'];
    const method = message['method'];
    if (typeof method !== 'string') {
      // A response to a question or permission request this peer asked.
      if ((typeof id === 'string' || typeof id === 'number') && this.waiting.has(id)) {
        const resume = this.waiting.get(id)!;
        this.waiting.delete(id);
        resume(message);
      }
      return;
    }
    const hasId = typeof id === 'string' || typeof id === 'number';
    switch (method) {
      case 'initialize':
        if (hasId) this.send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
        return;
      case 'session/new':
        if (hasId) this.send({ id, result: { sessionId: LIVE_TEST_QUESTION_SESSION_ID } });
        return;
      case 'session/prompt':
        if (hasId) void this.runPrompt(id, promptText(message['params']));
        return;
      case 'session/cancel':
        this.endPrompt('cancelled');
        return;
      default:
        if (hasId) this.send({ id, error: { code: -32601, message: `Live-test question peer does not support ${method}.` } });
    }
  }

  private ask(method: string, params: Json): Promise<Json> {
    const id = this.nextRequestId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  private say(text: string): void {
    this.send({
      method: 'session/update',
      params: { sessionId: LIVE_TEST_QUESTION_SESSION_ID, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
    });
  }

  private endPrompt(stopReason: 'end_turn' | 'cancelled'): void {
    if (this.promptId === null) return;
    const id = this.promptId;
    this.promptId = null;
    this.waiting.clear();
    this.send({ id, result: { stopReason } });
  }

  private async runPrompt(id: string | number, prompt: string): Promise<void> {
    this.promptId = id;
    const scenario = pickLiveTestQuestionScenario(prompt);
    const form = scenario === 'free-text' ? FREE_TEXT_FORM : CHOICE_FORM;
    const response = scenario === 'permission'
      ? await this.ask('session/request_permission', PERMISSION_REQUEST)
      : await this.ask('elicitation/create', form);
    await new Promise((resolve) => setTimeout(resolve, ANSWER_LATENCY_MS));
    // A cancel or exit while waiting already ended the turn.
    if (this.promptId !== id) return;
    const result = isRecord(response['result']) ? response['result'] : {};
    if (scenario === 'permission') {
      const outcome = isRecord(result['outcome']) ? result['outcome'] : {};
      this.say(`Fixture permission outcome: ${String(outcome['outcome'])}${outcome['optionId'] ? ` (${String(outcome['optionId'])})` : ''}`);
    } else if (result['action'] === 'accept') {
      this.say(`Fixture answer received: ${JSON.stringify(result['content'] ?? {})}`);
    } else {
      this.say(`Fixture question was not answered: ${String(result['action'] ?? 'no action')}`);
    }
    this.endPrompt('end_turn');
  }
}
