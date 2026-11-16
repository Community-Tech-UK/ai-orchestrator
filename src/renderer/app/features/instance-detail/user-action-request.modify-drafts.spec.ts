import { describe, expect, it } from 'vitest';
import { ModifyDrafts, parseModifiedInput } from './user-action-request.modify-drafts';

describe('parseModifiedInput', () => {
  it('accepts a non-empty JSON object', () => {
    expect(parseModifiedInput(' {"command":"echo hi"} ')).toEqual({ input: { command: 'echo hi' } });
  });

  it('says when the text is not JSON', () => {
    expect(parseModifiedInput('{oops')).toEqual({ error: 'Invalid JSON — please fix the syntax before approving.' });
  });

  it.each(['[]', '{}', 'null', '"text"', '5'])('refuses %s as the tool input', (raw) => {
    expect(parseModifiedInput(raw)).toEqual({ error: 'Input must be a non-empty JSON object ({ … }).' });
  });
});

describe('ModifyDrafts', () => {
  it('fills the editor from the tool input the first time it opens, then keeps what was typed', () => {
    const drafts = new ModifyDrafts();
    drafts.toggle('k', { command: 'ls' });
    expect(drafts.isOpen('k')).toBe(true);
    expect(JSON.parse(drafts.text('k'))).toEqual({ command: 'ls' });
    drafts.setText('k', 'edited');
    drafts.toggle('k', { command: 'ls' });
    drafts.toggle('k', { command: 'ls' });
    expect(drafts.text('k')).toBe('edited');
  });

  it('clears a stale error when the text changes', () => {
    const drafts = new ModifyDrafts();
    drafts.setError('k', 'bad');
    expect(drafts.error('k')).toBe('bad');
    drafts.setText('k', '{}');
    expect(drafts.error('k')).toBe('');
  });

  it('forgets one card without touching another', () => {
    const drafts = new ModifyDrafts();
    drafts.toggle('a', { x: 1 });
    drafts.toggle('b', { y: 2 });
    drafts.setError('a', 'bad');
    drafts.clear('a');
    expect([drafts.isOpen('a'), drafts.text('a'), drafts.error('a')]).toEqual([false, '', '']);
    expect(drafts.isOpen('b')).toBe(true);
  });
});
