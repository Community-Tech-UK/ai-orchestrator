import { createHash, randomInt } from 'node:crypto';

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
  /**
   * Re-unlock the vault and store a fresh session, resolving true on success.
   *
   * Needed because holding a session token is not the same as holding a working
   * one. Bitwarden keeps ONE active CLI session: a laptop sleeping long enough,
   * or any other process on the machine running `bw unlock`, rotates the key and
   * silently invalidates ours. Nothing observes that until the next command
   * fails, and the auto-unlock path cannot fix it because it treats "I hold a
   * string" as unlocked and returns early.
   */
  reauthenticate?: () => Promise<boolean>;
  /** Bitwarden folder the vault is jailed to. Default 'AIO-Agent'. */
  folderName?: string;
  /** Override the password generator (tests). Default: crypto-strong. */
  generatePassword?: () => string;
  now?: () => number;
}

export type CredentialFieldKind = 'username' | 'password' | 'totp';

/**
 * Generic (non-login) secret field types the procurement secret broker can
 * resolve. Each maps to a NAMED Bitwarden custom field on the same origin-bound,
 * folder-jailed vault item — never to a login field. `arbitrary_named_vault_field`
 * resolves an explicitly named custom field (the name is non-secret metadata the
 * model may pass; the value never leaves the worker).
 */
export type GenericSecretKind =
  | 'bank_account_number'
  | 'bank_sort_code'
  | 'iban'
  | 'bic_swift'
  | 'tax_identifier'
  | 'policy_number'
  | 'arbitrary_named_vault_field';

/** Every semantic secret type the broker + credential fill understand. */
export type SecretFieldKind = CredentialFieldKind | GenericSecretKind;

/**
 * Accepted normalized custom-field names per generic kind. Names are normalized
 * (lower-cased, non-alphanumerics stripped) before comparison so a Bitwarden
 * field labelled "Account Number", "account_number" or "accountNumber" all
 * resolve `bank_account_number`.
 */
const GENERIC_FIELD_ALIASES: Record<Exclude<GenericSecretKind, 'arbitrary_named_vault_field'>, string[]> = {
  bank_account_number: ['bankaccountnumber', 'accountnumber', 'account'],
  bank_sort_code: ['sortcode', 'sort'],
  iban: ['iban'],
  bic_swift: ['bicswift', 'swiftbic', 'bic', 'swift'],
  tax_identifier: ['taxidentifier', 'taxid', 'taxnumber', 'utr', 'vatnumber', 'vat'],
  policy_number: ['policynumber', 'policyno', 'policy'],
};

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface CreateAgentCredentialInput {
  origin: string;
  /** Optional non-secret Bitwarden item title. */
  itemTitle?: string;
  /** Optional login URI shown to Bitwarden; defaults to the bound origin. */
  loginUri?: string;
  username: string;
}

export interface CreateAgentCredentialResult {
  vaultItemRef: string;
  username: string;
}

export interface EnrolExistingCredentialInput {
  /** Bitwarden item id, or its exact item name. */
  item: string;
  /** Origin the credential is being bound to, e.g. https://auth.portal.gov.uk. */
  origin: string;
  /**
   * Move the item into the jailed folder when it currently sits elsewhere. The
   * caller must set this deliberately: it widens which items an authorized fill
   * can reach, so it is a human decision, never a default.
   */
  moveIntoFolder?: boolean;
}

export interface EnrolExistingCredentialResult {
  vaultItemRef: string;
  username: string;
  movedIntoFolder: boolean;
}

export interface GetSecretForFillInput {
  vaultItemRef: string;
  /** Live page origin; must match the item's bound origin. */
  origin: string;
  kind: CredentialFieldKind;
}

export interface GetGenericSecretForFillInput {
  vaultItemRef: string;
  /** Live page origin; must match the item's bound origin. */
  origin: string;
  kind: GenericSecretKind;
  /** Required for `arbitrary_named_vault_field`: the (non-secret) field name. */
  fieldName?: string;
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
      | 'secret_field_empty'
      | 'custom_field_not_found',
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
  /** Bitwarden custom fields — where generic (non-login) secrets live. */
  fields?: Array<{ name?: string | null; value?: string | null; type?: number }>;
}

const DEFAULT_FOLDER = 'AIO-Agent';

export class CredentialVault {
  private readonly runner: BwRunner;
  private readonly bindings: VaultOriginBindingStore;
  private readonly getSession: () => string | undefined;
  private readonly reauthenticate: (() => Promise<boolean>) | undefined;
  private readonly folderName: string;
  private readonly makePassword: () => string;
  private readonly now: () => number;
  private cachedFolderId: string | null = null;

