import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import {
  CliSpawnWorkerGateway,
  type CliSpawnWorkerLike,
} from "../spawn-worker/cli-spawn-worker-gateway";
import { CliAdapterWorkerProxy } from "../spawn-worker/cli-adapter-worker-proxy";
import { spawn } from "node:child_process";
import type { CliResponse } from "./base-cli-adapter";
import type { Instance } from "../../../shared/types/instance.types";
import { recordCompletionCost } from "../../instance/communication-completion-cost";
import { getCostTracker } from "../../core/system/cost-tracker";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../logging/logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("../../context/cache-analytics-service", () => ({
  getCacheAnalyticsService: () => ({ recordTurn: vi.fn() }),
}));
import { ClaudeCliAdapter } from "./claude-cli-adapter";
import { sendAbortableReviewerMessage } from "../../review/review-execution-host";
import {
  subscribeCostAttribution,
  type CostAttributionRecord,
} from "../../core/system/cost-attribution";
const paid = {
  type: "assistant",
  message: {
    content: [{ type: "text", text: "Partial paid fixture" }],
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
    },
  },
};
const failure = {
  type: "error",
  error: { message: "Fixture native execution failure" },
};
const synthetic = {
  type: "assistant",
  error: "authentication_failed",
  isApiErrorMessage: true,
  message: {
    model: "<synthetic>",
    content: [{ type: "text", text: "Fixture authentication failure" }],
  },
};
const result = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  total_cost_usd: 0.25,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function create(frames: unknown[], resident = false) {
  const adapter = new ClaudeCliAdapter({
    model: "claude-opus-5",
    timeout: 3000,
    residentClaude: resident,
  });
  const semantic = vi.fn();
  adapter.on("error", semantic);
  const text = frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n";
  vi.spyOn(
    adapter as unknown as {
      spawnProcess(args: string[]): ReturnType<typeof spawn>;
    },
    "spawnProcess",
  ).mockImplementation(() =>
    spawn(
      process.execPath,
      [
        "-e",
        `process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(text)},()=>{process.exitCode=1;process.stdin.destroy();});});process.stdin.resume();`,
      ],
      { stdio: ["pipe", "pipe", "pipe"], detached: true },
    ),
  );
  return { adapter, semantic };
}
describe("independent direct native semantics and paid evidence", () => {
  it.each(["top-level", "synthetic"] as const)(
    "rejects native %s one-shot and keeps observed counters",
    async (mode) => {
      vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
      const { adapter, semantic } = create([
        paid,
        mode === "top-level" ? failure : synthetic,
        result,
      ]);
      const rows: CostAttributionRecord[] = [];
      const stop = subscribeCostAttribution((row) => rows.push(row));
      try {
        const actual = await sendAbortableReviewerMessage(
          adapter,
          { role: "user", content: "Disposable direct fixture" },
          new AbortController().signal,
          undefined,
          {
            purpose: "cross-model-review",
            provider: "claude",
            model: "claude-opus-5",
          },
        ).then(
          (response) => ({ response, error: undefined }),
          (error) => ({ response: undefined, error }),
        );
        expect(semantic).toHaveBeenCalledOnce();
        expect(rows).toHaveLength(1);
        expect(actual.response).toBeUndefined();
        expect(actual.error?.message).toBe(
          mode === "top-level"
            ? "Fixture native execution failure"
            : "Fixture authentication failure",
        );
        expect(rows[0].outcome).toBe("error");
        expect(rows[0].usage).toMatchObject({
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
          cost: 0.25,
        });
      } finally {
        stop();
        await adapter.terminate(false);
      }
    },
  );
  it("completes a paid resident turn terminated by synthetic assistant error once", async () => {
    const { adapter, semantic } = create([paid, synthetic, result], true);
    const complete = vi.fn();
    adapter.on("complete", complete);
    try {
      await adapter.spawn();
      await adapter.sendInput("Disposable resident fixture");
      await vi.waitFor(() => expect(semantic).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(adapter.isRunning()).toBe(false));
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0][0].metadata?.turnErrored).toBe(true);
      expect(complete.mock.calls[0][0].usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        cost: 0.25,
      });
    } finally {
      await adapter.terminate(false);
    }
  });
});

