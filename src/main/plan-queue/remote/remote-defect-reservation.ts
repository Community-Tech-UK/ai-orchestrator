import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createIsolatedWorkerProcess } from '../../runtime/isolated-worker-process';
import type { DefectReservationWorkerRequest, DefectReservationWorkerResult } from './remote-defect-reservation-worker';

const execute = promisify(execFile);

/** The worker supplies no path or executable. Its assigned run owns the coordinator checkout. */
export const RemoteDefectReservationRequestSchema = z.strictObject({
  item_id: z.string().min(1).max(200),
  reserve_defect_ids: z.number().int().min(1).max(8),
});

/** Run the same durable allocator as local workers, on the coordinator, never on the remote clone.
 * A failure can burn earlier IDs in the batch; those immutable claims are intentionally retained. */
export async function reserveRemoteDefectIdentifiers(workspaceCwd: string, count: number): Promise<string[]> {
  RemoteDefectReservationRequestSchema.parse({ item_id: 'coordinator', reserve_defect_ids: count });
  const { stdout: worktrees } = await execute('git', ['worktree', 'list', '--porcelain', '-z'], {
    cwd: workspaceCwd, timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  const first = worktrees.split('\0')[0];
  if (!first.startsWith('worktree ')) throw new Error('Cannot locate the coordinator root checkout for defect allocation');
  const root = first.slice(9);
  const result = await runAllocator({ root, count });
  if (!result.ok) throw new Error(`The coordinator allocator refused the reservation: ${result.error}`);
  const { identifiers } = result;
  if (identifiers.length !== count || identifiers.some((id, index) => !/^LT-[0-9]+$/.test(id) || identifiers.indexOf(id) !== index)) {
    throw new Error('The coordinator allocator returned an invalid or repeated defect identifier. Preserve its ledger.');
  }
  return identifiers;
}

/** The allocator is the root checkout's own script library, run in an isolated worker (never ELECTRON_RUN_AS_NODE). */
async function runAllocator(request: DefectReservationWorkerRequest): Promise<DefectReservationWorkerResult> {
  const jsEntry = join(__dirname, 'remote-defect-reservation-worker.js');
  const worker = createIsolatedWorkerProcess<DefectReservationWorkerRequest, DefectReservationWorkerResult>({
    name: 'defect reservation worker',
    entrypoint: existsSync(jsEntry) ? jsEntry : join(__dirname, 'remote-defect-reservation-worker.ts'),
  });
  try {
    return await new Promise<DefectReservationWorkerResult>((resolve, reject) => {
      // The allocator may wait up to five seconds for contention on each identifier.
      const limitMs = 15_000 + request.count * 5_000;
      const timer = setTimeout(() => reject(new Error(`The coordinator allocator did not answer within ${limitMs / 1000} seconds. Preserve its ledger.`)), limitMs);
      worker.once('message', result => { clearTimeout(timer); resolve(result); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', code => { clearTimeout(timer); reject(new Error(`The coordinator allocator stopped (exit ${code}) before answering.`)); });
      worker.postMessage(request);
    });
  } finally {
    await worker.terminate();
  }
}
