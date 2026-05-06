import * as os from 'node:os';
import * as path from 'node:path';
import { getSettingsManager } from '../core/config/settings-manager';
import { getRLMDatabase } from '../persistence/rlm-database';
import { registerCleanup } from '../util/cleanup-registry';
import { CliMcpConfigService } from './cli-mcp-config-service';
import { OrchestratorInjectionReader } from './orchestrator-injection-reader';
import { OrchestratorMcpRepository } from './orchestrator-mcp-repository';
import { RedactionService } from './redaction-service';
import { SecretClassifier } from './secret-classifier';
import { getMcpSecretStorage } from './secret-storage';
import { SharedMcpCoordinator } from './shared-mcp-coordinator';
import { SharedMcpRepository } from './shared-mcp-repository';
import { WriteSafetyHelper } from './write-safety-helper';
import type { SupportedProvider } from '../../shared/types/mcp-scopes.types';
import type { ProviderMcpAdapter } from './adapters/provider-mcp-adapter.types';
import { ClaudeMcpAdapter } from './adapters/claude-mcp-adapter';
import { CodexMcpAdapter } from './adapters/codex-mcp-adapter';
import { CopilotMcpAdapter } from './adapters/copilot-mcp-adapter';
import { GeminiMcpAdapter } from './adapters/gemini-mcp-adapter';

let orchestratorRepo: OrchestratorMcpRepository | null = null;
let sharedRepo: SharedMcpRepository | null = null;
let sharedCoordinator: SharedMcpCoordinator | null = null;
let cliService: CliMcpConfigService | null = null;
let injectionReader: OrchestratorInjectionReader | null = null;
let writeSafetyInstance: WriteSafetyHelper | null = null;
let cleanupRegistered = false;

function homeDir(): string {
  return process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();
}

function cwdProvider(): string {
  const cwd = getSettingsManager().get('defaultWorkingDirectory');
  return cwd || process.cwd();
}

function writeSafety(): WriteSafetyHelper {
  if (writeSafetyInstance) {
    return writeSafetyInstance;
  }
  const settingsManager = getSettingsManager();
  writeSafetyInstance = new WriteSafetyHelper(readWriteSafetyOptions());
  settingsManager.on('setting:mcpAllowWorldWritableParent', () => {
    writeSafetyInstance?.updateOptions(readWriteSafetyOptions());
  });
  settingsManager.on('setting:mcpDisableProviderBackups', () => {
    writeSafetyInstance?.updateOptions(readWriteSafetyOptions());
  });
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    registerCleanup(async () => {
      if (getSettingsManager().get('mcpCleanupBackupsOnQuit')) {
        await writeSafetyInstance?.cleanupBackups();
      }
    });
  }
  return writeSafetyInstance;
}

function readWriteSafetyOptions(): {
  allowWorldWritableParent: boolean;
  writeBackups: boolean;
} {
  const settings = getSettingsManager().getAll();
  return {
    allowWorldWritableParent: settings.mcpAllowWorldWritableParent,
    writeBackups: !settings.mcpDisableProviderBackups,
  };
}

function buildAdapters(): Record<SupportedProvider, ProviderMcpAdapter> {
  const home = homeDir();
  const safety = writeSafety();
  return {
    claude: new ClaudeMcpAdapter({ home, writeSafety: safety }),
    codex: new CodexMcpAdapter({ codexHome: path.join(home, '.codex'), writeSafety: safety }),
    gemini: new GeminiMcpAdapter({ home, writeSafety: safety }),
    copilot: new CopilotMcpAdapter({ home, writeSafety: safety }),
  };
}

export function getOrchestratorMcpRepository(): OrchestratorMcpRepository {
  if (!orchestratorRepo) {
    orchestratorRepo = new OrchestratorMcpRepository(
      getRLMDatabase().getRawDb(),
      getMcpSecretStorage(),
    );
  }
  return orchestratorRepo;
}

export function getSharedMcpRepository(): SharedMcpRepository {
  if (!sharedRepo) {
    sharedRepo = new SharedMcpRepository(getRLMDatabase().getRawDb(), getMcpSecretStorage());
  }
  return sharedRepo;
}

export function getSharedMcpCoordinator(): SharedMcpCoordinator {
  if (!sharedCoordinator) {
    sharedCoordinator = new SharedMcpCoordinator({
      repo: getSharedMcpRepository(),
      adapters: buildAdapters(),
      cwdProvider,
    });
  }
  return sharedCoordinator;
}

export function getCliMcpConfigService(): CliMcpConfigService {
  if (!cliService) {
    cliService = new CliMcpConfigService({
      adapters: buildAdapters(),
      orchestratorRepo: getOrchestratorMcpRepository(),
      sharedRepo: getSharedMcpRepository(),
      sharedCoordinator: getSharedMcpCoordinator(),
      redaction: new RedactionService(new SecretClassifier()),
      cwdProvider,
    });
  }
  return cliService;
}

export function getOrchestratorInjectionReader(): OrchestratorInjectionReader {
  if (!injectionReader) {
    injectionReader = new OrchestratorInjectionReader(getOrchestratorMcpRepository());
  }
  return injectionReader;
}

export function _resetMcpMultiProviderSingletonsForTesting(): void {
  orchestratorRepo = null;
  sharedRepo = null;
  sharedCoordinator = null;
  cliService = null;
  injectionReader = null;
  writeSafetyInstance = null;
  cleanupRegistered = false;
}
