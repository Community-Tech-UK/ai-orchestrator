import { describe, expect, it } from 'vitest';
import { ContinuityToolEntryMerger, mergeDuplicateToolEntries } from './continuity-tool-entry-merger';
import type { ConversationEntry } from './session-continuity.types';

// Shapes produced by continuity-message-projection for one ACP tool call: the
// raw `tool_use`/`tool_result` events and the visible output messages.
const rawCall: ConversationEntry = {
  id: 'tool-call:c1', role: 'assistant', content: '', timestamp: 100,
  toolUse: { kind: 'call', toolName: 'Run tests', callId: 'c1', input: { kind: 'execute', rawInput: { command: 'npm test' } } },
};
const messageCall: ConversationEntry = {
  id: 'msg-call', role: 'assistant', content: 'Run tests', timestamp: 101,
  toolUse: { kind: 'call', toolName: 'execute', callId: 'c1', input: { command: 'npm test' } },
};
const messageResult: ConversationEntry = {
  id: 'msg-result', role: 'tool', content: '12 passing', timestamp: 200,
  toolUse: { kind: 'result', toolName: 'execute', resultForCallId: 'c1', input: null, output: '12 passing', isError: true },
};
const rawResult: ConversationEntry = {
  id: 'tool-result:c1:event-9', role: 'tool', content: '12 passing', timestamp: 201,
  toolUse: { kind: 'result', toolName: 'Run tests', resultForCallId: 'c1', input: null, output: '12 passing', isError: false },
};

describe('ContinuityToolEntryMerger', () => {
  it('adds the first entry for a call and folds the visible message into it', () => {
    const merger = new ContinuityToolEntryMerger();

    expect(merger.merge('inst', rawCall, false)).toEqual({ kind: 'add', entryId: 'tool-call:c1', entry: rawCall });
    const second = merger.merge('inst', messageCall, true);

    expect(second).toMatchObject({
      kind: 'patch',
      entryId: 'tool-call:c1',
      patch: {
        role: 'assistant',
        content: 'Run tests',
        // The message's fields win; its input is kept because it is present.
        toolUse: { kind: 'call', toolName: 'execute', callId: 'c1', input: { command: 'npm test' } },
      },
    });
  });

  it('skips a raw result that adds nothing to the visible one, keeping its is_error', () => {
    const merger = new ContinuityToolEntryMerger();

    expect(merger.merge('inst', messageResult, true).kind).toBe('add');
    expect(merger.merge('inst', rawResult, false)).toEqual({ kind: 'skip', entryId: 'msg-result' });
  });

  it('treats a second copy from the same source as a new call reusing the id', () => {
    const merger = new ContinuityToolEntryMerger();
    merger.merge('inst', rawCall, false);
    merger.merge('inst', messageCall, true);

    // The id comes round again: a new raw call, then its message, merge with each other only.
    const reusedRaw = { ...rawCall, id: 'tool-call:c1#2', timestamp: 300 };
    expect(merger.merge('inst', reusedRaw, false)).toMatchObject({ kind: 'add', entryId: 'tool-call:c1#2' });
    expect(merger.merge('inst', { ...messageCall, id: 'msg-call-2' }, true))
      .toMatchObject({ kind: 'patch', entryId: 'tool-call:c1#2' });
    // Two messages under different ids are two calls, never one.
    expect(merger.merge('inst', { ...messageCall, id: 'msg-call-3' }, true)).toMatchObject({ kind: 'add' });
  });

  it('carries the whole merged entry on a patch so a missing target can be re-added', () => {
    const merger = new ContinuityToolEntryMerger();
    merger.merge('inst', rawCall, false);

    const decision = merger.merge('inst', messageCall, true);

    expect(decision).toMatchObject({
      kind: 'patch',
      entry: { id: 'tool-call:c1', timestamp: 100, content: 'Run tests' },
    });
  });

  it('passes re-emissions of the same entry id through as ordinary adds', () => {
    const merger = new ContinuityToolEntryMerger();
    merger.merge('inst', messageCall, true);

    expect(merger.merge('inst', { ...messageCall, content: 'Run tests (updated)' }, true))
      .toMatchObject({ kind: 'add', entryId: 'msg-call' });
  });

  it('leaves entries without a call id and non-tool entries untouched', () => {
    const merger = new ContinuityToolEntryMerger();
    const idless: ConversationEntry = { id: 'x', role: 'tool', content: 'out', timestamp: 1, toolUse: { toolName: 't', input: null } };
    const text: ConversationEntry = { id: 'y', role: 'assistant', content: 'hi', timestamp: 2 };

    expect(merger.merge('inst', idless, true)).toEqual({ kind: 'add', entryId: 'x', entry: idless });
    expect(merger.merge('inst', { ...idless, id: 'x2' }, false)).toMatchObject({ kind: 'add', entryId: 'x2' });
    expect(merger.merge('inst', text, true)).toEqual({ kind: 'add', entryId: 'y', entry: text });
  });

  it('keeps scopes separate and forgets every generation of an instance', () => {
    const merger = new ContinuityToolEntryMerger();
    merger.merge('a:1', rawCall, false);

    expect(merger.merge('b:1', messageCall, true).kind).toBe('add');
    // A respawned adapter (new generation) never matches the previous run's call.
    expect(merger.merge('a:2', messageCall, true).kind).toBe('add');
    merger.forget('a');
    expect(merger.merge('a:1', messageCall, true).kind).toBe('add');
    // Forgetting `a` leaves an unrelated instance whose id merely starts with it.
    merger.merge('ab:1', rawCall, false);
    merger.forget('a');
    expect(merger.merge('ab:1', messageCall, true).kind).toBe('patch');
  });

  it('bounds how many calls it remembers per scope', () => {
    const merger = new ContinuityToolEntryMerger(2);
    for (const id of ['c1', 'c2', 'c3']) {
      merger.merge('inst', { ...rawCall, id: `tool-call:${id}`, toolUse: { ...rawCall.toolUse!, callId: id } }, false);
    }

    // c1 was evicted, so its visible message is added rather than merged.
    expect(merger.merge('inst', messageCall, true).kind).toBe('add');
  });
});

describe('mergeDuplicateToolEntries', () => {
  it('collapses raw and message copies saved by earlier builds, keeping order and the visible fields', () => {
    const history: ConversationEntry[] = [
      { id: 'ask', role: 'user', content: 'run the tests', timestamp: 1 },
      rawCall,
      messageCall,
      rawResult,
      messageResult,
      { id: 'answer', role: 'assistant', content: 'Done.', timestamp: 300 },
    ];

    const { entries, merged } = mergeDuplicateToolEntries(history);

    expect(merged).toBe(2);
    expect(entries.map((e) => e.id)).toEqual(['ask', 'tool-call:c1', 'tool-result:c1:event-9', 'answer']);
    expect(entries[1]).toMatchObject({ content: 'Run tests', timestamp: 100 });
    expect(entries[2].toolUse).toMatchObject({ isError: true, output: '12 passing' });
  });

  it('leaves a history without duplicates unchanged', () => {
    const history: ConversationEntry[] = [rawCall, messageResult];

    expect(mergeDuplicateToolEntries(history)).toEqual({ entries: history, merged: 0 });
  });
});
