/**
 * `aio-mcp copilot-account` — inspect GitHub Copilot account routing.
 *
 * Read-only. Writes stay in Settings because this CLI cannot distinguish the
 * operator from an agent; see `copilot-account-cli-contracts.ts` for the full
 * reasoning.
 */

import { ZodError, type ZodType } from 'zod';
import {
  COPILOT_ACCOUNT_CLI_METHODS,
  COPILOT_CLI_ORIGINS,
  CopilotAccountCliDoctorSchema,
  CopilotAccountCliProfileListSchema,
  CopilotAccountCliRouteSchema,
  CopilotAccountCliRuleListSchema,
  type CopilotAccountCliDoctor,
  type CopilotAccountCliProfile,
  type CopilotAccountCliRoute,
  type CopilotAccountCliRule,
} from './copilot-account-cli-contracts';
import {
  OrchestratorToolsRpcClient,
  type OrchestratorToolsRpcClientLike,
} from './orchestrator-tools-rpc-client';

export interface CopilotAccountCliDeps {
  client?: OrchestratorToolsRpcClientLike;
  createClient?: (timeoutMs: number) => OrchestratorToolsRpcClientLike;
  stdout?: (text: string) => void;
}

const RPC_TIMEOUT_MS = 30_000;

export async function runCopilotAccountCli(
  argv: readonly string[],
  deps: CopilotAccountCliDeps = {},
): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    stdout(formatHelp());
    return;
  }

  const json = argv.includes('--json');

  switch (command) {
    case 'list': {
      const profiles = await call(deps, COPILOT_ACCOUNT_CLI_METHODS.list, {}, CopilotAccountCliProfileListSchema);
      stdout(json ? `${JSON.stringify(profiles, null, 2)}\n` : formatProfiles(profiles));
      return;
    }
    case 'rules': {
      const rules = await call(deps, COPILOT_ACCOUNT_CLI_METHODS.rules, {}, CopilotAccountCliRuleListSchema);
      stdout(json ? `${JSON.stringify(rules, null, 2)}\n` : formatRules(rules));
      return;
    }
    case 'route': {
      const { workingDirectory, origin: originArg } = parseRouteArgs(argv.slice(1));
      const route = await call(
        deps,
        COPILOT_ACCOUNT_CLI_METHODS.route,
        { workingDirectory, ...(originArg ? { origin: originArg } : {}) },
        CopilotAccountCliRouteSchema,
      );
      stdout(json ? `${JSON.stringify(route, null, 2)}\n` : formatRoute(route));
      return;
    }
    case 'doctor': {
      const report = await call(deps, COPILOT_ACCOUNT_CLI_METHODS.doctor, {}, CopilotAccountCliDoctorSchema);
      stdout(json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctor(report));
      return;
    }
    default:
      throw new Error(`Unknown copilot-account command: ${command}`);
  }
}

/**
 * Both `--origin=x` and `--origin x` are accepted, and the value of the space
 * form is consumed rather than left in the positional stream.
 *
 * Taking "the first token not starting with `--`" as the path meant
 * `route --origin automation /real/path` silently used `"automation"` as the
 * workspace — a confident answer about a folder that does not exist. A flag
 * that is ignored is bad; a flag that eats the argument is worse.
 */
export function parseRouteArgs(args: readonly string[]): {
  workingDirectory: string;
  origin?: string;
} {
  let workingDirectory: string | undefined;
  let origin: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--origin') {
      origin = args[index + 1];
      if (!origin || origin.startsWith('--')) {
        throw new Error(`--origin requires a value. One of: ${COPILOT_CLI_ORIGINS.join(', ')}.`);
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--origin=')) {
      origin = arg.slice('--origin='.length);
      continue;
    }
    if (arg.startsWith('--')) continue;
    workingDirectory ??= arg;
  }

  if (!workingDirectory) {
    throw new Error('Usage: aio-mcp copilot-account route <path> [--origin=<name>] [--json]');
  }
  if (origin !== undefined && !(COPILOT_CLI_ORIGINS as readonly string[]).includes(origin)) {
    throw new Error(`Unknown origin "${origin}". One of: ${COPILOT_CLI_ORIGINS.join(', ')}.`);
  }
  return { workingDirectory, ...(origin ? { origin } : {}) };
}

