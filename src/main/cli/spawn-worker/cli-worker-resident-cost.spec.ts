import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliAdapterWorkerProxy } from "./cli-adapter-worker-proxy";
import {
  CliSpawnWorkerGateway,
  type CliSpawnGatewayPort,
  type CliSpawnWorkerLike,
} from "./cli-spawn-worker-gateway";
import type { CliAdapter } from "../adapters/adapter-factory";
import type { CliResponse } from "../adapters/base-cli-adapter";
import { InstanceCommunicationManager } from "../../instance/instance-communication";
import { recordCompletionCost } from "../../instance/communication-completion-cost";
import { getCostTracker } from "../../core/system/cost-tracker";
import {
  subscribeCostAttribution,
  type CostAttributionRecord,
} from "../../core/system/cost-attribution";
import type { Instance } from "../../../shared/types/instance.types";

vi.mock("../../core/config/settings-manager", () => ({
  getSettingsManager: () => ({ getAll: () => ({}) }),
}));
vi.mock("../../memory/output-storage", () => ({
  getOutputStorageManager: () => ({}),
}));
vi.mock("../../hooks/hook-manager", () => ({
  getHookManager: () => ({
    triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }),
  }),
}));
vi.mock("../../context/cache-analytics-service", () => ({
  getCacheAnalyticsService: () => ({ recordTurn: vi.fn() }),
}));
vi.mock("../adapters/claude-transcript-registry", () => ({
  nativeTranscriptExists: () => true,
  nativeSessionIdInUse: () => false,
  readLastClaudeCostState: () => undefined,
}));

