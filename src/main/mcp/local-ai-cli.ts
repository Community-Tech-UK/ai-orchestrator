import { ZodError, type ZodType } from 'zod';
import type { LocalAiProbeResult, LocalAiTargetConfig } from '../../shared/types/local-ai-guard.types';
import { LocalAiTargetPatchSchema } from '../../shared/validation/local-ai-guard.schemas';
import {
  LOCAL_AI_CLI_METHODS,
  LocalAiCliConfigPayloadSchema,
  LocalAiCliDiscoveryResultSchema,
  LocalAiCliEnrolPayloadSchema,
  LocalAiCliEnrolResultSchema,
  LocalAiCliAcknowledgeResultSchema,
  LocalAiCliRecheckResultSchema,
  LocalAiCliSetLifecyclePayloadSchema,
  LocalAiCliSetLifecycleResultSchema,
  LocalAiCliStatusResultSchema,
  LocalAiCliSummaryResultSchema,
  LocalAiCliTargetListResultSchema,
  LocalAiCliTargetResultSchema,
  LocalAiCliValidationResultSchema,
} from './local-ai-cli-contracts';
import {
  OrchestratorToolsRpcClient,
  type OrchestratorToolsRpcClientLike,
} from './orchestrator-tools-rpc-client';

export interface LocalAiCliDeps {
  client?: OrchestratorToolsRpcClientLike;
  createClient?: (timeoutMs: number) => OrchestratorToolsRpcClientLike;
  stdout?: (text: string) => void;
}

interface ParsedArgs {
  json: boolean;
  config?: LocalAiTargetConfig;
}

const LOCAL_AI_CLI_READ_TIMEOUT_MS = 120_000;
const LOCAL_AI_HEALTH_RPC_TRANSPORT_MARGIN_MS = 1_000;
const LOCAL_AI_CLI_COMPLETION_MARGIN_MS = 10_000;

