/**
 * Tool Runner Child Process
 *
 * Executes a single local tool module in an isolated Node process.
 * Parent sends { toolFilePath, args, ctx } and we respond once.
 *
 * This is not a security sandbox (tool code can still access Node),
 * but it hardens the host by isolating crashes, timeouts, and memory usage.
 */

type RunnerRequest = {
  toolFilePath: string;
  args: unknown;
  ctx: { instanceId: string; workingDirectory: string };
};

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
      if (process.send) process.send(msg);
    };

    const out = await def.execute(req.args ?? {}, { ...req.ctx, progress });
    return { ok: true, output: out };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

process.on('message', (msg: RunnerRequest) => {
  void (async () => {
    const res = await main(msg);
    if (process.send) process.send(res);
  })();
});