describe("independent direct cancellation boundaries", () => {
  it("never dispatches after cancellation while version preparation is pending", async () => {
    vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
    const { adapter } = create([paid, result]);
    let release!: () => void;
    let entered = false;
    vi.spyOn(
      adapter as unknown as { primeCliVersion(): Promise<void> },
      "primeCliVersion",
    ).mockImplementation(() => {
      entered = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const spawnCall = vi.mocked(
      (
        adapter as unknown as {
          spawnProcess(args: string[]): ReturnType<typeof spawn>;
        }
      ).spawnProcess,
    );
    const original = adapter.sendMessage.bind(adapter);
    let sent!: ReturnType<ClaudeCliAdapter["sendMessage"]>;
    vi.spyOn(adapter, "sendMessage").mockImplementation((message) => {
      sent = original(message);
      return sent;
    });
    const abort = new AbortController();
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution((row) => rows.push(row));
    try {
      const caller = sendAbortableReviewerMessage(
        adapter,
        { role: "user", content: "Cancelled before dispatch" },
        abort.signal,
        undefined,
        {
          purpose: "cross-model-review",
          provider: "claude",
          model: "claude-opus-5",
        },
      ).catch((error) => error);
      await vi.waitFor(() => expect(entered).toBe(true));
      abort.abort();
      expect((await caller).message).toBe("Review cancelled");
      release();
      await sent.catch(() => undefined);
      await Promise.resolve();
      expect(spawnCall).not.toHaveBeenCalled();
      expect(rows).toHaveLength(0);
    } finally {
      stop();
      await adapter.terminate(false);
    }
  });
  it("retains already-reported native paid usage when cancellation kills the process", async () => {
    vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
    const adapter = new ClaudeCliAdapter({
      model: "claude-opus-5",
      timeout: 3000,
    });
    adapter.on("error", () => undefined);
    const chunk =
      [
        paid,
        {
          ...result,
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
          },
        },
      ]
        .map((frame) => JSON.stringify(frame))
        .join("\n") + "\n";
    vi.spyOn(
      adapter as unknown as {
        spawnProcess(args: string[]): ReturnType<typeof spawn>;
      },
      "spawnProcess",
    ).mockImplementation(() =>
      spawn(
        process.execPath,
        [
          "-e",
          `process.on('SIGINT',()=>{});process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(chunk)});setInterval(()=>{},1000);});process.stdin.resume();`,
        ],
        { stdio: ["pipe", "pipe", "pipe"], detached: true },
      ),
    );
    const nativeCost = vi.fn();
    adapter.on("cost", nativeCost);
    const abort = new AbortController();
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution((row) => rows.push(row));
    try {
      const caller = sendAbortableReviewerMessage(
        adapter,
        { role: "user", content: "Cancelled paid direct fixture" },
        abort.signal,
        undefined,
        {
          purpose: "cross-model-review",
          provider: "claude",
          model: "claude-opus-5",
        },
      ).catch((error) => error);
      await vi.waitFor(() =>
        expect(nativeCost).toHaveBeenCalledWith({ costEstimate: 0.25 }),
      );
      abort.abort();
      expect((await caller).message).toBe("Review cancelled");
      await vi.waitFor(() => expect(rows).toHaveLength(1));
      expect(rows[0]).toMatchObject({
        outcome: "cancelled",
        costKnown: true,
        costSource: "provider",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
          cost: 0.25,
        },
      });
    } finally {
      stop();
      await adapter.terminate(false);
    }
  });
});

