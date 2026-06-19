/**
 * CLI Detection Service
 *
 * Handles detection and management of CLI tools:
 * - Scan for available CLIs
 * - Test CLI connections
 * - Track CLI status
 * - Manage CLI configurations
 */

import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { Subject, BehaviorSubject, interval } from 'rxjs';
import { takeUntil, startWith } from 'rxjs/operators';
import { ElectronIpcService } from '../../../../core/services/ipc';
import { VerificationStore } from '../../../../core/state/verification.store';
import type { CliInfo, CliType } from '../../../../../../shared/types/unified-cli-response';
import type { CliStatusInfo, CliStatus, CliScanResult } from '../../../../../../shared/types/verification-ui.types';

// ============================================
// CLI Metadata
// ============================================

interface CliMetadata {
  type: CliType;
  displayName: string;
  command: string;
  installUrl: string;
  authCommand?: string;
  capabilities: string[];
  description: string;
}

const CLI_METADATA: Record<CliType, CliMetadata> = {
  claude: {
    type: 'claude',
    displayName: 'Claude CLI',
    command: 'claude',
    installUrl: 'https://docs.anthropic.com/en/docs/claude-cli',
    authCommand: 'claude auth login',
    capabilities: ['streaming', 'tools', 'vision', 'long-context'],
    description: 'Anthropic\'s Claude Code CLI tool',
  },
  codex: {
    type: 'codex',
    displayName: 'Codex CLI',
    command: 'codex',
    installUrl: 'https://github.com/openai/codex',
    capabilities: ['streaming', 'tools', 'code-execution'],
    description: 'OpenAI Codex CLI for code generation',
  },
  gemini: {
    type: 'gemini',
    displayName: 'Gemini CLI',
    command: 'gemini',
    installUrl: 'https://cloud.google.com/sdk/docs/install',
    authCommand: 'gcloud auth login',
    capabilities: ['streaming', 'vision', 'web-search'],
    description: 'Google Gemini AI CLI',
  },
  antigravity: {
    type: 'antigravity',
    displayName: 'Antigravity',
    command: 'agy',
    installUrl: 'https://antigravity.google',
    authCommand: 'agy',
    capabilities: ['tools', 'web-search'],
    description: 'Google Antigravity CLI (agy) — successor to the Gemini CLI',
  },
  ollama: {
    type: 'ollama',
    displayName: 'Ollama',
    command: 'ollama',
    installUrl: 'https://ollama.ai/download',
    capabilities: ['streaming', 'local', 'file-access'],
    description: 'Local LLM runner',
  },
  aider: {
    type: 'aider',
    displayName: 'Aider',
    command: 'aider',
    installUrl: 'https://aider.chat/docs/install.html',
    capabilities: ['streaming', 'file-access', 'code-execution'],
    description: 'AI pair programming in terminal',
  },
  continue: {
    type: 'continue',
    displayName: 'Continue',
    command: 'continue',
    installUrl: 'https://continue.dev/docs/getting-started',
    capabilities: ['streaming', 'file-access'],
    description: 'Open-source AI code assistant',
  },
  cursor: {
    type: 'cursor',
    displayName: 'Cursor',
    command: 'cursor',
    installUrl: 'https://cursor.sh',
    capabilities: ['streaming', 'file-access', 'code-execution'],
    description: 'AI-first code editor',
  },
  copilot: {
    type: 'copilot',
    displayName: 'GitHub Copilot',
    command: 'gh copilot',
    installUrl: 'https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line',
    capabilities: ['streaming', 'file-access'],
    description: 'GitHub Copilot CLI',
  },
};

// ============================================
// State Types
// ============================================

interface DetectionState {
  /** All CLI status info */
  clis: Map<CliType, CliStatusInfo>;
  /** Currently scanning */
  isScanning: boolean;
  /** Last scan result */
  lastScan: CliScanResult | null;
  /** Scan error */
  scanError: string | null;
  /** Auto-refresh enabled */
  autoRefreshEnabled: boolean;
}