const cleanups: (() => Promise<void>)[] = [];
function harness(managed = true, actualWorker = false) {
  let handler:
    Parameters<CliSpawnGatewayPort["registerInstance"]>[1] | undefined;
  const fakeGateway: CliSpawnGatewayPort = {
    registerInstance: (_id, next) => {
      handler = next;
    },
    unregisterInstance: () => {
      handler = undefined;
    },
    spawnInstance: async () => {
      handler?.spawned?.(123);
      return { pid: 123 };
    },
    writeStdin: async () => undefined,
    sendSignal: vi.fn(),
    terminate: vi.fn(async () => {
      handler?.exited?.(null, "SIGKILL");
    }),
  };
  const realGateway = actualWorker
    ? new CliSpawnWorkerGateway({
        workerFactory: () =>
          new Worker(
            resolve("dist/main/cli/spawn-worker/cli-spawn-worker-main.js"),
          ) as CliSpawnWorkerLike,
      })
    : undefined;
  const gateway = realGateway ?? fakeGateway;
  const adapter = new CliAdapterWorkerProxy({
    cliType: "claude",
    instanceId: "managed-native",
    options: {
      workingDirectory: "/tmp",
      model: "claude-opus-5",
      residentClaude: true,
    },
    gateway,
  });
  const instance = {
    id: "managed-native",
    sessionId: "worker-session",
    provider: "claude",
    currentModel: "claude-opus-5",
    agentId: "build",
    parentId: null,
    status: "busy",
    restartEpoch: 0,
    requestCount: 1,
    outputBuffer: [],
    totalTokensUsed: 0,
    contextUsage: { used: 0, total: 200000, percentage: 0 },
    metadata: {},
  } as unknown as Instance;
  const completions: CliResponse[] = [];
  const rows: CostAttributionRecord[] = [];
  const stop = subscribeCostAttribution((row) => rows.push(row));
  const queueUpdate = vi.fn();
  if (managed) {
    const manager = new InstanceCommunicationManager({
      getInstance: () => instance,
      getAdapter: () => adapter as unknown as CliAdapter,
      setAdapter: vi.fn(),
      deleteAdapter: () => false,
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      emitProviderRuntimeEvent: vi.fn(),
    });
    manager.setupAdapterEvents(instance.id, adapter as unknown as CliAdapter);
  } else {
    adapter.on("complete", (response) =>
      recordCompletionCost(instance.id, instance, response),
    );
    adapter.on("error", () => undefined);
  }
  adapter.on("complete", (response) => completions.push(response));
  const emit = (value: unknown) =>
    handler?.stdout?.(JSON.stringify(value) + "\n");
  const raw = (value: string) => handler?.stdout?.(value);
  const lost = () => {
    handler?.failed?.(new Error("Fixture worker loss"));
    handler?.exited?.(null, "SIGKILL");
  };
  const exit = () => handler?.exited?.(1, null);
  cleanups.push(async () => {
    await adapter.terminate(false);
    await realGateway?.close();
    adapter.removeAllListeners();
    stop();
  });
  return {
    adapter,
    instance,
    completions,
    rows,
    emit,
    raw,
    exit,
    lost,
    gateway,
    queueUpdate,
  };
}
const result = (cost: number, input: number, output: number) => ({
  type: "result",
  subtype: "success",
  total_cost_usd: cost,
  usage: { input_tokens: 100, output_tokens: 20 },
  modelUsage: {
    "claude-opus-5": {
      inputTokens: input,
      outputTokens: output,
      costUSD: cost,
    },
  },
});
const assistant = {
  type: "assistant",
  message: {
    content: [{ type: "text", text: "Partial work" }],
    usage: { input_tokens: 100, output_tokens: 20 },
  },
};
const failure = { type: "error", error: { message: "Fixture native failure" } };
beforeEach(() => {
  vi.stubEnv("AIO_COST_ATTRIBUTION", "0");
  getCostTracker().clearEntries();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  getCostTracker().clearEntries();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resident worker → communication → real CostTracker", () => {
  it.each(["separate", "chunk", "fragment"])(
    "settles native failed usage once before owned cleanup (%s)",
    async (delivery) => {
      const { adapter, instance, emit, raw, exit, completions, rows } =
        harness();
      await adapter.spawn();
      await adapter.sendInput("First turn");
      emit(result(0.5, 100, 20));
      await vi.waitFor(() =>
        expect(getCostTracker().getEntries()).toHaveLength(1),
      );
      await adapter.sendInput("Failed turn");
      if (delivery === "chunk")
        raw(
          [assistant, failure, result(0.75, 200, 40)]
            .map((value) => JSON.stringify(value))
            .join("\n") + "\n",
        );
      else {
        emit(assistant);
        emit(failure);
        expect(completions).toHaveLength(2);
        expect(getCostTracker().getEntries()).toHaveLength(1);
        // Let the actual communication error-cleanup enter its native drain.
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (delivery === "fragment") {
          raw(JSON.stringify(result(0.75, 200, 40)));
          exit();
        } else emit(result(0.75, 200, 40));
      }
      await vi.waitFor(() =>
        expect(getCostTracker().getEntries()).toHaveLength(2),
      );
      expect(getCostTracker().getSummary().totalCost).toBe(0.75);
      expect(instance.contextUsage.costEstimate).toBe(0.75);
      expect(completions).toHaveLength(2);
      expect(completions[1]).toMatchObject({
        metadata: { turnErrored: true },
        usage: {
          cost: 0.25,
          byModel: [
            {
              model: "claude-opus-5",
              inputTokens: 100,
              outputTokens: 20,
              costUsd: 0.25,
            },
          ],
        },
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.usage?.cost)).toEqual([0.5, 0.25]);
    },
  );

  it("preserves pending failed usage across a newer input without completing that input", async () => {
    const { adapter, instance, emit, completions, rows } = harness(false);
    await adapter.spawn();
    await adapter.sendInput("First turn");
    emit(result(0.5, 100, 20));
    await adapter.sendInput("Failed turn");
    emit(assistant);
    emit(failure);
    await adapter.sendInput("Newer input");
    emit(result(0.75, 200, 40));
    expect(completions).toHaveLength(2);
    emit(assistant);
    emit(result(1, 300, 60));
    expect(completions).toHaveLength(3);
    expect(
      getCostTracker()
        .getEntries()
        .map((row) => row.cost),
    ).toEqual([0.5, 0.25, 0.25]);
    expect(instance.contextUsage.costEstimate).toBe(1);
    expect(rows).toHaveLength(3);
  });

  it("uses one priced observed fallback when native result is absent at shutdown", async () => {
    const { adapter, instance, emit, completions, rows } = harness();
    await adapter.spawn();
    await adapter.sendInput("Failed turn");
    emit(assistant);
    emit(failure);
    await vi.waitFor(() =>
      expect(getCostTracker().getEntries()).toHaveLength(1),
    );
    expect(completions).toHaveLength(1);
    expect(completions[0].metadata?.["turnErrored"]).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      costSource: "priced",
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    expect(instance.contextUsage.costEstimate).toBeGreaterThan(0);
  });

  it("does not price synthetic authentication failure text as paid assistant tokens", async () => {
    const { adapter, emit, completions, rows } = harness(false);
    await adapter.spawn();
    await adapter.sendInput("Authentication fixture");
    emit({
      type: "assistant",
      error: "authentication_failed",
      isApiErrorMessage: true,
      message: {
        model: "<synthetic>",
        content: [{ type: "text", text: "Fixture authentication failure" }],
      },
    });
    await adapter.terminate(false);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      metadata: { turnErrored: true },
      usage: { outputTokens: 0 },
    });
    expect(getCostTracker().getEntries()).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it.each([
    "fallback",
    "cache-only-zero-result",
    "native-positive-cache-result",
  ])("preserves observed cache buckets (%s)", async (mode) => {
    const { adapter, emit, rows } = harness();
    await adapter.spawn();
    await adapter.sendInput("Cached paid work");
    emit({
      type: "assistant",
      message: {
        content: [],
        usage: {
          input_tokens: mode === "fallback" ? 100 : 0,
          output_tokens: mode === "fallback" ? 20 : 0,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 500,
        },
      },
    });
    emit(failure);
    if (mode !== "fallback")
      emit({
        type: "result",
        total_cost_usd: 0.25,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens:
            mode === "native-positive-cache-result" ? 2000 : 0,
          cache_creation_input_tokens:
            mode === "native-positive-cache-result" ? 1000 : 0,
        },
      });
    await vi.waitFor(() =>
      expect(getCostTracker().getEntries()).toHaveLength(1),
    );
    const cacheReadTokens =
      mode === "native-positive-cache-result" ? 2000 : 1000;
    const cacheWriteTokens =
      mode === "native-positive-cache-result" ? 1000 : 500;
    expect(getCostTracker().getEntries()[0]).toMatchObject({
      cacheReadTokens,
      cacheWriteTokens,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      costSource: mode === "fallback" ? "priced" : "provider",
      usage: { cacheReadTokens, cacheWriteTokens },
    });
    if (mode !== "fallback") expect(rows[0].usage?.cost).toBe(0.25);
  });

  it.each(["fragment", "completed", "newer-after-error"])(
    "settles resident worker loss once (%s)",
    async (mode) => {
      const { adapter, emit, raw, lost, completions, rows } = harness(false);
      await adapter.spawn();
      await adapter.sendInput("Paid partial work");
      if (mode === "completed") emit(result(0.5, 100, 20));
      else if (mode === "fragment") raw(JSON.stringify(assistant));
      else {
        emit(assistant);
        emit(failure);
        await adapter.sendInput("Newer paid work");
        emit(assistant);
      }
      lost();
      const count = mode === "newer-after-error" ? 2 : 1;
      expect(completions).toHaveLength(count);
      expect(rows).toHaveLength(count);
      if (mode !== "completed")
        expect(
          completions.every((response) => response.metadata?.["turnErrored"]),
        ).toBe(true);
      expect(
        rows.every(
          (row) =>
            row.usage?.inputTokens === 100 && row.usage.outputTokens === 20,
        ),
      ).toBe(true);
      lost();
      expect(completions).toHaveLength(count);
      expect(rows).toHaveLength(count);
    },
  );

  it.each([
    "startup-result",
    "idle-error-result",
    "idle-error-eof",
    "idle-error-line",
  ])(
    "does not fabricate a resident completion for unowned frames (%s)",
    async (mode) => {
      const { adapter, completions, rows } = harness(false, true);
      vi.spyOn(
        adapter as unknown as { command(): string },
        "command",
      ).mockReturnValue(process.execPath);
      const synthetic = {
        type: "assistant",
        error: "authentication_failed",
        isApiErrorMessage: true,
        message: {
          model: "<synthetic>",
          content: [
            { type: "text", text: "Fixture idle authentication failure" },
          ],
        },
      };
      const idleResult = {
        ...result(0.5, 100, 20),
        is_error: true,
        subtype: "error_during_execution",
        usage: { input_tokens: 0, output_tokens: 0 },
      };
      const values =
        mode === "startup-result"
          ? [idleResult]
          : [
              assistant,
              result(0.5, 100, 20),
              synthetic,
              ...(mode === "idle-error-result" ? [idleResult] : []),
            ];
      const chunk =
        values.map((value) => JSON.stringify(value)).join("\n") +
        (mode === "idle-error-eof" ? "" : "\n");
      const output = `process.stdout.write(${JSON.stringify(chunk)},()=>process.exit(1));`;
      vi.spyOn(
        adapter as unknown as { buildArgs(): string[] },
        "buildArgs",
      ).mockReturnValue([
        "-e",
        mode === "startup-result"
          ? `setTimeout(()=>{${output}},100);process.stdin.resume();`
          : `process.stdin.once('data',()=>{${output}});process.stdin.resume();`,
      ]);
      await adapter.spawn();
      if (mode !== "startup-result")
        await adapter.sendInput("One disposable paid turn");
      await vi.waitFor(() => expect(adapter.isRunning()).toBe(false), {
        timeout: 5000,
      });
      const count = mode === "startup-result" ? 0 : 1;
      expect(completions).toHaveLength(count);
      expect(rows).toHaveLength(count);
      expect(getCostTracker().getEntries()).toHaveLength(count);
      if (count) expect(rows[0].usage?.cost).toBe(0.5);
    },
    10000,
  );

  it.each([true, false])(
    "preserves native EOF failure semantics through a real worker (LF=%s)",
    async (trailingLf) => {
      const { adapter, completions, rows } = harness(true, true);
      vi.spyOn(
        adapter as unknown as { command(): string },
        "command",
      ).mockReturnValue(process.execPath);
      const chunk =
        JSON.stringify(assistant) +
        "\n" +
        JSON.stringify(failure) +
        (trailingLf ? "\n" : "");
      vi.spyOn(
        adapter as unknown as { buildArgs(): string[] },
        "buildArgs",
      ).mockReturnValue([
        "-e",
        `process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(chunk)},()=>process.exit(1));});process.stdin.resume();`,
      ]);
      await adapter.spawn();
      await adapter.sendInput("Disposable resident failure fixture");
      await vi.waitFor(
        () => expect(getCostTracker().getEntries()).toHaveLength(1),
        { timeout: 5000 },
      );
      expect(adapter.isRunning()).toBe(false);
      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({
        metadata: { turnErrored: true },
        usage: { inputTokens: 100, outputTokens: 20 },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        costSource: "priced",
        usage: { inputTokens: 100, outputTokens: 20 },
      });
    },
    10000,
  );
});
