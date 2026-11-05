import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import {
  MailboxReaderError,
  senderMatchesDomains,
  type MailboxMessage,
  type MailboxReader,
  type MailboxSearchCriteria,
} from './browser-email-code-reader';
import { buildCliEnv } from '../cli/cli-environment';
import { getLogger } from '../logging/logger';

/**
 * Production MailboxReader over the local imap-mcp-server (stdio MCP).
 *
 * The IMAP credentials live entirely inside the imap-mcp-server's own config
 * (its accounts.json / IMAP_* env) — this module never sees or stores a mail
 * password. The child server is spawned lazily on first use, reused across
 * calls, and respawned transparently if it dies.
 *
 * Never logs message subjects, bodies, or senders — 2FA/verification mails are
 * one-time secrets. Logs are limited to counts and error categories.
 *
 * Every failure is thrown as a `MailboxReaderError` with a fixed category and
 * a fixed detail, never the server's own message text, so the credential fill
 * boundary can report WHY a code could not be read without risking a leak.
 */

const logger = getLogger('BrowserImapMailboxReader');

const DEFAULT_CALL_TIMEOUT_MS = 25_000;
const DEFAULT_BODY_FETCH_LIMIT = 10;

export interface ImapMcpServerCommand {
  command: string;
  args: string[];
}

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface McpToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * Minimal MCP stdio client: newline-delimited JSON-RPC over a spawned child
 * process, with the standard initialize handshake. Only what tools/call needs.
 */
export class ImapMcpClient {
  private child: ChildProcess | null = null;
  private reader: Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }
  >();
  private initializing: Promise<void> | null = null;

  constructor(
    private readonly server: ImapMcpServerCommand,
    private readonly callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  ) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureStarted();
    const response = await this.request('tools/call', { name, arguments: args }, `tools/call:${name}`);
    if (response.error) {
      throw new MailboxReaderError('mailbox_unavailable', 'rpc_error');
    }
    const result = response.result as McpToolCallResult | undefined;
    const text = result?.content?.find((block) => block.type === 'text')?.text;
    if (result?.isError) {
      throw new MailboxReaderError('mailbox_unavailable', 'tool_error');
    }
    if (text === undefined) {
      throw new MailboxReaderError('mailbox_unavailable', 'no_text_content');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new MailboxReaderError('mailbox_unavailable', 'invalid_json');
    }
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.initializing = null;
    this.reader?.close();
    this.reader = null;
    for (const entry of this.pending.values()) {
      entry.reject(new MailboxReaderError('mailbox_unavailable', 'client_disposed'));
    }
    this.pending.clear();
    child?.kill();
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.initializing) {
      return this.initializing;
    }
    this.disposeChildOnly();

    // The configured command is a bare `node`. Packaged Electron launched from
    // Finder/Dock inherits launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), which
    // has no node, so the spawn failed with ENOENT on every email_code fill.
    // Use the same tool PATH every other Harness CLI spawn gets.
    const child = spawn(this.server.command, this.server.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildCliEnv(),
    });
    this.child = child;
    child.on('error', (error: NodeJS.ErrnoException) => {
      const errno = typeof error.code === 'string' && /^E[A-Z0-9]+$/.test(error.code) ? `:${error.code}` : '';
      this.failAllPending(new MailboxReaderError('mailbox_unavailable', `process_error${errno}`));
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.initializing = null;
      }
      this.failAllPending(
        new MailboxReaderError('mailbox_unavailable', `server_exited:${code ?? signal ?? 'unknown'}`),
      );
    });
    // Surface startup problems (missing accounts.json etc.) without leaking mail.
    child.stderr?.on('data', (chunk: Buffer) => {
      logger.warn('imap MCP server stderr', { line: chunk.toString('utf-8').slice(0, 300) });
    });

    this.reader = createInterface({ input: child.stdout! });
    this.reader.on('line', (line) => this.handleLine(line));

    this.initializing = (async () => {
      const init = await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'aio-browser-gateway', version: '1.0.0' },
      });
      if (init.error) {
        throw new MailboxReaderError('mailbox_unavailable', 'initialize_failed');
      }
      this.notify('notifications/initialized');
    })().catch((error: unknown) => {
      // A failed handshake must not poison every later call — drop the child
      // so the next call respawns cleanly.
      this.disposeChildOnly();
      throw error;
    });
    return this.initializing;
  }

  private disposeChildOnly(): void {
    if (this.child) {
      this.child.removeAllListeners();
      this.child.kill();
      this.child = null;
    }
    this.reader?.close();
    this.reader = null;
    this.initializing = null;
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // Non-JSON noise on stdout is ignored.
    }
    if (typeof message.id !== 'number') {
      return; // Server notification — nothing pending on it.
    }
    const entry = this.pending.get(message.id);
    if (entry) {
      this.pending.delete(message.id);
      entry.resolve(message);
    }
  }

  private failAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** `label` names the request in a timeout; it must be a fixed string, never page or mail data. */
  private request(
    method: string,
    params: Record<string, unknown>,
    label: string = method,
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const child = this.child;
    if (!child?.stdin?.writable) {
      return Promise.reject(new MailboxReaderError('mailbox_unavailable', 'not_running'));
    }
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new MailboxReaderError('mailbox_timeout', label));
      }, this.callTimeoutMs);
      timeout.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private notify(method: string): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }
}