const INITIAL_STATE: DetectionState = {
  clis: new Map(),
  isScanning: false,
  lastScan: null,
  scanError: null,
  autoRefreshEnabled: false,
};

// ============================================
// Service
// ============================================

@Injectable({ providedIn: 'root' })
export class CliDetectionService implements OnDestroy {
  private ipc = inject(ElectronIpcService);
  private store = inject(VerificationStore);
  private destroy$ = new Subject<void>();

  // State
  private state$ = new BehaviorSubject<DetectionState>({ ...INITIAL_STATE, clis: new Map() });

  // Signals
  readonly state = signal<DetectionState>({ ...INITIAL_STATE, clis: new Map() });
  readonly isScanning = computed(() => this.state().isScanning);
  readonly scanError = computed(() => this.state().scanError);
  readonly lastScanTime = computed(() => this.state().lastScan?.scannedAt);

  // Computed CLI lists
  readonly cliList = computed(() => Array.from(this.state().clis.values()));
  readonly availableClis = computed(() =>
    this.cliList().filter(cli => cli.status === 'available')
  );
  readonly unavailableClis = computed(() =>
    this.cliList().filter(cli => cli.status !== 'available')
  );
  readonly authRequiredClis = computed(() =>
    this.cliList().filter(cli => cli.status === 'auth-required')
  );

  // CLI type lists for quick access
  readonly availableTypes = computed(() =>
    this.availableClis().map(cli => cli.type)
  );