export async function runLocalAiCli(
  argv: readonly string[],
  deps: LocalAiCliDeps = {},
): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    stdout(formatLocalAiHelp());
    return;
  }

  switch (command) {
    case 'discover': {
      const parsed = parseArgs(argv.slice(1), false);
      const client = clientFor(deps, LOCAL_AI_CLI_READ_TIMEOUT_MS);
      const result = parseResult(
        LocalAiCliDiscoveryResultSchema,
        await client.call(LOCAL_AI_CLI_METHODS.discover, {}),
        'discovery',
      );
      stdout(parsed.json
        ? formatJson(result)
        : formatDiscovery(result));
      return;
    }
    case 'list': {
      const parsed = parseArgs(argv.slice(1), false);
      const client = clientFor(deps, LOCAL_AI_CLI_READ_TIMEOUT_MS);
      const result = parseResult(
        LocalAiCliTargetListResultSchema,
        await client.call(LOCAL_AI_CLI_METHODS.list, {}),
        'target list',
      );
      stdout(parsed.json ? formatJson(result) : formatTargets(result));
      return;
    }
    case 'validate': {
      const parsed = parseArgs(argv.slice(1), true);
      const client = clientFor(deps, probeRpcTimeoutMs(parsed.config!, 'functional'));
      const result = parseResult(
        LocalAiCliValidationResultSchema,
        await client.call(LOCAL_AI_CLI_METHODS.validate, { config: parsed.config }),
        'validation',
      );
      stdout(parsed.json ? formatJson(result) : formatValidation(result));
      return;
    }
    case 'enrol': {
      const parsed = parseArgs(argv.slice(1), true, true);
      const client = clientFor(deps, probeRpcTimeoutMs(parsed.config!, 'functional'));
      const result = parseResult(
        LocalAiCliEnrolResultSchema,
        await client.call(LOCAL_AI_CLI_METHODS.enrol, { config: parsed.config }),
        'enrolment',
      );
      stdout(parsed.json
        ? formatJson(result)
        : `Enrolled ${result.target.label} (${result.target.id}).\n${formatValidation(result.validation)}`);
      return;
    }
    case 'set-lifecycle': {
      const parsed = parseLifecycleArgs(argv.slice(1));
      const client = clientFor(deps, LOCAL_AI_CLI_READ_TIMEOUT_MS);
      const result = parseResult(
        LocalAiCliSetLifecycleResultSchema,
        await client.call(LOCAL_AI_CLI_METHODS.setLifecycle, parsed.payload),
        'lifecycle',
      );
      stdout(parsed.json
        ? formatJson(result)
        : `${result.label} (${result.id}) is now ${result.lifecycle}.\n`);
      return;
    }
    case 'status': {
      const parsed = parseArgs(argv.slice(1), false);
      const result = parseResult(
        LocalAiCliStatusResultSchema,
        await clientFor(deps, LOCAL_AI_CLI_READ_TIMEOUT_MS).call(LOCAL_AI_CLI_METHODS.status, {}),
        'status',
      );
      stdout(parsed.json ? formatJson(result) : formatStatus(result, Date.now()));
      return;
    }
    case 'recheck': {
      const { json, positional, options } = parseOptions(argv.slice(1), ['--kind']);
      const [targetId] = requirePositional(positional, 1, 'local-ai recheck requires <target-id>');
      const kind = options.get('--kind') ?? 'lightweight';
      if (kind !== 'lightweight' && kind !== 'functional') {
        throw new Error('--kind must be lightweight or functional');
      }
      // Size the wait from the target's own probe settings, as the parent does.
      const targets = parseResult(
        LocalAiCliTargetListResultSchema,
        await clientFor(deps, LOCAL_AI_CLI_READ_TIMEOUT_MS).call(LOCAL_AI_CLI_METHODS.list, {}),
        'target list',
      );
      const target = targets.find((item) => item.id === targetId);
      if (!target) throw new Error(`Local AI target not found: ${targetId}`);
      let raw: unknown;
      try {
        raw = await clientFor(deps, probeRpcTimeoutMs(target, kind))
          .call(LOCAL_AI_CLI_METHODS.recheck, { targetId, kind });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/timed out/i.test(message)) throw error;
        throw new Error(`${message}. The check may still be running in Harness (a functional check `
          + 'waits for a busy target); run `aio-mcp local-ai status` to see its result.');
      }
      const result = parseResult(LocalAiCliRecheckResultSchema, raw, 'recheck');
      stdout(json ? formatJson(result) : formatTargetStatus(result, Date.now()));
      return;
    }
    case 'rename': {
      const { json, positional } = parseOptions(argv.slice(1), []);
      const [targetId, label] = requirePositional(positional, 2, 'local-ai rename requires <target-id> <label>');
      const result = parseResult(
        LocalAiCliTargetResultSchema,
        await clientFor(deps, LOCAL_AI_CLI_READ_TIMEOUT_MS)
          .call(LOCAL_AI_CLI_METHODS.rename, { targetId, label: label.trim() }),
        'rename',
      );
      stdout(json ? formatJson(result) : `${result.id} is now labelled "${result.label}".\n`);
      return;
    }
    case 'update': {
      const { json, positional } = parseOptions(argv.slice(1), []);
      const [targetId, rawPatch] = requirePositional(positional, 2, 'local-ai update requires <target-id> <patch-json>');
      const patch = parsePatch(rawPatch);
      const result = parseResult(
        LocalAiCliTargetResultSchema,
        await clientFor(deps, LOCAL_AI_CLI_READ_TIMEOUT_MS)
          .call(LOCAL_AI_CLI_METHODS.update, { targetId, patch }),
        'update',
      );
      stdout(json ? formatJson(result) : `Updated ${result.label} (${result.id}).\n`);
      return;
    }
    case 'summary': {
      const { json, positional, options } = parseOptions(argv.slice(1), ['--window']);
      requirePositional(positional, 0, 'local-ai summary takes no positional arguments');
      const window = options.get('--window') ?? '24h';
      if (window !== '24h' && window !== '7d' && window !== '30d') {
        throw new Error('--window must be 24h, 7d or 30d');
      }
      const result = parseResult(
        LocalAiCliSummaryResultSchema,
        await clientFor(deps, LOCAL_AI_CLI_READ_TIMEOUT_MS).call(LOCAL_AI_CLI_METHODS.summary, { window }),
        'summary',
      );
      stdout(json ? formatJson(result) : formatSummary(result));
      return;
    }
    case 'acknowledge': {
      const { json, positional } = parseOptions(argv.slice(1), []);
      const [incidentId] = requirePositional(positional, 1, 'local-ai acknowledge requires <incident-id>');
      const result = parseResult(
        LocalAiCliAcknowledgeResultSchema,
        await clientFor(deps, LOCAL_AI_CLI_READ_TIMEOUT_MS)
          .call(LOCAL_AI_CLI_METHODS.acknowledge, { incidentId }),
        'incident',
      );
      stdout(json ? formatJson(result) : `Incident ${result.id} is now ${result.state}.\n`);
      return;
    }
    default:
      throw new Error(`Unknown local-ai command: ${command}`);
  }
}

function clientFor(
  deps: LocalAiCliDeps,
  timeoutMs: number,
): OrchestratorToolsRpcClientLike {
  return deps.client
    ?? deps.createClient?.(timeoutMs)
    ?? new OrchestratorToolsRpcClient({ timeoutMs });
}

/**
 * RPC wait for one health check, mirroring the parent's `healthRpcBudget`: every
 * request in the worker's sequence may take up to the target's canary timeout.
 */
