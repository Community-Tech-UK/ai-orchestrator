/**
 * Default Orchestration Invokers
 *
 * Wires "extensibility points" (event-based invocation) to real CLI execution.
 * This replaces placeholder/stub behavior in MultiVerifyCoordinator by using our
 * in-repo CLI adapters directly (no dependency on sibling repos at runtime).
 */

import type { InstanceManager } from '../instance/instance-manager';
import type { DegradedReason } from '../cli/adapters/degraded-output-classifier';
import { getLogger } from '../logging/logger';
import { getMultiVerifyCoordinator } from './multi-verify-coordinator';
import { getReviewCoordinator } from '../agents/review-coordinator';
import { getDebateCoordinator } from './debate-coordinator';
import { getWorkflowManager } from '../workflows/workflow-manager';
import { resolveCliType, type CliAdapter, type UnifiedSpawnOptions } from '../cli/adapters/adapter-factory';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { readCodexAuthMode } from '../providers/codex-auth-mode';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import { getSettingsManager } from '../core/config/settings-manager';
import { recordCostAttribution } from '../core/system/cost-attribution';
import { getCircuitBreakerRegistry } from '../core/circuit-breaker';
import type { ProviderId, ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import { getModelRouter, resolveRoutedModel } from '../routing';
import {
  scheduleProviderLimitResume,
  type ProviderLimitResumeRequest,
} from './provider-limit-resume-scheduler';
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
import { buildLoopInvocationErrorPayload, logInvocationFailure } from './loop-invocation-error-payload';
import {
  resolveScaffoldingProvider,
  type ScaffoldingProviderChoice,
} from './scaffolding-local-provider';
import type { OrchestrationRoutingPolicyKey } from '../../shared/types/settings.types';
import { applyWrapUpToolsDisable } from './loop-tools-disable';

const logger = getLogger('DefaultInvokers');

type DebateInvocationSchema =
  | typeof DebateResponseInvocationPayloadSchema
  | typeof DebateCritiqueInvocationPayloadSchema
  | typeof DebateDefenseInvocationPayloadSchema
  | typeof DebateSynthesisInvocationPayloadSchema;

// Model resolution for this invoker path lives in invocation-model-resolver.ts
// (split out for the file-size ratchet). Re-exported so existing importers of
// resolveModelForInvocation / classifyCheapModelEligible / RoutingIntent keep
// resolving through this module.
export {
  classifyCheapModelEligible,
  resolveModelForInvocation,
  type RoutingIntent,
} from './invocation-model-resolver';
import {
  classifyCheapModelEligible,
  isExplicitModel,
  resolveModelForInvocation,
  shouldPreferScaffoldingProvider,
  type RoutingIntent,
} from './invocation-model-resolver';

function isBaseCliAdapterLike(adapter: CliAdapter): adapter is CliAdapter & { sendMessage: (m: CliMessage) => Promise<CliResponse> } {
  return typeof (adapter as { sendMessage?: unknown }).sendMessage === 'function';
}

const LOOP_DEFAULT_ACTIVE_TIMEOUT_MS = 5 * 60 * 1000;

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
   * Loop, workflow, and non-synthesis scaffolding gates set this; debate
   * synthesis passes 'synthesis' (balanced tier, no provider steering).
   * Consensus-merge leaves it unset so it keeps the strong default model.
   * Routing also requires the router to be enabled and `payloadModel` unset.
   */
  routingIntent?: RoutingIntent;
  /**
   * Which orchestration gate this is, for the operator routing policy
   * (`orchestrationRoutingPolicyJson`). Finer-grained than `routingIntent`:
   * verify/review/debate all share the `scaffolding` intent but are tuned
   * independently. Omit to keep the intent-based default tier.
   */
  routingPolicyKey?: OrchestrationRoutingPolicyKey;
  systemPrompt?: string;
  prompt: string;
  context?: string;
  breakerKey: string;
  correlationId: string;
  /** Optional override for the spawn wall-clock timeout in milliseconds.
   *  Acts as the outer safety net for the invocation. */
  timeoutMs?: number;
  /** Agentic-turn backstop for the spawned CLI run (`--max-turns`). Bounds
   *  runaway sessions within a single invocation; the wall-clock timeout and
   *  outer iteration caps do not bound turns. */
  maxTurns?: number;
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
  /** D2 (#6): deny tool use for this send (cap wrap-up). Enforced where the
   *  adapter supports it (claude); otherwise prompt-only fallback. */
  disableTools?: boolean;
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
}): Promise<ReturnType<typeof normalizeInvocationTextResult> & {
  costKnown: boolean;
  /** Resolved model, so cost-persisting callers can look up the per-model rate. */
  model?: string;
  /**
   * Full usage breakdown from the adapter. Callers that persist cost (Loop
   * Mode) need this: the scalar `tokens` cannot distinguish a cache read
   * (~10% of the input rate) from a cache write (full input rate).
   */
  usage?: LoopChildUsage;
  degradedReason?: DegradedReason;
  finishReason?: string;
}> {
  const instance = params.instanceId
    ? params.instanceManager.getInstance(params.instanceId)
    : undefined;
  const workingDirectory = params.workingDirectory || instance?.workingDirectory || process.cwd();
  const fallbackProvider = instance?.provider as string | undefined;
  let requestedProvider = params.requestedProvider ?? fallbackProvider ?? 'auto';
  const defaultCli = getSettingsManager().getAll().defaultCli;
  let scaffoldingChoice: ScaffoldingProviderChoice | undefined;
  if (shouldPreferScaffoldingProvider({
    routingIntent: params.routingIntent,
    explicitRequestedProvider: params.requestedProvider,
    payloadModel: params.payloadModel,
  })) {
    scaffoldingChoice = await resolveScaffoldingProvider(defaultCli, params.routingIntent);
    if (scaffoldingChoice) requestedProvider = scaffoldingChoice.provider;
  }
  // Ollama scaffolding bypasses binary detection: the adapter is REST-only and
  // the endpoint probe already proved availability. resolveCliType would fall
  // back to claude on machines without the (unneeded) ollama binary.
  const cliType = scaffoldingChoice?.provider === 'ollama'
    ? 'ollama'
    : await resolveCliType(requestedProvider as Parameters<typeof resolveCliType>[0], defaultCli);
  // The ollama scaffolding override is a concrete installed model — the tier
  // map has no ollama entries, so resolveModelForInvocation cannot produce one.
  let model = scaffoldingChoice?.model ?? resolveModelForInvocation({
    cliType,
    requestedProvider,
    payloadModel: params.payloadModel,
    prompt: params.prompt,
    routingIntent: params.routingIntent,
    routingPolicyKey: params.routingPolicyKey,
  });

  // routingClassification slot: when cost-tier routing applies (same guards as
  // resolveModelForInvocation), ask the aux LLM if the task is cheap-model
  // eligible and prefer the fast tier. Graceful no-op on any failure.
  const explicitlyRequested = isExplicitModel(params.payloadModel);
  const isCodexChatgpt =
    (cliType === 'codex' || requestedProvider === 'codex') && readCodexAuthMode() === 'chatgpt';
  if (
    params.routingIntent === 'loop' &&
    !explicitlyRequested &&
    !isCodexChatgpt &&
    getModelRouter().getConfig().enabled &&
    getSettingsManager().getAll().auxiliaryLlmRoutingClassificationEnabled &&
    (await classifyCheapModelEligible(params.prompt))
  ) {
    const providerHint =
      requestedProvider && requestedProvider !== 'auto' ? requestedProvider : cliType;
    const fastModel = resolveRoutedModel(params.prompt, {
      provider: providerHint,
      explicitModel: 'fast',
    }).model;
    if (fastModel && fastModel !== model) {
      logger.info('routingClassification: task is cheap-model eligible, preferring fast tier', {
        from: model,
        to: fastModel,
        provider: providerHint,
      });
      model = fastModel;
    }
  }

  const spawnOptions: UnifiedSpawnOptions = {
    workingDirectory,
    model,
    systemPrompt: params.systemPrompt,
    yoloMode: params.yoloMode ?? false,
    permissionHookPath: params.permissionHookPath,
    env: params.env,
    rtk: params.rtk,
    timeout: params.timeoutMs ?? 300000,
    maxTurns: params.maxTurns,
    ...(scaffoldingChoice?.endpoint ? { ollamaEndpoint: scaffoldingChoice.endpoint } : {}),
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
    // D2 (#6): adapter-enforced tools-disable for the cap wrap-up send; reused
    // adapters get the override cleared in `finally`. Providers without a
    // mechanism fall back to the prompt-only wrap-up directive (per-provider
    // matrix in loop-tools-disable.ts).
    const toolsDisable = params.disableTools ? applyWrapUpToolsDisable(adapter) : null;
    if (params.disableTools && !toolsDisable?.applied) {
      logger.info('disableTools requested but adapter has no tools-disable mechanism; prompt-only wrap-up', { cliType });
    }
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
      toolsDisable?.restore();
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

  const reportedCost = typeof response.usage?.cost === 'number' && Number.isFinite(response.usage.cost)
    ? Math.max(0, response.usage.cost)
    : null;
  const normalized = normalizeInvocationTextResult({
    response: response.content,
    tokens: response.usage?.totalTokens ?? 0,
    cost: reportedCost ?? 0,
  });

  logger.info('Orchestration invocation completed', {
    correlationId: params.correlationId,
    cliType,
    breakerKey: params.breakerKey,
    model,
    tokens: normalized.tokens,
    cost: normalized.cost,
    ...(response.degradedReason ? { degradedReason: response.degradedReason } : {}),
  });

  // Fan-out audit attribution: on by default, opt-out via
  // AIO_COST_ATTRIBUTION=0. The breaker key doubles as the task-type tag.
  recordCostAttribution({
    source: 'one-shot',
    taskType: params.breakerKey,
    correlationId: params.correlationId,
    instanceId: params.instanceId,
    provider: cliType,
    model,
    usage: { ...response.usage, totalTokens: response.usage?.totalTokens ?? normalized.tokens },
    costKnown: reportedCost !== null,
  });

  const finishReason = extractFinishReasonFromResponse(response);
  return {
    ...normalized,
    costKnown: reportedCost !== null,
    // Surface the full usage breakdown and the resolved model. Callers that
    // persist cost (Loop Mode) need these to price an iteration correctly:
    // `tokens` is a single scalar and cannot distinguish a cache read (~10% of
    // the input rate) from a cache write (full input rate).
    model,
    usage: {
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      cacheReadTokens: response.usage?.cacheReadTokens,
      cacheWriteTokens: response.usage?.cacheWriteTokens,
      reasoningTokens: response.usage?.reasoningTokens,
    },
    ...(response.degradedReason ? { degradedReason: response.degradedReason } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
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
        routingPolicyKey: 'verify',
        correlationId: parsed.correlationId,
        routingIntent: 'scaffolding',
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
        routingPolicyKey: 'review',
        correlationId: parsed.correlationId,
        routingIntent: 'scaffolding',
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
          // Synthesis is tuned separately: the claude-fanout audit measured it
          // on the powerful tier as 38.3% of that run's spend — the single most
          // expensive call. The other debate turns share the `debate` key.
          routingPolicyKey:
            eventName === 'debate:generate-synthesis' ? 'debateSynthesis' : 'debate',
          correlationId: parsed.correlationId,
          routingIntent: eventName === 'debate:generate-synthesis' ? 'synthesis' : 'scaffolding',
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
        routingPolicyKey: 'workflow',
        correlationId: parsed.correlationId,
        routingIntent: 'workflow',
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

import {
  branchSelectErr,
  runVerifyInDir,
  commitWorktreeChanges,
  canBorrowParentLoopAdapter,
  liveAdapterMatchesRequestedModel,
  scoreCandidatesListwise,
} from './loop-branch-selector-helpers';
import * as pathLoop from 'path';
import { getLoopCoordinator } from './loop-coordinator';
import { getProviderQuotaService } from '../core/system/provider-quota-service';
import { registerLoopSafetyAdvisor } from './loop-safety-advisor';
import type { LoopChildInvocationError, LoopChildResult, LoopChildUsage } from './loop-coordinator';
import type { LoopErrorRecord, LoopProvider } from '../../shared/types/loop.types';
import { defaultLoopContextConfig, LOOP_DEFAULT_MAX_TURNS_PER_ITERATION } from '../../shared/types/loop.types';
import { shouldRecycleLoopContext } from './loop-context-discipline';
import { attachInvocationActivity, type LoopInvocationActivity, type LoopInvocationActivityKind } from './loop-invocation-activity';
import {
  createLoopInvocationCapture,
  createToolTimeoutWatchdogWidener,
  extractFinishReasonFromResponse,
} from './loop-invoker-capture';
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
import { buildBranchCandidatePrompt } from './loop-branch-task-prompt';
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
            prompt: buildBranchCandidatePrompt({
              goal: input.goal,
              candidateIndex: i,
              candidateCount: input.exploration.fanout,
              verifyCommand: input.verifyCommand,
              taskPacket: input.taskPackets?.[i],
            }),
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
 * Tool calls, result hashes, read paths, and finish metadata are captured from
 * adapter activity while the turn is live; they cannot be reconstructed later
 * from the sealed assistant text.
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
  const persistentLoopAdapterModels = new Map<string, string | undefined>();
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
    persistentLoopAdapterModels.delete(loopRunId);
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
    || status === 'failed' || status === 'error' || status === 'no-progress'
    // Ping-pong terminal states (bigchange_pingpong_review §4.11).
    || status === 'cost-exceeded' || status === 'needs-human-arbitration'
    || status === 'reviewer-unreliable' || status === 'reviewer-unavailable'
    || status === 'builder-unreliable';
  const isTerminalLoopState = (state: { status?: string; endedAt?: unknown } | undefined): boolean => {
    if (!state?.status) return false;
    if (state.status === 'provider-limit') return state.endedAt != null;
    return isTerminalLoopStatus(state.status);
  };

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
    persistentLoopAdapterModels.delete(loopRunId);
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
    const payload = data as { loopRunId: string; state?: { status?: string; chatId?: string; endedAt?: unknown } };
    if (!isTerminalLoopState(payload?.state)) return;
    // Clear quota-park waitReason when the loop terminates.
    const chatId = payload?.state?.chatId;
    if (chatId) {
      instanceManager.queueInstanceUpdate(chatId, { waitReason: null });
    }
    void cleanupLoopAdapters(payload.loopRunId);
  });

  // D7: Surface quota-park as a machine-readable waitReason on the chat instance
  // so the renderer can show "Provider limit — resumes in Xm" with a countdown.
  coordinator.on('loop:provider-limit', (data: unknown) => {
    const ev = data as { loopRunId?: string; resumeAt: number | null; willResume?: boolean };
    if (!ev?.loopRunId) return;
    // getLoop() returns the live LoopState; it's the only way to resolve chatId from loopRunId here.
    const loopState = (coordinator as { getLoop?: (id: string) => { chatId?: string; config?: { provider?: string } } | undefined }).getLoop?.(ev.loopRunId);
    const chatId = loopState?.chatId;
    const provider = loopState?.config?.provider ?? 'unknown';
    if (!chatId) return;
    if (ev.willResume && typeof ev.resumeAt === 'number') {
      instanceManager.queueInstanceUpdate(chatId, {
        waitReason: { kind: 'quota-park', provider, resumeAt: ev.resumeAt },
      });
    } else {
      // Not resuming (terminated) — clear the waitReason.
      instanceManager.queueInstanceUpdate(chatId, { waitReason: null });
    }
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

  const setQuotaSnapshotRefresher = (coordinator as {
    setQuotaSnapshotRefresher?: (fn: (provider: ProviderId) => Promise<ProviderQuotaSnapshot | null>) => void;
  }).setQuotaSnapshotRefresher;
  if (typeof setQuotaSnapshotRefresher === 'function') {
    setQuotaSnapshotRefresher.call(coordinator, (provider) =>
      getProviderQuotaService().refresh(provider),
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
      /** P2: per-session worktree path; falls back to workspaceCwd when absent. */
      executionCwd?: string;
      stage: string;
      seq: number;
      prompt: string;
      config: {
        contextStrategy?: string;
        // LF-1 context-discipline block (optional; defaults applied below).
        context?: { compaction?: { enabled: boolean; resetAtUtilization: number; clearToolResults: boolean } };
        // LF-5 branch-and-select enables B7's delegated retrieval hint for offloaded output.
        exploration?: { enabled?: boolean };
        phase4?: { toolRwLocks?: { enabled?: boolean } };
        // Agentic-turn backstop per iteration; null disables, undefined → default.
        maxTurnsPerIteration?: number | null;
      };
      callback: (result: LoopChildResult | LoopChildInvocationError) => void;
      // Forwarded from LoopConfig — overrides the invoker's defaults.
      iterationTimeoutMs?: number;
      streamIdleTimeoutMs?: number;
      /** B6: provider/model context window learned from an overflow response. */
      contextWindowTokens?: number;
      loopControlEnv?: Record<string, string>;
      // LF-4 RPI: recycle the same-session adapter before this iteration runs.
      forceContextReset?: boolean;
      /** D2 (#6): cap wrap-up runs this iteration with tools disabled (optional; default off). */
      disableTools?: boolean;
    }
    const p = payload as Payload;
    if (!p?.callback || typeof p.callback !== 'function') {
      logger.warn('loop:invoke-iteration payload missing callback');
      return;
    }
    const workspaceDir = p.executionCwd ?? p.workspaceCwd;
    const capture = createLoopInvocationCapture({
      workspaceDir,
      rwLocksEnabled: p.config?.phase4?.toolRwLocks?.enabled === true,
    });
    const loopIterationTimeoutMs = p.iterationTimeoutMs ?? 30 * 60 * 1000;
    const loopActiveTimeoutMs = p.streamIdleTimeoutMs ?? LOOP_DEFAULT_ACTIVE_TIMEOUT_MS;
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
      'tool_result',
      'assistant',
      'input_required',
      'heartbeat',
      'complete',
    ]);
    const nudgeAdapterIdle = (): void => {
      const a = activeAdapterRef as { noteActivity?: () => void } | null;
      if (a && typeof a.noteActivity === 'function') a.noteActivity();
    };
    // E2 (#12): widen the adapter's stream-idle kill threshold to cover an
    // in-flight tool call's own declared timeout (e.g. a 20-minute Bash
    // build), reverting once that call settles. Composes with host-load
    // scaling — setStreamIdleTimeoutMs only changes the base the adapter
    // later multiplies by SystemLoadMonitor's multiplier.
    const toolTimeoutWidener = createToolTimeoutWatchdogWidener({
      baseTimeoutMs: loopActiveTimeoutMs,
      applyTimeoutMs: (timeoutMs) => {
        const setter = (activeAdapterRef as { setStreamIdleTimeoutMs?: (ms: number) => void } | null)
          ?.setStreamIdleTimeoutMs;
        if (typeof setter === 'function') setter.call(activeAdapterRef, timeoutMs);
      },
    });
    const emitActivity = (activity: LoopInvocationActivity) => {
      if (meaningfulKinds.has(activity.kind)) nudgeAdapterIdle();
      if (activity.kind === 'tool_use') toolTimeoutWidener.onToolUse(activity);
      else if (activity.kind === 'tool_result') toolTimeoutWidener.onToolResult(activity);
      else if (activity.kind === 'complete' || activity.kind === 'error') toolTimeoutWidener.onIterationSettled();
      capture.recordActivity(activity);
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
      message: `Iteration ${p.seq} starting in ${p.executionCwd ?? p.workspaceCwd}`,
      detail: { provider: p.provider, contextStrategy: p.config?.contextStrategy ?? 'same-session' },
    });
    // Agentic-turn backstop: `null` disables, `undefined` falls back to the
    // default. Bounds runaway single iterations (observed: one iteration at
    // 7.24M tokens) that the wall-clock/iteration caps cannot catch.
    const loopMaxTurns = p.config?.maxTurnsPerIteration === null
      ? undefined
      : p.config?.maxTurnsPerIteration ?? LOOP_DEFAULT_MAX_TURNS_PER_ITERATION;

    // Adapter selection priority for this iteration:
    //   1. The parent instance's existing adapter, only for providers whose
    //      session model is safe to borrow. This preserves Claude's "continue
    //      this chat" behavior while avoiding Codex inheriting a stale external
    //      rollout/thread id from the visible chat.
    //   2. A `same-session` persistent loop adapter — pre-fix legacy path for
    //      loops with no parent instance (chat-detail loops where the chat has
    //      no live runtime; pure-workspace loops). Owned by this listener.
    //   3. Fresh per-iteration adapter (the explicit fresh-child path inside
    //      invokeCliTextResponse).
    let reusedAdapter: unknown | undefined;
    let borrowedFromInstance = false;
    const contextStrategy = p.config?.contextStrategy ?? 'same-session';
    const sameSession = contextStrategy === 'same-session';

    // Defensive `?.` access — tests pass a stub `instanceManager` without
    // these methods. Production InstanceManager always has them.
    const liveInstance = instanceManager.getInstance?.(p.chatId);
    const liveAdapter = liveInstance ? instanceManager.getAdapter?.(p.chatId) : undefined;
    // Borrow same-session loops into the chat's live adapter; skip worktree isolation.
    if (
      sameSession &&
      !(p.executionCwd && p.executionCwd !== p.workspaceCwd) &&
      liveAdapter &&
      canBorrowParentLoopAdapter(p.provider, liveInstance?.provider) &&
      liveAdapterMatchesRequestedModel(liveInstance?.currentModel, p.model) &&
      isBaseCliAdapterLike(liveAdapter)
    ) {
      reusedAdapter = liveAdapter;
      borrowedFromInstance = true;
    }

    // LF-4 RPI: a PLAN→IMPLEMENT context reset recycles the persistent adapter
    // first, so the IMPLEMENT iteration starts from a fresh session anchored on
    // the finalized plan (durable disk state) rather than the planning chatter.
    // Also used by degraded-iteration retries. Tracked so B5a rehydration can
    // fire via `childResult.contextCompacted` after the iteration seals.
    let oneShotContextReset = false;
    if (sameSession && p.forceContextReset && persistentLoopAdapters.has(p.loopRunId)) {
      await recyclePersistentLoopAdapter(p.loopRunId);
      oneShotContextReset = true;
      emitActivity({ kind: 'status', message: 'Context reset for PLAN→IMPLEMENT (fresh session)' });
    }
    if (!reusedAdapter && sameSession) {
      const persistentCliType = await resolveCliType(
        p.provider as Parameters<typeof resolveCliType>[0],
        getSettingsManager().getAll().defaultCli,
      );
      const persistentModel = resolveModelForInvocation({
        cliType: persistentCliType,
        requestedProvider: p.provider,
        payloadModel: p.model,
        prompt: p.prompt,
        routingIntent: 'loop',
        // Must match the fresh-child path below, or a same-session loop would
        // resolve a different model than an otherwise-identical fresh-child one.
        routingPolicyKey: 'loop',
      });
      const existing = persistentLoopAdapters.get(p.loopRunId);
      if (existing) {
        const existingModelKnown = persistentLoopAdapterModels.has(p.loopRunId);
        const existingModel = persistentLoopAdapterModels.get(p.loopRunId);
        if (!existingModelKnown || existingModel !== persistentModel) {
          await recyclePersistentLoopAdapter(p.loopRunId);
          oneShotContextReset = true;
          emitActivity({
            kind: 'status',
            message: `Context reset for model switch (${existingModel ?? 'default'} → ${persistentModel ?? 'default'})`,
            detail: { previousModel: existingModel, nextModel: persistentModel },
          });
        } else {
          reusedAdapter = existing;
        }
      }
      if (!reusedAdapter) {
        // The first iteration creates the adapter. We let invokeCliTextResponse
        // do that the normal way, then capture the resulting adapter ref via
        // the breaker by routing through a small helper. Simpler approach:
        // create here directly, then pass it in for subsequent iters too.
        // Resolve the model through the SAME loop routing as fresh-child
        // iterations — previously this path hard-coded the house default
        // (Opus-1M), silently bypassing cost-tier routing for every
        // same-session loop.
        reusedAdapter = await createPersistentLoopAdapter({
          provider: p.provider,
          model: persistentModel,
          workingDirectory: p.executionCwd ?? p.workspaceCwd,
          timeoutMs: loopIterationTimeoutMs,
          streamIdleTimeoutMs: loopActiveTimeoutMs,
          maxTurns: loopMaxTurns,
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
          persistentLoopAdapterModels.set(p.loopRunId, persistentModel);
        }
      }
    }

    try {
      // When isolation is active, snapshot the worktree (executionCwd), not the
      // repo root — the agent edits the worktree and the diff must reflect that.
      const workspaceBefore = snapshotWorkspaceFiles(workspaceDir);
      const result = await invokeCliTextResponse({
        instanceManager,
        // When borrowing the parent instance's adapter, pass the instance id so
        // invokeCliTextResponse can pick up workspace/provider defaults from it
        // rather than relying solely on the loop's workspaceCwd. The adapter
        // itself is already the one wired to the instance's outputBuffer, so
        // assistant stream events flow into the instance's transcript as a
        // normal turn would.
        instanceId: borrowedFromInstance ? p.chatId : undefined,
        // Spawn the CLI inside the loop's execution directory. When worktree
        // isolation is active, executionCwd is the per-session worktree path;
        // otherwise it falls back to workspaceCwd (the repo root).
        workingDirectory: p.executionCwd ?? p.workspaceCwd,
        requestedProvider: p.provider,
        payloadModel: p.model,
        // Opt this (Loop Mode) call into cost-tiered routing. Routing only
        // actually fires when the router is enabled and no explicit model was
        // requested; otherwise the strong default is used as before.
        routingIntent: 'loop',
        routingPolicyKey: 'loop',
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
        maxTurns: loopMaxTurns,
        yoloMode: true,
        allowPartialOnTimeout: true,
        continueWhileActiveOnTimeout: true,
        activeTimeoutMs: loopActiveTimeoutMs,
        autoAnswerInputRequired: true,
        disableTools: p.disableTools === true,
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

      const workspaceDelta = snapshotFileChangesViaWorkspace(workspaceBefore, workspaceDir);
      const workspaceDeltaPaths = new Set(workspaceDelta.map((change) => change.path));
      const filesChanged = mergeFileChanges(
        workspaceDelta,
        snapshotFileChangesViaGit(workspaceDir).filter((change) => workspaceDeltaPaths.has(change.path)),
      );
      // FU-5: derive structured signals from the actual iteration output.
      // testPassCount/testFailCount feeds the D / D-prime signals;
      // errors feeds the E signal; toolCalls (collected via the activity
      // stream above) feeds G.
      // Parse structured signals from the FULL response first (so test-count /
      // error detection never miss content elided by externalization below).
      const { pass: testPassCount, fail: testFailCount } = parseTestCounts(result.response);
      const captureSnapshot = capture.finalize({ finishReason: result.finishReason });
      const toolRwLockConflicts = captureSnapshot.toolRwLockConflicts;
      const errors: LoopErrorRecord[] = [
        ...classifyIterationErrors(result.response),
        ...toolRwLockConflicts,
      ];
      // LF-1: when `clearToolResults` is enabled, offload an oversized full
      // response to the output cache (retrievable) and keep a compact
      // head+tail preview as the retained output — bounds peak memory + what
      // the loop persists/re-surfaces on chatty iterations. Completion markers
      // (the agent appends <promise>DONE</promise> at the END) survive in the
      // preserved tail. Best-effort; never blocks the loop.
      const ctxCompaction = p.config?.context?.compaction ?? defaultLoopContextConfig().compaction;
      const externalizeOptions = p.config?.exploration?.enabled === true
        ? { delegateInspectionHint: true }
        : undefined;
      const retainedOutput = await maybeExternalizeLoopOutput(
        result.response,
        ctxCompaction.clearToolResults,
        externalizeOptions,
      );
      const outputWithSafetyFailure = toolRwLockConflicts.length > 0
        ? [
            retainedOutput,
            '',
            '[phase4.toolRwLocks] Safety violation: overlapping write tool calls were observed. ' +
              'This iteration is failed closed to prevent silently accepting concurrent writes.',
          ].join('\n').trim()
        : retainedOutput;
      const childResult: LoopChildResult = {
        childInstanceId: null,
        output: outputWithSafetyFailure,
        tokens: result.tokens,
        ...(result.costKnown ? { costUsd: result.cost } : {}),
        // Carry the usage breakdown + model so the coordinator can price this
        // iteration with computeTokenCost when the provider reports no cost,
        // instead of the old flat $15/Mtok estimate over a cache-inclusive
        // token total.
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.model ? { model: result.model } : {}),
        filesChanged,
        filesRead: captureSnapshot.filesRead,
        toolCalls: captureSnapshot.toolCalls,
        errors,
        testPassCount,
        testFailCount,
        ...(captureSnapshot.finishReason ? { finishReason: captureSnapshot.finishReason } : {}),
        unresolvedToolCalls: captureSnapshot.unresolvedToolCalls,
        exitedCleanly: toolRwLockConflicts.length === 0,
        ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
        // When the chat's live adapter is borrowed, the iteration's assistant
        // stream already flowed into the instance transcript as a normal turn,
        // so the iteration→ledger write must skip it to avoid a duplicate. The
        // forked-session path (fresh / persistent / non-borrowable provider)
        // produces no transcript turn and is written into the canonical thread.
        transcriptBound: borrowedFromInstance,
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
        // Prefer the adapter's REAL context occupancy (last per-API-call usage,
        // including cache tokens) over the cumulative-token heuristic. The
        // cumulative metric sums generation tokens across every turn against a
        // synthetic 200k window, so it recycles long before the actual context
        // fills — and a single multi-turn iteration can report thousands of
        // percent. Adapters without per-call usage fall back to the heuristic.
        const occupancySource = persistentLoopAdapters.get(p.loopRunId) as
          | { getLastContextUsage?: () => { used: number; total: number } | null }
          | undefined;
        const occupancy = occupancySource?.getLastContextUsage?.() ?? null;
        const decision = shouldRecycleLoopContext({
          enabled: ctxCfg.enabled,
          cumulativeTokens: cumulative,
          resetAtUtilization: ctxCfg.resetAtUtilization,
          ...(typeof p.contextWindowTokens === 'number'
            && Number.isFinite(p.contextWindowTokens)
            && p.contextWindowTokens > 0
            ? { windowTokens: p.contextWindowTokens }
            : {}),
          ...(occupancy && occupancy.used > 0 && occupancy.total > 0
            ? { occupancyTokens: occupancy.used, occupancyWindowTokens: occupancy.total }
            : {}),
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

      // B5a: one-shot resets (PLAN→IMPLEMENT, degraded retry) recycle at the
      // start of the iteration but do not cross the LF-1 utilization threshold.
      // Mark contextCompacted so the survival manager re-injects plan/ledger/files.
      if (oneShotContextReset && !childResult.contextCompacted) {
        childResult.contextCompacted = {
          previousUtilization: 0,
          newUtilization: 0,
          reason: 'one-shot context reset (fresh session)',
        };
      }

      // D6: If borrowing the parent instance and it was interrupted mid-iteration
      // by the user (not a normal completion), pause the loop rather than treating
      // the incomplete output as a degraded iteration and retrying.
      if (borrowedFromInstance) {
        const chatInstance = instanceManager.getInstance(p.chatId);
        const chatStatus = chatInstance?.status;
        const wasInterrupted = chatStatus === 'idle' && chatInstance?.lastTurnOutcome === 'interrupted';
        const isInterrupting = chatStatus === 'interrupting' || chatStatus === 'interrupt-escalating';
        if (wasInterrupted || isInterrupting) {
          logger.info('Loop iteration completed via user interrupt on parent instance — pausing loop', {
            loopRunId: p.loopRunId,
            chatId: p.chatId,
            chatStatus,
          });
          // Signal the loop coordinator that this was a user-requested pause, not
          // a degraded iteration. Calling cancelLoop pauses it cleanly.
          const pauseLoop = (coordinator as { pauseLoop?: (id: string) => boolean }).pauseLoop;
          if (typeof pauseLoop === 'function') {
            pauseLoop.call(coordinator, p.loopRunId);
          }
          p.callback({ error: 'instance-interrupted' });
          return;
        }
      }
      p.callback(childResult);
    } catch (err) {
      const failure = buildLoopInvocationErrorPayload({
        correlationId: p.correlationId,
        invocation: 'Loop iteration invocation',
        error: err,
        provider: p.provider,
        model: p.model,
      });
      p.callback(failure);
    }
  });
}
