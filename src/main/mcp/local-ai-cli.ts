import { ZodError, type ZodType } from 'zod';
import type { LocalAiProbeResult, LocalAiTargetConfig } from '../../shared/types/local-ai-guard.types';
import {
  LOCAL_AI_CLI_METHODS,
  LocalAiCliConfigPayloadSchema,
  LocalAiCliDiscoveryResultSchema,
  LocalAiCliEnrolPayloadSchema,
  LocalAiCliEnrolResultSchema,
  LocalAiCliTargetListResultSchema,
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
      const client = clientFor(deps, functionalProbeRpcTimeoutMs(parsed.config!));
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
      const client = clientFor(deps, functionalProbeRpcTimeoutMs(parsed.config!));
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

function functionalProbeRpcTimeoutMs(config: LocalAiTargetConfig): number {
  const metadataRequests = config.provider === 'ollama' ? 2 : 1;
  const contextRequests = config.expectedModels.some(
    (model) => model.minContextLength !== undefined,
  )
    ? 1
    : 0;
  const inferenceRequests = 1;
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

function formatLocalAiHelp(): string {
  return [
    'Usage:',
    '  aio-mcp local-ai discover [--json]',
    '  aio-mcp local-ai list [--json]',
    '  aio-mcp local-ai validate <config-json> [--json]',
    '  aio-mcp local-ai enrol <config-json> [--json]',
    '',
  ].join('\n');
}
