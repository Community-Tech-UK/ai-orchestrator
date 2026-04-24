/**
 * CLI Store - Manages available CLI tools state
 */

import { Injectable, inject, signal, computed } from '@angular/core';
import { ProviderIpcService } from '../services/ipc';

export interface CliInfo {
  name: string;
  command: string;
  displayName: string;
  installed: boolean;
  version?: string;
  error?: string;
}

export type CliType = 'claude' | 'gemini' | 'codex' | 'copilot' | 'cursor';

const BENCHMARK_FALLBACK_CLIS: CliInfo[] = [
  {
    name: 'claude',
    command: 'claude',
    displayName: 'Claude Code',
    installed: true,
    version: 'benchmark',
  },
  {
    name: 'codex',
    command: 'codex',
    displayName: 'OpenAI Codex',
    installed: true,
    version: 'benchmark',
  },
  {
    name: 'gemini',
    command: 'gemini',
    displayName: 'Google Gemini',
    installed: true,
    version: 'benchmark',
  },
  {
    name: 'copilot',
    command: 'copilot',
    displayName: 'GitHub Copilot',
    installed: true,
    version: 'benchmark',
  },
];

interface CliState {
  clis: CliInfo[];
  selectedCli: CliType | null;
  loading: boolean;
  initialized: boolean;
}

@Injectable({ providedIn: 'root' })
export class CliStore {
  private ipc = inject(ProviderIpcService);

  private state = signal<CliState>({
    clis: [],
    selectedCli: null,
    loading: false,
    initialized: false,
  });

  // Selectors
  readonly clis = computed(() => this.state().clis);
  readonly selectedCli = computed(() => this.state().selectedCli);
  readonly loading = computed(() => this.state().loading);
  readonly initialized = computed(() => this.state().initialized);

  readonly availableClis = computed(() =>
    this.state().clis.filter((cli) => cli.installed)
  );

  readonly hasAnyCli = computed(() =>
    this.state().clis.some((cli) => cli.installed)
  );

  readonly selectedCliInfo = computed(() => {
    const selected = this.state().selectedCli;
    return this.state().clis.find((cli) => cli.name === selected) || null;
  });

  readonly noClisError = computed(() => {
    const { initialized, clis } = this.state();
    if (!initialized) return null;

    const hasAny = clis.some((cli) => cli.installed);
    if (hasAny) return null;

    return {
      title: 'No AI CLI Found',
      message: 'Please install one of the following CLI tools to use this application:',
      clis: [
        { name: 'Claude Code', installUrl: 'https://claude.ai/code', command: 'npm install -g @anthropic-ai/claude-code' },
        { name: 'Gemini CLI', installUrl: 'https://ai.google.dev/gemini-api/docs/cli', command: 'npm install -g @google/gemini-cli' },
        { name: 'OpenAI Codex CLI', installUrl: 'https://openai.com/codex-cli/setup', command: 'npm install -g @openai/codex' },
      ],
    };
  });

  /**
   * Initialize - detect available CLIs
   */
  async initialize(force?: boolean): Promise<void> {
    this.state.update((s) => ({ ...s, loading: true }));

    try {
      const response = await this.ipc.detectClis(force) as {
        success: boolean;
        data?: {
          detected: CliInfo[];
          available: CliInfo[];
          unavailable: CliInfo[];
          timestamp: Date;
        };
      };

      if (response.success && response.data) {
        // The response.data contains { detected, available, unavailable }
        // Use 'detected' for all CLIs, 'available' already has installed=true filtered
        const clis = response.data.detected || [];

        // Auto-select first available CLI
        const firstAvailable = clis.find((cli) => cli.installed);

        this.state.update((s) => ({
          ...s,
          clis,
          selectedCli: (firstAvailable?.name as CliType) || null,
          loading: false,
          initialized: true,
        }));
      } else {
        if (this.shouldUseBrowserBenchmarkFallback()) {
          this.useBrowserBenchmarkFallback();
        } else {
          this.state.update((s) => ({
            ...s,
            loading: false,
            initialized: true,
          }));
        }
      }
    } catch (error) {
      console.error('Failed to detect CLIs:', error);
      if (this.shouldUseBrowserBenchmarkFallback()) {
        this.useBrowserBenchmarkFallback();
      } else {
        this.state.update((s) => ({
          ...s,
          loading: false,
          initialized: true,
        }));
      }
    }
  }

  /**
   * Select a specific CLI
   */
  selectCli(cliType: CliType): void {
    const cli = this.state().clis.find((c) => c.name === cliType);
    if (cli?.installed) {
      this.state.update((s) => ({ ...s, selectedCli: cliType }));
    }
  }

  /**
   * Refresh CLI detection (force bypasses main-process cache)
   */
  async refresh(): Promise<void> {
    await this.initialize(true);
  }

  private shouldUseBrowserBenchmarkFallback(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }

    const params = new URLSearchParams(window.location.search);
    return params.get('bench') === '1';
  }

  private useBrowserBenchmarkFallback(): void {
    console.warn('[CliStore] Using browser benchmark CLI fallback');
    this.state.update((s) => ({
      ...s,
      clis: BENCHMARK_FALLBACK_CLIS,
      selectedCli: 'claude',
      loading: false,
      initialized: true,
    }));
  }
}
