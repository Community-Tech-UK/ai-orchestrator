import { describe, expect, it } from 'vitest';
import { extractTodoToolItems } from '../../src/main/instance/todo-tool-parser';
import { isBareGoAhead, stripInjected } from './message-classify';
import { transcriptToMessages } from './transcript-to-messages';

const ts = (n: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, n)).toISOString();
const user = (uuid: string, n: number, content: unknown, extra: object = {}) => ({ type: 'user', uuid, timestamp: ts(n), message: { content }, ...extra });
const assistant = (uuid: string, n: number, content: unknown[], extra: object = {}) => ({ type: 'assistant', uuid, timestamp: ts(n), message: { content }, ...extra });

describe('transcriptToMessages', () => {
  it('turns a typed line into a person-marked user message', () => {
    const [m] = transcriptToMessages([user('u1', 1, 'Please fix the sample bug')]);
    expect(m).toMatchObject({ type: 'user', content: 'Please fix the sample bug', metadata: { inputOrigin: { kind: 'person', typedAt: Date.parse(ts(1)) } } });
    expect(m.metadata?.internalInput).toBeUndefined();
  });

  it('turns an app-written line into a system message with internalInput', () => {
    const out = transcriptToMessages([
      user('u1', 1, 'Automatic check-in: still waiting on the build'),
      user('u2', 2, '<harness_internal_message source="plan-queue">do the thing</harness_internal_message>'),
      user('u3', 3, 'some unknown wrapper', {}),
    ]);
    expect(out[0]).toMatchObject({ type: 'system', metadata: { internalInput: { actor: 'harness', source: 'waiting-check-in' } } });
    expect(out[1]).toMatchObject({ type: 'system', metadata: { internalInput: { source: 'plan-queue' } } });
    expect(out[2].type).toBe('user');
  });

  it('strips injected context blocks before deciding who wrote the line', () => {
    const raw = '[Indexed Codebase Context]\nsome retrieved invented text\n[End Indexed Codebase Context]\nwhat does this do?';
    const [m] = transcriptToMessages([user('u1', 1, raw)]);
    expect(m.type).toBe('user');
    expect(m.content).toBe('what does this do?');
    expect(stripInjected(raw)).toBe('what does this do?');
  });

  it('turns assistant text into assistant and tool_use blocks into tool_use rows readable by the task parser', () => {
    const todos = { todos: [{ content: 'Write tests', status: 'pending', activeForm: 'Writing tests' }] };
    const out = transcriptToMessages([
      assistant('a1', 1, [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Starting now.' }, { type: 'tool_use', id: 't1', name: 'TodoWrite', input: todos }]),
    ]);
    expect(out.map((m) => m.type)).toEqual(['assistant', 'tool_use']);
    expect(out[1].metadata).toMatchObject({ name: 'TodoWrite', input: todos });
    expect(extractTodoToolItems(out[1])?.[0]).toMatchObject({ content: 'Write tests', status: 'pending' });
  });

  it('skips sidechain, meta and tool-result lines', () => {
    const out = transcriptToMessages([
      user('u1', 1, 'sidechain typed', { isSidechain: true }),
      user('u2', 2, 'meta line', { isMeta: true }),
      user('u3', 3, [{ type: 'tool_result', content: 'ok' }]),
      assistant('a1', 4, [{ type: 'text', text: 'side reply' }], { isSidechain: true }),
      { type: 'summary', timestamp: ts(5) },
    ]);
    expect(out).toEqual([]);
  });
});

describe('isBareGoAhead', () => {
  it('accepts go-ahead words and rejects real instructions', () => {
    expect(isBareGoAhead('Yes, go ahead!')).toBe(true);
    expect(isBareGoAhead('continue')).toBe(true);
    expect(isBareGoAhead('go with your recommendations')).toBe(true);
    expect(isBareGoAhead('yes but use the other table')).toBe(false);
    expect(isBareGoAhead('')).toBe(false);
  });
});
