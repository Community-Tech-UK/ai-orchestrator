/**
 * Default Orchestration Invokers
 *
 * Wires "extensibility points" (event-based invocation) to real CLI execution.
 * This replaces placeholder/stub behavior in MultiVerifyCoordinator by using our
 * in-repo CLI adapters directly (no dependency on sibling repos at runtime).
 */

import type { InstanceManager } from '../instance/instance-manager';
import { getLogger } from '../logging/logger';
import { getMultiVerifyCoordinator } from './multi-verify-coordinator';
import { getReviewCoordinator } from '../agents/review-coordinator';
import { getDebateCoordinator } from './debate-coordinator';
import { getWorkflowManager } from '../workflows/workflow-manager';
import { resolveCliType, type CliAdapter, type UnifiedSpawnOptions } from '../cli/adapters/adapter-factory';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import { getSettingsManager } from '../core/config/settings-manager';
import { getCircuitBreakerRegistry } from '../core/circuit-breaker';
import { coerceToFailoverError } from '../core/failover-error';
import { getDefaultModelForCli } from '../../shared/types/provider.types';
import type { CliType } from '../cli/cli-detection';
import {
  DebateCritiqueInvocationPayloadSchema,
  DebateDefenseInvocationPayloadSchema,
  DebateResponseInvocationPayloadSchema,
  DebateSynthesisInvocationPayloadSchema,
  normalizeInvocationTextResult,
  ReviewAgentInvocationPayloadSchema,
  VerificationAgentInvocationPayloadSchema,
  WorkflowAgentInvocationPayloadSchema,
} from '../../shared/types/orchestration-invocation.types';
import type { z } from 'zod';

const logger = getLogger('DefaultInvokers');

type DebateInvocationSchema =
  | typeof DebateResponseInvocationPayloadSchema
  | typeof DebateCritiqueInvocationPayloadSchema
  | typeof DebateDefenseInvocationPayloadSchema
  | typeof DebateSynthesisInvocationPayloadSchema;

function resolveDefaultModel(cliType: CliType, payloadModel?: string): string | undefined {
  if (typeof payloadModel === 'string' && payloadModel !== 'default') return payloadModel;
  return getDefaultModelForCli(cliType);
}

function isBaseCliAdapterLike(adapter: CliAdapter): adapter is CliAdapter & { sendMessage: (m: CliMessage) => Promise<CliResponse> } {
  return typeof (adapter as { sendMessage?: unknown }).sendMessage === 'function';
}

function buildUserPrompt(userPrompt: string, context?: string): string {
  if (!context || !context.trim()) return userPrompt;
  return `${context.trim()}\n\n---\n\n${userPrompt}`;
}

function parseInvocationPayload<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  invocationName: string,
): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new Error(`${invocationName} payload validation failed: ${result.error.issues[0]?.message ?? result.error.message}`);
  }
  return result.data;
}

function getCallbackFromPayload<T extends (...args: never[]) => unknown>(
  payload: unknown,
): T | undefined {
  const callback = (payload as { callback?: unknown } | null | undefined)?.callback;
  return typeof callback === 'function' ? (callback as T) : undefined;
}

