import { randomInt } from 'node:crypto';

/**
 * Agent Credential Vault (ACV) — main-process-only Bitwarden bridge for
 * agent-owned website accounts.
 *
 * Security contract (the reason this module exists):
 *  - The model NEVER sees a password. `createAgentCredential` generates the
 *    secret in-process and returns only a vault item reference + username.
 *    `getSecretForFill` is the ONLY method that returns a secret, and it is
 *    designed to be called by a main-process fill primitive that types the
 *    value straight into the page — never surfaced to a tool result.
 *  - The vault is JAILED to a single Bitwarden folder (default `AIO-Agent`).
 *    A getSecretForFill for an item outside that folder is refused, regardless
 *    of what the caller claims — so a prompt-injected agent cannot pull the
 *    user's personal logins.
 *  - Every item is ORIGIN-BOUND at creation. getSecretForFill refuses if the
 *    live page origin does not match the item's bound origin — the anti-phishing
 *    lock that stops a stolen reference being filled into evil.example.
 *  - Secrets are never placed in thrown errors or logs.
 *
 * Fully injectable (bw runner, binding store, session getter, RNG) so it
 * unit-tests against a fake `bw` shim with no real vault and no real secret.
 */

export interface BwCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs the Bitwarden `bw` CLI. Injected so tests supply a fake shim. */
export interface BwRunner {
  run(
    args: string[],
    opts?: { input?: string; session?: string; env?: Record<string, string> },
  ): Promise<BwCommandResult>;
}

export interface VaultOriginBinding {
  vaultItemRef: string;
  origin: string;
  username: string;
  createdAt: number;
}

/** Persists item→origin bindings (a SQLite table in production). */
export interface VaultOriginBindingStore {
  put(binding: VaultOriginBinding): void;
  get(vaultItemRef: string): VaultOriginBinding | undefined;
}

export interface CredentialVaultOptions {
  runner: BwRunner;
  bindings: VaultOriginBindingStore;
  /** Returns the current BW_SESSION token, or undefined when the vault is locked. */
  getSession: () => string | undefined;
  /** Bitwarden folder the vault is jailed to. Default 'AIO-Agent'. */
  folderName?: string;
  /** Override the password generator (tests). Default: crypto-strong. */
  generatePassword?: () => string;
  now?: () => number;
}

export type CredentialFieldKind = 'username' | 'password' | 'totp';

export interface CreateAgentCredentialInput {
  origin: string;
  username: string;
}

export interface CreateAgentCredentialResult {
  vaultItemRef: string;
  username: string;
}

export interface GetSecretForFillInput {
  vaultItemRef: string;
  /** Live page origin; must match the item's bound origin. */
  origin: string;
  kind: CredentialFieldKind;
}

export class CredentialVaultError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'vault_locked'
      | 'folder_unavailable'
      | 'item_not_found'
      | 'item_outside_agent_folder'
      | 'origin_binding_missing'
      | 'origin_mismatch'
      | 'bw_command_failed'
      | 'secret_field_empty',
  ) {
    super(message);
    this.name = 'CredentialVaultError';
  }
}

interface BwItem {
  id: string;
  folderId: string | null;
  login?: {
    username?: string | null;
    password?: string | null;
  };
}

const DEFAULT_FOLDER = 'AIO-Agent';

export class CredentialVault {
  private readonly runner: BwRunner;
  private readonly bindings: VaultOriginBindingStore;
  private readonly getSession: () => string | undefined;
  private readonly folderName: string;
  private readonly makePassword: () => string;
  private readonly now: () => number;
  private cachedFolderId: string | null = null;

