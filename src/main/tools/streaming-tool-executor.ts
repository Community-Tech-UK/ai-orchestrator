/**
 * Streaming Tool Executor
 *
 * Manages concurrent tool execution with:
 * - Concurrency safety metadata per tool
 * - Parallel execution for safe tools, exclusive for unsafe
 * - Progress message streaming via EventEmitter
 * - Sibling abort cascading on errors
 * - Results returned in submission order
 * - Discard support for streaming abort
 *
 * Inspired by Claude Code's StreamingToolExecutor.
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import {
  normalizeToolResultPayload,
  type ToolOutputMetadata,
  type ToolResultTelemetry,
} from './tool-result-normalizer';

const logger = getLogger('StreamingToolExecutor');

export enum ToolStatus {
  QUEUED = 'queued',
  EXECUTING = 'executing',
  COMPLETED = 'completed',
  YIELDED = 'yielded',
  DISCARDED = 'discarded',
}

export interface ToolExecutionResult {
  toolUseId: string;
  toolId: string;
  ok: boolean;
  output?: unknown;
  outputMetadata?: ToolOutputMetadata;
  error?: string;
  telemetry: ToolResultTelemetry;
  durationMs: number;
}

export interface AddToolParams {
  toolUseId: string;
  toolId: string;
  args: unknown;
  concurrencySafe: boolean;
  executeFn: (args: unknown, ctx: unknown, signal?: AbortSignal) => Promise<{ ok: boolean; output?: unknown; error?: string }>;
}

export interface TrackedTool {
  toolUseId: string;
  toolId: string;
  args: unknown;
  concurrencySafe: boolean;
  executeFn: AddToolParams['executeFn'];
  status: ToolStatus;
  result?: ToolExecutionResult;
  startedAt?: number;
  abortController: AbortController;
  promise?: Promise<void>;
}

export interface ProgressMessage {
  toolUseId: string;
  toolId?: string;
  message: string;
  timestamp: number;
}

export class StreamingToolExecutor extends EventEmitter {
  private tools: TrackedTool[] = [];
  private siblingAbortController = new AbortController();
  private hasErrored = false;
  private discarded = false;
  private resolveWaiting: (() => void) | null = null;

  addTool(params: AddToolParams): void {
    if (this.discarded) {
      logger.warn('addTool called after discard', { toolUseId: params.toolUseId });
      return;
    }

    const toolAbortController = new AbortController();

    // Link to sibling abort
    this.siblingAbortController.signal.addEventListener('abort', () => {
      toolAbortController.abort('sibling_error');
    });

    const tracked: TrackedTool = {
      toolUseId: params.toolUseId,
      toolId: params.toolId,
      args: params.args,
      concurrencySafe: params.concurrencySafe,
      executeFn: params.executeFn,
      status: ToolStatus.QUEUED,
      abortController: toolAbortController,
    };

    this.tools.push(tracked);
    this.processQueue();
  }

  emitProgress(toolUseId: string, message: string): void {
    const msg: ProgressMessage = {
      toolUseId,
      message,
      timestamp: Date.now(),
    };
    this.emit('progress', msg);
  }

  /**
   * Discard all pending/executing tools (streaming abort).
   * Generates synthetic error results for unfinished tools.
   */
  discard(): void {
    this.discarded = true;
    this.siblingAbortController.abort('discard');

    for (const tool of this.tools) {
      if (tool.status === ToolStatus.QUEUED || tool.status === ToolStatus.EXECUTING) {
        tool.status = ToolStatus.DISCARDED;
        tool.result = {
          toolUseId: tool.toolUseId,
          toolId: tool.toolId,
          ok: false,
          error: 'Tool execution discarded (streaming abort)',
          outputMetadata: {
            kind: 'empty',
            truncated: false,
            byteCount: 0,
            lineCount: 0,
          },
          telemetry: {
            status: 'error',
            outputKind: 'empty',
            truncated: false,
            byteCount: 0,
            lineCount: 0,
          },
          durationMs: tool.startedAt ? Date.now() - tool.startedAt : 0,
        };
      }
    }

    // Wake up any waiters
    this.resolveWaiting?.();
  }

  /**
   * Async generator that yields results in submission order.
   * Waits for executing tools to complete.
   */
  async *getRemainingResults(): AsyncGenerator<ToolExecutionResult> {
    for (const tool of this.tools) {
      // Wait for tool to finish if still executing or queued
      if (tool.status === ToolStatus.QUEUED || tool.status === ToolStatus.EXECUTING) {
        await new Promise<void>(resolve => {
          let resolved = false;
          const done = () => {
            if (resolved) return;
            if (tool.status !== ToolStatus.QUEUED && tool.status !== ToolStatus.EXECUTING) {
              resolved = true;
              this.off('tool:completed', onComplete);
              this.off('tool:discarded', onComplete);
              this.resolveWaiting = null;
              resolve();
            }
          };
          const onComplete = () => done();
          this.on('tool:completed', onComplete);
          this.on('tool:discarded', onComplete);
          this.resolveWaiting = () => { resolved = true; this.off('tool:completed', onComplete); this.off('tool:discarded', onComplete); resolve(); };
          // Check immediately in case it already completed
          done();
        });
      }

      if (tool.result) {
        tool.status = ToolStatus.YIELDED;
        yield tool.result;
      }
    }
  }

  private processQueue(): void {
    if (this.discarded) return;

    const executing = this.tools.filter(t => t.status === ToolStatus.EXECUTING);
    const queued = this.tools.filter(t => t.status === ToolStatus.QUEUED);

    if (queued.length === 0) return;

    const hasNonConcurrentExecuting = executing.some(t => !t.concurrencySafe);

    // If a non-concurrent tool is executing, wait
    if (hasNonConcurrentExecuting) return;

    for (const tool of queued) {
      if (!tool.concurrencySafe) {
        // Non-concurrent: only start if nothing else is executing
        if (executing.length === 0 && this.tools.filter(t => t.status === ToolStatus.EXECUTING).length === 0) {
          this.executeTool(tool);
          return; // Only one non-concurrent tool at a time
        }
        return; // Wait for concurrent tools to finish
      } else {
        // Concurrent: start immediately unless non-concurrent is queued first
        const firstQueued = queued[0];
        if (!firstQueued.concurrencySafe && firstQueued !== tool) {
          return; // Non-concurrent tool is ahead in queue, wait
        }
        this.executeTool(tool);
      }
    }
  }

  private executeTool(tool: TrackedTool): void {
    tool.status = ToolStatus.EXECUTING;
    tool.startedAt = Date.now();

    tool.promise = (async () => {
      try {
        // Check if already aborted before executing (sibling cascaded abort)
        if (tool.abortController.signal.aborted) {
          throw new Error('aborted');
        }
        const result = await tool.executeFn(tool.args, {}, tool.abortController.signal);
        const durationMs = Date.now() - tool.startedAt!;
        const normalized = normalizeToolResultPayload(
          result.ok ? result.output : undefined,
          result.ok ? 'success' : 'error',
        );

        tool.result = {
          toolUseId: tool.toolUseId,
          toolId: tool.toolId,
          ok: result.ok,
          output: result.ok ? normalized.output : undefined,
          outputMetadata: normalized.outputMetadata,
          error: result.ok ? undefined : result.error,
          telemetry: normalized.telemetry,
          durationMs,
        };

        if (!result.ok && !tool.concurrencySafe) {
          // Non-concurrent tool error: cascade abort to siblings
          this.hasErrored = true;
          this.siblingAbortController.abort('sibling_error');
        }
      } catch (err) {
        const durationMs = Date.now() - (tool.startedAt || Date.now());
        const message = err instanceof Error ? err.message : String(err);
        const isAbort = tool.abortController.signal.aborted;

        tool.result = {
          toolUseId: tool.toolUseId,
          toolId: tool.toolId,
          ok: false,
          error: isAbort ? `Cancelled: sibling tool errored` : message,
          outputMetadata: {
            kind: 'empty',
            truncated: false,
            byteCount: 0,
            lineCount: 0,
          },
          telemetry: {
            status: 'error',
            outputKind: 'empty',
            truncated: false,
            byteCount: 0,
            lineCount: 0,
          },
          durationMs,
        };

        if (!isAbort && !tool.concurrencySafe) {
          this.hasErrored = true;
          this.siblingAbortController.abort('sibling_error');
        }
      } finally {
        tool.status = tool.status === ToolStatus.DISCARDED ? ToolStatus.DISCARDED : ToolStatus.COMPLETED;
        this.emit('tool:completed', tool.toolUseId);
        // Process next queued tools
        this.processQueue();
      }
    })();
  }

  getStatus(): { total: number; queued: number; executing: number; completed: number; discarded: number } {
    return {
      total: this.tools.length,
      queued: this.tools.filter(t => t.status === ToolStatus.QUEUED).length,
      executing: this.tools.filter(t => t.status === ToolStatus.EXECUTING).length,
      completed: this.tools.filter(t => t.status === ToolStatus.COMPLETED || t.status === ToolStatus.YIELDED).length,
      discarded: this.tools.filter(t => t.status === ToolStatus.DISCARDED).length,
    };
  }
}
