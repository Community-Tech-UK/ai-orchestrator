import { open, realpath, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CopilotNumericUsage } from '../../../../shared/utils/copilot-usage';

const TYPES = new Set(['session.usage_record', 'session.usage_checkpoint', 'session.compaction_complete', 'session.shutdown']);
const MAX_READ = 256 * 1024;
const MAX_LINE = 64 * 1024;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : {};
const counter = (value: unknown): number | undefined => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Bounded read-only session tail. Only counters/offsets survive a poll, never JSON or message bodies. */
export class CopilotEventsTail {
  private offset = 0;
  private identity = '';
  private lastSize = -1;
  private lastChange = '';
  private boundary: number | undefined;
  private skippingLine = false;
  private overflow = false;
  private usage: CopilotNumericUsage = { compactions: 0 };
  private inFlight: Promise<CopilotNumericUsage> | undefined;

  constructor(private readonly home: string, private readonly sessionId: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(sessionId)) throw new Error('Invalid Copilot session ID');
  }

  poll(): Promise<CopilotNumericUsage> {
    this.inFlight ??= this.read().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async read(): Promise<CopilotNumericUsage> {
    let handle: FileHandle | undefined;
    try {
      const home = await realpath(this.home);
      const expected = join(home, 'session-state', this.sessionId, 'events.jsonl');
      // Check every ancestry component via realpath. A sibling account's symlink is never a session source.
      if (await realpath(expected) !== resolve(expected)) throw new Error('Copilot session containment check failed');
      handle = await open(expected, 'r');
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) throw new Error('Copilot events source is not a regular file');
      const size = Number(stat.size), identity = `${stat.dev}:${stat.ino}`;
      const change = `${stat.mtimeNs}:${stat.ctimeNs}`;
      if (identity === this.identity && size === this.lastSize && change === this.lastChange && this.offset >= size) return { ...this.usage };
      const rewritten = (size === this.lastSize && change !== this.lastChange)
        || (this.boundary !== undefined && size >= this.offset && this.boundary !== await fingerprint(handle, this.offset));
      if (identity !== this.identity || size < this.offset || rewritten) {
        this.offset = 0; this.skippingLine = false; this.overflow = false;
        this.usage = { compactions: 0 }; this.boundary = undefined;
      }
      this.identity = identity;
      const buffer = Buffer.alloc(Math.min(MAX_READ, Math.max(0, size - this.offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
      let start = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] !== 10) continue;
        if (!this.skippingLine && i - start <= MAX_LINE) this.consume(buffer.subarray(start, i).toString('utf8'));
        this.skippingLine = false;
        start = i + 1;
      }
      // Re-read short partial lines next time instead of retaining transcript bytes.
      // Oversized lines are discarded through the next newline, even across polls.
      if (this.skippingLine || bytesRead - start > MAX_LINE) {
        this.skippingLine = true; this.offset += bytesRead;
      } else this.offset += start;
      this.boundary = await fingerprint(handle, this.offset);
      this.lastSize = size; this.lastChange = change;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.usage = { compactions: 0 }; this.identity = ''; this.offset = 0; this.boundary = undefined;
    } finally { await handle?.close(); }
    return { ...this.usage };
  }

  private consume(line: string): void {
    let event: Record<string, unknown>;
    try { event = record(JSON.parse(line)); } catch { return; }
    if (typeof event['type'] !== 'string' || !TYPES.has(event['type'])) return;
    const data = record(event['data']);
    if ((event['sessionId'] !== undefined && event['sessionId'] !== this.sessionId)
      || (data['sessionId'] !== undefined && data['sessionId'] !== this.sessionId)) return;
    const root = event['agentId'] === undefined && data['agentId'] === undefined;
    if (event['type'] === 'session.usage_record') {
      const usage = record(data['usage']);
      const cost = counter(usage['cost']);
      if (cost !== undefined && !this.overflow) {
        const total = (this.usage.premiumRequests ?? 0) + cost;
        if (Number.isFinite(total)) this.usage.premiumRequests = total;
        else { delete this.usage.premiumRequests; this.overflow = true; }
      }
      const limit = counter(usage['maxPromptTokens']);
      if (root && limit && limit > 0) this.usage.tokenLimit = limit;
    } else if (root && event['type'] === 'session.compaction_complete') {
      if (data['success'] === true) {
        this.usage.compactions++;
        this.usage.postCompactionTokens = counter(data['postCompactionTokens']);
      }
    } else if (root) {
      const total = counter(data['totalPremiumRequests']) ?? counter(record(data['accountingSnapshot'])['totalPremiumRequestCost']);
      if (total !== undefined) { this.usage.premiumRequests = total; this.overflow = false; }
    }
  }
}

/** Numeric boundary hash detects truncate-and-regrow without holding transcript bytes between polls. */
async function fingerprint(handle: FileHandle, offset: number): Promise<number> {
  const bytes = Buffer.alloc(Math.min(offset, 64));
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset - bytes.length);
  let hash = 2166136261;
  for (let i = 0; i < bytesRead; i++) hash = Math.imul(hash ^ bytes[i], 16777619) >>> 0;
  return hash;
}
