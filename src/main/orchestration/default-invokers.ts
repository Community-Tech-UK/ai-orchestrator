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
import type { ProviderId } from '../../shared/types/provider-quota.types';
import { getModelRouter, resolveRoutedModel } from '../routing';
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

interface ProviderLimitResumeRequest {
  loopRunId: string;
  chatId: string;
  workspaceCwd: string;
  provider: ProviderId;
  resumeAt: number;
  reason: string;
  source: 'quota' | 'notice';
  action: string;
  windowId?: string;
}

type DebateInvocationSchema =
  | typeof DebateResponseInvocationPayloadSchema
  | typeof DebateCritiqueInvocationPayloadSchema
  | typeof DebateDefenseInvocationPayloadSchema
  | typeof DebateSynthesisInvocationPayloadSchema;

function resolveDefaultModel(cliType: CliType, payloadModel?: string): string | undefined {
  if (typeof payloadModel === 'string' && payloadModel !== 'default') return payloadModel;
  return getDefaultModelForCli(cliType);
}

/** Per-call-site opt-in for cost-tiered routing on the shared invoker path. */
export type RoutingIntent = 'loop' | 'workflow';

/**
 * Resolve the model for a CLI invocation (intent-routing Phase 2).
 *
 * Routing is OPT-IN per call-site and only fires when ALL hold:
 *   1. the caller passed an explicit `routingIntent` (only Loop Mode does today),
 *   2. the user did NOT request a concrete model (`payloadModel` unset/`'default'`),
 *   3. the model router is enabled (`ModelRoutingConfig.enabled`).
 *
 * Otherwise it falls back to `resolveDefaultModel` byte-for-byte — so the
 * verify/review/debate/workflow/consensus paths (which never pass a
 * `routingIntent`) keep resolving to the strong house model (Opus).
 */
export function resolveModelForInvocation(args: {
  cliType: CliType;
  requestedProvider: string;
  payloadModel?: string;
  prompt: string;
  routingIntent?: RoutingIntent;
}): string | undefined {
  const explicitlyRequested =
    typeof args.payloadModel === 'string' && args.payloadModel !== 'default';

  if (args.routingIntent && !explicitlyRequested && getModelRouter().getConfig().enabled) {
    // Prefer the concrete requested provider; fall back to the resolved CLI type
    // as a provider hint when the caller asked for `auto`.
    const provider =
      args.requestedProvider && args.requestedProvider !== 'auto'
        ? args.requestedProvider
        : args.cliType;
    const decision = resolveRoutedModel(args.prompt, { provider });
    logger.info('Routed invocation model', {
      intent: args.routingIntent,
      provider,
      tier: decision.tier,
      model: decision.model,
      reason: decision.reason,
    });
    return decision.model;
  }

  return resolveDefaultModel(args.cliType, args.payloadModel);
}

function isBaseCliAdapterLike(adapter: CliAdapter): adapter is CliAdapter & { sendMessage: (m: CliMessage) => Promise<CliResponse> } {
  return typeof (adapter as { sendMessage?: unknown }).sendMessage === 'function';
}

type LoopInvocationActivityKind =
  | 'spawned'
  | 'status'
  | 'tool_use'
  | 'assistant'
  | 'system'
  | 'input_required'
  | 'error'
  | 'stream-idle'
  | 'complete'
  | 'heartbeat';

interface LoopInvocationActivity {
  kind: LoopInvocationActivityKind;
  message: string;
  detail?: Record<string, unknown>;
}

const LOOP_AUTONOMOUS_INPUT_RESPONSE =
  'Loop Mode is unattended. Do not wait for human input. Make the best reasonable assumption a senior engineer would defend, document it in your loop NOTES file, and continue. If the work is genuinely blocked, write the BLOCKED.md file at the loop-state path given in your iteration prompt with the exact blocker, then exit the iteration.';
const LOOP_DEFAULT_ACTIVE_TIMEOUT_MS = 5 * 60 * 1000;

