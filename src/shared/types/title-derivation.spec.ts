import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_PREAMBLE_HEADER,
  deriveAttachmentTaskTitle,
  extractAttachmentPreamble,
  sanitizeGeneratedTitle,
  titleFromAttachments,
} from './title-derivation';

/** The exact prompt the loop builds when files are attached (screenshot case). */
const SCREENSHOT_PROMPT = [
  ATTACHMENT_PREAMBLE_HEADER,
  '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-05-30-mobile-control-app-plan.md',
  '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-06-02-chrome-devtools-managed-profile-attach.md',
  '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-06-02-outstanding-work-master-backlog.md',
  '',
  'Please work these files and implement them. Be thorough.',
].join('\n');

describe('extractAttachmentPreamble', () => {
  it('returns null for ordinary prompt text', () => {
    expect(extractAttachmentPreamble('Refactor the AuthService session cache')).toBeNull();
    expect(extractAttachmentPreamble('')).toBeNull();
    expect(extractAttachmentPreamble(undefined)).toBeNull();
  });

  it('parses the header, bullet paths, and trailing prompt', () => {
    const parsed = extractAttachmentPreamble(SCREENSHOT_PROMPT);
    expect(parsed).not.toBeNull();
    expect(parsed!.paths).toEqual([
      '.aio-loop-attachments/loop-1780437789286-a99d95f2/2026-05-30-mobile-control-app-plan.md',
      '.aio-loop-attachments/loop-1780437789286-a99d95f2/2026-06-02-chrome-devtools-managed-profile-attach.md',
      '.aio-loop-attachments/loop-1780437789286-a99d95f2/2026-06-02-outstanding-work-master-backlog.md',
    ]);
    expect(parsed!.remainder).toBe('Please work these files and implement them. Be thorough.');
  });

  it('tolerates a leading blank line and an empty remainder', () => {
    const parsed = extractAttachmentPreamble(`\n${ATTACHMENT_PREAMBLE_HEADER}\n- a/b.md`);
    expect(parsed).not.toBeNull();
    expect(parsed!.paths).toEqual(['a/b.md']);
    expect(parsed!.remainder).toBe('');
  });

  it('strips the "(skipped: …)" annotation from a path', () => {
    const parsed = extractAttachmentPreamble(
      `${ATTACHMENT_PREAMBLE_HEADER}\n- big.bin (skipped: too large or unwritable)`,
    );
    expect(parsed!.paths).toEqual(['big.bin']);
  });

  it('returns null when the header has no bullet paths under it', () => {
    expect(extractAttachmentPreamble(`${ATTACHMENT_PREAMBLE_HEADER}\nno bullets here`)).toBeNull();
  });
});

describe('deriveAttachmentTaskTitle', () => {
  it('titles the screenshot case from the first plan file + inferred action', () => {
    const parsed = extractAttachmentPreamble(SCREENSHOT_PROMPT)!;
    expect(deriveAttachmentTaskTitle(parsed.remainder, parsed.paths)).toBe(
      'Mobile control app implementation',
    );
  });

  it('falls back to the bare file list when no action verb is present', () => {
    expect(deriveAttachmentTaskTitle('here you go', ['a/notes.md', 'b/other.md'])).toBe(
      'notes.md +1 more',
    );
  });

  it('returns null when there are no attachment names', () => {
    expect(deriveAttachmentTaskTitle('implement this', [])).toBeNull();
  });
});

describe('titleFromAttachments', () => {
  it('uses the single label or a "+N more" summary', () => {
    expect(titleFromAttachments(['only.md'])).toBe('only.md');
    expect(titleFromAttachments(['a.md', 'b.md', 'c.md'])).toBe('a.md +2 more');
    expect(titleFromAttachments([])).toBeNull();
  });
});

describe('sanitizeGeneratedTitle', () => {
  it('removes closed XML and bracket thinking blocks', () => {
    expect(sanitizeGeneratedTitle('<think>reasoning</think>\nTab rename sanitizer')).toBe(
      'Tab rename sanitizer',
    );
    expect(sanitizeGeneratedTitle('[thinking]reasoning[/thinking]\nTab rename sanitizer')).toBe(
      'Tab rename sanitizer',
    );
  });

  it('rejects unfinished thinking tags', () => {
    expect(sanitizeGeneratedTitle('<think>reasoning only')).toBeNull();
    expect(sanitizeGeneratedTitle('[THINKING]reasoning only')).toBeNull();
  });
});