import { parseWorkerOutput } from "../spawn-worker/cli-adapter-worker-output";
describe("independent measured counter authority", () => {
  it("keeps positive native cache buckets authoritative in direct budget-stop parsing", () => {
    const adapter = new ClaudeCliAdapter({ model: "claude-opus-5" });
    const native = {
      ...result,
      subtype: "error_max_budget_usd",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 0,
      },
    };
    const response = adapter.parseOutput(
      [paid, native].map((frame) => JSON.stringify(frame)).join("\n"),
    );
    expect(response.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
    });
  });
  it("keeps measured native output zero rather than replacing it with text estimate in worker parsing", () => {
    const native = {
      ...result,
      usage: {
        input_tokens: 100,
        output_tokens: 0,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 0,
      },
    };
    const response = parseWorkerOutput(
      [paid, native].map((frame) => JSON.stringify(frame)).join("\n"),
      "claude",
      "fixture",
    );
    expect(response.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
    });
  });
});

describe("direct resident idle failure ownership", () => {
  it("does not fabricate a second completion for an idle authentication failure", async () => {
    const success = {
      ...result,
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
      },
    };
    const { adapter, semantic } = create(
      [paid, success, synthetic, result],
      true,
    );
    const complete = vi.fn();
    adapter.on("complete", complete);
    try {
      await adapter.spawn();
      await adapter.sendInput("One disposable resident turn");
      await vi.waitFor(() => expect(adapter.isRunning()).toBe(false));
      expect(semantic).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0][0].usage.cost).toBe(0.25);
    } finally {
      await adapter.terminate(false);
    }
  });
});

describe("native error results without a separate error frame", () => {
  it.each(["direct", "worker"])(
    "rejects a paid error result once (%s)",
    async (route) => {
      vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
      const gateway =
        route === "worker"
          ? new CliSpawnWorkerGateway({
              workerFactory: () =>
                new Worker(
                  resolve(
                    "dist/main/cli/spawn-worker/cli-spawn-worker-main.js",
                  ),
                ) as CliSpawnWorkerLike,
            })
          : undefined;
      const adapter = gateway
        ? new CliAdapterWorkerProxy({
            cliType: "claude",
            instanceId: "result-only-fixture",
            options: {
              workingDirectory: process.cwd(),
              model: "claude-opus-5",
            },
            gateway,
          })
        : create([paid, result]).adapter;
      if (gateway) {
        vi.spyOn(
          adapter as unknown as { command(): string },
          "command",
        ).mockReturnValue(process.execPath);
        const chunk =
          [paid, result].map((frame) => JSON.stringify(frame)).join("\n") +
          "\n";
        vi.spyOn(
          adapter as unknown as { buildArgs(): string[] },
          "buildArgs",
        ).mockReturnValue([
          "-e",
          `process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(chunk)},()=>process.exit(1));});process.stdin.resume();`,
        ]);
      }
      const rows: CostAttributionRecord[] = [];
      const stop = subscribeCostAttribution((row) => rows.push(row));
      try {
        const actual = await sendAbortableReviewerMessage(
          adapter,
          { role: "user", content: "Disposable error result" },
          new AbortController().signal,
          undefined,
          {
            purpose: "cross-model-review",
            provider: "claude",
            model: "claude-opus-5",
          },
        ).then(
          (response) => ({ response, error: undefined }),
          (error) => ({ response: undefined, error }),
        );
        expect(actual.response).toBeUndefined();
        expect(actual.error).toBeInstanceOf(Error);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          outcome: "error",
          costSource: "provider",
          costKnown: true,
          usage: {
            cost: 0.25,
            inputTokens: 100,
            outputTokens: 10,
            cacheReadTokens: 20,
            cacheWriteTokens: 5,
          },
        });
      } finally {
        stop();
        await adapter.terminate(false);
        await gateway?.close();
      }
    },
    10000,
  );
});

