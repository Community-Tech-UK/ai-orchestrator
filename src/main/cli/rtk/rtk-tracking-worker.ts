// Worker realms need their own runtime alias registration before logger imports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../register-aliases');
import { parentPort, workerData } from 'node:worker_threads';
import { RtkTrackingReader } from './rtk-tracking-reader';
import type { RtkWorkerRequest } from './rtk-tracking-client';

const reader = new RtkTrackingReader(workerData);
parentPort!.on('message', (request: RtkWorkerRequest) => {
  try {
    let result: unknown;
    if (request.method === 'summary') {
      const summary = reader.getSummary(request.options);
      result = summary ? { ...summary, projectBursts: reader.getProjectBursts() } : null;
    } else {
      result = reader.getRecentHistory(request.options);
    }
    parentPort!.postMessage({ id: request.id, result });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
parentPort!.on('close', () => reader.close());
