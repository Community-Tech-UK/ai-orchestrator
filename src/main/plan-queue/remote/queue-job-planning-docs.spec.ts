import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueDocument } from '../../remote-node/queue-job-rpc-schemas';
import { _setPlanQueueDataDirForTesting } from '../plan-queue-data-dir';
import { FakeMac } from './queue-job-fake-computer.test-helpers';
import {
  MAX_PLANNING_DOCUMENT_BYTES, applyReturnedDocuments, clearSentRecord, collectOutgoingDocuments, readSentRecord,
  recordedDocuments, refreshSentRecord, writeSentRecord, type ApplyReturnedResult, type SentRecord,
} from './queue-job-planning-docs';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let mac: FakeMac;
let root: string;
const PLAN = 'docs/plans/x_plan.md';
const ITEM = 'item-0001abcdef';

const doc = (path: string, text: string): QueueDocument => ({ path, contentBase64: Buffer.from(text).toString('base64') });
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const write = (rel: string, text: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const retained = (rel: string): string[] => readdirSync(join(root, dirname(rel))).filter(name => name.startsWith(`.${rel.split('/').pop()}.aio-retained-`));
const beside = (rel: string): string[] => readdirSync(join(root, dirname(rel))).filter(name => name.includes('.from-queue-'));

beforeEach(() => {
  mac = new FakeMac();
  root = realpathSync(mac.repo);
  _setPlanQueueDataDirForTesting(join(mac.root, 'data'));
  write(PLAN, `# plan\nSpec: [spec](${join(root, 'docs/specs/x_spec_planned.md')})\nAlso docs/plans/other_plan.md and [more](../specs/extra_spec.md).\n`);
  write('docs/specs/x_spec_planned.md', 'spec v1\n');
  write('docs/plans/other_plan.md', 'other v1\n');
  write('docs/specs/extra_spec.md', 'extra v1\n');
});
afterEach(() => { _setPlanQueueDataDirForTesting(null); mac.dispose(); });

async function sentNow(): Promise<SentRecord> { return refreshSentRecord(root, join(root, PLAN), {}); }

async function applyBack(sent: SentRecord, documents: QueueDocument[], deleted: string[] = []): Promise<ApplyReturnedResult> {
  return applyReturnedDocuments({ repoRoot: root, itemId: ITEM, computerLabel: 'the Windows PC', sent, documents, deleted });
}

describe('collectOutgoingDocuments', () => {
  it('sends the plan first, then its linked spec and the other planning documents it points at, at repository paths', async () => {
    const documents = await collectOutgoingDocuments(root, join(root, PLAN));
    expect(documents.map(document => document.path)).toEqual([
      PLAN, 'docs/specs/x_spec_planned.md', 'docs/plans/other_plan.md', 'docs/specs/extra_spec.md',
    ]);
    expect(documents[0].bytes.toString()).toContain('# plan');
  });

  it('finds the conventional linked spec even when the plan does not mention it', async () => {
    write('docs/plans/solo_plan.md', 'no links here\n');
    write('docs/specs/solo_spec_planned.md', 'solo spec\n');
    const documents = await collectOutgoingDocuments(root, join(root, 'docs/plans/solo_plan.md'));
    expect(documents.map(document => document.path)).toEqual(['docs/plans/solo_plan.md', 'docs/specs/solo_spec_planned.md']);
  });

  it('leaves out ordinary markdown, web addresses, missing files, oversized files, files outside the repository and symlinks out', async () => {
    const outside = join(mac.root, 'outside_plan.md');
    writeFileSync(outside, 'outside\n');
    symlinkSync(outside, join(root, 'docs/plans/escape_plan.md'));
    write('docs/plans/huge_plan.md', 'x'.repeat(MAX_PLANNING_DOCUMENT_BYTES + 1));
    write('docs/plans/links_plan.md', [
      'README.md', 'docs/architecture.md', 'https://example.invalid/remote_plan.md', 'docs/plans/missing_plan.md',
      'docs/plans/huge_plan.md', 'docs/plans/escape_plan.md', outside, '../../outside_plan.md', '/etc/passwd_plan.md',
      'docs/plans/ok_plan.md',
    ].join('\n'));
    write('docs/plans/ok_plan.md', 'fine\n');
    write('docs/architecture.md', 'not planning\n');
    const documents = await collectOutgoingDocuments(root, join(root, 'docs/plans/links_plan.md'));
    expect(documents.map(document => document.path)).toEqual(['docs/plans/links_plan.md', 'docs/plans/ok_plan.md']);
  });

  it('refuses to send a job document that is not inside the repository', async () => {
    const outside = join(mac.root, 'elsewhere_plan.md');
    writeFileSync(outside, 'x\n');
    await expect(collectOutgoingDocuments(root, outside)).rejects.toThrow(/cannot be sent/);
  });
});

describe('the sent record', () => {
  it('round-trips the exact bytes sent and is cleared on request', async () => {
    const sent = await sentNow();
    await writeSentRecord(root, ITEM, sent);
    const back = await readSentRecord(root, ITEM);
    expect(back).toEqual(sent);
    expect(Buffer.from(recordedDocuments(back).find(entry => entry.path === PLAN)!.contentBase64, 'base64').toString()).toBe(read(PLAN));
    await clearSentRecord(root, ITEM);
    expect(await readSentRecord(root, ITEM)).toEqual({});
  });

  it('is rebuilt from the main checkout\'s current bytes, keeps earlier documents that still exist and drops ones that are gone', async () => {
    const first = await sentNow();
    write('docs/plans/other_plan.md', 'other v2, trimmed by Harness\n');
    const planLinkingNothing = 'no links now\n';
    write(PLAN, planLinkingNothing);
    rmSync(join(root, 'docs/specs/extra_spec.md'));
    const second = await refreshSentRecord(root, join(root, PLAN), first);
    expect(Object.keys(second).sort()).toEqual(Object.keys(first).filter(file => file !== 'docs/specs/extra_spec.md').sort());
    expect(Buffer.from(second['docs/plans/other_plan.md'].contentBase64, 'base64').toString()).toBe('other v2, trimmed by Harness\n');
    expect(Buffer.from(second[PLAN].contentBase64, 'base64').toString()).toBe(planLinkingNothing);
  });
});

describe('applyReturnedDocuments: a document the job was sent with', () => {
  it('replaces the main copy when it is byte for byte what was sent, keeping the old file as a hidden copy', async () => {
    const sent = await sentNow();
    const result = await applyBack(sent, [doc(PLAN, '# plan\nupdated by the job\n')]);
    expect(result.replaced).toEqual([PLAN]);
    expect(result.hold).toBeNull();
    expect(result.written).toEqual([PLAN]);
    expect(read(PLAN)).toBe('# plan\nupdated by the job\n');
    const hidden = retained(PLAN);
    expect(hidden).toHaveLength(1);
    expect(readFileSync(join(root, dirname(PLAN), hidden[0]), 'utf8')).toContain('Spec: [spec]');
    expect(Buffer.from(result.sent[PLAN].contentBase64, 'base64').toString()).toBe('# plan\nupdated by the job\n');
  });

  it('writes nothing when the job\'s bytes equal the main copy', async () => {
    const sent = await sentNow();
    const inode = statSync(join(root, PLAN)).ino;
    const result = await applyBack(sent, [doc(PLAN, read(PLAN))]);
    expect(result.identical).toEqual([PLAN]);
    expect(result.written).toEqual([]);
    expect(retained(PLAN)).toHaveLength(0);
    expect(statSync(join(root, PLAN)).ino).toBe(inode);
  });

  it('keeps the job\'s version beside the plan and holds the job when the main copy changed meanwhile', async () => {
    const sent = await sentNow();
    write(PLAN, '# plan\njames edited this while the job was away\n');
    const result = await applyBack(sent, [doc(PLAN, '# plan\nthe job\'s version\n')]);
    expect(result.replaced).toEqual([]);
    expect(read(PLAN)).toBe('# plan\njames edited this while the job was away\n');
    expect(result.beside).toHaveLength(1);
    const copy = result.beside[0].copy;
    expect(copy).toMatch(/^docs\/plans\/x_plan\.from-queue-[a-z0-9]+\.md$/);
    expect(read(copy)).toBe('# plan\nthe job\'s version\n');
    expect(result.hold?.text).toBe('the plan changed here while the job was on the Windows PC');
    expect(result.hold?.files).toEqual([PLAN]);
    expect(result.hold?.detail).toContain(PLAN);
    expect(result.hold?.detail).toContain(copy);
    expect(result.written).toEqual([copy]);
    expect(retained(PLAN)).toHaveLength(0);
    // What was sent is unchanged, so the held round is not forgotten.
    expect(result.sent[PLAN]).toEqual(sent[PLAN]);
  });

  it('keeps a second copy, never overwriting the first, when it happens again', async () => {
    const sent = await sentNow();
    write(PLAN, 'edited\n');
    await applyBack(sent, [doc(PLAN, 'job 1\n')]);
    await applyBack(sent, [doc(PLAN, 'job 2\n')]);
    expect(beside(PLAN)).toHaveLength(2);
  });

  it('does not count Harness\'s own trim as an edit by James once the next send has refreshed what was sent', async () => {
    const sent = await sentNow();
    const first = await applyBack(sent, [doc(PLAN, '# plan\nround 1 by the job\n')]);
    // The coordinator's save trims the plan in place, then the next send refreshes the record from the main checkout.
    write(PLAN, '# plan\nround 1 by the job (trimmed)\n');
    const refreshed = await refreshSentRecord(root, join(root, PLAN), first.sent);
    const second = await applyBack(refreshed, [doc(PLAN, '# plan\nround 2 by the job\n')]);
    expect(second.hold).toBeNull();
    expect(second.replaced).toEqual([PLAN]);
    expect(read(PLAN)).toBe('# plan\nround 2 by the job\n');
    // Without the refresh the same trim would have looked like an edit.
    write(PLAN, '# plan\nround 1 by the job (trimmed)\n');
    const stale = await applyBack(first.sent, [doc(PLAN, '# plan\nround 2 again\n')]);
    expect(stale.hold).not.toBeNull();
  });

  it('keeps the job\'s version beside the plan when the main copy has gone', async () => {
    const sent = await sentNow();
    rmSync(join(root, 'docs/specs/extra_spec.md'));
    const result = await applyBack(sent, [doc('docs/specs/extra_spec.md', 'extra by the job\n')]);
    expect(existsSync(join(root, 'docs/specs/extra_spec.md'))).toBe(false);
    expect(result.hold?.files).toEqual(['docs/specs/extra_spec.md']);
    expect(read(result.beside[0].copy)).toBe('extra by the job\n');
  });

  it('replaces several documents independently: the unchanged ones are replaced and only the edited one is held', async () => {
    const sent = await sentNow();
    write('docs/plans/other_plan.md', 'james edited other\n');
    const result = await applyBack(sent, [doc(PLAN, 'plan by job\n'), doc('docs/plans/other_plan.md', 'other by job\n'), doc('docs/specs/x_spec_planned.md', 'spec by job\n')]);
    expect(result.replaced.sort()).toEqual([PLAN, 'docs/specs/x_spec_planned.md']);
    expect(result.hold?.files).toEqual(['docs/plans/other_plan.md']);
    expect(read('docs/specs/x_spec_planned.md')).toBe('spec by job\n');
  });
});

describe('applyReturnedDocuments: a document the job created or was not sent with', () => {
  it('copies a new document once and counts it as sent from then on', async () => {
    const sent = await sentNow();
    const created = 'docs/plans/x_plan_livetest.md';
    const first = await applyBack(sent, [doc(created, 'checks v1\n')]);
    expect(first.created).toEqual([created]);
    expect(read(created)).toBe('checks v1\n');
    expect(retained(created)).toHaveLength(0);
    expect(Object.keys(first.sent)).toContain(created);
    // The same bytes again do not write again.
    const again = await applyBack(first.sent, [doc(created, 'checks v1\n')]);
    expect(again.created).toEqual([]);
    expect(again.identical).toEqual([created]);
    // The next round's edit replaces it, as for any sent document.
    const edited = await applyBack(first.sent, [doc(created, 'checks v2\n')]);
    expect(edited.replaced).toEqual([created]);
    expect(read(created)).toBe('checks v2\n');
  });

  it('brings an unlinked existing document back only as a beside copy, never replacing it', async () => {
    const unlinked = 'docs/plans/unlinked_plan.md';
    write(unlinked, 'unlinked v1\n');
    const sent = await sentNow();
    expect(Object.keys(sent)).not.toContain(unlinked);
    const result = await applyBack(sent, [doc(unlinked, 'unlinked edited far away\n')]);
    expect(result.replaced).toEqual([]);
    expect(result.hold).toBeNull();
    expect(read(unlinked)).toBe('unlinked v1\n');
    expect(result.beside).toHaveLength(1);
    expect(read(result.beside[0].copy)).toBe('unlinked edited far away\n');
    expect(Object.keys(result.sent)).not.toContain(unlinked);
  });

  it('writes nothing for an unsent document that is identical to the main copy', async () => {
    const unlinked = 'docs/plans/unlinked_plan.md';
    write(unlinked, 'same\n');
    const result = await applyBack(await sentNow(), [doc(unlinked, 'same\n')]);
    expect(result.identical).toEqual([unlinked]);
    expect(result.written).toEqual([]);
    expect(Object.keys(result.sent)).not.toContain(unlinked);
  });
});

describe('applyReturnedDocuments: paths and deletions', () => {
  it('rejects paths that try to leave the project and writes nothing outside', async () => {
    const escapes = ['../escaped_plan.md', '../../escaped_plan.md', 'docs/../../escaped_plan.md', '/tmp/escaped_plan.md', 'C:/escaped_plan.md', '.git/hooks/x_plan.md', 'docs\\..\\escaped_plan.md', ''];
    const result = await applyBack(await sentNow(), escapes.map(path => doc(path, 'bad\n')));
    expect(result.rejected.map(entry => entry.path)).toEqual(escapes);
    expect(result.written).toEqual([]);
    expect(existsSync(join(dirname(root), 'escaped_plan.md'))).toBe(false);
    expect(existsSync(join(root, '.git/hooks/x_plan.md'))).toBe(false);
  });

  it('does not write through a folder that is a link out of the project', async () => {
    const outside = join(mac.root, 'outside-folder');
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'linked'));
    const result = await applyBack(await sentNow(), [doc('linked/new_plan.md', 'sneaky\n')]);
    expect(result.created).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(existsSync(join(outside, 'new_plan.md'))).toBe(false);
  });

  it('reports a document deleted over there without deleting it here', async () => {
    const result = await applyBack(await sentNow(), [], ['docs/plans/other_plan.md', '../bad.md']);
    expect(result.deletedFarSide).toEqual(['docs/plans/other_plan.md']);
    expect(result.rejected.map(entry => entry.path)).toEqual(['../bad.md']);
    expect(read('docs/plans/other_plan.md')).toBe('other v1\n');
  });
});
