import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopAuditEntry } from '../../shared/types/desktop-gateway.types';

const MAX_AUDIT_FILE_BYTES = 5 * 1024 * 1024;
const RETAINED_AUDIT_FILE_BYTES = 2 * 1024 * 1024;

export interface DesktopGatewayAuditStore {
  append(entry: DesktopAuditEntry): Promise<void> | void;
  list(filter: { instanceId?: string; appId?: string; limit?: number }): Promise<DesktopAuditEntry[]> | DesktopAuditEntry[];
}

export class InMemoryDesktopGatewayAuditStore implements DesktopGatewayAuditStore {
  private readonly entries: DesktopAuditEntry[] = [];

  append(entry: DesktopAuditEntry): void {
    this.entries.push(entry);
  }

  list(filter: { instanceId?: string; appId?: string; limit?: number }): DesktopAuditEntry[] {
    return filterAuditEntries(this.entries, filter);
  }
}

export class FileDesktopGatewayAuditStore implements DesktopGatewayAuditStore {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'desktop-gateway-audit.jsonl');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.filePath)) {
      fs.chmodSync(this.filePath, 0o600);
    }
  }

  append(entry: DesktopAuditEntry): void {
    this.rotateIfNeeded();
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  list(filter: { instanceId?: string; appId?: string; limit?: number }): DesktopAuditEntry[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    const lines = fs.readFileSync(this.filePath, 'utf-8')
      .split('\n')
      .filter(Boolean);
    const entries = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as DesktopAuditEntry];
      } catch {
        return [];
      }
    });
    return filterAuditEntries(entries, filter);
  }

  private rotateIfNeeded(): void {
    if (!fs.existsSync(this.filePath) || fs.statSync(this.filePath).size <= MAX_AUDIT_FILE_BYTES) {
      return;
    }
    const current = fs.readFileSync(this.filePath);
    const tail = current.subarray(Math.max(0, current.length - RETAINED_AUDIT_FILE_BYTES));
    const firstNewline = tail.indexOf(0x0a);
    const completeLines = firstNewline >= 0 ? tail.subarray(firstNewline + 1) : Buffer.alloc(0);
    fs.writeFileSync(this.filePath, completeLines, { mode: 0o600 });
  }
}

function filterAuditEntries(
  entries: DesktopAuditEntry[],
  filter: { instanceId?: string; appId?: string; limit?: number },
): DesktopAuditEntry[] {
  const limit = filter.limit ?? 50;
  return entries
    .filter((entry) => !filter.instanceId || entry.instanceId === filter.instanceId)
    .filter((entry) => !filter.appId || entry.appId === filter.appId)
    .slice(-limit)
    .reverse();
}
