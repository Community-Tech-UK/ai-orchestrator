import type { RawMcpRecord } from '../redaction-service';

export interface CodexTomlServer {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  transport?: 'stdio' | 'sse' | 'http';
  description?: string;
}

interface Section {
  name: string;
  lines: string[];
}

export class CodexTomlEditor {
  stripMcpServers(input: string): string {
    return this.filterSections(input, () => false);
  }

  deleteMcpServer(input: string, name: string): string {
    return this.filterSections(input, (serverName) => serverName !== name);
  }

  upsertMcpServer(input: string, name: string, entry: CodexTomlServer): string {
    const without = this.deleteMcpServer(input, name).replace(/\n+$/, '');
    const block = this.serializeBlock(name, entry);
    return `${without}${without ? '\n\n' : ''}${block}\n`;
  }

  parseMcpServers(input: string): Record<string, CodexTomlServer> {
    const servers: Record<string, CodexTomlServer> = {};
    for (const section of this.parseSections(input)) {
      const name = this.parseMcpSectionName(section.name);
      if (!name) {
        continue;
      }
      servers[name] = this.parseServerBody(section.lines);
    }
    return servers;
  }

  toCodexServer(record: RawMcpRecord): CodexTomlServer {
    return {
      command: record.command,
      args: record.args,
      url: record.url,
      headers: record.headers,
      env: record.env,
      transport: record.transport === 'stdio' ? undefined : record.transport,
      description: record.description,
    };
  }

  private filterSections(input: string, keepMcp: (serverName: string) => boolean): string {
    const lines = input.split('\n');
    const out: string[] = [];
    let skipping = false;
    for (const line of lines) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (header) {
        const sectionName = header[1] ?? '';
        const mcpName = this.parseMcpSectionName(sectionName) ?? this.parseNestedMcpTable(sectionName)?.name ?? null;
        skipping = mcpName !== null && !keepMcp(mcpName);
      }
      if (!skipping) {
        out.push(line);
      }
    }
    return out.join('\n');
  }

  private parseSections(input: string): Section[] {
    const sections: Section[] = [];
    let current: Section | null = null;
    for (const line of input.split('\n')) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (header) {
        const sectionName = header[1] ?? '';
        const nested = this.parseNestedMcpTable(sectionName);
        if (nested && current && this.parseMcpSectionName(current.name) === nested.name) {
          current.lines.push(line);
          continue;
        }
        current = { name: sectionName, lines: [] };
        sections.push(current);
      } else if (current) {
        current.lines.push(line);
      }
    }
    return sections;
  }

  private parseMcpSectionName(sectionName: string): string | null {
    const match = sectionName.match(/^mcp_servers\.(?:"([^"]+)"|([^.]+))$/);
    return match ? (match[1] ?? match[2] ?? null) : null;
  }

  private parseNestedMcpTable(sectionName: string): { name: string; table: 'env' | 'headers' } | null {
    const match = sectionName.match(/^mcp_servers\.(?:"([^"]+)"|([^.]+))\.(env|headers)$/);
    if (!match) {
      return null;
    }
    return {
      name: match[1] ?? match[2] ?? '',
      table: match[3] as 'env' | 'headers',
    };
  }

  private parseServerBody(lines: string[]): CodexTomlServer {
    const server: CodexTomlServer = {};
    let currentTable: 'env' | 'headers' | null = null;
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+#.*$/, '').trim();
      if (!line) continue;
      const table = line.match(/^\[(?:mcp_servers\.(?:"[^"]+"|[^\]]+)\.)?(env|headers)\]$/);
      if (table) {
        currentTable = table[1] as 'env' | 'headers';
        continue;
      }
      const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
      if (!assignment) continue;
      const key = assignment[1] ?? '';
      const value = assignment[2] ?? '';
      if (currentTable) {
        const bucket = server[currentTable] ?? {};
        bucket[key] = this.parseString(value) ?? '';
        server[currentTable] = bucket;
        continue;
      }
      if (key === 'args') {
        server.args = this.parseArray(value);
      } else if (key === 'command' || key === 'url' || key === 'transport' || key === 'description') {
        (server as Record<string, unknown>)[key] = this.parseString(value);
      }
    }
    return server;
  }

  private serializeBlock(name: string, entry: CodexTomlServer): string {
    const sectionName = /^[A-Za-z0-9_-]+$/.test(name)
      ? `mcp_servers.${name}`
      : `mcp_servers.${JSON.stringify(name)}`;
    const lines = [`[${sectionName}]`];
    if (entry.command) lines.push(`command = ${JSON.stringify(entry.command)}`);
    if (entry.args) lines.push(`args = [${entry.args.map((arg) => JSON.stringify(arg)).join(', ')}]`);
    if (entry.url) lines.push(`url = ${JSON.stringify(entry.url)}`);
    if (entry.transport && entry.transport !== 'stdio') {
      lines.push(`transport = ${JSON.stringify(entry.transport)}`);
    }
    if (entry.description) lines.push(`description = ${JSON.stringify(entry.description)}`);
    this.appendTable(lines, sectionName, 'headers', entry.headers);
    this.appendTable(lines, sectionName, 'env', entry.env);
    return lines.join('\n');
  }

  private appendTable(
    lines: string[],
    sectionName: string,
    key: 'headers' | 'env',
    value: Record<string, string> | undefined,
  ): void {
    if (!value || Object.keys(value).length === 0) {
      return;
    }
    lines.push('', `[${sectionName}.${key}]`);
    for (const [entryKey, entryValue] of Object.entries(value)) {
      lines.push(`${entryKey} = ${JSON.stringify(entryValue)}`);
    }
  }

  private parseString(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed.startsWith('"')) {
      return trimmed;
    }
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  private parseArray(value: string): string[] | undefined {
    const trimmed = value.trim();
    if (!trimmed.startsWith('[')) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
        ? parsed
        : undefined;
    } catch {
      return trimmed
        .slice(1, -1)
        .split(',')
        .map((item) => this.parseString(item.trim()) ?? '')
        .filter(Boolean);
    }
  }
}
