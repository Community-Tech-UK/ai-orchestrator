import * as fsp from 'fs/promises';
import { execFile } from 'child_process';
import type { BrowserProfile } from '@contracts/types/browser';
import type {
  BrowserAutomationHealthReport,
  BrowserAutomationHealthService,
} from '../browser-automation/browser-automation-health';
import { getBrowserAutomationHealthService } from '../browser-automation/browser-automation-health';
import {
  BrowserProfileStore,
  getBrowserProfileStore,
} from './browser-profile-store';

export type BrowserGatewayHealthStatus = 'ready' | 'partial' | 'missing';

export interface BrowserChromeRuntimeHealth {
  available: boolean;
  command?: string;
}

export interface BrowserGatewayHealthReport {
  status: BrowserGatewayHealthStatus;
  checkedAt: number;
  chromeRuntime: BrowserChromeRuntimeHealth;
  managedProfiles: {
    total: number;
    running: number;
  };
  mcpBridge: {
    available: boolean;
  };
  providerCapabilities: {
    claude: 'available_via_mcp' | 'legacy_chrome_disabled' | 'unconfigured';
    copilot: 'available_via_acp_mcp' | 'unconfigured';
    codex: 'unavailable_exec_mode' | 'available_app_server' | 'unconfigured';
    gemini: 'unconfigured_adapter_injection_missing';
  };
  rawLegacyAutomation: BrowserAutomationHealthReport;
  warnings: string[];
}

export interface BrowserHealthServiceOptions {
  profileStore?: Pick<BrowserProfileStore, 'listProfiles'>;
  rawAutomationHealthService?: Pick<BrowserAutomationHealthService, 'diagnose'>;
  mcpBridgeAvailable?: () => boolean;
  chromeRuntimeDetector?: () => Promise<BrowserChromeRuntimeHealth>;
  now?: () => number;
}

const CHROME_COMMANDS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
];

let defaultMcpBridgeAvailableProvider = (): boolean => false;

export function setBrowserGatewayMcpBridgeAvailabilityProvider(
  provider: () => boolean,
): void {
  defaultMcpBridgeAvailableProvider = provider;
}

async function commandExists(command: string): Promise<boolean> {
  if (command.startsWith('/')) {
    try {
      await fsp.access(command);
      return true;
    } catch {
      return false;
    }
  }

  return new Promise<boolean>((resolve) => {
    const child = execFile(
      'which',
      [command],
      {
        encoding: 'utf-8',
        timeout: 3000,
      },
      (error) => {
        resolve(!error);
      },
    );
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already exited
      }
      resolve(false);
    }, 3500);
  });
}

export async function detectChromeRuntime(): Promise<BrowserChromeRuntimeHealth> {
  for (const command of CHROME_COMMANDS) {
    if (await commandExists(command)) {
      return { available: true, command };
    }
  }
  return { available: false };
}

export class BrowserHealthService {
  private static instance: BrowserHealthService | null = null;
  private readonly profileStore: Pick<BrowserProfileStore, 'listProfiles'>;
  private readonly rawAutomationHealthService: Pick<BrowserAutomationHealthService, 'diagnose'>;
  private readonly mcpBridgeAvailable: () => boolean;
  private readonly chromeRuntimeDetector: () => Promise<BrowserChromeRuntimeHealth>;
  private readonly now: () => number;

  constructor(options: BrowserHealthServiceOptions = {}) {
    this.profileStore = options.profileStore ?? getBrowserProfileStore();
    this.rawAutomationHealthService =
      options.rawAutomationHealthService ?? getBrowserAutomationHealthService();
    this.mcpBridgeAvailable = options.mcpBridgeAvailable ?? defaultMcpBridgeAvailableProvider;
    this.chromeRuntimeDetector = options.chromeRuntimeDetector ?? detectChromeRuntime;
    this.now = options.now ?? Date.now;
  }

  static getInstance(): BrowserHealthService {
    if (!this.instance) {
      this.instance = new BrowserHealthService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  async diagnose(): Promise<BrowserGatewayHealthReport> {
    const [chromeRuntime, rawLegacyAutomation] = await Promise.all([
      this.chromeRuntimeDetector(),
      this.rawAutomationHealthService.diagnose(),
    ]);
    const profiles = this.profileStore.listProfiles();
    const running = profiles.filter((profile) => this.isRunning(profile)).length;
    const bridgeAvailable = this.mcpBridgeAvailable();
    const warnings: string[] = [];

    if (!chromeRuntime.available) {
      warnings.push('Google Chrome was not detected for managed Browser Gateway profiles.');
    }
    if (!bridgeAvailable) {
      warnings.push('Browser Gateway MCP bridge is unavailable for provider child processes.');
    }

    return {
      status: chromeRuntime.available && bridgeAvailable ? 'ready' : 'partial',
      checkedAt: this.now(),
      chromeRuntime,
      managedProfiles: {
        total: profiles.length,
        running,
      },
      mcpBridge: {
        available: bridgeAvailable,
      },
      providerCapabilities: {
        claude: bridgeAvailable ? 'available_via_mcp' : 'legacy_chrome_disabled',
        copilot: bridgeAvailable ? 'available_via_acp_mcp' : 'unconfigured',
        codex: 'unavailable_exec_mode',
        gemini: 'unconfigured_adapter_injection_missing',
      },
      rawLegacyAutomation,
      warnings,
    };
  }

  private isRunning(profile: BrowserProfile): boolean {
    return profile.status === 'running' || profile.status === 'starting';
  }
}

export function getBrowserHealthService(): BrowserHealthService {
  return BrowserHealthService.getInstance();
}
