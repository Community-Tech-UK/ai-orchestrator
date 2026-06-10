/**
 * Tool Runner Child Process
 *
 * Executes a single local tool module in an isolated Node process.
 * Parent sends { toolFilePath, args, ctx } and we respond once.
 *
 * This is not a security sandbox (tool code can still access Node),
 * but it hardens the host by isolating crashes, timeouts, and memory usage.
 */

import { getElectronParentPort } from '../runtime/electron-parent-port';

type RunnerRequest = {
  toolFilePath: string;
  args: unknown;
  ctx: { instanceId: string; workingDirectory: string };
};

// In packaged builds this child runs as an Electron utilityProcess (the
// RunAsNode fuse is disabled, so child_process.fork cannot produce a Node
// child; see src/main/runtime/isolated-worker-process.ts). IPC then runs
// over process.parentPort instead of process.send.
const electronPort = getElectronParentPort();

function sendToParent(message: unknown): void {
  if (electronPort) {
    electronPort.postMessage(message);
    return;
  }
  if (process.send) process.send(message);
}

function onParentMessage(listener: (message: RunnerRequest) => void): void {
  if (electronPort) {
    electronPort.start?.();
    electronPort.on('message', (event) => listener(event.data as RunnerRequest));
    return;
  }
  process.on('message', (message) => listener(message as RunnerRequest));
}

type ProgressMessage = { type: 'progress'; message: string; timestamp: number };

type RunnerResponse =
  | { ok: true; output: unknown }
  | { ok: false; error: string };

function loadTool(filePath: string): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(filePath);
  return mod && (mod.default || mod);
}

async function main(req: RunnerRequest): Promise<RunnerResponse> {
  try {
    const def = loadTool(req.toolFilePath);
    if (!def || typeof def !== 'object') {
      return { ok: false, error: 'Tool module did not export an object' };
    }
    if (typeof def.execute !== 'function') {
      return { ok: false, error: 'Tool module missing execute()' };
    }
    // Provide a progress callback to the tool
    const progress = (message: string) => {
      const msg: ProgressMessage = { type: 'progress', message, timestamp: Date.now() };
      sendToParent(msg);
    };

    const out = await def.execute(req.args ?? {}, { ...req.ctx, progress });
    return { ok: true, output: out };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

onParentMessage((msg: RunnerRequest) => {
  void (async () => {
    const res = await main(msg);
    sendToParent(res);
  })();
});