function probeRpcTimeoutMs(
  config: Pick<LocalAiTargetConfig, 'provider' | 'expectedModels' | 'canary'>,
  kind: 'lightweight' | 'functional',
): number {
  const metadataRequests = config.provider === 'ollama' ? 2 : 1;
  const contextRequests = config.expectedModels.some(
    (model) => model.minContextLength !== undefined,
  )
    ? 1
    : 0;
  // An Ollama canary first reads /api/ps so it can reuse the resident num_ctx.
  const inferenceRequests = kind === 'lightweight' ? 0 : config.provider === 'ollama' ? 2 : 1;
  return (
    (metadataRequests + contextRequests + inferenceRequests) * config.canary.timeoutMs
    + LOCAL_AI_HEALTH_RPC_TRANSPORT_MARGIN_MS
    + LOCAL_AI_CLI_COMPLETION_MARGIN_MS
  );
}

function parseArgs(
  argv: readonly string[],
  requiresConfig: boolean,
  enrolOnly = false,
): ParsedArgs {
  let json = false;
  let rawConfig: string | undefined;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('Use `aio-mcp local-ai --help` for Local AI command help');
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown local-ai option: ${arg}`);
    } else if (rawConfig === undefined) {
      rawConfig = arg;
    } else {
      throw new Error(`Unexpected local-ai argument: ${arg}`);
    }
  }
  if (!requiresConfig) {
    if (rawConfig !== undefined) throw new Error(`Unexpected local-ai argument: ${rawConfig}`);
    return { json };
  }
  if (rawConfig === undefined) {
    throw new Error('local-ai command requires <config-json>');
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawConfig) as unknown;
  } catch {
    throw new Error('Local AI target config must be valid JSON');
  }
  try {
    const payloadSchema = enrolOnly
      ? LocalAiCliEnrolPayloadSchema
      : LocalAiCliConfigPayloadSchema;
    const payload = payloadSchema.parse({ config: parsedJson });
    return { json, config: payload.config };
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`Invalid Local AI target config: ${error.issues[0]?.message ?? 'schema mismatch'}`);
    }
    throw error;
  }
}

function parseLifecycleArgs(argv: readonly string[]): {
  json: boolean;
  payload: ReturnType<typeof LocalAiCliSetLifecyclePayloadSchema.parse>;
} {
  let json = false;
  let pausedUntil: number | undefined;
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--paused-until') {
      const raw = argv[index + 1];
      index += 1;
      pausedUntil = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isSafeInteger(pausedUntil)) {
        throw new Error('--paused-until requires an epoch-milliseconds timestamp');
      }
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown local-ai option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) {
    throw new Error('local-ai set-lifecycle requires <target-id> <enrolled|paused|retired>');
  }
  const parsed = LocalAiCliSetLifecyclePayloadSchema.safeParse({
    targetId: positional[0],
    lifecycle: positional[1],
    ...(pausedUntil === undefined ? {} : { pausedUntil }),
  });
  if (!parsed.success) {
    throw new Error(`Invalid Local AI lifecycle request: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
  }
  return { json, payload: parsed.data };
}

function parseOptions(
  argv: readonly string[],
  valueOptions: readonly string[],
): { json: boolean; positional: string[]; options: Map<string, string> } {
  let json = false;
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--json') {
      json = true;
    } else if (valueOptions.includes(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options.set(arg, value);
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown local-ai option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { json, positional, options };
}

function requirePositional(positional: string[], count: number, usage: string): string[] {
  if (positional.length !== count || positional.some((value) => !value.trim())) throw new Error(usage);
  return positional;
}

function parsePatch(raw: string): ReturnType<typeof LocalAiTargetPatchSchema.parse> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Local AI target patch must be valid JSON');
  }
  const parsed = LocalAiTargetPatchSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`Invalid Local AI target patch: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
  }
  return parsed.data;
}

function parseResult<T>(
  schema: ZodType<T>,
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Parent returned an invalid Local AI ${label} result`);
  }
  return parsed.data;
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatDiscovery(
  endpoints: ReturnType<typeof LocalAiCliDiscoveryResultSchema.parse>,
): string {
  if (endpoints.length === 0) return 'No Local AI endpoints discovered.\n';
  return `${endpoints.map((endpoint) => {
    const location = endpoint.identity.location.type === 'worker'
      ? endpoint.identity.location.nodeId
      : 'coordinator';
    return [
      endpoint.label,
      `${location} · ${endpoint.identity.provider}`,
      endpoint.healthy ? 'healthy' : 'unhealthy',
      endpoint.models.join(', '),
      endpoint.enrolledTargetId ? `enrolled=${endpoint.enrolledTargetId}` : 'unmanaged',
    ].join(' | ');
  }).join('\n')}\n`;
}

