import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrossModelReviewService } from './cross-model-review-service';
import { InstanceToolResultProcessor } from '../instance/instance-tool-result-processor';
import { SessionDiffTracker } from '../instance/session-diff-tracker';
import { buildInstanceRecord } from '../instance/lifecycle/instance-create-builder';
import { getDefaultAgent } from '../../shared/types/agent.types';
import type { OutputMessage } from '../../shared/types/instance.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { HookManager } from '../hooks/hook-manager';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../util/cleanup-registry', () => ({ registerCleanup: vi.fn() }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ crossModelReviewEnabled: true }) }) }));
vi.mock('../pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false, on: vi.fn(), removeListener: vi.fn() }) }));
vi.mock('../local-models/local-model-inventory-service', () => ({ getLocalModelInventoryService: () => ({ list: () => [] }) }));

describe('automatic review eligibility follows structured edit outcomes', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'aio-edit-outcomes-')); CrossModelReviewService._resetForTesting(); });
  afterEach(() => { CrossModelReviewService._resetForTesting(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

  function harness() {
    const instance = buildInstanceRecord({ workingDirectory: directory, provider: 'claude' }, getDefaultAgent(), { defaultYoloMode: false, getParent: () => undefined });
    instance.status = 'idle'; instance.activeTurnId = 'turn-1';
    const tracker = new SessionDiffTracker(directory);
    const triggerLifecycleHooks = vi.fn().mockResolvedValue(undefined);
    const processor = new InstanceToolResultProcessor({ getDiffTracker: () => tracker,
      hookManager: { triggerLifecycleHooks } as unknown as HookManager });
    const service = CrossModelReviewService.getInstance();
    service.setInstanceManager({ getInstance: () => instance, getTurnFileChanges: () => tracker.getLastTurnChanges() } as unknown as InstanceManager);
    const dispatch = vi.spyOn(service as unknown as { dispatchReview: (...args: unknown[]) => Promise<{ status: 'started' }> }, 'dispatchReview')
      .mockResolvedValue({ status: 'started' });
    const use = (id: string): OutputMessage => ({ id: `use-${id}`, timestamp: 1, type: 'tool_use', content: 'Using tool: Edit',
      metadata: { id, name: 'Edit', input: { file_path: 'file.ts', old_string: 'initial', new_string: 'changed' } } });
    const result = (id: string, isError: boolean): OutputMessage => ({ id: `result-${id}`, timestamp: 2, type: 'tool_result',
      content: isError ? 'Edit refused; nothing was changed.' : 'The file was edited successfully.', metadata: { tool_use_id: id, is_error: isError } });
    const process = (message: OutputMessage) => processor.processToolLifecycle(instance.id, instance, message);
    const idle = async () => {
      tracker.computeDiff();
      service.bufferMessage(instance.id, 'assistant', 'Here is the coding result.', 'claude');
      await service.onInstanceIdle(instance.id);
    };
    return { instance, tracker, processor, triggerLifecycleHooks, dispatch, use, result, process, idle };
  }

  it.each(['failed', 'unresolved'] as const)('skips an unchanged %s Edit through the real processor, tracker and automatic trigger', async outcome => {
    writeFileSync(join(directory, 'file.ts'), 'initial\n');
    const h = harness();
    await h.process(h.use('edit-1'));
    if (outcome === 'failed') await h.process(h.result('edit-1', true));
    await h.idle();
    expect(readFileSync(join(directory, 'file.ts'), 'utf8')).toBe('initial\n');
    expect(h.tracker.getStats()).toMatchObject({ totalAdded: 0, totalDeleted: 0 });
    expect(h.tracker.getLastTurnChanges()).toMatchObject({ changedPaths: [], editedPaths: [] });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each(['before-edit', 'after-edit'] as const)('reviews a successful Edit once with %s baseline timing', async timing => {
    const file = join(directory, 'file.ts');
    writeFileSync(file, 'initial\n');
    const h = harness();
    if (timing === 'after-edit') writeFileSync(file, 'changed\n');
    await h.process(h.use('edit-1'));
    if (timing === 'before-edit') writeFileSync(file, 'changed\n');
    await h.process(h.result('edit-1', false));
    await h.idle();
    expect(h.tracker.getLastTurnChanges()).toMatchObject({ changedPaths: timing === 'before-edit' ? ['file.ts'] : [], editedPaths: ['file.ts'] });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    await h.idle();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('still reviews actual disk changes made before a failed result', async () => {
    const file = join(directory, 'file.ts'); writeFileSync(file, 'initial\n');
    const h = harness(); await h.process(h.use('edit-1')); writeFileSync(file, 'changed\n');
    await h.process(h.result('edit-1', true)); await h.idle();
    expect(h.tracker.getLastTurnChanges()).toMatchObject({ changedPaths: ['file.ts'], editedPaths: [] });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('a later failure on the same path does not erase a successful late-capture edit', async () => {
    writeFileSync(join(directory, 'file.ts'), 'changed\n');
    const h = harness(); await h.process(h.use('edit-success')); await h.process(h.result('edit-success', false));
    await h.process(h.use('edit-failure')); await h.process(h.result('edit-failure', true)); await h.idle();
    expect(h.tracker.getLastTurnChanges()).toMatchObject({ changedPaths: [], editedPaths: ['file.ts'] });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not carry an unresolved request into a later turn', async () => {
    writeFileSync(join(directory, 'file.ts'), 'initial\n');
    const h = harness(); await h.process(h.use('old-edit')); await h.idle();
    h.instance.activeTurnId = 'turn-2';
    await h.process(h.result('old-edit', false)); await h.idle();
    expect(h.tracker.getLastTurnChanges()).toMatchObject({ changedPaths: [], editedPaths: [] });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('matches a successful result that arrives while PreToolUse is still awaiting a hook', async () => {
    writeFileSync(join(directory, 'file.ts'), 'changed\n');
    const h = harness();
    let releaseHook!: () => void;
    h.triggerLifecycleHooks.mockImplementationOnce(() => new Promise<void>(resolve => { releaseHook = resolve; }));
    const request = h.process(h.use('edit-1'));
    await h.process(h.result('edit-1', false));
    releaseHook(); await request; await h.idle();
    expect(h.tracker.getLastTurnChanges()).toMatchObject({ changedPaths: [], editedPaths: ['file.ts'] });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('discards pending edit provenance on processor cleanup', async () => {
    writeFileSync(join(directory, 'file.ts'), 'initial\n');
    const h = harness(); await h.process(h.use('edit-1')); h.processor.cleanup(h.instance.id);
    await h.process(h.result('edit-1', false)); await h.idle();
    expect(h.tracker.getLastTurnChanges()).toMatchObject({ changedPaths: [], editedPaths: [] });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each(['before-edit', 'after-edit'] as const)('reviews a native NotebookEdit with %s baseline timing', async timing => {
    const file = join(directory, 'book.ipynb');
    const notebook = (source: string) => JSON.stringify({ cells: [{ source: [source] }] });
    writeFileSync(file, notebook('initial'));
    const h = harness();
    if (timing === 'after-edit') writeFileSync(file, notebook('changed'));
    await h.process({ id: 'notebook-use', timestamp: 1, type: 'tool_use', content: 'Using tool: NotebookEdit',
      metadata: { id: 'notebook-call', name: 'NotebookEdit', input: { notebook_path: file, new_source: 'changed', cell_id: 'cell-1' } } });
    if (timing === 'before-edit') writeFileSync(file, notebook('changed'));
    await h.process(h.result('notebook-call', false));
    await h.idle();
    expect(h.tracker.getLastTurnChanges()).toMatchObject({ changedPaths: timing === 'before-edit' ? ['book.ipynb'] : [], editedPaths: ['book.ipynb'] });
    expect(h.dispatch).toHaveBeenCalledOnce();
    await h.idle();
    expect(h.dispatch).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'unresolved'] as const)('skips an unchanged native %s NotebookEdit', async outcome => {
    const file = join(directory, 'book.ipynb');
    writeFileSync(file, 'initial notebook');
    const h = harness();
    await h.process({ id: 'notebook-use', timestamp: 1, type: 'tool_use', content: 'Using tool: NotebookEdit',
      metadata: { id: 'notebook-call', name: 'NotebookEdit', input: { notebook_path: file, new_source: 'changed' } } });
    if (outcome === 'failed') await h.process(h.result('notebook-call', true));
    await h.idle();
    expect(h.tracker.getLastTurnChanges()).toMatchObject({ changedPaths: [], editedPaths: [] });
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});
