import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopAuditEntry } from '../../shared/types/desktop-gateway.types';

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
  }

  append(entry: DesktopAuditEntry): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' });
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