async function invokeCliTextResponse(params: {
  instanceManager: InstanceManager;
  instanceId?: string;
  /** Overrides the working directory for the spawned CLI. Required for
   *  fresh-child invocations (e.g. Loop Mode) where there's no instance
   *  to inherit it from — without this we'd fall back to `process.cwd()`,
   *  which is the Electron app's launch directory, not the user's project. */
  workingDirectory?: string;
  requestedProvider?: string;
  payloadModel?: string;
  systemPrompt?: string;
  prompt: string;
  context?: string;
  breakerKey: string;
  correlationId: string;
  /** Optional override for the spawn wall-clock timeout in milliseconds.
   *  Acts as the outer safety net; stream-idle catches hangs sooner. */
  timeoutMs?: number;
  /** Optional override for the stream-idle threshold (no-stdout-for-X-ms
   *  abort). Inherits the adapter's default when undefined. */
  streamIdleTimeoutMs?: number;
  /** Reuse an existing adapter instead of creating + terminating a fresh
   *  one for every call. Used by Loop Mode's `same-session` contextStrategy
   *  so the conversation persists across iterations. The caller owns the
   *  adapter lifecycle when this is set. */
  reusedAdapter?: unknown;
}): Promise<ReturnType<typeof normalizeInvocationTextResult>> {
  const instance = params.instanceId
    ? params.instanceManager.getInstance(params.instanceId)
    : undefined;
  const workingDirectory = params.workingDirectory || instance?.workingDirectory || process.cwd();
  const fallbackProvider = instance?.provider as string | undefined;
  const requestedProvider = params.requestedProvider ?? fallbackProvider ?? 'auto';
  const defaultCli = getSettingsManager().getAll().defaultCli;
  const cliType = await resolveCliType(requestedProvider as Parameters<typeof resolveCliType>[0], defaultCli);
  const model = resolveDefaultModel(cliType, params.payloadModel);

  const spawnOptions: UnifiedSpawnOptions = {
    workingDirectory,
    model,
    systemPrompt: params.systemPrompt,
    yoloMode: false,
    timeout: params.timeoutMs ?? 300000,
  };

  const breaker = getCircuitBreakerRegistry().getBreaker(params.breakerKey, {
    failureThreshold: 3,
    resetTimeoutMs: 60000,
  });

  const prompt = buildUserPrompt(params.prompt, params.context);
  const response = await breaker.execute(async () => {
    // Either reuse the caller's adapter (same-session loop) or create a
    // fresh one (one-shot — chat orchestration, debate, fresh-child loop).
    const ownsAdapter = !params.reusedAdapter;
    const adapter: CliAdapter = (params.reusedAdapter as CliAdapter | undefined)
      ?? getProviderRuntimeService().createAdapter({ cliType, options: spawnOptions });
    try {
      if (!isBaseCliAdapterLike(adapter)) {
        throw new Error(`CLI adapter "${cliType}" does not support one-shot sendMessage`);
      }
      // Apply per-call stream-idle threshold override if the caller set one.
      // Default is whatever the adapter was constructed with (env var or 90s).
      if (typeof params.streamIdleTimeoutMs === 'number') {
        const setter = (adapter as { setStreamIdleTimeoutMs?: (ms: number) => void }).setStreamIdleTimeoutMs;
        if (typeof setter === 'function') setter.call(adapter, params.streamIdleTimeoutMs);
      }

      // Race the actual sendMessage against the adapter's stream-idle
      // watchdog. The watchdog (in BaseCliAdapter) fires when stdout has
      // been silent for ~90s — i.e., the CLI is hung, not legitimately
      // doing work. Without this race, the wall-time timeout (set to a
      // generous 30 min for loops) is the only escape, and the user
      // stares at "0 tok" the whole time. Tokens, tool calls, and file
      // edits all produce stdout, so legitimate long iterations are safe.
      const sendPromise = (adapter as { sendMessage(m: { role: 'user'; content: string }): Promise<{ content: string; usage?: { totalTokens?: number } }> })
        .sendMessage({ role: 'user', content: prompt });
      const idleAbort = new Promise<never>((_, reject) => {
        const adapterEmitter = adapter as unknown as {
          once: (evt: string, cb: (...args: unknown[]) => void) => void;
        };
        adapterEmitter.once('stream:idle', (info: unknown) => {
          const meta = (info && typeof info === 'object' ? info : {}) as { timeoutMs?: number };
          const seconds = meta.timeoutMs ? Math.round(meta.timeoutMs / 1000) : 90;
          reject(new Error(`CLI stalled — no output for ~${seconds}s. Likely hung (auth, network, or frozen child process).`));
        });
      });
      return await Promise.race([sendPromise, idleAbort]);
    } finally {
      // Caller owns the lifecycle when reusing an adapter (same-session
      // loops keep it alive across iterations and tear it down on terminate).
      if (ownsAdapter) {
        const terminator = (adapter as { terminate?: (graceful?: boolean) => Promise<void> }).terminate;
        if (typeof terminator === 'function') {
          await terminator.call(adapter, false).catch((cleanupError: unknown) => {
            logger.warn('One-shot invocation adapter cleanup failed', {
              correlationId: params.correlationId,
              cliType,
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            });
          });
        }
      }
    }
  });

  const normalized = normalizeInvocationTextResult({
    response: response.content,
    tokens: response.usage?.totalTokens ?? 0,
    cost: 0,
  });

  logger.info('Orchestration invocation completed', {
    correlationId: params.correlationId,
    cliType,
    breakerKey: params.breakerKey,
    model,
    tokens: normalized.tokens,
  });

  return normalized;
}

