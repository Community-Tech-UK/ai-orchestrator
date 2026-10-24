import type { CodexAppServerRuntimeClient } from './app-server-thread-runtime';
import type { AppServerNotification, AppServerResponseResult } from './app-server-types';
import type { CliAsyncWorkEvent } from '../claude-cli-async-work';
import { getLogger } from '../../../logging/logger';
import { errorDiagnostic } from '../../../logging/source-diagnostics';

const logger = getLogger('CodexBackgroundTerminals');
const REFRESH_TIMEOUT_MS = 3_000;
type Terminal = { itemId: string; processId: string; command: string; cwd: string };
type Work = { itemId: string; command: string };

/** A complete, time-bounded snapshot. Partial or malformed lists never clear protection. */
export async function listBackgroundTerminals(client: CodexAppServerRuntimeClient, threadId: string): Promise<Terminal[]> {
  const deadline = Date.now() + REFRESH_TIMEOUT_MS;
  const terminals: Terminal[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Codex background terminal refresh timed out');
    const page: AppServerResponseResult<'thread/backgroundTerminals/list'> = await client.request('thread/backgroundTerminals/list', { threadId, cursor, limit: 100 }, remaining);
    if (!page || !Array.isArray(page.data) || page.data.some((item) => !item
      || typeof item.itemId !== 'string' || typeof item.processId !== 'string'
      || typeof item.command !== 'string' || typeof item.cwd !== 'string')
      || (page.nextCursor != null && typeof page.nextCursor !== 'string')) {
      throw new Error('Invalid Codex background terminal list');
    }
    terminals.push(...page.data);
    cursor = page.nextCursor ?? null;
    if (cursor !== null && cursors.has(cursor)) throw new Error('Repeated Codex background terminal cursor');
    if (cursor !== null) cursors.add(cursor);
  } while (cursor !== null);
  return terminals;
}

function unsupported(error: unknown): boolean {
  const value = error as { rpcCode?: unknown; message?: unknown } | null;
  return value?.rpcCode === -32601 || (typeof value?.message === 'string'
    && /method (?:not found|not supported)|unknown method|experimental (?:api|capability).*required|requires.*experimental|unsupported.*(?:method|capability)/i.test(value.message));
}

/** One tracker per adapter, with a synchronous inhibitor before turn completion becomes idle. */
export class CodexBackgroundTerminalTracker {
  private client: CodexAppServerRuntimeClient | null = null;
  private threadId: string | null = null;
  private work = new Map<string, Work>();
  private readonly unfinished = new Map<string, Work>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<boolean> | null = null;
  private epoch = 0;
  private revision = 0;
  private unsupported = false;
  private stopping = false;

  constructor(
    private readonly emit: (event: CliAsyncWorkEvent) => void,
    private readonly stopped: (count: number, commands: string[]) => void,
  ) {}

  bind(client: CodexAppServerRuntimeClient, threadId: string): void {
    if (client === this.client && threadId === this.threadId) return;
    this.reset();
    this.client = client;
    this.threadId = threadId;
  }

  hasWork(): boolean { return this.work.size > 0; }

  observe(notification: AppServerNotification): void {
    if (!this.threadId || notification.params['threadId'] !== this.threadId) return;
    const { method, params } = notification;
    const item = params['item'] as { id?: string; type?: string; command?: string; status?: string } | undefined;
    if ((method === 'item/started' || method === 'item/completed') && item?.type === 'commandExecution' && item.id) {
      this.revision++;
      if (method === 'item/started' || item.status === 'inProgress') {
        this.unfinished.set(item.id, { itemId: item.id, command: item.command ?? '' });
      } else {
        this.unfinished.delete(item.id);
        for (const [id, work] of this.work) {
          if (work.itemId === item.id) {
            this.work.delete(id);
            this.complete(id, work);
          }
        }
        this.publish();
      }
    }
    if (method === 'turn/completed' && (this.unfinished.size > 0 || this.hasWork())) {
      this.revision++;
      const knownItems = new Set([...this.work.values()].map((work) => work.itemId));
      for (const [id, work] of this.unfinished) {
        if (!knownItems.has(id)) this.work.set(`codex-item:${id}`, work);
      }
      this.publish();
      void this.refresh().catch((error) => this.logRefreshFailure(error));
    }
  }

  refresh(stopping = false): Promise<boolean> {
    this.stopping ||= stopping;
    if (this.inFlight) return this.inFlight;
    if (!this.client || !this.threadId) return Promise.resolve(false);
    if (this.unsupported) return Promise.resolve(this.hasWork());
    const epoch = this.epoch;
    const promise = this.readSnapshot(epoch).finally(() => {
      if (this.inFlight === promise) this.inFlight = null;
      if (epoch === this.epoch) this.armTimer();
    });
    this.inFlight = promise;
    return promise;
  }

  private async readSnapshot(epoch: number): Promise<boolean> {
    const revision = this.revision;
    let terminals: Terminal[];
    try {
      terminals = await listBackgroundTerminals(this.client!, this.threadId!);
    } catch (error) {
      if (epoch !== this.epoch) return this.hasWork();
      if (!unsupported(error)) throw error;
      this.unsupported = true;
      logger.warn('Codex background terminal listing is unsupported; tracking unfinished command items');
      return this.hasWork();
    }
    if (epoch !== this.epoch) return this.hasWork();
    // Item events arriving during a list can make its result stale. Keep the
    // inhibitor and require a later authoritative read before allowing sleep.
    if (revision !== this.revision) throw new Error('Codex background terminals changed during refresh');
    const next = new Map<string, Work>(terminals.map((terminal) => [
      `codex-term:${terminal.processId}`, { itemId: terminal.itemId, command: terminal.command },
    ]));
    const listedItems = new Set(terminals.map((terminal) => terminal.itemId));
    for (const [id, work] of this.work) {
      if (!next.has(id) && !listedItems.has(work.itemId)) {
        this.unfinished.delete(work.itemId);
        this.complete(id, work);
      }
    }
    this.work = next;
    this.publish();
    return this.hasWork();
  }

  private complete(workId: string, work: Work): void {
    this.emit({ phase: 'terminal', workId, kind: 'background-shell', status: 'completed', ...(this.stopping ? { continueOnCompletion: false } : {}), detail: work.command.slice(0, 120) });
  }

  private publish(): void {
    this.emit({ phase: 'snapshot', work: [...this.work.keys()].map((workId) => ({ workId, kind: 'background-shell' })) });
    this.armTimer();
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.hasWork()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch((error) => this.logRefreshFailure(error));
    }, 60_000);
    this.timer.unref?.();
  }

  private logRefreshFailure(error: unknown): void {
    logger.warn('Could not refresh Codex background commands; keeping sleep protection', errorDiagnostic(error));
  }

  reportStopped(): void {
    if (this.hasWork()) this.stopped(this.work.size, [...this.work.values()].map((work) => work.command.slice(0, 120)));
    this.reset();
  }

  reset(): void {
    this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.inFlight = null;
    this.work.clear();
    this.unfinished.clear();
    this.client = null;
    this.threadId = null;
    this.unsupported = false;
    this.stopping = false;
    this.publish();
  }
}
