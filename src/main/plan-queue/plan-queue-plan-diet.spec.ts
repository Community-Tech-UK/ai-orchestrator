import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_SMALL_SUMMARY_BYTES, closeSmallDocument, dietPointerLine, maybeDietDocument, splitDatedJournalSections } from './plan-queue-plan-diet';
import { renameDocumentsInPlace } from './plan-queue-doc-close';

const roots: string[] = [];
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe('close-small section boundaries', () => {
  const history = 'work_history_completed.md';
  const peers = '## Final verification\r\nPassed 🧪.  \r\n### 2026-11-03 receipt\r\nKeep this dated verification.\r\n'
    + '## Live checks\r\n- [ ] Check café and 日本語\r\n## Finishing\r\nKeep the final line without a newline';

  it('keeps later peer sections byte for byte when long undated notes exceed the budget', () => {
    const notes = Array.from({ length: 100 }, (_, i) => `Evidence ${i}: café 日本語 🧪.  \n`).join('');
    const before = '# Plan\n## Acceptance\nKeep requirements.\n';
    const original = `${before}## As-built\n${notes}${peers}`;
    const result = closeSmallDocument(original, history);
    expect(Buffer.byteLength(notes)).toBeGreaterThan(CLOSE_SMALL_SUMMARY_BYTES);
    expect(result.content.slice(result.content.indexOf('## Final verification'))).toBe(peers);
    expect(result.moved).not.toContain('Final verification');
    expect(result.content.startsWith(before)).toBe(true);
    expect(result.moved.length).toBeGreaterThan(0);
    expect(result.content.replace(dietPointerLine(history), '').replace(peers, '') + result.moved + peers).toBe(original);
  });

  it('does not charge a large verification section against short as-built notes', () => {
    const original = '# Plan\n## As-built\nImplemented.\n## Final verification\n' + 'Keep verification evidence.\n'.repeat(300);
    expect(closeSmallDocument(original, history)).toEqual({ content: original, moved: '' });
  });

  it.each(['Final verification 2026-11-03', 'Live checks 3 November', 'Finishing 2026-11-03'])(
    'preserves the dated peer section %s as document content', heading => {
      const original = `# Plan\n## As-built\nImplemented.\n## ${heading}\n` + 'Keep this peer section.\n'.repeat(300);
      expect(closeSmallDocument(original, history)).toEqual({ content: original, moved: '' });
    },
  );

  it.each(['```', '~~~~'])('moves an entire %s fenced block when the budget ends inside it', marker => {
    const prefix = '## As-built\n' + 'Kept evidence.\n'.repeat(180);
    const fence = `${marker}markdown\n### 2026-11-03 example\n## Final verification example\n`
      + 'Unicode café 日本語 🧪\n'.repeat(80) + `${marker}\n`;
    const overflow = `${fence}After the complete fence.\n`;
    const result = closeSmallDocument(prefix + overflow + peers, history);
    expect(result.content).toBe(prefix + dietPointerLine(history) + peers);
    expect(result.moved).toBe(overflow);
  });

  it('moves a long Unicode line intact, including its original final newline state', () => {
    const prefix = '# Plan\n## As-built\nBrief summary.\n';
    const longLine = '🧪 café 日本語 '.repeat(500);
    const result = closeSmallDocument(prefix + longLine, history);
    expect(result.content).toBe(prefix + dietPointerLine(history));
    expect(result.moved).toBe(longLine);
    expect(result.content.replace(dietPointerLine(history), '') + result.moved).toBe(prefix + longLine);
  });

  it('slims separate as-built sections without moving dated evidence inside intervening peer sections', () => {
    const first = '## As-built\n### 2026-10-30\nFirst journal.\n';
    const middle = '## Final verification\n### 2026-11-01\nVerification receipt.\n';
    const second = '## Journal\n### 2026-11-02\nSecond journal.\n';
    const result = closeSmallDocument(first + middle + second + peers, history);
    expect(result.content).toContain(middle);
    expect(result.content.endsWith(peers)).toBe(true);
    expect(result.moved).toBe('### 2026-10-30\nFirst journal.\n### 2026-11-02\nSecond journal.\n');
  });

  it('publishes lossless overflow with stable closure hashes and preserves shared history across retry', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-diet-close-'))); roots.push(root);
    const documentPath = join(root, 'work_plan.md');
    const sharedHistory = join(root, 'work_history.md');
    const original = '# Plan\n## As-built\n' + 'Undated café 🧪 evidence.\n'.repeat(300) + peers;
    const earlier = 'Earlier shared evidence.  \n\n';
    writeFileSync(documentPath, original); writeFileSync(sharedHistory, earlier);
    await renameDocumentsInPlace(documentPath, null);
    const receipt = JSON.parse(readFileSync(join(root, 'work_plan_closure_completed.json'), 'utf8'));
    const closed = readFileSync(join(root, 'work_plan_completed.md'), 'utf8');
    expect(closed.slice(closed.indexOf('## Final verification'))).toBe(peers);
    expect(receipt.sources.find((s: { relativePath: string }) => s.relativePath === 'work_plan.md').sha256)
      .toBe(createHash('sha256').update(original).digest('hex'));
    for (const output of receipt.outputs) {
      expect(createHash('sha256').update(readFileSync(join(root, output.relativePath))).digest('hex')).toBe(output.sha256);
    }
    const snapshot = receipt.outputs.find((o: { relativePath: string }) => /_history_.*_completed.md$/.test(o.relativePath));
    const evidence = readFileSync(join(root, snapshot.relativePath), 'utf8');
    const moved = evidence.slice(evidence.indexOf(earlier) + earlier.length + 2);
    const pointer = dietPointerLine(snapshot.relativePath);
    expect(closed.replace(pointer, '').replace(peers, '') + moved + peers).toBe(original);
    await renameDocumentsInPlace(documentPath, null);
    expect(readFileSync(join(root, snapshot.relativePath), 'utf8')).toBe(evidence);
    expect(readFileSync(sharedHistory, 'utf8')).toBe(earlier);
  });
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const content = '# Plan\n## Status\nActive\n## Acceptance\n- [ ] Keep this requirement\n## As built\n'
  + '### 2026-10-28\nFirst journal\n### 2026-10-29\nSecond journal\n### 2026-10-30\nThird journal\n## Status\nStill active\n';

describe('checkpoint plan diet', () => {
  it('preserves both files when existing history cannot be read', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-diet-'))); roots.push(root);
    const documentPath = join(root, 'work_plan.md'); const historyPath = join(root, 'work_history.md');
    writeFileSync(documentPath, content); writeFileSync(historyPath, 'Earlier evidence\n');
    vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from(content))
      .mockRejectedValueOnce(Object.assign(new Error('history permission denied'), { code: 'EACCES' }));
    await expect(maybeDietDocument({ documentPath, historyPath, bytesAtJobStart: 0 })).rejects.toThrow('history permission denied');
    expect(readFileSync(documentPath, 'utf8')).toBe(content);
    expect(readFileSync(historyPath, 'utf8')).toBe('Earlier evidence\n');
  });
  it('moves every dated journal section while conserving bytes and keeping requirements', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-diet-'))); roots.push(root);
    const documentPath = join(root, 'work_plan.md'); const historyPath = join(root, 'work_history.md');
    writeFileSync(documentPath, content);
    expect(await maybeDietDocument({ documentPath, historyPath, bytesAtJobStart: Buffer.byteLength(content) })).toMatchObject({ moved: true });
    const kept = readFileSync(documentPath, 'utf8'); const moved = readFileSync(historyPath, 'utf8');
    expect(kept).toContain('- [ ] Keep this requirement');
    expect(moved).toContain('First journal'); expect(moved).toContain('Third journal');
    expect(Buffer.byteLength(kept) + Buffer.byteLength(moved)).toBe(Buffer.byteLength(content) + Buffer.byteLength(dietPointerLine('work_history.md')));
  });
  it('does not overwrite a concurrent document edit or create a history on that attempt', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-diet-'))); roots.push(root);
    const documentPath = join(root, 'work_plan.md'); const historyPath = join(root, 'work_history.md');
    writeFileSync(documentPath, content);
    expect(await maybeDietDocument({ documentPath, historyPath, bytesAtJobStart: 0,
      onMovePrepared: () => { writeFileSync(documentPath, 'James changed this document'); } })).toMatchObject({ moved: false });
    expect(readFileSync(documentPath, 'utf8')).toBe('James changed this document');
    expect(() => readFileSync(historyPath)).toThrow();
  });
  it('preserves invalid document bytes instead of rewriting them as replacement characters', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-diet-'))); roots.push(root);
    const documentPath = join(root, 'work_plan.md'); const historyPath = join(root, 'work_history.md');
    const original = Buffer.concat([Buffer.from(content), Buffer.from([0xff])]);
    writeFileSync(documentPath, original); writeFileSync(historyPath, 'Earlier evidence\n');
    await expect(maybeDietDocument({ documentPath, historyPath, bytesAtJobStart: 0 })).rejects.toThrow('UTF-8');
    expect(readFileSync(documentPath)).toEqual(original);
    expect(readFileSync(historyPath, 'utf8')).toBe('Earlier evidence\n');
  });
  it('keeps fenced examples with dated headings and moves only the real journal', () => {
    const example = '```markdown\n## As built\n### 2026-10-20\nAn example, not evidence\n```\n';
    const original = '# Plan\n' + example + '## As built\n### 2026-10-30\nReal evidence\n';
    const result = splitDatedJournalSections(original, 'history.md');
    expect(result.kept).toContain(example);
    expect(result.moved).toBe('### 2026-10-30\nReal evidence\n');
  });
  it('does not move dated acceptance headings above the as-built notes', () => {
    expect(splitDatedJournalSections('## 2026-10-30 acceptance\n- [ ] Required\n## As built\nNo journal\n', 'history.md').moved).toBe('');
  });
});