  constructor() {
    // Sync state$ to signal
    this.state$.pipe(takeUntil(this.destroy$)).subscribe(state => {
      this.state.set(state);
    });

    // Initialize with known CLI types
    this.initializeClis();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Get metadata for a CLI type
   */
  getCliMetadata(type: CliType): CliMetadata {
    return CLI_METADATA[type];
  }

  /**
   * Get all CLI metadata
   */
  getAllCliMetadata(): CliMetadata[] {
    return Object.values(CLI_METADATA);
  }

  /**
   * Scan for all CLIs
   */
  async scanAll(force = false): Promise<CliScanResult> {
    this.updateState({ isScanning: true, scanError: null });
    const startTime = Date.now();

    try {
      // Call main process to detect CLIs
      const result = await this.ipc.invoke<{
        detected: CliInfo[];
        available: CliInfo[];
        unavailable: CliInfo[];
      }>('cli:detect-all', { force });

      if (!result.success || !result.data) {
        throw new Error(result.error?.message || 'Failed to detect CLIs');
      }

      const { detected, available } = result.data;

      // Update CLI status map
      const clis = new Map<CliType, CliStatusInfo>();

      for (const cli of detected) {
        const type = cli.name as CliType;
        const isAvailable = available.some(a => a.name === cli.name);
        const needsAuth = cli.installed && cli.authenticated === false;

        clis.set(type, {
          type,
          status: needsAuth ? 'auth-required' : (isAvailable ? 'available' : 'not-found'),
          version: cli.version,
          path: cli.path,
          capabilities: cli.capabilities || CLI_METADATA[type]?.capabilities || [],
          lastChecked: Date.now(),
        });
      }

      // Add any missing CLIs as not-found
      for (const type of Object.keys(CLI_METADATA) as CliType[]) {
        if (!clis.has(type)) {
          clis.set(type, {
            type,
            status: 'not-found',
            capabilities: CLI_METADATA[type].capabilities,
            lastChecked: Date.now(),
          });
        }
      }

      const scanResult: CliScanResult = {
        clis: Array.from(clis.values()),
        scannedAt: Date.now(),
        duration: Date.now() - startTime,
      };

      this.updateState({
        clis,
        isScanning: false,
        lastScan: scanResult,
      });

      // Also update the store
      this.store.scanClis(force);

      return scanResult;
    } catch (error) {
      const errorMsg = (error as Error).message;
      this.updateState({
        isScanning: false,
        scanError: errorMsg,
      });

      return {
        clis: [],
        scannedAt: Date.now(),
        duration: Date.now() - startTime,
        errors: [errorMsg],
      };
    }
  }

  /**
   * Test a specific CLI connection
   */
  async testCli(type: CliType): Promise<boolean> {
    const metadata = CLI_METADATA[type];
    if (!metadata) return false;

    // Update status to checking
    this.updateCliStatus(type, 'checking');

    try {
      const result = await this.ipc.invoke<{ success: boolean; version?: string; error?: string }>(
        'cli:test-connection',
        { command: metadata.command }
      );

      if (result.success && result.data?.success) {
        this.updateCliStatus(type, 'available', result.data.version);
        return true;
      } else {
        this.updateCliStatus(type, 'error', undefined, result.data?.error);
        return false;
      }
    } catch (error) {
      this.updateCliStatus(type, 'error', undefined, (error as Error).message);
      return false;
    }
  }

  /**
   * Get install URL for a CLI
   */
  getInstallUrl(type: CliType): string {
    return CLI_METADATA[type]?.installUrl || '';
  }

  /**
   * Get auth command for a CLI
   */
  getAuthCommand(type: CliType): string | undefined {
    return CLI_METADATA[type]?.authCommand;
  }

  /**
   * Check if a CLI is available
   */
  isAvailable(type: CliType): boolean {
    return this.state().clis.get(type)?.status === 'available';
  }

  /**
   * Check if a CLI needs authentication
   */
  needsAuth(type: CliType): boolean {
    return this.state().clis.get(type)?.status === 'auth-required';
  }

  /**
   * Enable/disable auto-refresh
   */
  setAutoRefresh(enabled: boolean, intervalMs = 60000): void {
    this.updateState({ autoRefreshEnabled: enabled });

    if (enabled) {
      interval(intervalMs)
        .pipe(
          takeUntil(this.destroy$),
          startWith(0)
        )
        .subscribe(() => {
          if (this.state().autoRefreshEnabled) {
            this.scanAll();
          }
        });
    }
  }

  /**
   * Get status info for a CLI
   */
  getCliStatus(type: CliType): CliStatusInfo | undefined {
    return this.state().clis.get(type);
  }

  /**
   * Convert CliInfo to CliStatusInfo
   */
  toStatusInfo(cli: CliInfo): CliStatusInfo {
    const type = cli.name as CliType;
    let status: CliStatus;

    if (!cli.installed) {
      status = 'not-found';
    } else if (cli.authenticated === false) {
      status = 'auth-required';
    } else if (cli.error) {
      status = 'error';
    } else {
      status = 'available';
    }

    return {
      type,
      status,
      version: cli.version,
      path: cli.path,
      errorMessage: cli.error,
      capabilities: cli.capabilities,
      lastChecked: Date.now(),
    };
  }

  // ============================================
  // Private Methods
  // ============================================

  private initializeClis(): void {
    const clis = new Map<CliType, CliStatusInfo>();

    for (const type of Object.keys(CLI_METADATA) as CliType[]) {
      clis.set(type, {
        type,
        status: 'not-found',
        capabilities: CLI_METADATA[type].capabilities,
      });
    }

    this.updateState({ clis });
  }

  private updateState(partial: Partial<DetectionState>): void {
    this.state$.next({
      ...this.state$.value,
      ...partial,
    });
  }

  private updateCliStatus(
    type: CliType,
    status: CliStatus,
    version?: string,
    errorMessage?: string
  ): void {
    const clis = new Map(this.state$.value.clis);
    const existing = clis.get(type);

    if (existing) {
      clis.set(type, {
        ...existing,
        status,
        version: version ?? existing.version,
        errorMessage,
        lastChecked: Date.now(),
      });
      this.updateState({ clis });
    }
  }
}
