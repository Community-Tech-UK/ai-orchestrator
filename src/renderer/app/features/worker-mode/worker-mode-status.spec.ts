import type { WorkerConnectionSnapshot, WorkerModeStatus } from '../../../../shared/types/pair-both.types';
import { describeConnection, describeWorkerStatus } from './worker-mode-status';

function report(state: WorkerConnectionSnapshot['state'], coordinatorUrl?: string): WorkerConnectionSnapshot {
  return { state, ...(coordinatorUrl ? { coordinatorUrl } : {}), since: 1, updatedAt: 1, alive: true, stale: false };
}

const paired: WorkerModeStatus = {
  paired: true,
  enrolled: true,
  config: null,
  runtime: { state: 'running' },
  backgroundService: false,
  runAtSignIn: false,
  runAtSignInAvailable: false,
  connection: null,
};

describe('worker mode status wording', () => {
  it('names the main Harness by host and port, or leaves the address out', () => {
    expect(describeConnection(report('connecting', 'wss://mac.tail.ts.net:4878'), false).text)
      .toBe('Connecting to your main Harness at mac.tail.ts.net:4878...');
    expect(describeConnection(report('connecting'), false).text).toBe('Connecting to your main Harness...');
    expect(describeConnection(report('connecting', 'not a url'), false).text).toBe('Connecting to your main Harness...');
  });

  it('does not give network advice when the fault was on this computer', () => {
    const view = describeConnection(
      { ...report('unreachable', 'ws://mac:4878'), message: 'Something went wrong on this computer while connecting.' },
      false,
    );
    expect(view.text).toBe('Something went wrong on this computer while connecting. Still trying. If this does not clear, press Stop Worker and then Start Worker.');
    expect(view.warning).toBe(true);
  });

  it('treats only the problems as warnings', () => {
    const warnings = (['connected', 'connecting', 'registering', 'reconnecting', 'unreachable', 'rejected', 'failed'] as const)
      .filter((state) => describeConnection(report(state), false).warning);
    expect(warnings).toEqual(['unreachable', 'rejected', 'failed']);
  });

  it('prefers the worker report over what Harness knows about the process', () => {
    const context = { connection: report('unreachable'), externalWorker: false, signInStarting: false, startedAt: null };
    expect(describeWorkerStatus(paired, context).text).toContain('Cannot reach your main Harness');
    expect(describeWorkerStatus(paired, { ...context, connection: null }).text).toBe('Starting the worker...');
    expect(describeWorkerStatus(null, context).text).toBe('Checking the worker...');
  });

  it('shows a fresh failure reason even while the supervisor is still retrying', () => {
    const failed: WorkerConnectionSnapshot = { ...report('failed'), message: 'Bad address.', alive: false, updatedAt: 2_000 };
    const running = { ...paired, connection: failed };
    const context = { connection: null, externalWorker: false, signInStarting: false, startedAt: 1_000 };

    expect(describeWorkerStatus(running, context).text).toBe('The worker could not start: Bad address.');
    expect(describeWorkerStatus({ ...running, runAtSignIn: true }, { ...context, signInStarting: true }).text)
      .toBe('The background worker could not start: Bad address.');
    // A report from before the latest Start press is out of date.
    expect(describeWorkerStatus(running, { ...context, startedAt: 3_000 }).text).toBe('Starting the worker...');
  });
});
