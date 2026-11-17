import { describe, expect, it } from 'vitest';
import { hashTicketText, normaliseTicketLineEndings, type TicketText, type TicketTextComment } from './plan-queue-linear-ticket-hash';

const comment = (id: string, body: string, over: Partial<TicketTextComment> = {}): TicketTextComment =>
  ({ id, authorId: 'user-1', body, createdAt: '2026-11-01T10:00:00.000Z', fromBot: false, ...over });
const base = (): TicketText => ({
  title: 'Fix the login page',
  description: 'The button\ndoes nothing.',
  comments: [comment('c1', 'First.', { createdAt: '2026-11-01T10:00:00.000Z' }), comment('c2', 'Second.', { createdAt: '2026-11-01T11:00:00.000Z' })],
});

describe('the ticket text hash', () => {
  it('is a lowercase SHA-256 and is the same for the same text', () => {
    expect(hashTicketText(base())).toMatch(/^[0-9a-f]{64}$/);
    expect(hashTicketText(base())).toBe(hashTicketText(base()));
  });

  it('is the same whatever the line endings', () => {
    const windows: TicketText = {
      title: 'Fix the login page', description: 'The button\r\ndoes nothing.',
      comments: [comment('c1', 'First.', { createdAt: '2026-11-01T10:00:00.000Z' }), comment('c2', 'Second.', { createdAt: '2026-11-01T11:00:00.000Z' })],
    };
    const oldMac = { ...windows, description: 'The button\rdoes nothing.' };
    expect(hashTicketText(windows)).toBe(hashTicketText(base()));
    expect(hashTicketText(oldMac)).toBe(hashTicketText(base()));
    expect(normaliseTicketLineEndings('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    const multiLineComment = { ...base(), comments: [comment('c1', 'one\r\ntwo')] };
    expect(hashTicketText(multiLineComment)).toBe(hashTicketText({ ...base(), comments: [comment('c1', 'one\ntwo')] }));
  });

  it('does not depend on the order the comments arrive in, only on when they were created', () => {
    const reversed = { ...base(), comments: [...base().comments].reverse() };
    expect(hashTicketText(reversed)).toBe(hashTicketText(base()));
    const swappedTimes = { ...base(), comments: [comment('c1', 'First.', { createdAt: '2026-11-01T11:00:00.000Z' }), comment('c2', 'Second.', { createdAt: '2026-11-01T10:00:00.000Z' })] };
    expect(hashTicketText(swappedTimes)).not.toBe(hashTicketText(base()));
  });

  it('differs when a comment is added', () => {
    expect(hashTicketText({ ...base(), comments: [...base().comments, comment('c3', 'Third.', { createdAt: '2026-11-02T10:00:00.000Z' })] })).not.toBe(hashTicketText(base()));
  });

  it('differs when a comment is edited', () => {
    const [first, second] = base().comments;
    expect(hashTicketText({ ...base(), comments: [first, { ...second, body: 'Second, edited.' }] })).not.toBe(hashTicketText(base()));
  });

  it('differs when a comment is deleted', () => {
    expect(hashTicketText({ ...base(), comments: [base().comments[0]] })).not.toBe(hashTicketText(base()));
  });

  it('differs when a comment is replaced by another with the same words', () => {
    const [first, second] = base().comments;
    expect(hashTicketText({ ...base(), comments: [first, { ...second, id: 'c9' }] })).not.toBe(hashTicketText(base()));
  });

  it('differs when a comment changes author', () => {
    const [first, second] = base().comments;
    expect(hashTicketText({ ...base(), comments: [first, { ...second, authorId: 'user-2' }] })).not.toBe(hashTicketText(base()));
  });

  it('differs when the title changes', () => {
    expect(hashTicketText({ ...base(), title: 'Fix the sign-in page' })).not.toBe(hashTicketText(base()));
  });

  it('differs when the description changes', () => {
    expect(hashTicketText({ ...base(), description: 'The button works.' })).not.toBe(hashTicketText(base()));
  });

  it('keeps the fields apart: text moved from the title to the description is a change', () => {
    expect(hashTicketText({ title: 'ab', description: 'c', comments: [] })).not.toBe(hashTicketText({ title: 'a', description: 'bc', comments: [] }));
  });

  it('leaves out a comment the connector marks as from a bot or integration, and counts every other', () => {
    const withBot = { ...base(), comments: [...base().comments, comment('bot-1', 'Linked to a pull request.', { authorId: null, fromBot: true, createdAt: '2026-11-03T10:00:00.000Z' })] };
    expect(hashTicketText(withBot)).toBe(hashTicketText(base()));
    const notFlagged = { ...base(), comments: [...base().comments, comment('c4', 'Linked to a pull request.', { authorId: null, fromBot: false, createdAt: '2026-11-03T10:00:00.000Z' })] };
    expect(hashTicketText(notFlagged)).not.toBe(hashTicketText(base()));
  });
});