async function call<T>(
  deps: CopilotAccountCliDeps,
  method: string,
  payload: Record<string, unknown>,
  schema: ZodType<T>,
): Promise<T> {
  const client =
    deps.client
    ?? deps.createClient?.(RPC_TIMEOUT_MS)
    ?? new OrchestratorToolsRpcClient({ timeoutMs: RPC_TIMEOUT_MS });
  const result = await client.call(method, { payload });
  try {
    return schema.parse(result);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`Unexpected response from Harness for ${method}.`);
    }
    throw error;
  }
}

function formatProfiles(profiles: CopilotAccountCliProfile[]): string {
  if (profiles.length === 0) {
    return 'No Copilot account profiles are configured; Copilot uses its single existing sign-in.\n';
  }
  const lines = profiles.map((profile) => {
    const marks = [profile.isDefault ? 'default' : '', profile.isLegacy ? 'existing' : '']
      .filter(Boolean)
      .join(', ');
    const identity = profile.expectedLogin ?? 'not signed in yet';
    const observed =
      profile.bindingState === 'identity-mismatch' && profile.observedLogin
        ? ` (actually signed in as ${profile.observedLogin})`
        : '';
    return (
      `${profile.id}\n`
      + `  ${profile.label}${marks ? ` [${marks}]` : ''}\n`
      + `  ${identity} on ${profile.host} — ${profile.bindingState}${observed}\n`
      + `  scope: ${profile.scopePolicy}, automation: ${profile.automationPolicy}\n`
    );
  });
  return `${lines.join('')}`;
}

function formatRules(rules: CopilotAccountCliRule[]): string {
  if (rules.length === 0) {
    return 'No routing rules; every workspace uses the default account.\n';
  }
  return `${rules
    .map((rule) => `${rule.target} -> ${rule.profileId}${rule.isProtected ? ' [protected]' : ''}\n`)
    .join('')}`;
}

function formatRoute(route: CopilotAccountCliRoute): string {
  // The origin is always printed. The same workspace can resolve for an
  // interactive session and be refused for every automation, so an answer that
  // hides which one it assumed is worse than no answer.
  const as = `as ${route.origin}`;
  if (route.ok) {
    return `${route.profileLabel ?? route.profileId} (${route.source}, ${as})\n`;
  }
  return `Blocked ${as}: ${route.detail ?? route.source ?? 'this workspace cannot run Copilot.'}\n`;
}

function formatDoctor(report: CopilotAccountCliDoctor): string {
  const lines = [`${report.aggregate} on ${report.nodeId}`];
  if (report.legacyMigrationInUse) lines.push('using the pre-existing single Copilot sign-in');
  if (report.ambientTokenVariablesPresent.length > 0) {
    // Names only — never values.
    lines.push(`ambient token variables set: ${report.ambientTokenVariablesPresent.join(', ')}`);
  }
  for (const warning of report.warnings) lines.push(warning);
  return `${lines.join('\n')}\n`;
}

function formatHelp(): string {
  return [
    'Usage: aio-mcp copilot-account <command> [--json]',
    '',
    '  list            GitHub Copilot account profiles and their sign-in state',
    '  rules           routing rules, most specific first',
    '  route <path>    which account a workspace resolves to, and why',
    '                  assumes an interactive session; pass --origin=automation',
    '                  (or review, loop, workflow, ...) to check what an',
    '                  automated run would actually get — the answer differs',
    '  doctor          routing health, conflicts and warnings',
    '',
    'Read-only. Add, remove and re-map accounts in Settings > GitHub Copilot',
    'Accounts: these decide which GitHub identity services a repository, and',
    'this CLI cannot tell an operator apart from an agent.',
    '',
  ].join('\n');
}
