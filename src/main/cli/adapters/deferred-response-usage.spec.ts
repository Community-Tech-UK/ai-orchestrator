import { EventEmitter } from "node:events";
import { watchClaudeProcessClose } from "./claude-one-shot-lifecycle";
import { describe, expect, it, vi } from "vitest";
import type { CliResponse } from "./base-cli-adapter.types";
import { ClaudeResidentTurnSettlement } from "./claude-resident-turn-settlement";
import {
  deferResponseUsage,
  deferUntilResponseUsageSettled,
} from "./deferred-response-usage";

describe("in-process deferred response usage", () => {
  it("settles every observer once even when one throws, with no serialized callback state", () => {
    const response: CliResponse = {
      id: "failed-turn",
      role: "assistant",
      content: "",
      usage: { inputTokens: 100 },
    };
    const originalWire = JSON.stringify(response);
    const settle = deferResponseUsage(response);
    const booking = vi.fn();
    const forwarding = vi.fn();
    expect(
      deferUntilResponseUsageSettled(response, () => {
        throw new Error("Fixture observer failure");
      }),
    ).toBe(true);
    expect(deferUntilResponseUsageSettled(response, booking)).toBe(true);
    expect(deferUntilResponseUsageSettled(response, forwarding)).toBe(true);
    expect(JSON.stringify(response)).toBe(originalWire);
    settle();
    settle();
    expect(booking).toHaveBeenCalledTimes(1);
    expect(forwarding).toHaveBeenCalledTimes(1);
    expect(deferUntilResponseUsageSettled(response, booking)).toBe(false);
  });
});

describe("failed resident counter authority", () => {
  it.each(["all-zero", "positive-cache", "positive-total"])(
    "uses observed fallback only when every native counter is zero (%s)",
    (mode) => {
      const response: CliResponse = {
        id: "native-counter-fixture",
        role: "assistant",
        content: "",
        metadata: { turnErrored: true },
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
          totalTokens: 135,
        },
      };
      const settleUsage = vi.fn();
      const owner = new ClaudeResidentTurnSettlement(settleUsage);
      owner.defer(response);
      const booked = vi.fn();
      expect(deferUntilResponseUsageSettled(response, booked)).toBe(true);
      owner.settle({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: mode === "positive-cache" ? 40 : 0,
        cacheWriteTokens: 0,
        totalTokens: mode === "positive-total" ? 50 : 0,
        providerSessionTotalUsd: 0.25,
      });
      expect(response.usage).toMatchObject(
        mode === "all-zero"
          ? {
              inputTokens: 100,
              outputTokens: 10,
              cacheReadTokens: 20,
              cacheWriteTokens: 5,
              totalTokens: 135,
            }
          : {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: mode === "positive-cache" ? 40 : 0,
              cacheWriteTokens: 0,
              totalTokens: mode === "positive-total" ? 50 : 0,
            },
      );
      expect(response.usage?.providerSessionTotalUsd).toBe(0.25);
      expect(response.metadata?.["turnErrored"]).toBe(true);
      expect(owner.settle()).toBe(false);
      expect(settleUsage).toHaveBeenCalledOnce();
      expect(booked).toHaveBeenCalledOnce();
    },
  );
});

describe("resident native close finality", () => {
  it.each(["close", "deadline"])(
    "starts a bounded wait after teardown and releases the close observer (%s)",
    async (mode) => {
      vi.useFakeTimers();
      try {
        const child = new EventEmitter();
        const wait = watchClaudeProcessClose(child);
        await vi.advanceTimersByTimeAsync(6000);
        expect(child.listenerCount("close")).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
        const settled = vi.fn();
        const waiting = wait().then(settled);
        await vi.advanceTimersByTimeAsync(2999);
        expect(settled).not.toHaveBeenCalled();
        if (mode === "close") child.emit("close");
        else await vi.advanceTimersByTimeAsync(1);
        await waiting;
        expect(settled).toHaveBeenCalledOnce();
        expect(child.listenerCount("close")).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        child.emit("close");
        await Promise.resolve();
        expect(settled).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("accepts a close observed before teardown finishes without creating a timer", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      const wait = watchClaudeProcessClose(child);
      child.emit("close");
      await wait();
      expect(child.listenerCount("close")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
