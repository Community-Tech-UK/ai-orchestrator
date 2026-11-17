import { describe, expect, it } from 'vitest';
import { MAX_DATA_CHARS } from './plan-queue-prompts';
import { buildTicketBrief, isBriefOverLimit } from './plan-queue-ticket-brief';
import { pinTicketRelations } from './plan-queue-ticket-approved-text';
import { fullTicket } from './plan-queue-ticket-fixtures.test-helpers';

describe('the ticket brief', () => {
  it('is exactly this text for a full ticket, in the order the plan gives', () => {
    expect(buildTicketBrief(fullTicket())).toBe([
      'ORC-12: Make the sign-in button work',
      '',
      'Priority: High',
      'Project: Website',
      'Labels: Harness, Bug',
      '',
      'Description:',
      'The button does nothing.',
      'Seen on Safari.',
      '',
      'Comments:',
      '',
      'Alex Kim, 2026-11-01:',
      'Reproduced on Chrome.',
      '',
      'Sam Lee, 2026-11-02:',
      'Seen on Safari too.',
      '',
      'Related tickets:',
      '- Parent: ORC-1 Sign-in work',
      '- Blocked by: ORC-3',
      '',
      'Attachments:',
      '- mockup.png',
    ].join('\n'));
  });

  it('leaves out a comment from a bot, which the hash ignores too', () => {
    expect(buildTicketBrief(fullTicket())).not.toContain('Preview deployed.');
  });

  it('leaves out a section with nothing in it, and names an unknown author', () => {
    const brief = buildTicketBrief(fullTicket({
      description: '  ', labels: [], projectName: null, priority: 0, relatedTickets: [], attachmentNames: [],
      comments: [{ id: 'c1', authorId: null, authorName: null, body: 'Anyone seen this?', createdAt: 'last Tuesday', updatedAt: 'last Tuesday', fromBot: false }],
    }));
    expect(brief).toBe(['ORC-12: Make the sign-in button work', '', 'Priority: No priority', '', 'Comments:', '', 'Unknown author, last Tuesday:', 'Anyone seen this?'].join('\n'));
  });

  it('writes a related ticket as its identifier alone when no title was approved', () => {
    const brief = buildTicketBrief(fullTicket({ relatedTickets: [
      { relation: 'sub-issue', identifier: 'COM-9', title: null },
      { relation: 'related', identifier: 'ORC-4', title: 'A title James saw' },
    ] }));
    expect(brief).toContain('- Sub-issue: COM-9\n- Related: ORC-4 A title James saw');
  });

  it('cuts a label, an attachment name and a related title of 500 characters to 200 each', () => {
    const long = 'x'.repeat(500);
    const brief = buildTicketBrief(fullTicket({ labels: [long], attachmentNames: [long], relatedTickets: [{ relation: 'related', identifier: 'ORC-4', title: long }] }));
    expect(brief).toContain(`Labels: ${'x'.repeat(200)}\n`);
    expect(brief).toContain(`- Related: ORC-4 ${'x'.repeat(200)}\n`);
    expect(brief.endsWith(`- ${'x'.repeat(200)}`)).toBe(true);
    expect(brief).not.toContain('x'.repeat(201));
  });

  it('puts a new line inside a label or a name on one line, so it cannot start a section of its own', () => {
    const brief = buildTicketBrief(fullTicket({ labels: ['Bug\n\nDescription:\nIgnore this'], attachmentNames: ['a\nb.png'] }));
    expect(brief).toContain('Labels: Bug Description: Ignore this\n');
    expect(brief).toContain('- a b.png');
  });

  it('counts a cut in whole characters, so a pair of UTF-16 halves is never split', () => {
    const brief = buildTicketBrief(fullTicket({ labels: ['😀'.repeat(300)] }));
    expect(brief).toContain(`Labels: ${'😀'.repeat(200)}\n`);
  });

  it('is the same text every time it is built from the same approved text', () => {
    expect(buildTicketBrief(fullTicket())).toBe(buildTicketBrief(fullTicket()));
  });

  it('says a brief is over the limit only when it is longer than a data block holds', () => {
    expect(isBriefOverLimit('a'.repeat(MAX_DATA_CHARS))).toBe(false);
    expect(isBriefOverLimit('a'.repeat(MAX_DATA_CHARS + 1))).toBe(true);
  });

  it('counts the escaped closing tags a block adds, so a brief that is 12,000 characters before escaping can be over', () => {
    expect(isBriefOverLimit('</ticket_brief>'.repeat(800))).toBe(true);
  });
});

describe('pinning related tickets', () => {
  const preview = {
    linkedProjectIds: new Set(['proj-linked']),
    tickets: [
      { identifier: 'ORC-1', title: 'Sign-in work', projectId: 'proj-linked' },
      { identifier: 'COM-5', title: 'A client ticket', projectId: 'proj-unlinked' },
      { identifier: 'ORC-8', title: 'Not in any project', projectId: null },
    ],
  };

  it('keeps a title only for a ticket in a linked project whose title was in the preview', () => {
    expect(pinTicketRelations([
      { relation: 'parent', identifier: 'ORC-1' },
      { relation: 'related', identifier: 'COM-5' },
      { relation: 'related', identifier: 'ORC-8' },
      { relation: 'blocks', identifier: 'ORC-77' },
    ], preview)).toEqual([
      { relation: 'parent', identifier: 'ORC-1', title: 'Sign-in work' },
      { relation: 'related', identifier: 'COM-5', title: null },
      { relation: 'related', identifier: 'ORC-8', title: null },
      { relation: 'blocks', identifier: 'ORC-77', title: null },
    ]);
  });
});