function attachInvocationActivity(
  adapter: CliAdapter,
  sink: (activity: LoopInvocationActivity) => void,
  options: { autoAnswerInputRequired?: boolean } = {},
): () => void {
  const emitter = adapter as unknown as {
    on?: (event: string, handler: (...args: unknown[]) => void) => void;
    off?: (event: string, handler: (...args: unknown[]) => void) => void;
    removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  };
  if (typeof emitter.on !== 'function') return () => { /* noop */ };

  const removers: (() => void)[] = [];
  const listen = (event: string, handler: (...args: unknown[]) => void) => {
    emitter.on!(event, handler);
    removers.push(() => {
      if (typeof emitter.off === 'function') emitter.off(event, handler);
      else if (typeof emitter.removeListener === 'function') emitter.removeListener(event, handler);
    });
  };

  listen('spawned', (pid) => {
    sink({
      kind: 'spawned',
      message: `CLI child spawned${typeof pid === 'number' ? ` (pid ${pid})` : ''}`,
      detail: typeof pid === 'number' ? { pid } : undefined,
    });
  });
  listen('status', (status) => {
    sink({
      kind: 'status',
      message: `CLI status: ${String(status)}`,
      detail: { status: String(status) },
    });
  });
  listen('heartbeat', () => {
    sink({ kind: 'heartbeat', message: 'CLI heartbeat received' });
  });
  listen('stream:idle', (info) => {
    const meta = isRecord(info) ? info : {};
    const timeoutMs = typeof meta['timeoutMs'] === 'number' ? meta['timeoutMs'] : undefined;
    const seconds = timeoutMs ? Math.round(timeoutMs / 1000) : null;
    sink({
      kind: 'stream-idle',
      message: seconds
        ? `No CLI output for ${seconds}s; still waiting for the iteration to finish`
        : 'No CLI output recently; still waiting for the iteration to finish',
      detail: { ...meta },
    });
  });
  listen('output', (output) => {
    sink(describeAdapterOutput(output));
  });
  listen('input_required', (payload) => {
    const data = isRecord(payload) ? payload : {};
    const metadata = isRecord(data['metadata']) ? data['metadata'] : {};
    const prompt = typeof data['prompt'] === 'string' ? data['prompt'] : 'CLI requested input';
    const promptType = typeof metadata['type'] === 'string' ? metadata['type'] : 'input_required';
    sink({
      kind: 'input_required',
      message: summarizeActivityText(`CLI requested input (${promptType}): ${prompt}`),
      detail: {
        ...metadata,
        id: typeof data['id'] === 'string' ? data['id'] : undefined,
        prompt,
      },
    });

    if (!options.autoAnswerInputRequired) {
      return;
    }

    const terminateHiddenInputWait = (reason: string): void => {
      const terminate = (adapter as unknown as { terminate?: (graceful?: boolean) => Promise<void> }).terminate;
      if (typeof terminate !== 'function') {
        return;
      }
      sink({
        kind: 'status',
        message: `Terminating hidden loop child after input request: ${reason}`,
        detail: { promptType },
      });
      terminate.call(adapter, false).catch((error: unknown) => {
        sink({
          kind: 'error',
          message: `Failed to terminate hidden loop child after input request: ${error instanceof Error ? error.message : String(error)}`,
          detail: { promptType },
        });
      });
    };

    const canAutoAnswer =
      promptType !== 'permission_denial' &&
      promptType !== 'deferred_permission' &&
      promptType !== 'mcp_elicitation' &&
      promptType !== 'acp_elicitation';
    const sendRaw = (adapter as unknown as { sendRaw?: (text: string) => Promise<void> }).sendRaw;
    if (!canAutoAnswer || typeof sendRaw !== 'function') {
      sink({
        kind: 'error',
        message: canAutoAnswer
          ? 'Loop child requested input, but this adapter cannot receive an automatic response'
          : `Loop child requested ${promptType}; cannot auto-answer that safely in hidden Loop Mode`,
        detail: { promptType, prompt },
      });
      terminateHiddenInputWait(canAutoAnswer ? 'adapter cannot receive automatic response' : `${promptType} cannot be answered safely`);
      return;
    }

    sink({
      kind: 'status',
      message: 'Auto-answering hidden loop question with autonomous-mode guidance',
      detail: { promptType },
    });
    sendRaw.call(adapter, LOOP_AUTONOMOUS_INPUT_RESPONSE).catch((error: unknown) => {
      sink({
        kind: 'error',
        message: `Failed to auto-answer hidden loop question: ${error instanceof Error ? error.message : String(error)}`,
        detail: { promptType },
      });
      terminateHiddenInputWait('automatic response failed');
    });
  });
  listen('complete', (response) => {
    const meta = isRecord(response) ? response : {};
    const usage = isRecord(meta['usage']) ? meta['usage'] : {};
    const metadata = isRecord(meta['metadata']) ? meta['metadata'] : {};
    sink({
      kind: 'complete',
      message: metadata['timedOut'] === true
        ? 'CLI iteration timeout reached after partial output; continuing from partial result'
        : 'CLI response complete',
      detail: {
        tokens: typeof usage['totalTokens'] === 'number' ? usage['totalTokens'] : undefined,
        timedOut: metadata['timedOut'] === true ? true : undefined,
        timeoutMs: typeof metadata['timeoutMs'] === 'number' ? metadata['timeoutMs'] : undefined,
      },
    });
  });
  listen('error', (error) => {
    sink({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  });

  return () => {
    for (const remove of removers.splice(0)) remove();
  };
}

function describeAdapterOutput(output: unknown): LoopInvocationActivity {
  if (typeof output === 'string') {
    return { kind: 'assistant', message: summarizeActivityText(output) };
  }
  if (!isRecord(output)) {
    return { kind: 'system', message: summarizeActivityText(String(output)) };
  }

  const type = typeof output['type'] === 'string' ? output['type'] : 'output';
  const content = typeof output['content'] === 'string' ? output['content'] : '';
  const metadata = isRecord(output['metadata']) ? output['metadata'] : {};
  if (type === 'tool_use') {
    const name = typeof metadata['name'] === 'string' ? metadata['name'] : undefined;
    return {
      kind: 'tool_use',
      message: summarizeActivityText(name ? `Using tool: ${name}` : content || 'Using tool'),
      detail: metadata,
    };
  }
  if (type === 'error') {
    return { kind: 'error', message: summarizeActivityText(content || 'CLI emitted an error'), detail: metadata };
  }
  if (type === 'assistant') {
    return { kind: 'assistant', message: summarizeActivityText(content || 'Assistant output received'), detail: metadata };
  }
  return {
    kind: 'system',
    message: summarizeActivityText(content || `CLI output: ${type}`),
    detail: metadata,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function summarizeActivityText(value: string, max = 280): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

async function terminateCliAdapter(adapter: unknown, graceful: boolean): Promise<void> {
  const terminator = (adapter as { terminate?: (graceful?: boolean) => Promise<void> } | null | undefined)?.terminate;
  if (typeof terminator === 'function') {
    await terminator.call(adapter, graceful);
  }
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
  /**
   * Opt-in cost-tiered routing for this call (intent-routing Phase 2).
   * Only Loop Mode sets this; verify/review/debate/workflow/consensus leave it
   * unset so they keep the strong default model. Routing also requires the
   * router to be enabled and `payloadModel` to be unset.
   */
  routingIntent?: RoutingIntent;
  systemPrompt?: string;
  prompt: string;
  context?: string;
  breakerKey: string;
  correlationId: string;
  /** Optional override for the spawn wall-clock timeout in milliseconds.
   *  Acts as the outer safety net for the invocation. */
  timeoutMs?: number;
  /** Optional override for the adapter's stream-idle warning threshold. */
  streamIdleTimeoutMs?: number;
  /** Run the child non-interactively, auto-approving CLI tool permissions. */
  yoloMode?: boolean;
  /** Return partial CLI output instead of failing if a loop iteration hits its wall-clock cap. */
  allowPartialOnTimeout?: boolean;
  /** Treat the wall-clock timeout as a checkpoint while recent CLI output proves the child is active. */
  continueWhileActiveOnTimeout?: boolean;
  /** Recent-output window used to decide whether a timed-out loop child is still active. */
  activeTimeoutMs?: number;
  /** Hidden loop workers cannot ask the user; ordinary clarification prompts get an autonomous response. */
  autoAnswerInputRequired?: boolean;
  permissionHookPath?: string;
  env?: Record<string, string>;
  rtk?: UnifiedSpawnOptions['rtk'];
  /** Reuse an existing adapter instead of creating + terminating a fresh
   *  one for every call. Used by Loop Mode's `same-session` contextStrategy
   *  so the conversation persists across iterations. The caller owns the
   *  adapter lifecycle when this is set. */
  reusedAdapter?: unknown;
  activity?: (activity: LoopInvocationActivity) => void;
  onAdapterReady?: (adapter: CliAdapter) => (() => void) | void;
  cleanupAdapter?: (adapter: CliAdapter, graceful: boolean) => Promise<void>;
}): Promise<ReturnType<typeof normalizeInvocationTextResult>> {
  const instance = params.instanceId
    ? params.instanceManager.getInstance(params.instanceId)
    : undefined;
  const workingDirectory = params.workingDirectory || instance?.workingDirectory || process.cwd();
  const fallbackProvider = instance?.provider as string | undefined;
  const requestedProvider = params.requestedProvider ?? fallbackProvider ?? 'auto';
  const defaultCli = getSettingsManager().getAll().defaultCli;
  const cliType = await resolveCliType(requestedProvider as Parameters<typeof resolveCliType>[0], defaultCli);
  const model = resolveModelForInvocation({
    cliType,
    requestedProvider,
    payloadModel: params.payloadModel,
    prompt: params.prompt,
    routingIntent: params.routingIntent,
  });

  const spawnOptions: UnifiedSpawnOptions = {
    workingDirectory,
    model,
    systemPrompt: params.systemPrompt,
    yoloMode: params.yoloMode ?? false,
    permissionHookPath: params.permissionHookPath,
    env: params.env,
    rtk: params.rtk,
    timeout: params.timeoutMs ?? 300000,
  };

  const breaker = getCircuitBreakerRegistry().getBreaker(params.breakerKey, {
    failureThreshold: 3,
    resetTimeoutMs: 60000,
    // Every call through this path is an interactive CLI turn (loop iteration,
    // verify, review, debate) that legitimately runs for minutes — deep
    // thinking, many tool calls, file edits. The breaker's default slow-call
    // tracking (10s threshold, open at 50% slow) would classify *every*
    // healthy iteration as "slow" and could trip the breaker on success alone.
    // Only real failures (throws: timeouts with no active output, adapter
    // crashes, provider errors) should count toward opening it.
    trackSlowCalls: false,
  });

  const prompt = buildUserPrompt(params.prompt, params.context);
  const response = await breaker.execute(async () => {
    // Either reuse the caller's adapter (same-session loop) or create a
    // fresh one (one-shot — chat orchestration, debate, fresh-child loop).
    const ownsAdapter = !params.reusedAdapter;
    const adapter: CliAdapter = (params.reusedAdapter as CliAdapter | undefined)
      ?? getProviderRuntimeService().createAdapter({ cliType, options: spawnOptions });
    const untrackAdapter = params.onAdapterReady?.(adapter) ?? (() => { /* noop */ });
    const detachActivity = params.activity
      ? attachInvocationActivity(adapter, params.activity, {
          autoAnswerInputRequired: params.autoAnswerInputRequired,
        })
      : () => { /* noop */ };
    params.activity?.({
      kind: ownsAdapter ? 'spawned' : 'status',
      message: ownsAdapter
        ? `Starting ${cliType} loop child in ${workingDirectory}`
        : `Reusing ${cliType} loop child in ${workingDirectory}`,
      detail: { cliType, workingDirectory, reused: !ownsAdapter },
    });
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

      // Stream-idle is intentionally advisory here. Claude CLI can be quiet
      // for minutes during real planning/thinking phases before emitting the
      // next JSON chunk, so treating the adapter's no-stdout watchdog as a
      // hard failure kills valid Loop Mode work. Loop Mode can opt into
      // treating the wall-clock timeout as a checkpoint while recent stdout
      // proves the child is still active.
      const sendMetadata: CliMessage['metadata'] | undefined = params.allowPartialOnTimeout
        ? {
            allowPartialOnTimeout: true,
            ...(params.continueWhileActiveOnTimeout ? { continueWhileActiveOnTimeout: true } : {}),
            ...(typeof params.activeTimeoutMs === 'number' ? { activeTimeoutMs: params.activeTimeoutMs } : {}),
          }
        : undefined;
      return await (adapter as { sendMessage(m: CliMessage): Promise<CliResponse> })
        .sendMessage({
          role: 'user',
          content: prompt,
          metadata: sendMetadata,
        });
    } finally {
      detachActivity();
      // Caller owns the lifecycle when reusing an adapter (same-session
      // loops keep it alive across iterations and tear it down on terminate).
      if (ownsAdapter) {
        const cleanup = params.cleanupAdapter ?? terminateCliAdapter;
        await cleanup(adapter, false).catch((cleanupError: unknown) => {
          logger.warn('One-shot invocation adapter cleanup failed', {
            correlationId: params.correlationId,
            cliType,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        });
      }
      untrackAdapter();
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
import * as pathLoop from 'path';
import { getLoopCoordinator } from './loop-coordinator';
import { getProviderQuotaService } from '../core/system/provider-quota-service';
import { registerLoopSafetyAdvisor } from './loop-safety-advisor';
import type { LoopChildResult } from './loop-coordinator';
import type { LoopErrorRecord, LoopProvider, LoopToolCallRecord } from '../../shared/types/loop.types';
import { defaultLoopContextConfig } from '../../shared/types/loop.types';
import { shouldRecycleLoopContext } from './loop-context-discipline';
import {
  runBranchSelect,
  pickCandidateProvider,
  type BranchCandidate,
  type BranchSelectDeps,
  type BranchSelectInput,
} from './loop-branch-select';
import { collectWorkspaceDiff } from './loop-diff';
import { DurableLoopMemoryStore } from './loop-memory';
import { maybeExternalizeLoopOutput } from './loop-output-externalize';
import { getWorktreeManager } from '../workspace/git/worktree-manager';
import {
  classifyIterationErrors,
  createPersistentLoopAdapter,
  enableAdapterResume,
  parseTestCounts,
} from './default-loop-invoker-helpers';
export {
  classifyIterationErrors,
  parseTestCounts,
} from './default-loop-invoker-helpers';
import {
  mergeFileChanges,
  snapshotFileChangesViaGit,
  snapshotFileChangesViaWorkspace,
  snapshotWorkspaceFiles,
} from './loop-workspace-snapshot';

function branchSelectErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * LF-5 — run a verify command in a candidate worktree dir. Synchronous spawn
 * (bounded by `timeoutMs`); returns true only on a clean exit. Never throws.
 */
function runVerifyInDir(cmd: string, cwd: string, timeoutMs: number): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  try {
    const result = spawnSync(trimmed, [], {
      cwd,
      shell: true,
      timeout: Math.max(1, timeoutMs),
      env: { ...process.env, CI: '1' },
      stdio: 'ignore',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * LF-5 — commit a candidate worktree's working-tree changes onto its branch so
 * `mergeWorktree` (which merges branch COMMITS, not the dirty working tree) can
 * adopt them. Loop iterations don't commit, so without this the winner's edits
 * would never reach the workspace. Passes an explicit committer identity so it
 * succeeds even when global git config is absent (headless/CI). No-op when there
 * is nothing to commit; best-effort.
 */
function commitWorktreeChanges(cwd: string): void {
  try {
    spawnSync('git', ['add', '-A'], { cwd, timeout: 30_000, stdio: 'ignore' });
    spawnSync(
      'git',
      ['-c', 'user.email=loop-branch@local', '-c', 'user.name=Loop Branch-Select', 'commit', '-m', 'loop branch-select candidate', '--no-verify'],
      { cwd, timeout: 30_000, stdio: 'ignore' },
    );
  } catch {
    /* nothing to commit / git unavailable — best-effort */
  }
}

/**
 * LF-5 — list-wise LLM scoring of candidate diffs (best-effort). Returns a
 * map of candidate id → score (0..1); `{}` on any failure so the caller falls
 * back to the verify+heuristic ranking. Lazy-requires the LLM stack.
 */
async function scoreCandidatesListwise(
  candidates: readonly BranchCandidate[],
  goal: string,
): Promise<Record<string, number>> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLLMService } = require('../rlm/llm-service') as typeof import('../rlm/llm-service');
    const llm = getLLMService();
    if (!(await llm.isAvailable())) return {};
    const context = candidates
      .map((c, i) => `CANDIDATE id=${c.id} (#${i + 1}, verify=${c.verifyPassed ? 'PASS' : 'FAIL'}):\n${c.summary.slice(0, 1500)}`)
      .join('\n\n');
    const prompt =
      'Several candidate diffs each attempt the GOAL in an isolated worktree. Score each ' +
      '0..1 by how well its diff advances the goal (correct, complete, maintainable; prefer ' +
      'candidates whose verify passed). Respond with ONLY a JSON object mapping candidate id ' +
      'to score, e.g. {"abc":0.8,"def":0.3}. No other text.';
    const raw = await llm.subQuery({
      requestId: `loop-branch-listwise-${Date.now()}`,
      prompt: `GOAL:\n${goal}\n\n${prompt}`,
      context,
      depth: 0,
    });
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(obj)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[id] = Math.max(0, Math.min(1, value));
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * LF-5 — real branch-and-select I/O deps: isolate each candidate in a git
 * worktree, run a CLI turn there, verify it, then (on a winner) merge it back
 * and tear down every worktree. The pure orchestration/selection lives in
 * `runBranchSelect`/`selectWinner`; this is the thin runtime glue.
 */
export function buildLoopBranchSelectorDeps(instanceManager: InstanceManager): BranchSelectDeps {
  return {
    async fanout(input: BranchSelectInput): Promise<BranchCandidate[]> {
      if (!input.verifyCommand.trim()) {
        logger.info('Branch-select: no verify command — cannot rank candidates; skipping fan-out', {
          loopRunId: input.loopRunId,
        });
        return [];
      }
      const wm = getWorktreeManager();
      const candidates: BranchCandidate[] = [];
      for (let i = 0; i < input.exploration.fanout; i++) {
        const provider = pickCandidateProvider(input.provider, input.exploration.crossModel, i);
        let session: { id: string; worktreePath: string };
        try {
          session = await wm.createWorktree(
            `loop-branch-${input.loopRunId}`,
            `branch-select candidate ${i + 1} (${provider})`,
            { repoRoot: input.workspaceCwd, skipInstall: true, taskType: 'feature' },
          );
        } catch (err) {
          logger.warn('Branch-select: createWorktree failed; skipping candidate', {
            loopRunId: input.loopRunId, index: i, error: branchSelectErr(err),
          });
          continue;
        }
        let response = '';
        try {
          const result = await invokeCliTextResponse({
            instanceManager,
            workingDirectory: session.worktreePath,
            requestedProvider: provider,
            prompt:
              `${input.prompt}\n\n## Branch-and-Select Candidate\nThe serial loop STALLED here. You are ` +
              `candidate ${i + 1} of ${input.exploration.fanout} exploring in an isolated worktree. Take a ` +
              `DIFFERENT approach to the stuck part than the obvious one, make the change, and ensure the ` +
              `project's verify command passes.`,
            breakerKey: `loop-branch:${provider}`,
            correlationId: `${input.loopRunId}::branch::${i}`,
            timeoutMs: input.iterationTimeoutMs,
            yoloMode: true,
            allowPartialOnTimeout: true,
            continueWhileActiveOnTimeout: true,
            autoAnswerInputRequired: true,
          });
          response = result.response;
        } catch (err) {
          logger.warn('Branch-select: candidate invocation failed', {
            loopRunId: input.loopRunId, index: i, error: branchSelectErr(err),
          });
        }
        const verifyPassed = runVerifyInDir(input.verifyCommand, session.worktreePath, input.verifyTimeoutMs);
        let filesChanged = 0;
        let summary = response.slice(0, 800);
        try {
          // Capture the diff BEFORE committing (git diff HEAD shows the
          // still-uncommitted candidate edits + untracked files).
          const diff = collectWorkspaceDiff(session.worktreePath, { maxChars: 4000 });
          filesChanged = diff.changedFiles.length;
          summary = `${summary}\n--- diff ---\n${diff.diff.slice(0, 2000)}`;
        } catch { /* diff is best-effort */ }
        // Commit the candidate's edits onto its branch so the winner is mergeable.
        commitWorktreeChanges(session.worktreePath);
        candidates.push({ id: session.id, provider, workdir: session.worktreePath, verifyPassed, filesChanged, summary });
      }
      return candidates;
    },

    async adopt(winner: BranchCandidate): Promise<void> {
      const result = await getWorktreeManager().mergeWorktree(winner.id, {
        strategy: 'auto',
        commitMessage: `loop branch-select: adopt candidate (${winner.provider})`,
        allowConflicts: false,
      });
      if (!result.success) {
        throw new Error(`worktree merge failed: ${result.error ?? 'unknown'}`);
      }
    },

    async cleanup(candidates: readonly BranchCandidate[]): Promise<void> {
      const wm = getWorktreeManager();
      for (const candidate of candidates) {
        try {
          await wm.abandonWorktree(candidate.id, 'branch-select cleanup');
        } catch (err) {
          logger.warn('Branch-select: abandonWorktree failed', { id: candidate.id, error: branchSelectErr(err) });
        }
      }
    },

    listwiseScore: (candidates, goal) => scoreCandidatesListwise(candidates, goal),
  };
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

  // claude2_todo #20: non-blocking post-iteration safety advisor. Guarded by
  // the same once-per-coordinator gate above so it isn't double-registered.
  registerLoopSafetyAdvisor(coordinator);

  // Per-loop persistent adapters for `contextStrategy: 'same-session'`. The
  // map is keyed by loopRunId; entries are torn down when the coordinator
  // emits a terminal `loop:state-changed` for the matching run.
  const persistentLoopAdapters = new Map<string, unknown>();
  const activeLoopAdapters = new Map<string, Set<unknown>>();
  const terminatedAdapters = new WeakSet<object>();
  // LF-1: cumulative same-session tokens per loop, used to decide when to
  // recycle the persistent adapter to a fresh session (context discipline).
  const loopContextTokens = new Map<string, number>();

  const terminateTrackedAdapter = async (adapter: unknown, graceful: boolean): Promise<void> => {
    if (adapter && typeof adapter === 'object') {
      if (terminatedAdapters.has(adapter)) return;
      terminatedAdapters.add(adapter);
    }
    await terminateCliAdapter(adapter, graceful);
  };

  const trackActiveAdapter = (loopRunId: string, adapter: unknown): (() => void) => {
    if (adapter && typeof adapter === 'object') {
      terminatedAdapters.delete(adapter);
    }
    const set = activeLoopAdapters.get(loopRunId) ?? new Set<unknown>();
    set.add(adapter);
    activeLoopAdapters.set(loopRunId, set);
    return () => {
      const current = activeLoopAdapters.get(loopRunId);
      if (!current) return;
      current.delete(adapter);
      if (current.size === 0) activeLoopAdapters.delete(loopRunId);
    };
  };

  // LF-1: recycle a loop's persistent same-session adapter to a fresh session.
  // Terminates the current adapter, drops it from both tracking maps, and zeroes
  // the cumulative-token counter so the NEXT iteration creates a fresh adapter.
  // Durable disk state (STAGE/NOTES/ITERATION_LOG/plan + the goal persisted each
  // iteration) re-anchors the fresh session. terminateTrackedAdapter dedupes via
  // a WeakSet so a later teardown of the same adapter is a no-op.
  const recyclePersistentLoopAdapter = async (loopRunId: string): Promise<void> => {
    const adapter = persistentLoopAdapters.get(loopRunId);
    persistentLoopAdapters.delete(loopRunId);
    loopContextTokens.delete(loopRunId);
    if (adapter) {
      const set = activeLoopAdapters.get(loopRunId);
      if (set) {
        set.delete(adapter);
        if (set.size === 0) activeLoopAdapters.delete(loopRunId);
      }
      try {
        await terminateTrackedAdapter(adapter, true);
      } catch (err) {
        logger.warn('LF-1 context recycle: adapter teardown failed', {
          loopRunId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const isTerminalLoopStatus = (status: string): boolean =>
    status === 'completed' || status === 'completed-needs-review' || status === 'cancelled' || status === 'cap-reached'
    || status === 'failed' || status === 'error' || status === 'no-progress' || status === 'provider-limit';

  // FU-8: cleanup function that tears down every adapter we own for a
  // given loop. Two callers may invoke this concurrently (the awaitable
  // hook AND the `loop:state-changed` listener — see comment below). We
  // dedupe via `inFlightCleanups` so the second caller observes the
  // first caller's promise instead of running a separate (now-empty)
  // pass. Without the dedupe, the hook's promise would resolve
  // instantly (the listener already drained the maps) and `cancelLoop`'s
  // `awaitTerminalCleanup` would return before the actual CLI children
  // are torn down — the exact behaviour FU-8 exists to prevent.
  const inFlightCleanups = new Map<string, Promise<void>>();
  const cleanupLoopAdapters = (loopRunId: string): Promise<void> => {
    const existing = inFlightCleanups.get(loopRunId);
    if (existing) return existing;
    const adapters = new Set<unknown>(activeLoopAdapters.get(loopRunId) ?? []);
    const persistentAdapter = persistentLoopAdapters.get(loopRunId);
    if (persistentAdapter) adapters.add(persistentAdapter);
    activeLoopAdapters.delete(loopRunId);
    persistentLoopAdapters.delete(loopRunId);
    loopContextTokens.delete(loopRunId); // LF-1: drop cumulative-token tracking.
    if (adapters.size === 0) return Promise.resolve();
    const promise = Promise.allSettled(
      [...adapters].map(async (adapter) => {
        try {
          await terminateTrackedAdapter(adapter, false);
        } catch (err) {
          logger.warn('Loop adapter teardown failed', {
            loopRunId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    ).then(() => undefined);
    inFlightCleanups.set(loopRunId, promise);
    void promise.finally(() => {
      if (inFlightCleanups.get(loopRunId) === promise) {
        inFlightCleanups.delete(loopRunId);
      }
    });
    return promise;
  };
  // FU-8: prefer the awaitable hook (lets cancelLoop / app-shutdown
  // wait for real CLI teardown). Older test harnesses construct a plain
  // EventEmitter as the coordinator stub, so guard the call.
  const setHook = (coordinator as { setAdapterCleanupHook?: (h: typeof cleanupLoopAdapters) => void })
    .setAdapterCleanupHook;
  if (typeof setHook === 'function') {
    setHook.call(coordinator, cleanupLoopAdapters);
  }
  // Defense-in-depth: also clean up on any terminal state-change. Catches
  // exotic paths that bypass `terminate()` directly (test mocks emitting
  // state-changed without invoking the hook). `cleanupLoopAdapters` is
  // idempotent: if a cleanup is already in flight for the loop, this
  // call observes the same promise.
  coordinator.on('loop:state-changed', (data: unknown) => {
    const payload = data as { loopRunId: string; state: { status: string } };
    if (!isTerminalLoopStatus(payload?.state?.status ?? '')) return;
    void cleanupLoopAdapters(payload.loopRunId);
  });

  // LF-5: wire the real branch-and-select runtime fan-out (worktree-isolated
  // candidates + verify + merge-winner). Opt-in via `LoopConfig.exploration`;
  // the coordinator only invokes it on a CRITICAL when enabled + a cost cap is
  // set, so the default config remains a no-op. Guarded for test stubs.
  const setBranchSelector = (coordinator as {
    setBranchSelector?: (s: (i: BranchSelectInput) => Promise<unknown>) => void;
  }).setBranchSelector;
  if (typeof setBranchSelector === 'function') {
    const deps = buildLoopBranchSelectorDeps(instanceManager);
    setBranchSelector.call(coordinator, (input: BranchSelectInput) => runBranchSelect(input, deps));
  }

  // LF-6: wire durable, cross-restart loop memory under the app's userData dir.
  // Falls back to the in-memory default when electron's app path is unavailable
  // (headless/test). Best-effort — never blocks invoker registration.
  const setLoopMemoryStore = (coordinator as {
    setLoopMemoryStore?: (s: DurableLoopMemoryStore) => void;
  }).setLoopMemoryStore;
  if (typeof setLoopMemoryStore === 'function') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as { app?: { getPath?: (n: string) => string } };
      const userData = electron?.app?.getPath?.('userData');
      if (userData) {
        setLoopMemoryStore.call(coordinator, new DurableLoopMemoryStore(pathLoop.join(userData, 'loop-learnings.json')));
        logger.info('Wired durable loop memory', { path: pathLoop.join(userData, 'loop-learnings.json') });
      }
    } catch (err) {
      logger.info('Durable loop memory unavailable; using in-memory default', { error: branchSelectErr(err) });
    }
  }

  // Usage-aware throttling: feed the loop the live provider quota snapshot so
  // its pre-iteration pre-flight can park before spilling into paid overage.
  // Guarded for test stubs (plain EventEmitter coordinators).
  const setQuotaSnapshotProvider = (coordinator as {
    setQuotaSnapshotProvider?: (fn: (provider: ProviderId) => unknown) => void;
  }).setQuotaSnapshotProvider;
  if (typeof setQuotaSnapshotProvider === 'function') {
    setQuotaSnapshotProvider.call(coordinator, (provider) =>
      getProviderQuotaService().getSnapshot(provider),
    );
  }

  const setProviderLimitResumeScheduler = (coordinator as {
    setProviderLimitResumeScheduler?: (fn: (request: ProviderLimitResumeRequest) => (() => void) | void) => void;
    resumeLoop?: (loopRunId: string) => boolean;
  }).setProviderLimitResumeScheduler;
  if (typeof setProviderLimitResumeScheduler === 'function') {
    setProviderLimitResumeScheduler.call(coordinator, (request: ProviderLimitResumeRequest) =>
      scheduleProviderLimitResume({ request, resumeLoop: (loopRunId) => {
        const resume = (coordinator as { resumeLoop?: (id: string) => boolean }).resumeLoop;
        return typeof resume === 'function' ? resume.call(coordinator, loopRunId) : false;
      } }),
    );
  }

  coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
    interface Payload {
      correlationId: string;
      loopRunId: string;
      chatId: string;
      provider: LoopProvider;
      model?: string;
      workspaceCwd: string;
      stage: string;
      seq: number;
      prompt: string;
      config: {
        contextStrategy?: string;
        // LF-1 context-discipline block (optional; defaults applied below).
        context?: { compaction?: { enabled: boolean; resetAtUtilization: number; clearToolResults: boolean } };
      };
      callback: (result: LoopChildResult | { error: string }) => void;
      // Forwarded from LoopConfig — overrides the invoker's defaults.
      iterationTimeoutMs?: number;
      streamIdleTimeoutMs?: number;
      loopControlEnv?: Record<string, string>;
      // LF-4 RPI: recycle the same-session adapter before this iteration runs.
      forceContextReset?: boolean;
    }
    const p = payload as Payload;
    if (!p?.callback || typeof p.callback !== 'function') {
      logger.warn('loop:invoke-iteration payload missing callback');
      return;
    }
    // FU-5: collect tool-use events from the adapter activity stream so
    // LoopIteration.toolCalls reflects what the child actually did. The
    // progress detector's G signal (tool-call repetition) was unable to
    // fire before because this list was hardcoded to []. We capture
    // tool name + a content-stable hash of the args + an approximate
    // duration so the same call can be detected across iterations.
    const toolCalls: LoopToolCallRecord[] = [];
    const toolStarts = new Map<string, number>();
    // FU-1: when we see meaningful activity from the adapter's event
    // stream (tool use, assistant tokens, input_required), nudge the
    // adapter's stream-idle watchdog so it doesn't fire while the child
    // is demonstrably working. The watchdog already resets on stdout
    // (and now stderr + heartbeat per FU-1 in base-cli-adapter), but
    // these higher-level events catch cases where progress is reported
    // over non-stdout channels (e.g. JSON-RPC notifications) parsed by
    // the adapter without re-emitting raw stdout.
    let activeAdapterRef: CliAdapter | null = null;
    const meaningfulKinds = new Set<LoopInvocationActivityKind>([
      'spawned',
      'tool_use',
      'assistant',
      'input_required',
      'heartbeat',
      'complete',
    ]);
    const nudgeAdapterIdle = (): void => {
      const a = activeAdapterRef as { noteActivity?: () => void } | null;
      if (a && typeof a.noteActivity === 'function') a.noteActivity();
    };
    const emitActivity = (activity: LoopInvocationActivity) => {
      if (meaningfulKinds.has(activity.kind)) nudgeAdapterIdle();
      if (activity.kind === 'tool_use') {
        const detail = activity.detail ?? {};
        const toolName = typeof detail['name'] === 'string'
          ? detail['name']
          : activity.message.replace(/^Using tool:\s*/i, '');
        const toolId = typeof detail['id'] === 'string' ? detail['id'] : null;
        // Hash everything except identity-like fields so reruns with the
        // same intent collapse to the same argsHash.
        const argSource = (() => {
          const copy: Record<string, unknown> = { ...detail };
          delete copy['id'];
          delete copy['name'];
          delete copy['startedAt'];
          delete copy['durationMs'];
          try { return JSON.stringify(copy); } catch { return String(copy); }
        })();
        const argsHash = createHash('sha256').update(`${toolName}:${argSource}`).digest('hex').slice(0, 16);
        if (toolId) toolStarts.set(toolId, Date.now());
        toolCalls.push({ toolName: toolName || 'unknown', argsHash, success: true, durationMs: 0 });
      } else if (activity.kind === 'complete' || activity.kind === 'error') {
        // Approximate duration: distance from each tool start to the
        // terminal event. Better than zero for the signal detectors.
        const now = Date.now();
        for (const [id, started] of toolStarts) {
          for (let i = toolCalls.length - 1; i >= 0; i--) {
            if (toolCalls[i].durationMs === 0) {
              toolCalls[i] = { ...toolCalls[i], durationMs: now - started };
              break;
            }
          }
          toolStarts.delete(id);
        }
      }
      coordinator.emit('loop:activity', {
        loopRunId: p.loopRunId,
        seq: p.seq,
        stage: p.stage,
        timestamp: Date.now(),
        ...activity,
      });
    };
    emitActivity({
      kind: 'status',
      message: `Iteration ${p.seq} starting in ${p.workspaceCwd}`,
      detail: { provider: p.provider, contextStrategy: p.config?.contextStrategy ?? 'fresh-child' },
    });
    const loopIterationTimeoutMs = p.iterationTimeoutMs ?? 30 * 60 * 1000;
    const loopActiveTimeoutMs = p.streamIdleTimeoutMs ?? LOOP_DEFAULT_ACTIVE_TIMEOUT_MS;

    // Adapter selection priority for this iteration:
    //   1. The parent instance's existing adapter, when `p.chatId` resolves to
    //      a live instance. This is the path that makes loops "proper sessions":
    //      the CLI process is the instance's CLI, its session file on disk gets
    //      every turn, and the session survives restart through the normal
    //      session-continuity / history-restore machinery. The loop coordinator
    //      borrows the adapter — it does NOT own its lifecycle, so we explicitly
    //      skip the trackActiveAdapter / cleanupAdapter wiring below.
    //   2. A `same-session` persistent loop adapter — pre-fix legacy path for
    //      loops with no parent instance (chat-detail loops where the chat has
    //      no live runtime; pure-workspace loops). Owned by this listener.
    //   3. Fresh per-iteration adapter (the default fresh-child path inside
    //      invokeCliTextResponse).
    let reusedAdapter: unknown | undefined;
    let borrowedFromInstance = false;

    // Defensive `?.` access — tests pass a stub `instanceManager` without
    // these methods. Production InstanceManager always has them.
    const liveInstance = instanceManager.getInstance?.(p.chatId);
    const liveAdapter = liveInstance ? instanceManager.getAdapter?.(p.chatId) : undefined;
    // A borrowed live adapter is already running, so loop-control env cannot
    // be injected retroactively. Use a loop-owned adapter when control is on.
    if (!p.loopControlEnv && liveAdapter && isBaseCliAdapterLike(liveAdapter)) {
      reusedAdapter = liveAdapter;
      borrowedFromInstance = true;
    }

    const sameSession = p.config?.contextStrategy === 'same-session';
    // LF-4 RPI: a PLAN→IMPLEMENT context reset recycles the persistent adapter
    // first, so the IMPLEMENT iteration starts from a fresh session anchored on
    // the finalized plan (durable disk state) rather than the planning chatter.
    if (sameSession && p.forceContextReset && persistentLoopAdapters.has(p.loopRunId)) {
      await recyclePersistentLoopAdapter(p.loopRunId);
      emitActivity({ kind: 'status', message: 'Context reset for PLAN→IMPLEMENT (fresh session)' });
    }
    if (!reusedAdapter && sameSession) {
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
          timeoutMs: loopIterationTimeoutMs,
          streamIdleTimeoutMs: loopActiveTimeoutMs,
          env: p.loopControlEnv,
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
      const workspaceBefore = snapshotWorkspaceFiles(p.workspaceCwd);
      const result = await invokeCliTextResponse({
        instanceManager,
        // When borrowing the parent instance's adapter, pass the instance id so
        // invokeCliTextResponse can pick up workspace/provider defaults from it
        // rather than relying solely on the loop's workspaceCwd. The adapter
        // itself is already the one wired to the instance's outputBuffer, so
        // assistant stream events flow into the instance's transcript as a
        // normal turn would.
        instanceId: borrowedFromInstance ? p.chatId : undefined,
        // Spawn the CLI inside the loop's workspace, not Electron's CWD.
        // Without this the AI runs in `/` (or the app bundle path) and
        // can't see any of the user's project files.
        workingDirectory: p.workspaceCwd,
        requestedProvider: p.provider,
        payloadModel: p.model,
        // Opt this (Loop Mode) call into cost-tiered routing. Routing only
        // actually fires when the router is enabled and no explicit model was
        // requested; otherwise the strong default is used as before.
        routingIntent: 'loop',
        systemPrompt: undefined,
        prompt: p.prompt,
        breakerKey: `loop-orchestration:${p.provider}`,
        correlationId: p.correlationId,
        // Wall-clock checkpoint per iteration — generous by default so
        // legitimate long work (deep thinking, many tool calls, file edits)
        // isn't killed. If the child is still producing output near the
        // checkpoint, the adapter keeps waiting until it goes quiet past the
        // stream-idle threshold.
        timeoutMs: loopIterationTimeoutMs,
        streamIdleTimeoutMs: loopActiveTimeoutMs,
        yoloMode: true,
        allowPartialOnTimeout: true,
        continueWhileActiveOnTimeout: true,
        activeTimeoutMs: loopActiveTimeoutMs,
        autoAnswerInputRequired: true,
        env: p.loopControlEnv,
        reusedAdapter,
        activity: emitActivity,
        // Track + clean up adapters the loop owns. The instance's adapter is
        // borrowed (the instance owns its own lifecycle) so we skip both hooks
        // — otherwise the loop's terminal-state listener would terminate the
        // user's session CLI when the loop ends.
        onAdapterReady: borrowedFromInstance
          ? (adapter) => {
              activeAdapterRef = adapter;
              return () => { activeAdapterRef = null; };
            }
          : (adapter) => {
              activeAdapterRef = adapter;
              const stopTracking = trackActiveAdapter(p.loopRunId, adapter);
              return () => {
                activeAdapterRef = null;
                stopTracking();
              };
            },
        cleanupAdapter: borrowedFromInstance
          ? undefined
          : (adapter, graceful) => terminateTrackedAdapter(adapter, graceful),
      });
      if (sameSession && reusedAdapter) {
        enableAdapterResume(reusedAdapter);
      }

      const workspaceDelta = snapshotFileChangesViaWorkspace(workspaceBefore, p.workspaceCwd);
      const workspaceDeltaPaths = new Set(workspaceDelta.map((change) => change.path));
      const filesChanged = mergeFileChanges(
        workspaceDelta,
        snapshotFileChangesViaGit(p.workspaceCwd).filter((change) => workspaceDeltaPaths.has(change.path)),
      );
      // FU-5: derive structured signals from the actual iteration output.
      // testPassCount/testFailCount feeds the D / D-prime signals;
      // errors feeds the E signal; toolCalls (collected via the activity
      // stream above) feeds G.
      // Parse structured signals from the FULL response first (so test-count /
      // error detection never miss content elided by externalization below).
      const { pass: testPassCount, fail: testFailCount } = parseTestCounts(result.response);
      const errors: LoopErrorRecord[] = classifyIterationErrors(result.response);
      // LF-1: when `clearToolResults` is enabled, offload an oversized full
      // response to the output cache (retrievable) and keep a compact
      // head+tail preview as the retained output — bounds peak memory + what
      // the loop persists/re-surfaces on chatty iterations. Completion markers
      // (the agent appends <promise>DONE</promise> at the END) survive in the
      // preserved tail. Best-effort; never blocks the loop.
      const ctxCompaction = p.config?.context?.compaction ?? defaultLoopContextConfig().compaction;
      const retainedOutput = await maybeExternalizeLoopOutput(result.response, ctxCompaction.clearToolResults);
      const childResult: LoopChildResult = {
        childInstanceId: null,
        output: retainedOutput,
        tokens: result.tokens,
        filesChanged,
        toolCalls,
        errors,
        testPassCount,
        testFailCount,
        exitedCleanly: true,
      };

      // LF-1: context discipline for the loop's OWN persistent same-session
      // adapter. Borrowed instance adapters are skipped — the instance owns its
      // compaction lifecycle and must never be recycled here. Accumulate
      // same-session tokens; when utilization crosses the configured reset
      // threshold, recycle to a fresh session so the NEXT iteration starts
      // clean (durable disk state re-anchors it).
      if (sameSession && !borrowedFromInstance && persistentLoopAdapters.has(p.loopRunId)) {
        const ctxCfg = p.config?.context?.compaction ?? defaultLoopContextConfig().compaction;
        const cumulative = (loopContextTokens.get(p.loopRunId) ?? 0) + (result.tokens || 0);
        loopContextTokens.set(p.loopRunId, cumulative);
        const decision = shouldRecycleLoopContext({
          enabled: ctxCfg.enabled,
          cumulativeTokens: cumulative,
          resetAtUtilization: ctxCfg.resetAtUtilization,
        });
        if (decision.recycle) {
          await recyclePersistentLoopAdapter(p.loopRunId);
          childResult.contextCompacted = {
            previousUtilization: decision.utilization,
            newUtilization: 0,
            reason: decision.reason,
          };
          emitActivity({
            kind: 'status',
            message: `Context recycled to a fresh session (${decision.reason})`,
            detail: { previousUtilization: decision.utilization },
          });
        }
      }

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

function scheduleProviderLimitResume(params: {
  request: ProviderLimitResumeRequest;
  resumeLoop: (loopRunId: string) => boolean;
}): () => void {
  const { request, resumeLoop } = params;
  let automationId: string | null = null;
  let cancelled = false;

  void (async () => {
    const { createAutomationWithScheduling } = await import('../automations/automation-create-service');
    const automation = await createAutomationWithScheduling({
      name: `Resume loop after ${request.provider} quota reset`,
      description: `Auto-created provider-limit wake for loop ${request.loopRunId}.`,
      enabled: true,
      schedule: {
        type: 'oneTime',
        runAt: request.resumeAt + 5_000,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      },
      missedRunPolicy: 'runOnce',
      concurrencyPolicy: 'skip',
      destination: {
        kind: 'thread',
        instanceId: request.chatId,
        reviveIfArchived: true,
      },
      action: {
        workingDirectory: request.workspaceCwd,
        provider: request.provider,
        systemAction: {
          type: 'loopProviderLimitResume',
          loopRunId: request.loopRunId,
        },
        prompt: [
          `Provider quota window reset for loop ${request.loopRunId}.`,
          `Reason: ${request.reason}`,
          'AIO will try to resume the paused loop directly. If direct resume is unavailable, report the loop status and next action.',
        ].join('\n'),
      },
    });
    automationId = automation?.id ?? null;
    if (cancelled && automationId) {
      const { getAutomationStore } = await import('../automations');
      await getAutomationStore().delete(automationId);
    }
  })().catch((err) => {
    logger.warn('Failed to create durable provider-limit resume automation', {
      loopRunId: request.loopRunId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const delay = Math.max(0, request.resumeAt - Date.now()) + 5_000;
  const timer = setTimeout(() => {
    const resumed = resumeLoop(request.loopRunId);
    logger.info('Provider-limit local resume timer fired', {
      loopRunId: request.loopRunId,
      resumed,
    });
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();

  return () => {
    cancelled = true;
    clearTimeout(timer);
    if (!automationId) return;
    void import('../automations')
      .then(({ getAutomationStore }) => getAutomationStore().delete(automationId as string))
      .catch((err) => logger.warn('Failed to delete provider-limit resume automation', {
        loopRunId: request.loopRunId,
        automationId,
        error: err instanceof Error ? err.message : String(err),
      }));
  };
}