function formatTargets(
  targets: ReturnType<typeof LocalAiCliTargetListResultSchema.parse>,
): string {
  if (targets.length === 0) return 'No Local AI targets enrolled.\n';
  return `${targets.map((target) => [
    target.label,
    target.id,
    target.lifecycle,
    target.expectedModels.map((model) => model.modelId).join(', '),
    target.routingRoles.join(', '),
  ].join(' | ')).join('\n')}\n`;
}

function formatValidation(results: LocalAiProbeResult[]): string {
  if (results.length === 0) return 'No validation results returned.\n';
  return `${results.map((result) => [
    result.layer,
    result.ok ? 'passed' : 'failed',
    result.required ? 'required' : 'optional',
    `${result.durationMs} ms`,
    result.failureCode ?? '',
  ].filter(Boolean).join(' | ')).join('\n')}\n`;
}

function formatAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1_000));
  if (seconds < 120) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

function formatTargetStatus(
  status: ReturnType<typeof LocalAiCliRecheckResultSchema.parse>,
  now: number,
): string {
  const layers = (['worker', 'endpoint', 'model', 'inference'] as const).map((layer) => {
    const result = status.layers[layer];
    const name = layer === 'inference' ? 'canary' : layer;
    if (!result) return `${name}: not checked`;
    const outcome = result.ok ? 'ok' : `FAILED${result.failureCode ? ` (${result.failureCode})` : ''}`;
    return `${name}: ${outcome}, ${formatAge(result.checkedAt, now)}`;
  });
  return [
    `${status.label} (${status.id})`,
    `  state: ${status.state} | ${status.lifecycle} | ${status.provider} | consecutive failures: ${status.consecutiveFailures}`,
    `  routes: ${status.routableRoles.length > 0 ? status.routableRoles.join(', ') : 'none'}`,
    `  checks: ${layers.join(' · ')}`,
    '',
  ].join('\n');
}

function formatStatus(
  status: ReturnType<typeof LocalAiCliStatusResultSchema.parse>,
  now: number,
): string {
  const { aggregate } = status;
  const lines = [
    `Overall: ${aggregate.state} (enrolled ${aggregate.enrolled}, healthy ${aggregate.healthy}, `
      + `degraded ${aggregate.degraded}, unavailable ${aggregate.unavailable}, paused ${aggregate.paused})`,
    '',
    ...status.targets.map((target) => formatTargetStatus(target, now)),
  ];
  if (status.incidents.length === 0) {
    lines.push('No open incidents.');
  } else {
    lines.push('Incidents:');
    for (const incident of status.incidents) {
      lines.push(`  ${incident.id} | ${incident.state} | ${incident.severity} | ${incident.failureCode} | `
        + `${incident.targetLabel ?? incident.targetId} | opened ${formatAge(incident.openedAt, now)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function formatSummary(summary: ReturnType<typeof LocalAiCliSummaryResultSchema.parse>): string {
  const eligible = summary.localTasks + summary.proposedFallbacks;
  const percent = eligible === 0 ? 0 : Math.round((summary.localTasks / eligible) * 100);
  return [
    `Local AI effectiveness (${summary.window}): ${percent}% local (${summary.localTasks} of ${eligible} tasks)`,
    `  local tokens: ${summary.localTokens}`,
    `  fallbacks: ${summary.proposedFallbacks} proposed, ${summary.allowedFallbacks} allowed, `
      + `${summary.deferredFallbacks} deferred, ${summary.blockedFallbacks} blocked`,
    `  cloud cost: $${summary.knownCostUsd.toFixed(4)} measured, $${summary.estimatedCostUsd.toFixed(4)} estimated, `
      + `${summary.unpricedDispatchCount} unpriced`,
    `  avoided: ${summary.avoidedEstimatedTokens} tokens, $${summary.avoidedEstimatedCostUsd.toFixed(4)} estimated`,
    '',
  ].join('\n');
}

function formatLocalAiHelp(): string {
  return [
    'Usage:',
    '  aio-mcp local-ai discover [--json]',
    '  aio-mcp local-ai list [--json]',
    '  aio-mcp local-ai validate <config-json> [--json]',
    '  aio-mcp local-ai enrol <config-json> [--json]',
    '  aio-mcp local-ai set-lifecycle <target-id> <enrolled|paused|retired> [--paused-until <epoch-ms>] [--json]',
    '  aio-mcp local-ai status [--json]',
    '  aio-mcp local-ai recheck <target-id> [--kind lightweight|functional] [--json]',
    '  aio-mcp local-ai rename <target-id> <label> [--json]',
    '  aio-mcp local-ai update <target-id> <patch-json> [--json]',
    '  aio-mcp local-ai summary [--window 24h|7d|30d] [--json]',
    '  aio-mcp local-ai acknowledge <incident-id> [--json]',
    '',
  ].join('\n');
}
