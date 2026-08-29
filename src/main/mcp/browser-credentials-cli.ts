import { ZodError, type ZodType } from 'zod';
import {
  BROWSER_CREDENTIALS_CLI_METHODS,
  BrowserCredentialsCliAuthorizationListSchema,
  BrowserCredentialsCliAuthorizationSchema,
  BrowserCredentialsCliEnrolResultSchema,
  BrowserCredentialsCliRevokeResultSchema,
  type BrowserCredentialsCliAuthorization,
} from './browser-credentials-cli-contracts';
import { parseCredentialOrigin } from '../browser-gateway/browser-credential-origin';
import {
  OrchestratorToolsRpcClient,
  type OrchestratorToolsRpcClientLike,
} from './orchestrator-tools-rpc-client';

export interface BrowserCredentialsCliDeps {
  client?: OrchestratorToolsRpcClientLike;
  createClient?: (timeoutMs: number) => OrchestratorToolsRpcClientLike;
  stdout?: (text: string) => void;
  now?: () => number;
}

/** Enrolment shells out to `bw`, which reaches the network. Be generous. */
const BROWSER_CREDENTIALS_CLI_TIMEOUT_MS = 120_000;

const PURPOSES = ['login', 'register', 'totp', 'email_code'] as const;
type Purpose = typeof PURPOSES[number];

export interface Flags {
  json: boolean;
  values: Map<string, string[]>;
  bools: Set<string>;
}

export async function runBrowserCredentialsCli(
  argv: readonly string[],
  deps: BrowserCredentialsCliDeps = {},
): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    stdout(formatHelp());
    return;
  }

  const flags = parseFlags(argv.slice(1));

  switch (command) {
    case 'enrol':
    case 'enroll': {
      const payload = {
        item: requireOne(flags, 'item'),
        origin: requireOne(flags, 'origin'),
        ...(flags.bools.has('move-into-folder') ? { moveIntoFolder: true } : {}),
      };
      const result = parseResult(
        BrowserCredentialsCliEnrolResultSchema,
        await call(deps, BROWSER_CREDENTIALS_CLI_METHODS.enrol, payload),
        'enrolment',
      );
      stdout(flags.json
        ? formatJson(result)
        : `Enrolled ${result.username} for ${payload.origin}\n`
          + `  vault item: ${result.vaultItemRef}\n`
          + `  moved into agent folder: ${result.movedIntoFolder ? 'yes' : 'no'}\n`);
      return;
    }
    case 'authorize':
    case 'authorise': {
      const payload = {
        profileId: resolveScope(flags),
        allowedOrigins: requireMany(flags, 'origin').map(parseCredentialOrigin),
        purposes: parsePurposes(requireMany(flags, 'purpose')),
        vaultFolder: requireOne(flags, 'vault-folder'),
        expiresAt: resolveExpiry(flags, deps.now?.() ?? Date.now()),
        ...(optionalOne(flags, 'note') ? { note: optionalOne(flags, 'note')! } : {}),
        ...(flags.values.has('sender-domain')
          ? { allowedSenderDomains: flags.values.get('sender-domain')! }
          : {}),
      };
      const result = parseResult(
        BrowserCredentialsCliAuthorizationSchema,
        await call(deps, BROWSER_CREDENTIALS_CLI_METHODS.authorize, payload),
        'authorization',
      );
      stdout(flags.json ? formatJson(result) : `Authorization created.\n${formatAuthorization(result)}`);
      return;
    }
    case 'list': {
      const profileId = optionalOne(flags, 'profile');
      const result = parseResult(
        BrowserCredentialsCliAuthorizationListSchema,
        await call(
          deps,
          BROWSER_CREDENTIALS_CLI_METHODS.list,
          profileId === undefined ? {} : { profileId },
        ),
        'authorization list',
      );
      stdout(flags.json ? formatJson(result) : formatAuthorizationList(result));
      return;
    }
    case 'revoke': {
      const authorizationId = requireOne(flags, 'id');
      const result = parseResult(
        BrowserCredentialsCliRevokeResultSchema,
        await call(deps, BROWSER_CREDENTIALS_CLI_METHODS.revoke, { authorizationId }),
        'revocation',
      );
      stdout(flags.json
        ? formatJson(result)
        : `Revoked authorization ${authorizationId}.\n`);
      return;
    }
    default:
      throw new Error(`Unknown browser-credentials command: ${command}`);
  }
}

