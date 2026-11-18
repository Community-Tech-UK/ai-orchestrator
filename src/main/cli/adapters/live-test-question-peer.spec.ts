import { describe, expect, it } from 'vitest';
import { LiveTestQuestionPeer, pickLiveTestQuestionScenario } from './live-test-question-peer';

function talk() {
  const peer = new LiveTestQuestionPeer();
  const lines: Record<string, unknown>[] = [];
  peer.stdout.setEncoding('utf8');
  peer.stdout.on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) lines.push(JSON.parse(line) as Record<string, unknown>);
  });
  const send = (message: Record<string, unknown>) => peer.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  return { peer, lines, send };
}

describe('pickLiveTestQuestionScenario', () => {
  it.each([
    ['ask me a question', 'choice'],
    ['', 'choice'],
    ['Ask a Free-Text question', 'free-text'],
    ['free text please', 'free-text'],
    ['raise a permission card', 'permission'],
  ])('%j asks %s', (prompt, expected) => expect(pickLiveTestQuestionScenario(prompt)).toBe(expected));
});

describe('LiveTestQuestionPeer', () => {
  it('has no process id to signal', () => {
    expect(new LiveTestQuestionPeer().pid).toBeUndefined();
  });

  it('refuses a method it does not support instead of guessing', async () => {
    const { lines, send } = talk();
    send({ id: 1, method: 'fs/read_text_file', params: {} });
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Live-test question peer does not support fs/read_text_file.' } }]);
  });

  it('ends a waiting turn as cancelled and ignores the late answer', async () => {
    const { lines, send } = talk();
    send({ id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'ask me' }] } });
    await new Promise((resolve) => setImmediate(resolve));
    const question = lines.find((line) => line['method'] === 'elicitation/create')!;
    send({ method: 'session/cancel', params: {} });
    send({ id: question['id'], result: { action: 'accept', content: { colour: 'red' } } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines.filter((line) => line['id'] === 1)).toEqual([{ jsonrpc: '2.0', id: 1, result: { stopReason: 'cancelled' } }]);
    expect(JSON.stringify(lines)).not.toContain('Fixture answer received');
  });

  it('reports a declined question and ends the turn', async () => {
    const { lines, send } = talk();
    send({ id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'ask me' }] } });
    await new Promise((resolve) => setImmediate(resolve));
    const question = lines.find((line) => line['method'] === 'elicitation/create')!;
    send({ id: question['id'], result: { action: 'decline' } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(JSON.stringify(lines)).toContain('Fixture question was not answered: decline');
    expect(lines.at(-1)).toEqual({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
  });

  it('does not end the turn in the same breath as the answer, so a session settles on "idle"', async () => {
    const { lines, send } = talk();
    send({ id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'ask me' }] } });
    await new Promise((resolve) => setImmediate(resolve));
    const question = lines.find((line) => line['method'] === 'elicitation/create')!;
    send({ id: question['id'], result: { action: 'accept', content: { colour: 'red' } } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines.some((line) => line['id'] === 1)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lines.at(-1)).toEqual({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
  });

  it('says nothing after it is closed, and closing twice exits once', () => {
    const { peer, lines, send } = talk();
    let exits = 0;
    peer.on('exit', () => exits++);
    peer.close();
    peer.close();
    send({ id: 1, method: 'initialize', params: {} });
    expect(exits).toBe(1);
    expect(lines).toEqual([]);
    expect(peer.killed).toBe(true);
  });
});