  constructor(options: CredentialVaultOptions) {
    this.runner = options.runner;
    this.bindings = options.bindings;
    this.getSession = options.getSession;
    this.reauthenticate = options.reauthenticate;
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
      name: input.itemTitle ?? `aio/${hostOf(input.origin)}/${input.username}`,
      folderId,
      notes: null,
      login: {
        username: input.username,
        password,
        uris: [{ uri: input.loginUri ?? input.origin, match: null }],
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
   * Bind an EXISTING login (an account a human already registered) to an origin
   * so an authorized fill can use it.
   *
   * Without this, only agent-created accounts are usable: `getSecretForFill`
   * refuses any item with no recorded binding, and `createAgentCredential` was
   * the only writer of bindings. Every hand-registered portal account was
   * therefore permanently unfillable.
   *
   * The same two locks still apply afterwards — the item must live in the jailed
   * folder, and the binding pins it to one origin. Moving an item into the jail
   * widens what an authorized fill can reach, so it happens only when the caller
   * explicitly asks. The password is never read, returned, or logged here: the
   * item body is re-encoded in this process solely to change `folderId`.
   */
  async enrolExistingCredential(
    input: EnrolExistingCredentialInput,
  ): Promise<EnrolExistingCredentialResult> {
    const folderId = await this.resolveFolderId();
    const item = this.parseItem(await this.bw(['get', 'item', input.item]));
    const username = typeof item.login?.username === 'string' ? item.login.username : '';
    if (username === '') {
      throw new CredentialVaultError(
        `Vault item ${item.id} has no username to enrol`,
        'secret_field_empty',
      );
    }
    if (typeof item.login?.password !== 'string' || item.login.password === '') {
      throw new CredentialVaultError(
        `Vault item ${item.id} has no password to enrol`,
        'secret_field_empty',
      );
    }

    let movedIntoFolder = false;
    if (item.folderId !== folderId) {
      if (!input.moveIntoFolder) {
        throw new CredentialVaultError(
          `Vault item ${item.id} is not inside the ${this.folderName} folder`,
          'item_outside_agent_folder',
        );
      }
      await this.moveItemToFolder(item.id, folderId);
      movedIntoFolder = true;
    }

    this.bindings.put({
      vaultItemRef: item.id,
      origin: input.origin,
      username,
      createdAt: this.now(),
    });

    return { vaultItemRef: item.id, username, movedIntoFolder };
  }

  /**
   * Resolve a secret for a main-process fill. Enforces folder jail + origin
   * binding. The returned string must be typed directly into the page and never
   * returned in a tool result or logged.
   */
  async getSecretForFill(input: GetSecretForFillInput): Promise<string> {
    const item = await this.resolveJailedItem(input.vaultItemRef, input.origin);
    if (input.kind === 'totp') {
      const totp = (await this.bw(['get', 'totp', input.vaultItemRef])).trim();
      return this.requireNonEmpty(totp);
    }
    const secret =
      input.kind === 'username' ? item.login?.username : item.login?.password;
    return this.requireNonEmpty(typeof secret === 'string' ? secret : '');
  }

  /**
   * Resolve a GENERIC (non-login) secret — bank account number, sort code, IBAN,
   * BIC/SWIFT, tax id, policy number, or an arbitrary named field — from a NAMED
   * Bitwarden custom field on the same folder-jailed, origin-bound item. Same
   * anti-phishing + jail guarantees as getSecretForFill. The returned value must
   * be typed straight into the page and never returned in a tool result, logged,
   * or placed in an error.
   */
  async getGenericSecretForFill(input: GetGenericSecretForFillInput): Promise<string> {
    const item = await this.resolveJailedItem(input.vaultItemRef, input.origin);
    const field = this.findCustomField(item, input.kind, input.fieldName);
    if (!field) {
      // Names only — never echo field values in the error.
      throw new CredentialVaultError(
        `Vault item ${input.vaultItemRef} has no custom field for ${input.kind}`,
        'custom_field_not_found',
      );
    }
    return this.requireNonEmpty(typeof field.value === 'string' ? field.value : '');
  }

  /**
   * Binding + origin + folder-jail preamble shared by every secret read. Refuses
   * an item with no recorded origin binding, an origin mismatch, or anything
   * outside the agent folder — even when handed a valid reference to one of the
   * user's personal items.
   */
  private async resolveJailedItem(vaultItemRef: string, origin: string): Promise<BwItem> {
    const binding = this.bindings.get(vaultItemRef);
    if (!binding) {
      throw new CredentialVaultError(
        `No origin binding recorded for vault item ${vaultItemRef}`,
        'origin_binding_missing',
      );
    }
    if (!originsMatch(binding.origin, origin)) {
      throw new CredentialVaultError(
        `Vault item ${vaultItemRef} is bound to a different origin than the live page`,
        'origin_mismatch',
      );
    }
    const folderId = await this.resolveFolderId();
    const item = this.parseItem(await this.bw(['get', 'item', vaultItemRef]));
    if (item.folderId !== folderId) {
      throw new CredentialVaultError(
        `Vault item ${vaultItemRef} is not inside the ${this.folderName} folder`,
        'item_outside_agent_folder',
      );
    }
    return item;
  }

  private findCustomField(
    item: BwItem,
    kind: GenericSecretKind,
    fieldName: string | undefined,
  ): { name?: string | null; value?: string | null } | undefined {
    const fields = item.fields ?? [];
    if (kind === 'arbitrary_named_vault_field') {
      if (!fieldName) {
        throw new CredentialVaultError(
          'arbitrary_named_vault_field requires an explicit fieldName',
          'custom_field_not_found',
        );
      }
      const wanted = normalizeFieldName(fieldName);
      return fields.find((field) => typeof field.name === 'string' && normalizeFieldName(field.name) === wanted);
    }
    const aliases = GENERIC_FIELD_ALIASES[kind];
    return fields.find(
      (field) => typeof field.name === 'string' && aliases.includes(normalizeFieldName(field.name)),
    );
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

  /**
   * Re-encode an item with a new folderId. The decoded body carries the
   * password, so it stays in this scope: it is never returned, logged, or placed
   * in an error (`bw` failures report only the subcommand verb and stderr).
   */
  private async moveItemToFolder(itemId: string, folderId: string): Promise<void> {
    const raw = safeJson(await this.bw(['get', 'item', itemId])) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') {
      throw new CredentialVaultError('Could not parse bw item output', 'item_not_found');
    }
    const encoded = Buffer.from(JSON.stringify({ ...raw, folderId }), 'utf-8').toString('base64');
    await this.bw(['edit', 'item', itemId, encoded]);
    await this.bw(['sync']);
  }

  private async bw(args: string[]): Promise<string> {
    let result = await this.runOnce(args);

    // A held token that the CLI rejects is the common failure in unattended use,
    // and it is indistinguishable from a locked vault to everything upstream.
    // Re-unlock once and retry rather than failing the whole run.
    if (result.code !== 0 && this.reauthenticate && isStaleSessionFailure(result)) {
      if (await this.reauthenticate()) {
        result = await this.runOnce(args);
      }
    }

    if (result.code !== 0) {
      // Neither argv nor stderr is safe to echo: a failed Bitwarden command may
      // repeat the encoded item body, which contains the generated password.
      throw new CredentialVaultError(
        `bw ${args[0] ?? ''} failed (exit ${result.code})`,
        'bw_command_failed',
      );
    }
    return result.stdout;
  }

  private async runOnce(args: string[]): Promise<BwCommandResult> {
    const session = this.getSession();
    if (!session) {
      throw new CredentialVaultError('Credential vault is locked (no BW_SESSION)', 'vault_locked');
    }
    return this.runner.run(args, { session });
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
/**
 * Does this failure look like the session we hold is no longer valid?
 *
 * Deliberately narrow. Retrying every failure would double the work on a genuine
 * error (a missing item, a malformed edit) and could repeat a mutation. These
 * are the messages the Bitwarden CLI emits when the session key it was handed is
 * rejected, matched case-insensitively.
 *
 * `stderr` is inspected but never logged or returned: a failed command can echo
 * an encoded item body containing a password.
 */
export function isStaleSessionFailure(result: BwCommandResult): boolean {
  const text = `${result.stderr ?? ''}`.toLowerCase();
  return (
    text.includes('not logged in')
    || text.includes('vault is locked')
    || text.includes('session key is invalid')
    || text.includes('invalid session')
    || text.includes('mac failed')
  );
}

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

/**
 * Non-reversible digest of a secret, for worker-side fill verification. The
 * broker compares the digest of the vault value with the digest of the value it
 * read back from the page IN-PROCESS; neither plaintext nor this digest is ever
 * returned to the model, logged, or written to audit.
 */
export function secretVerificationDigest(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

/**
 * True iff the value read back from the page matches the vaulted secret, by
 * constant-shape digest comparison. Both plaintexts stay in the worker; only the
 * boolean escapes. An empty/absent read-back is treated as unverified.
 */
export function verifyFilledSecret(expected: string, readback: string | undefined): boolean {
  if (typeof readback !== 'string' || readback.length === 0) {
    return false;
  }
  return secretVerificationDigest(expected) === secretVerificationDigest(readback);
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