interface ImapSearchSummary {
  uid: number;
  from?: string;
  subject?: string;
  date?: string;
  snippet?: string;
}

interface ImapReadMessage {
  from?: string;
  subject?: string;
  date?: string;
  text?: string;
  html?: string;
}

export interface ImapMcpMailboxReaderOptions {
  server: ImapMcpServerCommand;
  /** Account selector (id / email / fragment). Default: the server's default account. */
  account?: string;
  mailbox?: string;
  /** Max messages whose bodies are fetched per search (newest first). */
  bodyFetchLimit?: number;
  /** Injectable for tests. */
  client?: Pick<ImapMcpClient, 'callTool'>;
  now?: () => number;
}

export class ImapMcpMailboxReader implements MailboxReader {
  private readonly client: Pick<ImapMcpClient, 'callTool'>;
  private readonly account?: string;
  private readonly mailbox: string;
  private readonly bodyFetchLimit: number;
  private readonly now: () => number;

  constructor(options: ImapMcpMailboxReaderOptions) {
    this.client = options.client ?? new ImapMcpClient(options.server);
    this.account = options.account;
    this.mailbox = options.mailbox ?? 'INBOX';
    this.bodyFetchLimit = options.bodyFetchLimit ?? DEFAULT_BODY_FETCH_LIMIT;
    this.now = options.now ?? (() => Date.now());
  }

  async search(criteria: MailboxSearchCriteria): Promise<MailboxMessage[]> {
    const limit = Math.min(criteria.limit ?? this.bodyFetchLimit, this.bodyFetchLimit);
    const senderDomains = [...new Set(criteria.senderDomains.map((domain) => domain.toLowerCase()))];
    // One server-side search per sender domain, so unrelated mail is never
    // fetched and a busy inbox cannot push the code out of the result window.
    const byUid = new Map<number, ImapSearchSummary>();
    for (const domain of senderDomains) {
      const summaries = await this.client.callTool('search_messages', {
        ...(this.account ? { account: this.account } : {}),
        mailbox: this.mailbox,
        // IMAP FROM is a substring match on the whole header, so it is only a
        // pre-filter: the exact domain check below decides.
        from: domain,
        // IMAP SINCE is date-granular; post-filter by exact receivedAt below.
        since: new Date(criteria.sinceMs).toISOString().slice(0, 10),
        limit: Math.min(Math.max(limit * 2, 10), 100),
      });
      if (!Array.isArray(summaries)) {
        throw new MailboxReaderError('mailbox_unavailable', 'invalid_search_result');
      }
      for (const summary of summaries as ImapSearchSummary[]) {
        byUid.set(summary.uid, summary);
      }
    }

    const recent = [...byUid.values()]
      .filter((summary) => senderMatchesDomains(summary.from ?? '', senderDomains))
      .map((summary) => ({ summary, receivedAt: parseDate(summary.date) }))
      .filter((entry) => entry.receivedAt >= criteria.sinceMs)
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, limit);

    logger.info('Mailbox search completed', {
      senderDomains: senderDomains.length,
      candidates: byUid.size,
      withinWindow: recent.length,
    });

    const messages: MailboxMessage[] = [];
    for (const entry of recent) {
      messages.push(await this.toMessage(entry.summary, entry.receivedAt));
    }
    return messages;
  }

  private async toMessage(
    summary: ImapSearchSummary,
    receivedAt: number,
  ): Promise<MailboxMessage> {
    let textBody = summary.snippet ?? '';
    try {
      const full = (await this.client.callTool('read_message', {
        ...(this.account ? { account: this.account } : {}),
        mailbox: this.mailbox,
        uid: summary.uid,
      })) as ImapReadMessage;
      textBody = full.text?.trim() || stripHtml(full.html) || textBody;
    } catch (error) {
      // A per-message tool error (the message moved, a parse problem) falls
      // back to the search snippet; the code may still be extractable there. A
      // dead or wedged server is not per-message: every later read would fail
      // the same way, one timeout at a time, so stop and report it.
      if (!(error instanceof MailboxReaderError && error.detail === 'tool_error')) {
        throw error;
      }
      logger.warn('Failed to read full message body; using snippet', { failure: error.detail });
    }
    return {
      id: String(summary.uid),
      from: summary.from ?? '',
      subject: summary.subject ?? '',
      textBody,
      receivedAt: receivedAt || this.now(),
    };
  }
}

function parseDate(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stripHtml(html: string | undefined): string {
  if (!html) {
    return '';
  }
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