describe("worker stdin acknowledgement failure after paid output", () => {
  it("rejects with the observed bill and removes observers after closure", async () => {
    vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
    const gateway = new CliSpawnWorkerGateway({
      workerFactory: () =>
        new Worker(
          resolve("dist/main/cli/spawn-worker/cli-spawn-worker-main.js"),
        ) as CliSpawnWorkerLike,
    });
    const adapter = new CliAdapterWorkerProxy({
      cliType: "claude",
      instanceId: "paid-write-failure",
      options: { workingDirectory: process.cwd(), model: "claude-opus-5" },
      gateway,
    });
    vi.spyOn(
      adapter as unknown as { command(): string },
      "command",
    ).mockReturnValue(process.execPath);
    const chunk =
      [paid, result].map((frame) => JSON.stringify(frame)).join("\n") + "\n";
    vi.spyOn(
      adapter as unknown as { buildArgs(): string[] },
      "buildArgs",
    ).mockReturnValue([
      "-e",
      `process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(chunk)});setInterval(()=>{},1000);});process.stdin.resume();`,
    ]);
    let reportCost!: () => void;
    const nativeCost = new Promise<void>((resolve) => {
      reportCost = resolve;
    });
    const onCost = () => reportCost();
    adapter.on("cost", onCost);
    const write = gateway.writeStdin.bind(gateway);
    vi.spyOn(gateway, "writeStdin").mockImplementation(async (...args) => {
      await write(...args);
      await nativeCost;
      throw new Error("Fixture stdin acknowledgement lost");
    });
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution((row) => rows.push(row));
    try {
      const error = await sendAbortableReviewerMessage(
        adapter,
        { role: "user", content: "Disposable paid write" },
        new AbortController().signal,
        undefined,
        {
          purpose: "cross-model-review",
          provider: "claude",
          model: "claude-opus-5",
        },
      ).catch((error) => error);
      expect(error.message).toBe("Fixture stdin acknowledgement lost");
      expect(error.partialUsage).toMatchObject({
        cost: 0.25,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: "error",
        costKnown: true,
        costSource: "provider",
        usage: { cost: 0.25 },
      });
      for (const event of ["usage", "complete", "error", "exit"])
        expect(adapter.listenerCount(event)).toBe(0);
    } finally {
      stop();
      adapter.off("cost", onCost);
      await adapter.terminate(false);
      await gateway.close();
    }
  }, 10000);
});

describe("worker pending-spawn input fence", () => {
  it("never writes the cancelled prompt after the accepted spawn finishes", async () => {
    vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
    const gateway = new CliSpawnWorkerGateway({
      workerFactory: () =>
        new Worker(
          resolve("dist/main/cli/spawn-worker/cli-spawn-worker-main.js"),
        ) as CliSpawnWorkerLike,
    });
    const adapter = new CliAdapterWorkerProxy({
      cliType: "claude",
      instanceId: "held-spawn-input",
      options: { workingDirectory: process.cwd() },
      gateway,
    });
    vi.spyOn(
      adapter as unknown as { command(): string },
      "command",
    ).mockReturnValue(process.execPath);
    vi.spyOn(
      adapter as unknown as { buildArgs(): string[] },
      "buildArgs",
    ).mockReturnValue([
      "-e",
      "process.on('SIGINT',()=>{});process.stderr.write('fixture-ready');process.stdin.resume();setInterval(()=>{},1000);",
    ]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawn = gateway.spawnInstance.bind(gateway);
    vi.spyOn(gateway, "spawnInstance").mockImplementation(async (request) => {
      const result = await spawn(request);
      await held;
      return result;
    });
    const writes = vi.spyOn(gateway, "writeStdin");
    const ready = vi.fn();
    adapter.on("stderr", ready);
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution((row) => rows.push(row));
    const abort = new AbortController();
    let sent!: Promise<unknown>;
    const send = adapter.sendMessage.bind(adapter);
    vi.spyOn(adapter, "sendMessage").mockImplementation((message) => {
      const pending = send(message);
      sent = pending;
      return pending;
    });
    try {
      const caller = sendAbortableReviewerMessage(
        adapter,
        { role: "user", content: "Cancelled before stdin" },
        abort.signal,
        undefined,
        { purpose: "cross-model-review", provider: "claude" },
      ).catch((error) => error);
      await vi.waitFor(() => expect(ready).toHaveBeenCalled(), {
        timeout: 5000,
      });
      abort.abort();
      expect((await caller).message).toBe("Review cancelled");
      release();
      await sent.catch(() => undefined);
      await Promise.resolve();
      expect(writes).not.toHaveBeenCalled();
      expect(rows).toHaveLength(0);
      expect(adapter.listenerCount("usage")).toBe(0);
      expect(adapter.listenerCount("complete")).toBe(0);
    } finally {
      release();
      stop();
      adapter.off("stderr", ready);
      await adapter.terminate(false);
      await gateway.close();
    }
  }, 10000);
});

describe("direct resident native fragment shutdown", () => {
  it("settles the final native receipt after child close flushes an unterminated result", async () => {
    const { adapter, semantic } = create([], true);
    const prefix =
      [paid, failure].map((frame) => JSON.stringify(frame)).join("\n") + "\n";
    vi.mocked(
      (
        adapter as unknown as {
          spawnProcess(args: string[]): ReturnType<typeof spawn>;
        }
      ).spawnProcess,
    ).mockImplementation(() =>
      spawn(
        process.execPath,
        [
          "-e",
          `process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(prefix)});setTimeout(()=>process.stdout.write(${JSON.stringify(JSON.stringify(result))}),50);});process.stdin.resume();setInterval(()=>{},1000);`,
        ],
        { stdio: ["pipe", "pipe", "pipe"], detached: true },
      ),
    );
    const complete = vi.fn();
    const exit = vi.fn();
    adapter.on("complete", complete);
    adapter.on("exit", exit);
    try {
      await adapter.spawn();
      await adapter.sendInput("Disposable failed resident turn");
      await vi.waitFor(() => expect(semantic).toHaveBeenCalledOnce());
      await adapter.terminate(false);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0][0]).toMatchObject({
        metadata: { turnErrored: true },
        usage: {
          cost: 0.25,
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
        },
      });
      expect(adapter.isRunning()).toBe(false);
    } finally {
      await adapter.terminate(false);
    }
  }, 10000);
});


