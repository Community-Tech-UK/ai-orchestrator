/**
 * Runs the coordinator checkout's own defect-ID allocator for a remote worker, outside the main process.
 * Started through createIsolatedWorkerProcess: the packaged app cannot run Node through ELECTRON_RUN_AS_NODE.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { getElectronParentPort } from '../../runtime/electron-parent-port';

export interface DefectReservationWorkerRequest { root: string; count: number }
export type DefectReservationWorkerResult = { ok: true; identifiers: string[] } | { ok: false; error: string };

interface Allocator {
  reservationAuthority(cwd: string): unknown;
  reserveIdentifier(authority: unknown): string;
}

// Native import must survive the CommonJS main-process compilation.
const importModule = compileFunction('return import(specifier)', ['specifier'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}) as (specifier: string) => Promise<Allocator>;

async function reserve({ root, count }: DefectReservationWorkerRequest): Promise<DefectReservationWorkerResult> {
  try {
    const allocator = await importModule(pathToFileURL(join(root, 'scripts/lib/lt-id-reservation.mjs')).href);
    const authority = allocator.reservationAuthority(root);
    const identifiers: string[] = [];
    // Each claim is durable as soon as it is made; a later failure keeps the earlier ones.
    for (let index = 0; index < count; index++) identifiers.push(allocator.reserveIdentifier(authority));
    return { ok: true, identifiers };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const electronPort = getElectronParentPort();
if (electronPort) {
  electronPort.start?.();
  electronPort.on('message', event => {
    void reserve(event.data as DefectReservationWorkerRequest).then(result => electronPort.postMessage(result));
  });
} else if (typeof process.send === 'function') {
  process.once('disconnect', () => process.exit(0));
  process.on('message', message => {
    void reserve(message as DefectReservationWorkerRequest).then(result => process.send?.(result));
  });
} else {
  throw new Error('remote-defect-reservation-worker must run as a utility or child process');
}
