import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeDocumentFile, documentFileIdentity, isRecoveryCopyName } from './plan-queue-document-mutation';
import { PlanQueueRecoveryCopies, RECOVERY_COPY_KEPT_MS } from './plan-queue-recovery-copies';

const UUID = '3fde27ee-e5a3-4b54-925a-33442a8413b0';
let folder: string;
const write = (name: string, content = 'old version\n') => fs.writeFileSync(path.join(folder, name), content);
const present = () => fs.readdirSync(folder).sort();
// Change times cannot be set, so a copy's age comes from the sweep's clock.
const weekOn = (extraMs: number) => Date.now() + RECOVERY_COPY_KEPT_MS + extraMs;

// The real path: document changes refuse a symlinked ancestor such as macOS's /var.
beforeEach(() => { folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pq-recovery-copies-'))); });
afterEach(() => { fs.rmSync(folder, { recursive: true, force: true }); });

describe('recovery copy names', () => {
  it('matches the names changeDocumentFile leaves beside a document', () => {
    write('a_plan.md', 'before\n');
    const file = path.join(folder, 'a_plan.md');
    changeDocumentFile(documentFileIdentity(file), Buffer.from('before\n'), 'after\n');
    const copies = present().filter(name => name !== 'a_plan.md');
    expect(copies).toHaveLength(1);
    expect(isRecoveryCopyName(copies[0])).toBe(true);
  });

  it('matches nothing else', () => {
    expect(isRecoveryCopyName(`.a_plan.md.aio-prepared-${UUID}`)).toBe(true);
    for (const name of ['a_plan.md', `a_plan.md.aio-retained-${UUID}`, '.a_plan.md.aio-retained-1234', `.a_plan.md.aio-retained-${UUID}.bak`,
      `.a_plan.md.aio-kept-${UUID}`]) expect(isRecoveryCopyName(name), name).toBe(false);
  });
});

describe('PlanQueueRecoveryCopies', () => {
  it('removes both kinds of copy a week after their last change and keeps younger ones', async () => {
    write(`.a_plan.md.aio-retained-${UUID}`);
    write(`.a_plan.md.aio-prepared-${UUID}`);
    await new PlanQueueRecoveryCopies().sweep([folder], weekOn(-60_000));
    expect(present()).toHaveLength(2);
    await new PlanQueueRecoveryCopies().sweep([folder], weekOn(60_000));
    expect(present()).toEqual([]);
  });

  it('judges age by when the copy was set aside, not by when the document was last edited', async () => {
    const copy = path.join(folder, `.a_plan.md.aio-retained-${UUID}`);
    write(`.a_plan.md.aio-retained-${UUID}`);
    const monthAgo = new Date(Date.now() - 4 * RECOVERY_COPY_KEPT_MS);
    fs.utimesSync(copy, monthAgo, monthAgo);
    await new PlanQueueRecoveryCopies().sweep([folder], Date.now());
    expect(fs.existsSync(copy)).toBe(true);
  });

  it('leaves documents, look-alike names, folders and links alone', async () => {
    write('a_plan.md');
    write(`a_plan.md.aio-retained-${UUID}`);
    write('.a_plan.md.aio-retained-not-a-uuid');
    fs.mkdirSync(path.join(folder, `.b_plan.md.aio-retained-${UUID}`));
    const target = path.join(folder, 'target.md');
    write('target.md');
    fs.symlinkSync(target, path.join(folder, `.c_plan.md.aio-retained-${UUID}`));
    const before = present();
    await new PlanQueueRecoveryCopies().sweep([folder], weekOn(60_000));
    expect(present()).toEqual(before);
    expect(fs.readFileSync(target, 'utf8')).toBe('old version\n');
  });

  it('skips a folder that has gone and sweeps the rest', async () => {
    write(`.a_plan.md.aio-retained-${UUID}`);
    await new PlanQueueRecoveryCopies().sweep([path.join(folder, 'gone'), folder], weekOn(60_000));
    expect(present()).toEqual([]);
  });

  it('carries on past a copy it cannot remove', async () => {
    const other = '0485b8b1-854f-4f05-bbe7-5f1661645039';
    write(`.a_plan.md.aio-retained-${UUID}`);
    write(`.b_plan.md.aio-retained-${other}`);
    const unlink = vi.spyOn(fs.promises, 'unlink');
    unlink.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    try {
      await new PlanQueueRecoveryCopies().sweep([folder], weekOn(60_000));
    } finally { unlink.mockRestore(); }
    expect(present()).toHaveLength(1);
  });

  it('sweeps once an hour', () => {
    const copies = new PlanQueueRecoveryCopies();
    const folders = vi.fn(() => [] as string[]);
    copies.sweepDue(folders, 1000);
    copies.sweepDue(folders, 2000);
    expect(folders).toHaveBeenCalledTimes(1);
    copies.sweepDue(folders, 1000 + 60 * 60_000);
    expect(folders).toHaveBeenCalledTimes(2);
  });
});
