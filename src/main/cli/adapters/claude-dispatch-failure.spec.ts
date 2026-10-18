import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import {
  CliSpawnWorkerGateway,
  type CliSpawnWorkerLike,
} from "../spawn-worker/cli-spawn-worker-gateway";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
vi.mock("../../logging/logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
import { ClaudeCliAdapter } from "./claude-cli-adapter";
import { CliAdapterWorkerProxy } from "../spawn-worker/cli-adapter-worker-proxy";
import { InputFormatter } from "../input-formatter";
import { sendAbortableReviewerMessage } from "../../review/review-execution-host";
import {
  subscribeCostAttribution,
  type CostAttributionRecord,
} from "../../core/system/cost-attribution";
const paid = {
  type: "assistant",
  message: {
    content: [{ type: "text", text: "Disposable paid child" }],
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
    },
  },
};
const result = {
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.25,
  usage: {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 5,
  },
};
const context = {
  purpose: "cross-model-review" as const,
  provider: "claude",
  model: "claude-opus-5",
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function fixture(
  frames: unknown[] = [],
  stay = true,
  timeout = 3000,
  command = process.execPath,
) {
  const adapter = new ClaudeCliAdapter({
    model: "claude-opus-5",
    timeout,
  });
  adapter.on("error", () => undefined);
  let child: ReturnType<typeof spawn> | undefined;
  const closed = vi.fn();
  const spawnError = vi.fn();
  const output = frames.map((x) => JSON.stringify(x)).join("\n") + "\n";
  vi.spyOn(
    adapter as unknown as {
      spawnProcess(args: string[]): ReturnType<typeof spawn>;
    },
    "spawnProcess",
  ).mockImplementation(() => {
    child = spawn(
      command,
      [
        "-e",
        `process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(output)},()=>{${stay ? "" : "process.stdin.destroy();"}});});process.stdin.resume();${stay ? "setInterval(()=>{},1000);" : ""}`,
      ],
      { stdio: ["pipe", "pipe", "pipe"], detached: true },
    );
    child.once("close", closed);
    child.on("error", spawnError);
    return child;
  });
  return {
    adapter,
    closed,
    spawnError,
    get child() {
      return child;
    },
  };
}
async function run(
  adapter: { sendMessage: ClaudeCliAdapter["sendMessage"] },
  content: string,
  extra: Record<string, unknown> = {},
) {
  const rows: CostAttributionRecord[] = [];
  const stop = subscribeCostAttribution((row) => rows.push(row));
  try {
    const error = await sendAbortableReviewerMessage(
      adapter,
      { role: "user", content, ...extra },
      new AbortController().signal,
      undefined,
      context,
    ).catch((e) => e);
    return { rows, error };
  } finally {
    stop();
  }
}
describe("actual direct and worker dispatch failure boundaries", () => {
  it("normal real direct child books the same native paid receipt successfully", async () => {
    vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
    const f = fixture([paid, result], false);
    try {
      const actual = await run(f.adapter, "Disposable successful control");
      expect(actual.rows).toHaveLength(1);
      expect(actual.rows[0]).toMatchObject({
        outcome: "success",
        costKnown: true,
        costSource: "provider",
        usage: { cost: 0.25 },
      });
    } finally {
      await f.adapter.terminate(false);
    }
  });
  it("does not book a real compiled-worker nonexistent-CWD spawn refusal", async () => {
    vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
    const gateway = new CliSpawnWorkerGateway({
      workerFactory: () =>
        new Worker(
          resolve("dist/main/cli/spawn-worker/cli-spawn-worker-main.js"),
        ) as CliSpawnWorkerLike,
    });
    const adapter = new CliAdapterWorkerProxy({
      cliType: "claude",
      instanceId: "real-spawn-refusal",
      options: {
        workingDirectory: join(
          tmpdir(),
          "aio-dispatch-gate-definitely-absent-directory",
        ),
      },
      gateway,
    });
    vi.spyOn(
      adapter as unknown as { command(): string },
      "command",
    ).mockReturnValue(process.execPath);
    const writes = vi.spyOn(gateway, "writeStdin");
    try {
      const actual = await run(adapter, "Undispatched actual worker spawn");
      expect.soft(writes).not.toHaveBeenCalled();
      expect(actual.rows).toHaveLength(0);
    } finally {
      await adapter.terminate(false);
      await gateway.close();
    }
  }, 10000);

  it("retains paid native evidence and closes owned direct child after send ACK failure", async () => {
    vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
    const f = fixture([paid, result]);
    const complete = vi.fn();
    f.adapter.on("complete", complete);
    let seen!: () => void;
    const costSeen = new Promise<void>((resolve) => {
      seen = resolve;
    });
    f.adapter.on("cost", seen);
    const original = InputFormatter.prototype.sendMessage;
    vi.spyOn(InputFormatter.prototype, "sendMessage").mockImplementation(
      async function (this: InputFormatter, ...args) {
        await original.apply(this, args);
        await costSeen;
        throw new Error("Fixture direct stdin acknowledgement lost");
      },
    );
    try {
      const actual = await run(f.adapter, "Disposable paid request");
      expect.soft(actual.error.partialUsage).toMatchObject({
        cost: 0.25,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
      });
      expect.soft(actual.rows[0]).toMatchObject({
        outcome: "error",
        costKnown: true,
        costSource: "provider",
        usage: { cost: 0.25 },
      });
      expect.soft(complete).toHaveBeenCalledOnce();
      expect.soft(f.closed).toHaveBeenCalledOnce();
      expect.soft(f.child?.signalCode).toBe("SIGKILL");
      expect.soft(f.adapter.isRunning()).toBe(false);
    } finally {
      await f.adapter.terminate(false);
    }
  }, 10000);
  it("retains a native paid receipt when the direct watchdog rejects", async () => {
    vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
    const f = fixture([paid, result], true, 500);
    const complete = vi.fn();
    f.adapter.on("complete", complete);
    try {
      const actual = await run(f.adapter, "Disposable paid timeout");
      expect(actual.error.message).toBe("Claude CLI timeout");
      expect(actual.error.partialUsage).toMatchObject({
        cost: 0.25,
        inputTokens: 100,
        outputTokens: 10,
      });
      expect(actual.rows).toHaveLength(1);
      expect(actual.rows[0]).toMatchObject({
        outcome: "error",
        costKnown: true,
        costSource: "provider",
        usage: { cost: 0.25 },
      });
      expect(complete).toHaveBeenCalledOnce();
      expect(f.closed).toHaveBeenCalledOnce();
      expect(f.child?.signalCode).toBe("SIGKILL");
      expect(f.adapter.isRunning()).toBe(false);
    } finally {
      await f.adapter.terminate(false);
    }
  }, 10000);
  it("does not book an undispatched empty-format rejection and shuts down its direct child", async () => {
    vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
    const f = fixture();
    try {
      const actual = await run(f.adapter, "");
      expect.soft(actual.rows).toHaveLength(0);
      expect.soft(f.closed).toHaveBeenCalledOnce();
      expect.soft(f.child?.signalCode).toBe("SIGKILL");
      expect.soft(f.adapter.isRunning()).toBe(false);
    } finally {
      await f.adapter.terminate(false);
    }
  });
  it("does not book real direct spawn refusal before any child exists", async () => {
    vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
    const adapter = new ClaudeCliAdapter({
      workingDirectory: join(
        tmpdir(),
        "aio-dispatch-gate-definitely-absent-directory",
      ),
      timeout: 3000,
    });
    adapter.on("error", () => undefined);
    try {
      const actual = await run(adapter, "Undispatched spawn");
      expect(actual.rows).toHaveLength(0);
    } finally {
      await adapter.terminate(false);
    }
  });
  it("owns an asynchronous native spawn refusal without booking a call", async () => {
    vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
    const f = fixture(
      [],
      true,
      3000,
      join(tmpdir(), "aio-dispatch-no-such-executable"),
    );
    try {
      const actual = await run(
        f.adapter,
        "Never dispatched to a missing executable",
      );
      expect(f.spawnError).toHaveBeenCalledOnce();
      expect(actual.error).toMatchObject({ code: "ENOENT" });
      expect(actual.rows).toHaveLength(0);
      expect(f.closed).toHaveBeenCalledOnce();
      expect(f.adapter.isRunning()).toBe(false);
    } finally {
      await f.adapter.terminate(false);
    }
  });
  it("does not book real worker attachment formatting refusal before spawn", async () => {
    vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
    const dir = mkdtempSync(join(tmpdir(), "aio-review-format-"));
    const file = join(dir, "ordinary-file");
    writeFileSync(file, "fixture");
    const gateway = {
      registerInstance: vi.fn(),
      unregisterInstance: vi.fn(),
      spawnInstance: vi.fn(),
      writeStdin: vi.fn(),
      terminate: vi.fn(),
      sendSignal: vi.fn(),
    };
    const adapter = new CliAdapterWorkerProxy({
      cliType: "claude",
      instanceId: "format-refusal-probe",
      options: { workingDirectory: file },
      gateway,
    });
    try {
      const actual = await run(adapter, "Undispatched formatting", {
        attachments: [
          {
            type: "text/plain",
            name: "fixture.txt",
            data: "Zml4dHVyZQ==",
            size: 7,
          },
        ],
      });
      expect.soft(gateway.spawnInstance).not.toHaveBeenCalled();
      expect.soft(actual.rows).toHaveLength(0);
    } finally {
      await adapter.terminate(false);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