async function call(
  deps: BrowserCredentialsCliDeps,
  method: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const client = deps.client
    ?? deps.createClient?.(BROWSER_CREDENTIALS_CLI_TIMEOUT_MS)
    ?? new OrchestratorToolsRpcClient({ timeoutMs: BROWSER_CREDENTIALS_CLI_TIMEOUT_MS });
  try {
    return await client.call(method, payload);
  } catch (error) {
    throw withRemedy(error);
  }
}

function parseFlags(argv: readonly string[]): Flags {
  const values = new Map<string, string[]>();
  const bools = new Set<string>();
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (name === 'json') {
      json = true;
      continue;
    }
    if (name === 'move-into-folder' || name === 'local') {
      bools.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Flag --${name} requires a value`);
    }
    index += 1;
    const existing = values.get(name);
    if (existing) {
      existing.push(value);
    } else {
      values.set(name, [value]);
    }
  }

  return { json, values, bools };
}

function requireOne(flags: Flags, name: string): string {
  const found = flags.values.get(name);
  if (!found || found.length === 0) {
    throw new Error(`Missing required flag --${name}`);
  }
  if (found.length > 1) {
    throw new Error(`Flag --${name} may only be given once`);
  }
  return found[0]!;
}

function optionalOne(flags: Flags, name: string): string | undefined {
  const found = flags.values.get(name);
  if (!found || found.length === 0) return undefined;
  if (found.length > 1) {
    throw new Error(`Flag --${name} may only be given once`);
  }
  return found[0]!;
}

function requireMany(flags: Flags, name: string): string[] {
  const found = flags.values.get(name);
  if (!found || found.length === 0) {
    throw new Error(`Missing required flag --${name}`);
  }
  return found;
}

/**
 * Which scope the grant is keyed on. This is NOT always a browser profile id,
 * and getting it wrong creates a grant that can never match: at fill time
 * `credentialAuthorizationProfileScope` resolves a shared existing tab to its
 * node scope, because a shared tab's own profileId is per-tab and ephemeral.
 *
 * Making the caller pick one of three explicit flags removes the failure mode
 * where a plausible string is accepted and silently never matches. The scope is
 * checked against the real roster main-side by `resolveCredentialScope`, which
 * also maps a friendly node name to the node id the fill looks up.
 */
export function resolveScope(flags: Flags): string {
  const profile = optionalOne(flags, 'profile');
  const node = optionalOne(flags, 'node');
  const local = flags.bools.has('local');
  const given = [
    profile !== undefined ? '--profile' : null,
    node !== undefined ? '--node' : null,
    local ? '--local' : null,
  ].filter((value): value is string => value !== null);

  if (given.length === 0) {
    throw new Error(
      'Missing a scope. Give exactly one of --local (a shared tab on this machine), '
        + '--node <nodeId> (a shared tab on a worker node, e.g. windows-pc), '
        + 'or --profile <id> (a managed browser profile).',
    );
  }
  if (given.length > 1) {
    throw new Error(`Give exactly one scope, not ${given.join(' and ')}`);
  }
  if (local) return 'local';
  return (node ?? profile)!;
}

/**
 * Turn a bare failure into something the operator can act on. This runs
 * unattended, so "Credential vault is locked" with no next step is a dead end
 * in a log at 3am.
 */
function withRemedy(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/vault is locked|vault_locked|BW_SESSION/i.test(message)) {
    return new Error(
      `${message}\nUnlock it first: set browserVaultMasterPasswordFile and `
        + 'browserVaultAutoUnlock via `aio-mcp settings set`, or unlock the vault '
        + 'on the Browser Gateway screen.',
    );
  }
  if (/outside_agent_folder|not inside the/i.test(message)) {
    return new Error(
      `${message}\nPass --move-into-folder to move it into the agent folder, `
        + 'which is a deliberate widening of what an authorized fill can reach.',
    );
  }
  if (/item_not_found|Could not parse bw item/i.test(message)) {
    return new Error(
      `${message}\nCheck the item exists in the vault and that --item is its exact `
        + 'name or id.',
    );
  }
  return error instanceof Error ? error : new Error(message);
}

function parsePurposes(raw: readonly string[]): Purpose[] {
  const purposes = raw.map((value) => {
    if (!(PURPOSES as readonly string[]).includes(value)) {
      throw new Error(
        `Invalid purpose '${value}'. Expected one of: ${PURPOSES.join(', ')}.`,
      );
    }
    return value as Purpose;
  });
  return [...new Set(purposes)];
}

/**
 * `--expires-in 90d` / `12w`, or `--expires-at <epoch ms>`. The 1-year cap is
 * enforced main-side by `assertAuthorizationExpiry`, so this only has to turn
 * the operator's shorthand into an instant.
 */
export function resolveExpiry(flags: Flags, now: number): number {
  const at = optionalOne(flags, 'expires-at');
  const inValue = optionalOne(flags, 'expires-in');
  if (at !== undefined && inValue !== undefined) {
    throw new Error('Give either --expires-in or --expires-at, not both');
  }
  if (at !== undefined) {
    const parsed = Number(at);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid --expires-at '${at}'. Expected epoch milliseconds.`);
    }
    return parsed;
  }
  if (inValue === undefined) {
    throw new Error('Missing required flag --expires-in (e.g. 90d) or --expires-at');
  }
  const match = /^(\d+)([dw])$/.exec(inValue.trim());
  if (!match) {
    throw new Error(`Invalid --expires-in '${inValue}'. Expected a value like 90d or 12w.`);
  }
  const amount = Number(match[1]);
  if (amount <= 0) {
    throw new Error(`Invalid --expires-in '${inValue}'. Must be greater than zero.`);
  }
  const days = match[2] === 'w' ? amount * 7 : amount;
  return now + days * 24 * 60 * 60 * 1000;
}