function logInvocationFailure(params: {
  correlationId: string;
  invocation: string;
  error: unknown;
  eventName?: string;
  provider?: string;
  model?: string;
  instanceId?: string;
}): string {
  const failoverErr = coerceToFailoverError(params.error, {
    provider: params.provider,
    model: params.model,
    instanceId: params.instanceId,
  });
  if (failoverErr) {
    logger.warn(`${params.invocation} failed (classified)`, {
      correlationId: params.correlationId,
      eventName: params.eventName,
      reason: failoverErr.reason,
      retryable: failoverErr.retryable,
    });
  }

  const message = params.error instanceof Error ? params.error.message : String(params.error);
  logger.error(`${params.invocation} failed`, params.error instanceof Error ? params.error : undefined, {
    correlationId: params.correlationId,
    eventName: params.eventName,
    provider: params.provider,
    model: params.model,
    instanceId: params.instanceId,
  });
  return message;
}

export function registerDefaultMultiVerifyInvoker(instanceManager: InstanceManager): void {
  const coordinator = getMultiVerifyCoordinator();

  // Avoid double-registration if initialize() is called multiple times (macOS window lifecycle).
  const alreadyRegistered = coordinator.listenerCount('verification:invoke-agent') > 0;
  if (alreadyRegistered) return;

  coordinator.on('verification:invoke-agent', async (payload: unknown) => {
    const callback = getCallbackFromPayload<
      z.infer<typeof VerificationAgentInvocationPayloadSchema>['callback']
    >(payload);
    let parsed: z.infer<typeof VerificationAgentInvocationPayloadSchema>;
    try {
      parsed = parseInvocationPayload(
        VerificationAgentInvocationPayloadSchema,
        payload,
        'verification:invoke-agent',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Verification invocation payload rejected', error instanceof Error ? error : undefined);
      callback?.(message);
      return;
    }

    try {
      const result = await invokeCliTextResponse({
        instanceManager,
        instanceId: parsed.instanceId,
        payloadModel: parsed.model,
        systemPrompt: parsed.systemPrompt,
        prompt: parsed.userPrompt,
        context: parsed.context,
        breakerKey: 'verify-orchestration',
        correlationId: parsed.correlationId,
      });
      parsed.callback(null, result.response, result.tokens, result.cost);
    } catch (err) {
      const message = logInvocationFailure({
        correlationId: parsed.correlationId,
        invocation: 'Verification agent invocation',
        error: err,
        instanceId: parsed.instanceId,
        model: parsed.model,
      });
      parsed.callback(message);
    }
  });
}

export function registerDefaultReviewInvoker(instanceManager: InstanceManager): void {
  const coordinator = getReviewCoordinator();

  const alreadyRegistered = coordinator.listenerCount('review:invoke-agent') > 0;
  if (alreadyRegistered) return;

  coordinator.on('review:invoke-agent', async (payload: unknown) => {
    const callback = getCallbackFromPayload<
      z.infer<typeof ReviewAgentInvocationPayloadSchema>['callback']
    >(payload);
    let parsed: z.infer<typeof ReviewAgentInvocationPayloadSchema>;
    try {
      parsed = parseInvocationPayload(
        ReviewAgentInvocationPayloadSchema,
        payload,
        'review:invoke-agent',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Review invocation payload rejected', error instanceof Error ? error : undefined);
      callback?.(message);
      return;
    }

    try {
      const result = await invokeCliTextResponse({
        instanceManager,
        instanceId: parsed.instanceId,
        payloadModel: parsed.model,
        systemPrompt: parsed.systemPrompt,
        prompt: parsed.userPrompt,
        context: parsed.context,
        breakerKey: 'review-orchestration',
        correlationId: parsed.correlationId,
      });
      parsed.callback(null, result.response, result.tokens, result.cost);
    } catch (err) {
      const message = logInvocationFailure({
        correlationId: parsed.correlationId,
        invocation: 'Review agent invocation',
        error: err,
        instanceId: parsed.instanceId,
        model: parsed.model,
      });
      parsed.callback(message);
    }
  });
}

const DEBATE_EVENTS = [
  'debate:generate-response',
  'debate:generate-critiques',
  'debate:generate-defense',
  'debate:generate-synthesis',
] as const;
type DebateEventName = (typeof DEBATE_EVENTS)[number];

export function registerDefaultDebateInvoker(instanceManager: InstanceManager): void {
  const coordinator = getDebateCoordinator();
  const schemasByEvent: Record<DebateEventName, DebateInvocationSchema> = {
    'debate:generate-response': DebateResponseInvocationPayloadSchema,
    'debate:generate-critiques': DebateCritiqueInvocationPayloadSchema,
    'debate:generate-defense': DebateDefenseInvocationPayloadSchema,
    'debate:generate-synthesis': DebateSynthesisInvocationPayloadSchema,
  };

  for (const eventName of DEBATE_EVENTS) {
    const alreadyRegistered = coordinator.listenerCount(eventName) > 0;
    if (alreadyRegistered) continue;

    coordinator.on(eventName, async (payload: unknown) => {
      const callback = getCallbackFromPayload<
        | z.infer<typeof DebateResponseInvocationPayloadSchema>['callback']
        | z.infer<typeof DebateCritiqueInvocationPayloadSchema>['callback']
        | z.infer<typeof DebateDefenseInvocationPayloadSchema>['callback']
        | z.infer<typeof DebateSynthesisInvocationPayloadSchema>['callback']
      >(payload);
      let parsed:
        | z.infer<typeof DebateResponseInvocationPayloadSchema>
        | z.infer<typeof DebateCritiqueInvocationPayloadSchema>
        | z.infer<typeof DebateDefenseInvocationPayloadSchema>
        | z.infer<typeof DebateSynthesisInvocationPayloadSchema>;
      try {
        parsed = parseInvocationPayload(
          schemasByEvent[eventName],
          payload,
          eventName,
        );
      } catch (error) {
        logger.error(`${eventName} payload rejected`, error instanceof Error ? error : undefined);
        if (callback) {
          logger.warn('Rejected debate payload has no error callback channel', { eventName });
        }
        return;
      }

      try {
        const result = await invokeCliTextResponse({
          instanceManager,
          instanceId: parsed.instanceId,
          requestedProvider: parsed.provider,
          payloadModel: parsed.model,
          systemPrompt: parsed.systemPrompt,
          prompt: parsed.prompt,
          context: parsed.context,
          breakerKey: `debate-orchestration:${eventName}`,
          correlationId: parsed.correlationId,
        });
        if (eventName === 'debate:generate-response') {
          (
            parsed as z.infer<typeof DebateResponseInvocationPayloadSchema>
          ).callback(result.response, result.tokens);
        } else {
          (
            parsed as
              | z.infer<typeof DebateCritiqueInvocationPayloadSchema>
              | z.infer<typeof DebateDefenseInvocationPayloadSchema>
              | z.infer<typeof DebateSynthesisInvocationPayloadSchema>
          ).callback(result.response);
        }
      } catch (err) {
        logInvocationFailure({
          correlationId: parsed.correlationId,
          invocation: 'Debate agent invocation',
          error: err,
          eventName,
          provider: parsed.provider,
          model: parsed.model,
          instanceId: parsed.instanceId,
        });
        // Debate callbacks don't have an error parameter — the Promise will
        // time out on the coordinator side if no callback is invoked.
        logger.error('Error handling debate event', err instanceof Error ? err : undefined, { eventName });
      }
    });
  }
}

export function registerDefaultWorkflowInvoker(instanceManager: InstanceManager): void {
  const manager = getWorkflowManager();

  const alreadyRegistered = manager.listenerCount('workflow:invoke-agent') > 0;
  if (alreadyRegistered) return;

  manager.on('workflow:invoke-agent', async (payload: unknown) => {
    const callback = getCallbackFromPayload<
      z.infer<typeof WorkflowAgentInvocationPayloadSchema>['callback']
    >(payload);
    let parsed: z.infer<typeof WorkflowAgentInvocationPayloadSchema>;
    try {
      parsed = parseInvocationPayload(
        WorkflowAgentInvocationPayloadSchema,
        payload,
        'workflow:invoke-agent',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Workflow invocation payload rejected', error instanceof Error ? error : undefined);
      callback?.(`[Error: ${message}]`, 0);
      return;
    }

    try {
      // Find the instance associated with this workflow execution by scanning instanceExecutions
      let instance: ReturnType<InstanceManager['getInstance']> | undefined;
      if (parsed.executionId) {
        for (const inst of instanceManager.getAllInstances()) {
          const execution = manager.getExecutionByInstance(inst.id);
          if (execution?.id === parsed.executionId) {
            instance = inst;
            break;
          }
        }
      }

      const agentType = parsed.agentType;
      const systemPrompt = agentType
        ? `You are a ${agentType} agent. Complete the task described below thoroughly and accurately.`
        : undefined;
      const result = await invokeCliTextResponse({
        instanceManager,
        instanceId: instance?.id,
        payloadModel: parsed.model,
        systemPrompt,
        prompt: parsed.prompt,
        breakerKey: 'workflow-orchestration',
        correlationId: parsed.correlationId,
      });
      parsed.callback(result.response, result.tokens);
    } catch (err) {
      const message = logInvocationFailure({
        correlationId: parsed.correlationId,
        invocation: 'Workflow agent invocation',
        error: err,
        instanceId: instanceManager
          .getAllInstances()
          .find((inst) => manager.getExecutionByInstance(inst.id)?.id === parsed.executionId)
          ?.id,
        model: parsed.model,
      });
      logger.error('Error handling workflow:invoke-agent', err instanceof Error ? err : undefined);
      // Workflow callbacks expect (response, tokens) — return error as response
      parsed.callback(`[Error: ${message}]`, 0);
    }
  });
}

// ─── Loop Mode invoker ─────────────────────────────────────────────────────

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fsLoop from 'fs';
import * as pathLoop from 'path';
import { getLoopCoordinator } from './loop-coordinator';
import type { LoopChildResult } from './loop-coordinator';
import type { LoopFileChange } from '../../shared/types/loop.types';

/**
 * Best-effort file change detection: shells out to `git diff --numstat HEAD`
 * inside the workspace, then computes a content hash for each file. Returns
 * an empty list if not a git repo (the loop still works — progress detector
 * will gracefully degrade).
 */
/**
 * Build a long-lived CLI adapter for `contextStrategy: 'same-session'`
 * loops. Lifecycle is owned by the loop invoker — created once on the
 * first iteration of the run, torn down when the coordinator broadcasts
 * a terminal state. Same spawn options as a fresh-child invocation, but
 * we pass through the stream-idle override up front since the adapter
 * is reused.
 */
async function createPersistentLoopAdapter(opts: {
  provider: 'claude' | 'codex';
  workingDirectory: string;
  streamIdleTimeoutMs?: number;
}): Promise<unknown> {
  const cliType = await resolveCliType(opts.provider as Parameters<typeof resolveCliType>[0], 'claude');
  const model = resolveDefaultModel(cliType, undefined);
  const adapter = getProviderRuntimeService().createAdapter({
    cliType,
    options: {
      workingDirectory: opts.workingDirectory,
      model,
      yoloMode: false,
      // Generous wall-clock cap so a long iteration doesn't die on a
      // spawn-level timeout. Stream-idle is the real hang detector.
      timeout: 30 * 60 * 1000,
    },
  });
  if (typeof opts.streamIdleTimeoutMs === 'number') {
    const setter = (adapter as { setStreamIdleTimeoutMs?: (ms: number) => void }).setStreamIdleTimeoutMs;
    if (typeof setter === 'function') setter.call(adapter, opts.streamIdleTimeoutMs);
  }
  return adapter;
}

function snapshotFileChangesViaGit(cwd: string): LoopFileChange[] {
  try {
    const numstat = spawnSync('git', ['diff', '--numstat', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (numstat.status !== 0 || !numstat.stdout) return [];
    const out: LoopFileChange[] = [];
    for (const line of numstat.stdout.trim().split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const additions = Number.parseInt(parts[0], 10);
      const deletions = Number.parseInt(parts[1], 10);
      const relPath = parts[2];
      const abs = pathLoop.resolve(cwd, relPath);
      let contentHash = '';
      try {
        if (fsLoop.existsSync(abs) && fsLoop.statSync(abs).isFile()) {
          const buf = fsLoop.readFileSync(abs);
          contentHash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
        }
      } catch { /* ignore */ }
      out.push({
        path: relPath,
        additions: Number.isFinite(additions) ? additions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0,
        contentHash,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Wire `loop:invoke-iteration` to the existing CLI adapter pipeline. The
 * prompt is sent as a single user message; the response text is captured
 * along with token usage. File diffs are best-effort via git.
 *
 * Tool calls and structured error classification are not captured here in
 * v1 — those signals will be empty, which the progress detector handles
 * gracefully (it just doesn't fire G/E without data).
 */
export function registerDefaultLoopInvoker(instanceManager: InstanceManager): void {
  const coordinator = getLoopCoordinator();
  if (coordinator.listenerCount('loop:invoke-iteration') > 0) return;

  // Per-loop persistent adapters for `contextStrategy: 'same-session'`. The
  // map is keyed by loopRunId; entries are torn down when the coordinator
  // emits a terminal `loop:state-changed` for the matching run.
  const persistentLoopAdapters = new Map<string, unknown>();

  const isTerminalLoopStatus = (status: string): boolean =>
    status === 'completed' || status === 'cancelled' || status === 'cap-reached'
    || status === 'error' || status === 'no-progress';

  coordinator.on('loop:state-changed', (data: unknown) => {
    const payload = data as { loopRunId: string; state: { status: string } };
    if (!isTerminalLoopStatus(payload?.state?.status ?? '')) return;
    const adapter = persistentLoopAdapters.get(payload.loopRunId);
    if (!adapter) return;
    persistentLoopAdapters.delete(payload.loopRunId);
    const terminator = (adapter as { terminate?: (graceful?: boolean) => Promise<void> }).terminate;
    if (typeof terminator === 'function') {
      terminator.call(adapter, false).catch((err: unknown) => {
        logger.warn('Same-session loop adapter teardown failed', {
          loopRunId: payload.loopRunId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });

  coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
    interface Payload {
      correlationId: string;
      loopRunId: string;
      chatId: string;
      provider: 'claude' | 'codex';
      workspaceCwd: string;
      stage: string;
      seq: number;
      prompt: string;
      config: { contextStrategy?: string };
      callback: (result: LoopChildResult | { error: string }) => void;
      // Forwarded from LoopConfig — overrides the invoker's defaults.
      iterationTimeoutMs?: number;
      streamIdleTimeoutMs?: number;
    }
    const p = payload as Payload;
    if (!p?.callback || typeof p.callback !== 'function') {
      logger.warn('loop:invoke-iteration payload missing callback');
      return;
    }

    // For `contextStrategy: 'same-session'`, lazily create one persistent
    // adapter per loopRunId and reuse it across iterations so the
    // conversation persists. Caller (this listener) owns the lifecycle —
    // teardown happens when the coordinator broadcasts a terminal state.
    let reusedAdapter: unknown | undefined;
    const sameSession = p.config?.contextStrategy === 'same-session';
    if (sameSession) {
      const existing = persistentLoopAdapters.get(p.loopRunId);
      if (existing) {
        reusedAdapter = existing;
      } else {
        // The first iteration creates the adapter. We let invokeCliTextResponse
        // do that the normal way, then capture the resulting adapter ref via
        // the breaker by routing through a small helper. Simpler approach:
        // create here directly, then pass it in for subsequent iters too.
        reusedAdapter = await createPersistentLoopAdapter({
          provider: p.provider,
          workingDirectory: p.workspaceCwd,
          streamIdleTimeoutMs: p.streamIdleTimeoutMs,
        }).catch((err: unknown) => {
          logger.warn('Failed to create same-session loop adapter, falling back to fresh-child', {
            loopRunId: p.loopRunId,
            error: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        });
        if (reusedAdapter) {
          persistentLoopAdapters.set(p.loopRunId, reusedAdapter);
        }
      }
    }

    try {
      const result = await invokeCliTextResponse({
        instanceManager,
        instanceId: undefined,
        // Spawn the CLI inside the loop's workspace, not Electron's CWD.
        // Without this the AI runs in `/` (or the app bundle path) and
        // can't see any of the user's project files.
        workingDirectory: p.workspaceCwd,
        requestedProvider: p.provider,
        payloadModel: undefined,
        systemPrompt: undefined,
        prompt: p.prompt,
        breakerKey: `loop-orchestration:${p.provider}`,
        correlationId: p.correlationId,
        // Wall-clock cap per iteration — generous by default so legitimate
        // long work (deep thinking, many tool calls, file edits) isn't
        // killed. Hung CLIs are caught much faster by the stream-idle
        // watchdog inside `invokeCliTextResponse` (no stdout for the
        // configured threshold → abort).
        timeoutMs: p.iterationTimeoutMs ?? 30 * 60 * 1000,
        streamIdleTimeoutMs: p.streamIdleTimeoutMs,
        reusedAdapter,
      });

      const filesChanged = snapshotFileChangesViaGit(p.workspaceCwd);
      const childResult: LoopChildResult = {
        childInstanceId: null,
        output: result.response,
        tokens: result.tokens,
        filesChanged,
        toolCalls: [],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        exitedCleanly: true,
      };
      p.callback(childResult);
    } catch (err) {
      const message = logInvocationFailure({
        correlationId: p.correlationId,
        invocation: 'Loop iteration invocation',
        error: err,
        provider: p.provider,
      });
      p.callback({ error: message });
    }
  });
}
