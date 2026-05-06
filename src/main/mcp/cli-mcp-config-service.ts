import { shell } from 'electron';
import type {
  McpMultiProviderStateDto,
  OrchestratorMcpDto,
  ProviderTabDto,
  SharedMcpDto,
} from '../../shared/types/mcp-dtos.types';
import { SUPPORTED_PROVIDERS, type ProviderMcpScope, type SupportedProvider } from '../../shared/types/mcp-scopes.types';
import { RedactionService, type RawMcpRecord } from './redaction-service';
import type { ProviderMcpAdapter } from './adapters/provider-mcp-adapter.types';
import type { OrchestratorMcpRecordWithTargets, OrchestratorMcpRepository } from './orchestrator-mcp-repository';
import type { SharedMcpRepository } from './shared-mcp-repository';
import type { SharedMcpCoordinator } from './shared-mcp-coordinator';

export interface CliMcpConfigServiceDeps {
  adapters: Record<SupportedProvider, ProviderMcpAdapter>;
  orchestratorRepo: OrchestratorMcpRepository;
  sharedRepo: SharedMcpRepository;
  sharedCoordinator: SharedMcpCoordinator;
  redaction: RedactionService;
  cwdProvider: () => string;
}

export class CliMcpConfigService {
  private stateVersion = 0;

  constructor(private readonly deps: CliMcpConfigServiceDeps) {}

  async getMultiProviderState(): Promise<McpMultiProviderStateDto> {
    return {
      orchestrator: this.getOrchestratorDtos(),
      shared: await this.getSharedDtos(),
      providers: await this.getProviderTabs(),
      stateVersion: this.stateVersion,
    };
  }

  async refreshMultiProviderState(): Promise<McpMultiProviderStateDto> {
    this.bumpStateVersion();
    return this.getMultiProviderState();
  }

  orchestratorUpsert(payload: Parameters<OrchestratorMcpRepository['upsert']>[0]): OrchestratorMcpRecordWithTargets {
    const saved = this.deps.orchestratorRepo.upsert(payload);
    this.bumpStateVersion();
    return saved;
  }

  orchestratorDelete(serverId: string): void {
    this.deps.orchestratorRepo.delete(serverId);
    this.bumpStateVersion();
  }

  orchestratorSetInjectionTargets(serverId: string, providers: readonly SupportedProvider[]): void {
    this.deps.orchestratorRepo.setInjectionTargets(serverId, providers);
    this.bumpStateVersion();
  }

  sharedUpsert(payload: Parameters<SharedMcpRepository['upsert']>[0]): string {
    const saved = this.deps.sharedRepo.upsert(payload);
    this.bumpStateVersion();
    return saved.id;
  }

  sharedDelete(serverId: string): void {
    this.deps.sharedRepo.delete(serverId);
    this.bumpStateVersion();
  }

  async providerUserUpsert(payload: RawMcpRecord & { provider: SupportedProvider }): Promise<void> {
    const adapter = this.deps.adapters[payload.provider];
    const sourceFile = await this.getUserScopeFile(adapter);
    const existingSnapshot = await adapter.readScope('user', sourceFile).catch(() => null);
    const existing = existingSnapshot?.servers.find((server) =>
      server.id === payload.id || server.name === payload.name
    );
    const transport = payload.transport ?? existing?.transport ?? 'stdio';
    await adapter.writeUserServer({
      kind: 'upsert',
      sourceFile,
      record: {
        ...(existing ?? {}),
        ...payload,
        id: payload.id || `${payload.provider}:user:${payload.name}`,
        transport,
        command: transport === 'stdio' ? payload.command ?? existing?.command : undefined,
        args: transport === 'stdio' ? payload.args ?? existing?.args : undefined,
        url: transport !== 'stdio' ? payload.url ?? existing?.url : undefined,
        headers: payload.headers
          ? { ...(existing?.headers ?? {}), ...payload.headers }
          : existing?.headers,
        env: payload.env
          ? { ...(existing?.env ?? {}), ...payload.env }
          : existing?.env,
        autoConnect: payload.autoConnect ?? true,
        createdAt: existing?.createdAt ?? payload.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      },
    });
    this.bumpStateVersion();
  }

  async providerUserDelete(provider: SupportedProvider, serverId: string): Promise<void> {
    const adapter = this.deps.adapters[provider];
    await adapter.writeUserServer({
      kind: 'delete',
      sourceFile: await this.getUserScopeFile(adapter),
      serverId,
    });
    this.bumpStateVersion();
  }

  async providerOpenScopeFile(provider: SupportedProvider, scope: ProviderMcpScope): Promise<{ filePath?: string }> {
    const adapter = this.deps.adapters[provider];
    const discovery = await adapter.discoverScopes({ cwd: this.deps.cwdProvider() });
    const filePath = discovery.scopeFiles[scope];
    if (filePath) {
      await shell.openPath(filePath);
    }
    return { filePath };
  }

  bumpStateVersion(): void {
    this.stateVersion += 1;
  }

  private getOrchestratorDtos(): OrchestratorMcpDto[] {
    return this.deps.orchestratorRepo.list().map(({ record, injectInto }) => ({
      record: this.deps.redaction.redact(record, {
        scope: record.scope,
        readOnly: false,
      }) as OrchestratorMcpDto['record'],
      injectInto,
    }));
  }

  private async getSharedDtos(): Promise<SharedMcpDto[]> {
    const driftById = new Map<string, Awaited<ReturnType<SharedMcpCoordinator['getDrift']>>>();
    for (const record of this.deps.sharedRepo.list()) {
      driftById.set(record.id, await this.deps.sharedCoordinator.getDrift(record.id));
    }
    return this.deps.sharedRepo.list().map((record) => ({
      record: this.deps.redaction.redact({
        ...record,
        autoConnect: true,
      }, {
        scope: 'shared',
        readOnly: false,
        sharedTargets: record.targets,
      }) as SharedMcpDto['record'],
      targets: driftById.get(record.id) ?? [],
    }));
  }

  private async getProviderTabs(): Promise<ProviderTabDto[]> {
    const tabs: ProviderTabDto[] = [];
    for (const provider of SUPPORTED_PROVIDERS) {
      const adapter = this.deps.adapters[provider];
      const discovery = await adapter.discoverScopes({ cwd: this.deps.cwdProvider() });
      const servers = [];
      for (const [scope, filePath] of Object.entries(discovery.scopeFiles) as [ProviderMcpScope, string][]) {
        try {
          const snapshot = await adapter.readScope(scope, filePath);
          for (const server of snapshot.servers) {
            servers.push(this.deps.redaction.redact(server, {
              scope,
              sourceFile: snapshot.sourceFile,
              readOnly: scope !== 'user',
            }));
          }
        } catch {
          // Keep one bad config file from blanking the whole MCP page.
        }
      }
      tabs.push({
        provider,
        cliAvailable: discovery.cliAvailable,
        servers,
      });
    }
    return tabs;
  }

  private async getUserScopeFile(adapter: ProviderMcpAdapter): Promise<string> {
    const discovery = await adapter.discoverScopes({ cwd: this.deps.cwdProvider() });
    const sourceFile = discovery.scopeFiles.user;
    if (!sourceFile) {
      throw new Error(`${adapter.provider} does not expose a user MCP config path`);
    }
    return sourceFile;
  }
}
