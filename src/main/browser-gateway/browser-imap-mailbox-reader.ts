import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type {
  MailboxMessage,
  MailboxReader,
  MailboxSearchCriteria,
} from './browser-email-code-reader';
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
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error) {
      throw new Error(`imap MCP call failed: ${response.error.message ?? 'unknown error'}`);
    }
    const result = response.result as McpToolCallResult | undefined;
    const text = result?.content?.find((block) => block.type === 'text')?.text;
    if (result?.isError) {
      throw new Error(`imap MCP tool error: ${text ?? 'unknown tool error'}`);
    }
    if (text === undefined) {
      throw new Error('imap MCP tool returned no text content');
    }
    return JSON.parse(text);
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.initializing = null;
    this.reader?.close();
    this.reader = null;
    for (const entry of this.pending.values()) {
      entry.reject(new Error('imap MCP client disposed'));
    }
    this.pending.clear();
    child?.kill();
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.initializing) {
      return this.initializing;
    }
    this.disposeChildOnly();

    const child = spawn(this.server.command, this.server.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.on('error', (error) => this.failAllPending(error));
    child.on('exit', (code) => {
      if (this.child === child) {
        this.child = null;
        this.initializing = null;
      }
      this.failAllPending(new Error(`imap MCP server exited (code ${code ?? 'unknown'})`));
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
        throw new Error(`imap MCP initialize failed: ${init.error.message ?? 'unknown'}`);
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

  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const child = this.child;
    if (!child?.stdin?.writable) {
      return Promise.reject(new Error('imap MCP server is not running'));
    }
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`imap MCP request timed out: ${method}`));
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
    const summaries = (await this.client.callTool('search_messages', {
      ...(this.account ? { account: this.account } : {}),
      mailbox: this.mailbox,
      // IMAP SINCE is date-granular; post-filter by exact receivedAt below.
      since: new Date(criteria.sinceMs).toISOString().slice(0, 10),
      limit: Math.min(Math.max(limit * 2, 10), 100),
    })) as ImapSearchSummary[];

    const recent = summaries
      .map((summary) => ({ summary, receivedAt: parseDate(summary.date) }))
      .filter((entry) => entry.receivedAt >= criteria.sinceMs)
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, limit);

    logger.info('Mailbox search completed', {
      candidates: summaries.length,
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
      // Fall back to the search snippet; the code may still be extractable.
      logger.warn('Failed to read full message body; using snippet', {
        error: error instanceof Error ? error.message : String(error),
      });
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