function parseResult<T>(schema: ZodType<T>, value: unknown, label: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`Malformed ${label} response from Harness`);
    }
    throw error;
  }
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatOrigin(origin: BrowserCredentialsCliAuthorization['allowedOrigins'][number]): string {
  return `${origin.scheme}://${origin.includeSubdomains ? '*.' : ''}${origin.hostPattern}`;
}

function formatAuthorization(auth: BrowserCredentialsCliAuthorization): string {
  const lines = [
    `  id: ${auth.id}`,
    `  scope: ${auth.profileId}`,
    `  origins: ${auth.allowedOrigins.map(formatOrigin).join(', ')}`,
    `  purposes: ${auth.purposes.join(', ')}`,
    `  vault folder: ${auth.vaultFolder}`,
    `  expires: ${new Date(auth.expiresAt).toISOString()}`,
  ];
  if (auth.allowedSenderDomains?.length) {
    lines.push(`  sender domains: ${auth.allowedSenderDomains.join(', ')}`);
  }
  if (auth.note) lines.push(`  note: ${auth.note}`);
  if (auth.revokedAt !== undefined) {
    lines.push(`  REVOKED: ${new Date(auth.revokedAt).toISOString()}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatAuthorizationList(list: readonly BrowserCredentialsCliAuthorization[]): string {
  if (list.length === 0) return 'No credential authorizations.\n';
  return list
    .map((auth) => formatAuthorization(auth))
    .join('\n');
}

function formatHelp(): string {
  return [
    'Usage: aio-mcp browser-credentials <command> [flags]',
    '',
    'Bind an existing vault login to an origin and manage the standing',
    'authorizations that let an unattended browser fill use it.',
    '',
    'Commands:',
    '  enrol      --item <name|id> --origin <url> [--move-into-folder]',
    '  authorize  (--local | --node <nodeId> | --profile <id>)',
    '             --origin <url> [--origin <url> ...]',
    '             --purpose <login|register|totp|email_code> [--purpose ...]',
    '             --vault-folder <name> (--expires-in 90d | --expires-at <epoch ms>)',
    '             [--note <text>] [--sender-domain <domain> ...]',
    '  list       [--profile <scope>]   (filters on the stored scope)',
    '  revoke     --id <authorizationId>',
    '',
    'Flags:',
    '  --json               Machine-readable output.',
    '  --move-into-folder   Move the vault item into the agent folder if it is',
    '                       elsewhere. Widens what an authorized fill can reach,',
    '                       so it is never the default.',
    '',
    'Scope picks what the fill will look up. A shared tab in your everyday',
    'Chrome authorizes by machine (--local, or --node windows-pc); a managed',
    'browser profile authorizes by its own id (--profile). An unknown scope is',
    'refused, because a grant on one can never match.',
    '',
    'Origins take the form https://host or https://*.host. A port is kept; a',
    'path is dropped. A URL in a host field is refused.',
    'A wildcard over a public suffix (*.com, *.co.uk) is refused.',
    'Standing consent is capped at 1 year.',
    'No command ever prints a password.',
    '',
  ].join('\n');
}
