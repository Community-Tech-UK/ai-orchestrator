import {
  WORKER_INTERNAL_CONNECT_ERROR,
  type WorkerConnectionSnapshot,
  type WorkerModeStatus,
} from '../../../../shared/types/pair-both.types';

export interface WorkerStatusView {
  text: string;
  warning: boolean;
}

export interface WorkerStatusContext {
  /** The worker's own report, while the worker that wrote it is still running. */
  connection: WorkerConnectionSnapshot | null;
  /** That worker was not started by this Harness (see WorkerModeComponent.externalWorker). */
  externalWorker: boolean;
  /** The sign-in task was just asked to start its worker. */
  signInStarting: boolean;
  /** When Start Worker was last pressed, if it was on this page. */
  startedAt: number | null;
}

/**
 * The Worker Mode status line. Prefers the worker's own report of whether it
 * reached the main Harness; falls back to what Harness knows about the process.
 */
export function describeWorkerStatus(
  status: WorkerModeStatus | null,
  context: WorkerStatusContext,
): WorkerStatusView {
  if (!status) {
    return { text: 'Checking the worker...', warning: false };
  }
  if (status.backgroundService) {
    return {
      text: 'The background service runs this worker, even when Harness is closed.',
      warning: false,
    };
  }
  const { connection, externalWorker } = context;
  if (connection && !connection.stale) {
    const view = describeConnection(connection, status.runAtSignIn);
    return externalWorker
      ? { ...view, text: `A worker started outside Harness is running on this computer. ${view.text}` }
      : view;
  }
  if (connection?.stale) {
    return {
      text: externalWorker
        ? 'A worker started outside Harness is running on this computer but has not reported for a few minutes. If your main Harness does not list this computer, restart this computer.'
        : 'The worker is running but has not reported for a few minutes. If your main Harness does not list this computer, press Stop Worker and then Start Worker.',
      warning: true,
    };
  }
  // Shown even while the supervisor is still retrying (the process looks
  // "running" for up to a minute), unless Start was pressed since.
  const report = status.connection;
  const failed = report?.state === 'failed' && (context.startedAt === null || report.updatedAt >= context.startedAt)
    ? report.message
    : undefined;
  if (status.runAtSignIn) {
    if (failed) {
      return { text: `The background worker could not start: ${failed}`, warning: true };
    }
    if (context.signInStarting || status.runtime.state === 'running') {
      return { text: 'Starting the background worker...', warning: false };
    }
    return {
      text: 'The background worker is stopped. Press Start Worker to start it; it then also starts whenever you sign in to Windows.',
      warning: true,
    };
  }
  if (failed) {
    return { text: `The worker could not start: ${failed}`, warning: true };
  }
  if (status.runtime.state === 'running') {
    return { text: 'Starting the worker...', warning: false };
  }
  if (status.runtime.error) {
    return { text: `${status.runtime.error} Press Start Worker to try again.`, warning: true };
  }
  return {
    text: 'The worker is stopped. Press Start Worker so your main Harness can send work to this computer.',
    warning: true,
  };
}

/** Plain-language status for the worker's own connection report. */
export function describeConnection(
  connection: WorkerConnectionSnapshot,
  runAtSignIn: boolean,
): WorkerStatusView {
  const host = coordinatorHost(connection.coordinatorUrl);
  const at = host ? ` at ${host}` : '';
  switch (connection.state) {
    case 'connected':
      return {
        text: runAtSignIn
          ? `Working in the background, even with Harness closed. Connected to your main Harness${at}.`
          : `Working. Connected to your main Harness${at}, which can now send work to this computer.`,
        warning: false,
      };
    case 'connecting':
    case 'registering':
      return { text: `Connecting to your main Harness${at}...`, warning: false };
    case 'reconnecting':
      return { text: `Lost the connection to your main Harness${at}. Reconnecting...`, warning: false };
    case 'unreachable':
      // The network advice is wrong when the fault was on this computer.
      if (connection.message === WORKER_INTERNAL_CONNECT_ERROR) {
        return {
          text: `${connection.message} Still trying. If this does not clear, press Stop Worker and then Start Worker.`,
          warning: true,
        };
      }
      return {
        text: `Cannot reach your main Harness${at}.${connection.message ? ` ${connection.message}` : ''} Check that Harness is open on that computer and that both computers are on the same network (or both on Tailscale). Still trying.`,
        warning: true,
      };
    case 'rejected':
      return {
        text: `Your main Harness turned this computer away${connection.message ? ` (${connection.message})` : ''}. Press Pair Again to pair it again.`,
        warning: true,
      };
    case 'failed':
      return {
        text: `The worker could not start${connection.message ? `: ${connection.message}` : '.'}`,
        warning: true,
      };
    case 'stopped':
      return { text: 'The worker is stopped.', warning: true };
  }
}

function coordinatorHost(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}
