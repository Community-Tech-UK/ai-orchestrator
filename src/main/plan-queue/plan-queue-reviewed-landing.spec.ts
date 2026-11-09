import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import * as disk from 'node:fs';
import { tmpdir } from 'node:os';
import * as fs from 'fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueVerdict } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import { PlanQueueGateRunner } from './plan-queue-gate-receipts';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import { PlanQueueVerification } from './plan-queue-verification';
import { dietAtCheckpoint } from './plan-queue-plan-diet';
import { landItemBranch } from './plan-queue-landing';
import type { PlanQueueItem } from './plan-queue.types';

// Keep real verification, durable history, serialization, diet, and filesystem closure.
// Git promotion/checkout ownership are separate integration boundaries covered elsewhere.
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), linkSync: vi.fn(actual.linkSync) };
});
vi.mock('fs/promises', async original => {
  const actual = await original<typeof import('fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
vi.mock('../workspace/git/git-exec', () => ({ gitExec: vi.fn(async (args: string[]) => {
  if (args[0] === 'check-ignore') return '';
  if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? 'head' : 'base';
  return '';
}), gitExecSafe: vi.fn(async () => '0') }));
vi.mock('./plan-queue-doc-merge', () => ({ recoverDocumentMergeForItem: async () => ({ ok: true, mergedPaths: [] }) }));
vi.mock('./plan-queue-squash', () => ({ returnToItemCheckout: async () => null }));
// The work folder here is not a git checkout, so the pre-commit overlap check has nothing to read.
vi.mock('./plan-queue-landing-wait', async original => ({ ...(await original<typeof import('./plan-queue-landing-wait')>()), landingBlockers: async () => [] }));
vi.mock('./plan-queue-landing', () => ({ landItemBranch: vi.fn(async () => ({ status: 'landed', commit: 'promoted' })) }));
let root: string;
let db: SqliteDriver;
let store: PlanQueueStore;
let host: PlanQueueFlowHost;
let flow: PlanQueueItemFlow;
const reviewed = '# Plan\n\n- [x] Original implemented criterion.\n';
const addition = '- [ ] Newly added requirement after PASS.\n';
const pass: PlanQueueVerdict = { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: true, needJames: [], notChecked: [] };
beforeAll(() => initSqliteWasm());
beforeEach(async () => {
  const diskActual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(disk.writeFileSync).mockImplementation(diskActual.writeFileSync);
  vi.mocked(disk.linkSync).mockImplementation(diskActual.linkSync);
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  vi.mocked(fs.writeFile).mockImplementation(actual.writeFile);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-reviewed-landing-')));
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db); store = new PlanQueueStore(db);
  store.upsertRun({ id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: root,
    status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, baseBranch: 'main', verifierGates: [], postMergeGate: [] },
    workerProvider: 'claude', workerModel: null, relaxation: null, startedAt: 1, endedAt: null });
  host = { store, history: store.history, getRun: (id: string) => store.getRun(id)!, getItem: (id: string) => store.getItem(id)!,
    save: (item: PlanQueueItem) => { store.upsertItem(item); return item; },
    transition: (item: PlanQueueItem, state: PlanQueueItem['state'], patch: Partial<PlanQueueItem> = {}) => {
      const next = { ...item, ...patch, state }; store.upsertItem(next); return next;
    }, instances: { getInstance: () => undefined }, tracker: {}, requestPump: vi.fn(),
    worktrees: {
      checkpoint: async (item: PlanQueueItem) => { await dietAtCheckpoint(item, store.history); return item; },
      preflightPlanningFiles: async () => ({ moved: [], beside: [], failed: [] }),
      removeWithProof: async (item: PlanQueueItem) => { host.save({ ...item, worktreePath: null }); return { removed: true }; },
      deleteBranchWithProof: async (item: PlanQueueItem) => { host.save({ ...item, branchName: null }); },
    },
  } as unknown as PlanQueueFlowHost;
  flow = new PlanQueueItemFlow(host);
  vi.mocked(landItemBranch).mockClear();
  vi.mocked(landItemBranch).mockImplementation(async () => ({ status: 'landed', commit: 'promoted' }));
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(root, { recursive: true, force: true }); });
async function checkedItem(id = 'item', content = reviewed, runId = 'run', section?: number): Promise<PlanQueueItem> {
  const sourceRef = join(root, `${id}_plan.md`);
  const worktreePath = join(root, `${id}-worktree`); mkdirSync(worktreePath);
  writeFileSync(sourceRef, content);
  const item = newPlanQueueItem(id, runId, sourceRef, 1, { state: 'verifying', branchName: `queue/${id}`,
    worktreePath, checkpointCommit: 'head', verifiedMainCommit: 'base', ...(section === undefined ? {} : { section }) });
  store.upsertItem(item);
  const verification = new PlanQueueVerification(host, new PlanQueueGateRunner(), { lock: async (_id, action) => action(), waiting: () => false });
  await verification.prompt(item, host.getRun(runId), 'main');
  const verdict = await verification.record(item, pass);
  expect(verdict.verdict).toBe('PASS');
  return host.transition(item, 'landing', { verdict, round: 1 });
}
function expectOpen(item: PlanQueueItem): void {
  expect(readFileSync(item.sourceRef, 'utf8')).toContain(addition);
  expect(existsSync(item.sourceRef.replace('.md', '_completed.md'))).toBe(false);
  expect(host.getItem(item.id).state).toBe('parked');
}
describe('reviewed root document through landing and closure', () => {
  it.each(['changed', 'introduced', 'removed'] as const)('keeps linked specification %s after PASS open across restart', async change => {
    const spec = join(root, 'item_spec_planned.md');
    if (change !== 'introduced') writeFileSync(spec, reviewed);
    const item = await checkedItem();
    if (change === 'removed') rmSync(spec);
    else writeFileSync(spec, reviewed + addition);
    store = new PlanQueueStore(db); host = { ...host, store, history: store.history }; flow = new PlanQueueItemFlow(host);
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(host.getItem(item.id).state).toBe('parked');
    expect(existsSync(item.sourceRef)).toBe(true);
    expect(existsSync(join(root, 'item_spec_completed.md'))).toBe(false);
    if (change !== 'removed') expect(readFileSync(spec, 'utf8')).toContain(addition);
    expect(landItemBranch).not.toHaveBeenCalled();
  });

  it('promotes nothing when the document changed after its commit was built, as it can during a landing wait', async () => {
    const item = await checkedItem();
    host.save({ ...item, landedCommit: 'built-before-the-wait', landingWaitSince: 1 });
    writeFileSync(item.sourceRef, reviewed + addition);
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(landItemBranch).not.toHaveBeenCalled();
    expectOpen(item);
  });

  it('keeps a linked specification changed at promotion open for another review', async () => {
    const spec = join(root, 'item_spec_planned.md'); writeFileSync(spec, reviewed);
    const item = await checkedItem();
    vi.mocked(landItemBranch).mockImplementationOnce(async () => {
      writeFileSync(spec, reviewed + addition); return { status: 'landed', commit: 'promoted' };
    });
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(host.getItem(item.id)).toMatchObject({ state: 'parked', landedCommit: 'promoted' });
    expect(readFileSync(spec, 'utf8')).toContain(addition);
    expect(existsSync(item.sourceRef)).toBe(true);
    expect(existsSync(join(root, 'item_spec_completed.md'))).toBe(false);
  });

  it.each([false, true])('keeps added requirements open after a serialized landing delay (restart: %s)', async restart => {
    const first = await checkedItem('first');
    const second = await checkedItem('second');
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const enteredLanding = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(landItemBranch).mockImplementationOnce(async () => { entered(); await waiting; return { status: 'landed', commit: 'promoted' }; });
    if (restart) flow = new PlanQueueItemFlow(host);
    const firstLanding = flow.enqueueLanding(first.id);
    await enteredLanding;
    // A fresh flow still reads the persisted verdict identity, never an in-memory review map.
    const secondLanding = flow.enqueueLanding(second.id);
    writeFileSync(second.sourceRef, reviewed + addition);
    release(); await firstLanding; await secondLanding; await flow.whenSettled();
    expectOpen(second);
    expect(host.getItem(first.id).state).toBe('landed');
  });

  it.each(['changed', 'introduced'] as const)('rejects a specification %s after interrupted publication and restart', async change => {
    const spec = join(root, 'item_spec_planned.md');
    if (change === 'changed') writeFileSync(spec, reviewed);
    const item = await checkedItem();
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
      if (String(args[0]).includes('item_plan_completed.md.')) throw new Error('Interrupted fixture publication');
      return actual.writeFile(...args);
    });
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(existsSync(join(root, 'item_plan_closure_completed.json'))).toBe(true);
    expect(host.getItem(item.id)).toMatchObject({ state: 'parked', landedCommit: 'promoted' });
    writeFileSync(spec, reviewed + addition);
    vi.mocked(fs.writeFile).mockImplementation(actual.writeFile);
    store = new PlanQueueStore(db); host = { ...host, store, history: store.history }; flow = new PlanQueueItemFlow(host);
    host.transition(host.getItem(item.id), 'landing');
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(host.getItem(item.id).state).toBe('parked');
    expect(readFileSync(spec, 'utf8')).toContain(addition);
    expect(existsSync(item.sourceRef)).toBe(true);
    expect(existsSync(join(root, 'item_plan_completed.md'))).toBe(false);
  });

  it('refuses a legacy root-only PASS rather than guessing that no specification was reviewed', async () => {
    const item = await checkedItem();
    const original = store.history.listVerdicts(item.id)[0];
    store.history.recordVerdict({ itemId: item.id, runId: item.runId, round: 2, verdict: 'PASS',
      findings: [], gatesRun: [], notChecked: [], worktreeHead: original.worktreeHead, documentSha256: original.documentSha256 });
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(host.getItem(item.id)).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(existsSync(item.sourceRef)).toBe(true);
    expect(existsSync(join(root, 'item_plan_completed.md'))).toBe(false);
    expect(landItemBranch).not.toHaveBeenCalled();
    expect(store.history.listVerdicts(item.id)[0]).toEqual(original);
  });

  it('closes the unchanged positive control and preserves shared history', async () => {
    const item = await checkedItem();
    writeFileSync(join(root, 'item_history.md'), 'Shared history remains active.\n');
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(host.getItem(item.id).state).toBe('landed');
    expect(existsSync(item.sourceRef)).toBe(false);
    expect(readFileSync(join(root, 'item_plan_completed.md'), 'utf8')).toContain('Original implemented criterion.');
    expect(readFileSync(join(root, 'item_history.md'), 'utf8')).toBe('Shared history remains active.\n');
  });

  it('keeps requirements added at the promotion to final-closure boundary active', async () => {
    const item = await checkedItem();
    vi.mocked(landItemBranch).mockImplementationOnce(async () => {
      writeFileSync(item.sourceRef, reviewed + addition);
      return { status: 'landed', commit: 'promoted' };
    });
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expectOpen(item);
    expect(host.getItem(item.id).landedCommit).toBe('promoted');
  });

  it('keeps legacy PASS work without a durable review identity open for a new check', async () => {
    const reviewedItem = await checkedItem();
    const item = { ...reviewedItem, id: 'legacy', sourceRef: join(root, 'legacy_plan.md') };
    writeFileSync(item.sourceRef, reviewed);
    store.upsertItem(item);
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(readFileSync(item.sourceRef, 'utf8')).toBe(reviewed);
    expect(existsSync(join(root, 'legacy_plan_completed.md'))).toBe(false);
    expect(host.getItem(item.id)).toMatchObject({ state: 'parked', parkReason: 'land-blocked', branchName: item.branchName });
    expect(host.getItem(item.id).detail).toContain('check it again');
    expect(vi.mocked(landItemBranch)).not.toHaveBeenCalled();
  });

  it('rechecks the source at the final completed-file publication boundary', async () => {
    const item = await checkedItem();
    const { writeFile: write } = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
      await write(...args);
      if (String(args[0]).includes('item_plan_completed.md.') && String(args[0]).endsWith('.tmp')) {
        writeFileSync(item.sourceRef, reviewed + addition);
      }
    });
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expectOpen(item);
  });

  it.each(['original descriptor', 'active path'] as const)('refuses a diet transform with a concurrent %s requirement before closure', async writer => {
    const item = await checkedItem('item', reviewed + '## Status\nReady\n## Status\nReady\n## As-built\n### 3 November\nJournal.\n');
    const original = store.history.listVerdicts(item.id)[0];
    const before = readFileSync(item.sourceRef, 'utf8');
    const originalFd = disk.openSync(item.sourceRef, 'a');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let injected = false;
    const append = () => {
      if (injected) return;
      injected = true;
      if (writer === 'original descriptor') disk.writeSync(originalFd, addition);
      else disk.appendFileSync(item.sourceRef, addition);
    };
    // Exercise the old destructive write and its complete-before-visible replacement boundary.
    vi.mocked(disk.writeFileSync).mockImplementation((file, data, options) => {
      if (typeof file === 'number' && existsSync(item.sourceRef)
        && disk.fstatSync(file).ino === disk.statSync(item.sourceRef).ino) append();
      return actual.writeFileSync(file, data, options);
    });
    vi.mocked(disk.linkSync).mockImplementation((from, to) => {
      actual.linkSync(from, to);
      if (String(to) === item.sourceRef) append();
    });
    try {
      await flow.enqueueLanding(item.id); await flow.whenSettled();
      expect(injected).toBe(true);
      const copies = disk.readdirSync(root).filter(name => disk.lstatSync(join(root, name)).isFile());
      expect(copies.some(name => readFileSync(join(root, name), 'utf8').includes(addition))).toBe(true);
      const retained = copies.filter(name => name.startsWith('.item_plan.md.aio-retained-'));
      expect(retained).toHaveLength(1);
      expect(readFileSync(join(root, retained[0]), 'utf8')).toBe(before + (writer === 'original descriptor' ? addition : ''));
      if (writer === 'active path') expect(readFileSync(item.sourceRef, 'utf8')).toContain(addition);
      expect(host.getItem(item.id).state).toBe('parked');
      expect(existsSync(item.sourceRef)).toBe(true);
      expect(existsSync(join(root, 'item_plan_completed.md'))).toBe(false);
      expect(landItemBranch).not.toHaveBeenCalled();
      expect(store.history.listVerdicts(item.id)[0]).toEqual(original);
      expect(store.history.reviewedDocumentSha256(item.id)).toBe(original.documentSha256);
    } finally { disk.closeSync(originalFd); }
  });

  it.each([false, true])('restores exact coordinator journal acceptance across restart, rejecting later work (changed: %s)', async changed => {
    const journal = '### 2026-11-03\nEarlier evidence.\n';
    const item = await checkedItem('item', reviewed + '## Status\nReady\n## Status\nReady\n## As-built\n' + journal);
    const originalReview = store.history.listVerdicts(item.id)[0];
    await dietAtCheckpoint(item, store.history);
    store = new PlanQueueStore(db); host = { ...host, store, history: store.history }; flow = new PlanQueueItemFlow(host);
    expect(store.history.listVerdicts(item.id)[0]).toEqual(originalReview);
    if (changed) writeFileSync(item.sourceRef, readFileSync(item.sourceRef, 'utf8') + addition);
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    if (changed) { expectOpen(item); return; }
    expect(host.getItem(item.id).state).toBe('landed');
    expect(readFileSync(join(root, 'item_history.md'), 'utf8')).toBe(journal);
    expect(existsSync(item.sourceRef)).toBe(false);
  });

  it('lands nothing and keeps the plan open when its Status names work on another branch', async () => {
    const item = await checkedItem('elsewhere', '# Plan\n\n## Status\n\nOn main: no (queue/other-branch)\n\n- [x] Done.\n');
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    const parked = host.getItem(item.id);
    expect(parked.state).toBe('parked');
    expect(parked.parkReason).toBe('land-blocked');
    expect(parked.detail).toContain('its Status names other unlanded work');
    expect(landItemBranch).not.toHaveBeenCalled();
    expect(existsSync(item.sourceRef)).toBe(true);
    expect(existsSync(join(root, 'elsewhere_plan_completed.md'))).toBe(false);
  });

  it('closes a plan whose Status names only its own branch, saying the work is on main', async () => {
    const item = await checkedItem('own', '# Plan\n\n## Status\n\nOn main: no (queue/own)\n\n- [x] Done.\n');
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(host.getItem(item.id).state).toBe('landed');
    // This folder is not a git repository, so the plan is closed in place with the landed commit.
    const closed = readFileSync(join(root, 'own_plan_completed.md'), 'utf8');
    expect(closed).toMatch(/On main: yes \(\w+\)/);
    expect(closed).not.toContain('On main: no');
  });

  it('updates the "On main" line of a plan that stays open once its work lands', async () => {
    const item = await checkedItem('open', '# Plan\n\n## Status\n\nOn main: no (queue/open)\nNext: Step 2.\n\n- [x] Done.\n');
    host.save({ ...host.getItem(item.id), verdict: { ...item.verdict!, documentComplete: false } });
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(host.getItem(item.id).state).toBe('landed');
    const text = readFileSync(item.sourceRef, 'utf8');
    expect(text).toContain('On main: yes (');
    expect(text).not.toContain('On main: no');
    expect(text).toContain('Next: Step 2.');
    expect(existsSync(join(root, 'open_plan_completed.md'))).toBe(false);
  });

  it('lands a step job without closing its plan, even on a passing verdict, and says only that the step landed', async () => {
    const item = await checkedItem('stepped', '# Plan\n\n## Status\n\nOn main: no (queue/stepped)\n\n## Step 2. Two\n\n- [x] Done.\n', 'run', 2);
    store.upsertItem(newPlanQueueItem('later', 'run', item.sourceRef, 9, { state: 'queued', section: 3 }));
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(host.getItem(item.id).state).toBe('landed');
    expect(landItemBranch).toHaveBeenCalledOnce();
    expect(vi.mocked(landItemBranch).mock.calls[0][5]).toEqual([]);
    expect(existsSync(join(root, 'stepped_plan_completed.md'))).toBe(false);
    expect(readFileSync(item.sourceRef, 'utf8')).toMatch(/On main: Step 2 landed \(\w+\); the other steps may still be open/);
  });

  it.each([['landed', 'yes ('], ['parked', 'Step 3 landed (']] as const)('says the whole plan is on main only when the last step lands after every earlier one (earlier step %s)', async (earlier, wording) => {
    const item = await checkedItem('finale', '# Plan\n\n## Status\n\nOn main: no (queue/finale)\n\n## Step 3. Three\n\n- [x] Done.\n', 'run', 3);
    store.upsertItem(newPlanQueueItem('before', 'run', item.sourceRef, 0, { state: earlier, section: 2 }));
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(host.getItem(item.id).state).toBe('landed');
    expect(readFileSync(item.sourceRef, 'utf8')).toContain(`On main: ${wording}`);
    expect(existsSync(join(root, 'finale_plan_completed.md'))).toBe(false);
  });

  it('sets a step job aside, promoting nothing, when its plan was renamed to the closed name in the root checkout', async () => {
    const item = await checkedItem('renamed', '# Plan\n\n- [x] Done.\n', 'run', 2);
    disk.renameSync(item.sourceRef, join(root, 'renamed_plan_completed.md'));
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(host.getItem(item.id)).toMatchObject({ state: 'parked', parkReason: 'missing-document', detail: expect.stringContaining('a step job never closes its plan') });
    expect(landItemBranch).not.toHaveBeenCalled();
  });

  it.each(['## Status (7 Nov)', '## Status: nearly done'])('updates the existing "%s" block of an open plan instead of adding a second Status heading', async heading => {
    const item = await checkedItem('dated', `# Plan\n\n${heading}\n\nOn main: no (queue/dated)\nNext: Step 2.\n\n- [x] Done.\n`);
    host.save({ ...host.getItem(item.id), verdict: { ...item.verdict!, documentComplete: false } });
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(host.getItem(item.id).state).toBe('landed');
    const text = readFileSync(item.sourceRef, 'utf8');
    expect(text).toContain(`${heading}\n\nOn main: yes (`);
    expect(text.match(/^## Status/gm)).toHaveLength(1);
    expect(text).toContain('Next: Step 2.');
  });

  it('refuses to close a plan whose dated Status heading names other unlanded work', async () => {
    const item = await checkedItem('dated-other', '# Plan\n\n## Status (7 Nov)\n\nOn main: no (queue/other-branch)\n\n- [x] Done.\n');
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(host.getItem(item.id).parkReason).toBe('land-blocked');
    expect(host.getItem(item.id).detail).toContain('queue/other-branch');
    expect(existsSync(join(root, 'dated-other_plan_completed.md'))).toBe(false);
  });

  it('leaves a live-test document without a Status block alone when its work lands', async () => {
    store.upsertRun({ ...store.getRun('run')!, id: 'live-run', kind: 'livetests' });
    const item = await checkedItem('live', '# Live checks\n\n- [x] Done.\n', 'live-run');
    host.save({ ...host.getItem(item.id), verdict: { ...item.verdict!, documentComplete: false } });
    await flow.enqueueLanding(item.id); await flow.whenSettled();
    expect(host.getItem(item.id).state).toBe('landed');
    expect(readFileSync(item.sourceRef, 'utf8')).toBe('# Live checks\n\n- [x] Done.\n');
  });
});