// A subordinate assistant is not a main-turn billing boundary. Keep this on
// real child-process NDJSON and the communication layer's real accounting seam.
describe("resident main-turn settlement around subagent output", () => {
  const subagent = {
    ...paid,
    parent_tool_use_id: "fixture-subagent-tool",
    message: {
      content: [{ type: "text", text: "Subagent work" }],
      usage: { input_tokens: 25, output_tokens: 5 },
    },
  };
  const receipt = (cost: number, input: number, output: number) => ({
    type: "result", subtype: "success", total_cost_usd: cost,
    usage: { input_tokens: 100, output_tokens: 10 },
    modelUsage: { "claude-opus-5": { inputTokens: input, outputTokens: output, costUSD: cost } },
  });
  function account(adapter: ClaudeCliAdapter) {
    getCostTracker().clearEntries();
    const instance = {
      sessionId: "subagent-settlement-fixture", provider: "claude",
      currentModel: "claude-opus-5", agentId: "build", parentId: null,
      metadata: {}, contextUsage: { used: 0, total: 200000, percentage: 0 },
    } as unknown as Instance;
    const completions: CliResponse[] = [];
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(row => rows.push(row));
    adapter.on("complete", response => {
      completions.push(response);
      recordCompletionCost("subagent-settlement-instance", instance, response);
    });
    return { instance, completions, rows, stop };
  }

  it.each([
    { withSubagent: false, split: false },
    { withSubagent: false, split: true },
    { withSubagent: true, split: false },
    { withSubagent: true, split: true },
  ])("retains final native main-turn dollars ($withSubagent subagent, $split split)", async ({ withSubagent, split }) => {
    const frames = [receipt(0.5, 100, 10), paid, failure,
      ...(withSubagent ? [subagent] : []), receipt(0.75, 200, 20)];
    const { adapter } = create(frames, true);
    if (split) {
      const chunks = frames.map(frame => JSON.stringify(frame) + "\n");
      vi.mocked((adapter as unknown as { spawnProcess(args: string[]): ReturnType<typeof spawn> }).spawnProcess)
        .mockImplementation(() => spawn(process.execPath, ["-e",
          `process.stdin.once('data',()=>{const chunks=${JSON.stringify(chunks)};const next=()=>{const chunk=chunks.shift();if(chunk===undefined){process.stdin.destroy();return;}process.stdout.write(chunk,()=>setImmediate(next));};next();});process.stdin.resume();`,
        ], { stdio: ["pipe", "pipe", "pipe"], detached: true }));
    }
    const { instance, completions, rows, stop } = account(adapter);
    try {
      await adapter.spawn();
      await adapter.sendInput("Disposable main-turn settlement fixture");
      await vi.waitFor(() => expect(adapter.isRunning()).toBe(false));
      expect(completions).toHaveLength(2);
      expect(completions[1].metadata?.['turnErrored']).toBe(true);
      expect(rows).toHaveLength(2);
      expect(rows.map(row => row.usage?.cost)).toEqual([0.5, 0.25]);
      expect(rows.every(row => row.costSource === "provider")).toBe(true);
      expect(completions[1].usage?.byModel).toEqual([{
        model: "claude-opus-5", inputTokens: 100, outputTokens: 10,
        cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25,
      }]);
      expect(getCostTracker().getEntries()).toHaveLength(2);
      expect(getCostTracker().getSummary().totalCost).toBeCloseTo(0.75, 8);
      expect(instance.contextUsage.costEstimate).toBeCloseTo(0.75, 8);
    } finally {
      stop(); await adapter.terminate(false); getCostTracker().clearEntries();
    }
  });

  it("uses the next main assistant as the fallback boundary when the old result is absent", async () => {
    const { adapter } = create([receipt(0.5, 100, 10), paid, failure, subagent, paid, receipt(0.75, 200, 20)], true);
    const { completions, rows, stop } = account(adapter);
    try {
      await adapter.spawn(); await adapter.sendInput("Disposable boundary fixture");
      await vi.waitFor(() => expect(adapter.isRunning()).toBe(false));
      expect(completions).toHaveLength(3);
      expect(rows).toHaveLength(3);
      expect(rows[1]).toMatchObject({ costSource: "priced", usage: { inputTokens: 100, outputTokens: 10 } });
      expect(rows[1].usage?.cost).toBeGreaterThan(0);
      expect(rows[2]).toMatchObject({ costSource: "provider", usage: { cost: 0.25 } });
      expect(completions[2].metadata?.['turnErrored']).not.toBe(true);
      expect(getCostTracker().getEntries()).toHaveLength(3);
    } finally {
      stop(); await adapter.terminate(false); getCostTracker().clearEntries();
    }
  });

  it.each(["exit", "terminate"] as const)("settles missing-result fallback once on %s after subagent output", async ending => {
    const { adapter } = create([paid, failure, subagent], true);
    if (ending === "terminate") {
      const chunk = [paid, failure, subagent].map(frame => JSON.stringify(frame)).join("\n") + "\n";
      vi.mocked((adapter as unknown as { spawnProcess(args: string[]): ReturnType<typeof spawn> }).spawnProcess)
        .mockImplementation(() => spawn(process.execPath, ["-e",
          `process.stdin.once('data',()=>process.stdout.write(${JSON.stringify(chunk)}));process.stdin.resume();setInterval(()=>{},1000);`,
        ], { stdio: ["pipe", "pipe", "pipe"], detached: true }));
    }
    const { completions, rows, stop } = account(adapter);
    try {
      await adapter.spawn(); await adapter.sendInput("Disposable missing-result fixture");
      if (ending === "terminate") {
        await vi.waitFor(() => expect(completions).toHaveLength(1));
        await adapter.terminate(false);
      }
      await vi.waitFor(() => expect(adapter.isRunning()).toBe(false));
      await adapter.terminate(false);
      expect(completions).toHaveLength(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ costSource: "priced", usage: { inputTokens: 100, outputTokens: 10 } });
      expect(rows[0].usage?.cost).toBeGreaterThan(0);
      expect(getCostTracker().getEntries()).toHaveLength(1);
    } finally {
      stop(); await adapter.terminate(false); getCostTracker().clearEntries();
    }
  });
});
