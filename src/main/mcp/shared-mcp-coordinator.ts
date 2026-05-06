import type { SharedDriftStatusDto } from '../../shared/types/mcp-dtos.types';
import type { SharedMcpRecord } from '../../shared/types/mcp-shared.types';
import { SUPPORTED_PROVIDERS, type SupportedProvider } from '../../shared/types/mcp-scopes.types';
import type { RawMcpRecord } from './redaction-service';
import type { SharedMcpRepository } from './shared-mcp-repository';
import type { ProviderMcpAdapter } from './adapters/provider-mcp-adapter.types';

export type DriftResolution = 'overwrite-target' | 'adopt-target' | 'untrack-target';

export interface SharedMcpCoordinatorDeps {
  repo: SharedMcpRepository;
  adapters: Record<SupportedProvider, ProviderMcpAdapter>;
  cwdProvider: () => string;
}

export class SharedMcpCoordinator {
  constructor(private readonly deps: SharedMcpCoordinatorDeps) {}

  async fanOut(serverId: string, providers?: readonly SupportedProvider[]): Promise<SharedDriftStatusDto[]> {
    const record = this.mustGet(serverId);
    const targets = providers ?? record.targets;
    const statuses: SharedDriftStatusDto[] = [];
    for (const provider of targets) {
      const adapter = this.deps.adapters[provider];
      const sourceFile = await this.getUserScopeFile(adapter);
      await adapter.writeUserServer({
        kind: 'upsert',
        record: this.toRawRecord(record),
        sourceFile,
      });
      statuses.push({
        provider,
        state: 'in-sync',
        lastObservedAt: Date.now(),
      });
    }
    return statuses;
  }

  async getDrift(serverId: string): Promise<SharedDriftStatusDto[]> {
    const record = this.mustGet(serverId);
    const statuses: SharedDriftStatusDto[] = [];
    for (const provider of SUPPORTED_PROVIDERS) {
      if (!record.targets.includes(provider)) {
        statuses.push({ provider, state: 'not-installed', lastObservedAt: Date.now() });
        continue;
      }
      try {
        const adapter = this.deps.adapters[provider];
        const sourceFile = await this.getUserScopeFile(adapter);
        const snapshot = await adapter.readScope('user', sourceFile);
        const target = snapshot.servers.find((server) => server.name === record.name);
        if (!target) {
          statuses.push({ provider, state: 'missing', lastObservedAt: Date.now() });
          continue;
        }
        const canonical = this.canonicalize(this.toRawRecord(record));
        const observed = this.canonicalize(target);
        statuses.push({
          provider,
          state: canonical === observed ? 'in-sync' : 'drifted',
          diff: canonical === observed ? undefined : this.makeDiff(canonical, observed),
          lastObservedAt: Date.now(),
        });
      } catch (error) {
        statuses.push({
          provider,
          state: 'missing',
          diff: `Failed to read provider MCP config: ${error instanceof Error ? error.message : String(error)}`,
          lastObservedAt: Date.now(),
        });
      }
    }
    return statuses;
  }

  async resolveDrift(
    serverId: string,
    provider: SupportedProvider,
    action: DriftResolution,
  ): Promise<void> {
    const record = this.mustGet(serverId);
    if (action === 'overwrite-target') {
      await this.fanOut(serverId, [provider]);
      return;
    }
    if (action === 'untrack-target') {
      this.deps.repo.upsert({
        ...record,
        targets: record.targets.filter((target) => target !== provider),
      });
      return;
    }

    const adapter = this.deps.adapters[provider];
    const sourceFile = await this.getUserScopeFile(adapter);
    const snapshot = await adapter.readScope('user', sourceFile);
    const target = snapshot.servers.find((server) => server.name === record.name);
    if (!target) {
      throw new Error(`Cannot adopt missing shared MCP target ${record.name} for ${provider}`);
    }
    this.deps.repo.upsert({
      ...record,
      transport: target.transport,
      command: target.command,
      args: target.args,
      url: target.url,
      headers: target.headers,
      env: target.env,
    });
  }

  private async getUserScopeFile(adapter: ProviderMcpAdapter): Promise<string> {
    const discovery = await adapter.discoverScopes({ cwd: this.deps.cwdProvider() });
    const sourceFile = discovery.scopeFiles.user;
    if (!sourceFile) {
      throw new Error(`${adapter.provider} does not expose a user MCP scope`);
    }
    return sourceFile;
  }

  private mustGet(serverId: string): SharedMcpRecord {
    const record = this.deps.repo.get(serverId);
    if (!record) {
      throw new Error(`Shared MCP server not found: ${serverId}`);
    }
    return record;
  }

  private toRawRecord(record: SharedMcpRecord): RawMcpRecord {
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      transport: record.transport,
      command: record.command,
      args: record.args,
      url: record.url,
      headers: record.headers,
      env: record.env,
      autoConnect: true,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private canonicalize(record: RawMcpRecord): string {
    return JSON.stringify({
      transport: record.transport,
      command: record.command ?? null,
      args: record.args ?? [],
      url: record.url ?? null,
      headers: record.headers ?? {},
      env: record.env ?? {},
    });
  }

  private makeDiff(canonical: string, observed: string): string {
    return [
      'canonical:',
      canonical,
      'observed:',
      observed,
    ].join('\n');
  }
}