  constructor(options: CredentialVaultOptions) {
    this.runner = options.runner;
    this.bindings = options.bindings;
    this.getSession = options.getSession;
    this.folderName = options.folderName ?? DEFAULT_FOLDER;
    this.makePassword = options.generatePassword ?? generateStrongPassword;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Create a new agent-owned login: generate a strong password, store it to the
   * jailed folder bound to `origin`, and return only a reference + username.
   */
  async createAgentCredential(
    input: CreateAgentCredentialInput,
  ): Promise<CreateAgentCredentialResult> {
    const folderId = await this.resolveFolderId();
    const password = this.makePassword();
    const item = {
      type: 1,
      name: `aio/${hostOf(input.origin)}/${input.username}`,
      folderId,
      notes: null,
      login: {
        username: input.username,
        password,
        uris: [{ uri: input.origin, match: null }],
      },
    };
    const encoded = Buffer.from(JSON.stringify(item), 'utf-8').toString('base64');
    const created = await this.bw(['create', 'item', encoded]);
    const parsed = this.parseItem(created);
    await this.bw(['sync']);

    this.bindings.put({
      vaultItemRef: parsed.id,
      origin: input.origin,
      username: input.username,
      createdAt: this.now(),
    });

    return { vaultItemRef: parsed.id, username: input.username };
  }

  /**
   * Resolve a secret for a main-process fill. Enforces folder jail + origin
   * binding. The returned string must be typed directly into the page and never
   * returned in a tool result or logged.
   */
  async getSecretForFill(input: GetSecretForFillInput): Promise<string> {
    const binding = this.bindings.get(input.vaultItemRef);
    if (!binding) {
      throw new CredentialVaultError(
        `No origin binding recorded for vault item ${input.vaultItemRef}`,
        'origin_binding_missing',
      );
    }
    if (!originsMatch(binding.origin, input.origin)) {
      throw new CredentialVaultError(
        `Vault item ${input.vaultItemRef} is bound to a different origin than the live page`,
        'origin_mismatch',
      );
    }

    const folderId = await this.resolveFolderId();
    const item = this.parseItem(await this.bw(['get', 'item', input.vaultItemRef]));
    if (item.folderId !== folderId) {
      // The jail: refuse anything not inside the agent folder even if a caller
      // hands us a valid reference to one of the user's personal items.
      throw new CredentialVaultError(
        `Vault item ${input.vaultItemRef} is not inside the ${this.folderName} folder`,
        'item_outside_agent_folder',
      );
    }

    if (input.kind === 'totp') {
      const totp = (await this.bw(['get', 'totp', input.vaultItemRef])).trim();
      return this.requireNonEmpty(totp);
    }
    const secret =
      input.kind === 'username' ? item.login?.username : item.login?.password;
    return this.requireNonEmpty(typeof secret === 'string' ? secret : '');
  }

  private requireNonEmpty(secret: string): string {
    if (secret === '') {
      throw new CredentialVaultError('Vault item field was empty', 'secret_field_empty');
    }
    return secret;
  }

  private async resolveFolderId(): Promise<string> {
    if (this.cachedFolderId) {
      return this.cachedFolderId;
    }
    const listed = await this.bw(['list', 'folders', '--search', this.folderName]);
    const folders = safeJsonArray(listed) as Array<{ id?: string; name?: string }>;
    const existing = folders.find((folder) => folder.name === this.folderName);
    if (existing?.id) {
      this.cachedFolderId = existing.id;
      return existing.id;
    }
    const encoded = Buffer.from(
      JSON.stringify({ name: this.folderName }),
      'utf-8',
    ).toString('base64');
    const created = await this.bw(['create', 'folder', encoded]);
    const parsed = safeJson(created) as { id?: string } | null;
    if (!parsed?.id) {
      throw new CredentialVaultError(
        `Could not resolve or create the ${this.folderName} folder`,
        'folder_unavailable',
      );
    }
    this.cachedFolderId = parsed.id;
    return parsed.id;
  }

  private async bw(args: string[]): Promise<string> {
    const session = this.getSession();
    if (!session) {
      throw new CredentialVaultError('Credential vault is locked (no BW_SESSION)', 'vault_locked');
    }
    const result = await this.runner.run(args, { session });
    if (result.code !== 0) {
      // Never echo item bodies (they can contain the encoded secret) — report
      // only the subcommand verb and bw's own stderr.
      throw new CredentialVaultError(
        `bw ${args[0] ?? ''} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
        'bw_command_failed',
      );
    }
    return result.stdout;
  }

  private parseItem(stdout: string): BwItem {
    const parsed = safeJson(stdout) as BwItem | null;
    if (!parsed?.id) {
      throw new CredentialVaultError('Could not parse bw item output', 'item_not_found');
    }
    return parsed;
  }
}

const PASSWORD_CHARSETS = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnpqrstuvwxyz',
  digit: '23456789',
  symbol: '!@#$%^&*()-_=+[]',
};

/** Crypto-strong, policy-compliant password (>=1 of each class), length 20. */
export function generateStrongPassword(length = 20): string {
  const all =
    PASSWORD_CHARSETS.upper +
    PASSWORD_CHARSETS.lower +
    PASSWORD_CHARSETS.digit +
    PASSWORD_CHARSETS.symbol;
  const required = [
    pick(PASSWORD_CHARSETS.upper),
    pick(PASSWORD_CHARSETS.lower),
    pick(PASSWORD_CHARSETS.digit),
    pick(PASSWORD_CHARSETS.symbol),
  ];
  const chars = [...required];
  while (chars.length < length) {
    chars.push(pick(all));
  }
  // Fisher–Yates with a CSPRNG so the required chars are not positionally fixed.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}

function pick(charset: string): string {
  return charset[randomInt(charset.length)] as string;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

function originsMatch(a: string, b: string): boolean {
  return normalizeOrigin(a) === normalizeOrigin(b);
}

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return value.trim().toLowerCase().replace(/\/+$/, '');
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safeJsonArray(value: string): unknown[] {
  const parsed = safeJson(value);
  return Array.isArray(parsed) ? parsed : [];
}
