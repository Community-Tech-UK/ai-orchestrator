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
import {
  getWorkerNodeRegistry,
  type WorkerNodeRegistry,
} from '../remote-node/worker-node-registry';
import {
  BROWSER_EXTENSION_CONTACT_FRESH_MS,
  describeBrowserExtensionContact,
  getBrowserExtensionContactState,
  type BrowserExtensionContactGapStats,
  type BrowserExtensionContactStateReader,
  type BrowserExtensionDisconnectRecord,
} from './browser-extension-contact-state';
import {
  browserExtensionQueueKeyForNode,
  getBrowserExtensionCommandStore,
  type BrowserExtensionCommandStore,
  type BrowserExtensionQueueSnapshot,
} from './browser-extension-command-store';
import {
  getBrowserReliabilityEvents,
  type BrowserReliabilityEvent,
  type BrowserReliabilityEvents,
} from './browser-reliability-events';
import { BROWSER_GATEWAY_RPC_PROTOCOL_VERSION } from './browser-rpc-contract';
import { expectedBrowserToolSurface } from './browser-rpc-server-support';
import {
  getBrowserToolRevealStore,
  type BrowserToolRevealStore,
} from './browser-tool-reveal-store';
import {
  getBrowserLocalExtensionHealth,
  type BrowserLocalExtensionHealth,
} from './browser-local-extension-health';
import {
  getBrowserExtensionTabStore,
  type BrowserExtensionTabStore,
} from './browser-extension-tab-store';

export type BrowserGatewayHealthStatus = 'ready' | 'partial' | 'missing';

export interface BrowserChromeRuntimeHealth {
  available: boolean;
  command?: string;
}

export interface BrowserGatewayProviderCapabilities {
  claude: 'available_via_mcp' | 'legacy_chrome_disabled' | 'unconfigured';
  copilot: 'available_via_acp_mcp' | 'unconfigured';
  codex: 'available_via_mcp' | 'unconfigured';
  gemini: 'unconfigured_adapter_injection_missing';
}

export interface BrowserGatewayProviderCapabilityDetails {
  claude: {
    available: boolean;
    status: BrowserGatewayProviderCapabilities['claude'];
    message: string;
  };
  copilot: {
    available: boolean;
    status: BrowserGatewayProviderCapabilities['copilot'];
    message: string;
  };
  codex: {
    available: boolean;
    status: BrowserGatewayProviderCapabilities['codex'];
    message: string;
  };
  gemini: {
    available: boolean;
    status: BrowserGatewayProviderCapabilities['gemini'];
    message: string;
  };
}

export interface BrowserGatewayHealthReport {
  status: BrowserGatewayHealthStatus;
  checkedAt: number;
  chromeRuntime: BrowserChromeRuntimeHealth;
  /**
   * The AIO host's own Chrome extension session. Present on every report so
   * "no local extension" is a stated fact rather than an absent field.
   */
  localExtension: BrowserLocalExtensionHealth;
  managedProfiles: {
    total: number;
    running: number;
    locked: number;
    errors: number;
  };
  mcpBridge: {
    available: boolean;
  };
  remoteExtensions: {
    total: number;
    ready: number;
    silent: number;
    nodes: Array<{
      nodeId: string;
      nodeName: string;
      enabled: boolean;
      running: boolean;
      silent: boolean;
      lastContactAt?: number;
      /** Milliseconds since the extension last contacted the coordinator. */
      contactAgeMs?: number;
      /** Command channel load: queued (undelivered), in-flight, waiting pollers. */
      queue: Omit<BrowserExtensionQueueSnapshot, 'queueKey'>;
      /** Outage telemetry — gaps >30s since the node registered. */
      contactGaps: BrowserExtensionContactGapStats;
      /** Most recent channel-close reported by the node's native host. */
      lastDisconnect?: BrowserExtensionDisconnectRecord;
      /** Observed MV3 service-worker restarts since this service began watching the node. */
      serviceWorkerRestarts: number;
      registration?: 'ok' | 'repaired' | 'contested' | 'error';
      lastRegistrationCheckAt?: number;
    }>;
  };
  providerCapabilities: BrowserGatewayProviderCapabilities;
  providerCapabilityDetails: BrowserGatewayProviderCapabilityDetails;
  rawLegacyAutomation: BrowserAutomationHealthReport;
  /** Reliability hardening: the RPC/tool-surface contract of THIS build. */
  contract?: {
    protocolVersion: number;
    expectedToolCount: number;
    expectedSurfaceHash: string;
  };
  /**
   * Per-instance MCP forwarder sessions that reported their tool surface.
   * `schemaMatch` false or a non-empty `missing` list means the bridge binary
   * is skewed against this build — rebuild before starting a long flow.
   */
  mcpSessions?: Array<{
    instanceId: string;
    protocolVersion: number;
    reportedAt: number;
    schemaMatch: boolean;
    /** The forwarder restarted and could not restore its revealed tool set. */
    revealRestoreFailed?: boolean;
    toolParity: {
      reportedCount: number;
      expectedCount: number;
      missing: string[];
    };
  }>;
  /** Recent disconnect/skew/rejected-write telemetry (newest last). */
  recentReliabilityEvents?: BrowserReliabilityEvent[];
  warnings: string[];
}

export interface BrowserHealthServiceOptions {
  profileStore?: Pick<BrowserProfileStore, 'listProfiles'>;
  rawAutomationHealthService?: Pick<BrowserAutomationHealthService, 'diagnose'>;
  workerNodeRegistry?: Pick<WorkerNodeRegistry, 'getAllNodes'>;
  extensionContactState?: BrowserExtensionContactStateReader;
  extensionCommandStore?: Pick<BrowserExtensionCommandStore, 'describeQueue'>;
  toolRevealStore?: Pick<BrowserToolRevealStore, 'listSurfaces'>;
  extensionTabStore?: Pick<BrowserExtensionTabStore, 'listTabs'>;
  reliabilityEvents?: Pick<BrowserReliabilityEvents, 'recent'>;
  /** Overrides the whole local-extension probe (filesystem-backed by default). */
  localExtensionHealth?: () => BrowserLocalExtensionHealth;
  userDataPath?: string;
  expectedToolSurface?: () => { names: string[]; surfaceHash: string };
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
  private readonly workerNodeRegistry: Pick<WorkerNodeRegistry, 'getAllNodes'>;
  private readonly extensionContactState: BrowserExtensionContactStateReader;
  private readonly extensionCommandStore: Pick<BrowserExtensionCommandStore, 'describeQueue'>;
  private readonly toolRevealStore: Pick<BrowserToolRevealStore, 'listSurfaces'>;
  private readonly extensionTabStore: Pick<BrowserExtensionTabStore, 'listTabs'>;
  private readonly reliabilityEvents: Pick<BrowserReliabilityEvents, 'recent'>;
  private readonly localExtensionHealth: () => BrowserLocalExtensionHealth;
  private readonly expectedToolSurface: () => { names: string[]; surfaceHash: string };
  private readonly mcpBridgeAvailable: () => boolean;
  private readonly chromeRuntimeDetector: () => Promise<BrowserChromeRuntimeHealth>;
  private readonly now: () => number;
  private readonly extensionStartedAtByNode = new Map<string, number>();
  private readonly serviceWorkerRestartsByNode = new Map<string, number>();

  constructor(options: BrowserHealthServiceOptions = {}) {
    this.profileStore = options.profileStore ?? getBrowserProfileStore();
    this.rawAutomationHealthService =
      options.rawAutomationHealthService ?? getBrowserAutomationHealthService();
    this.workerNodeRegistry = options.workerNodeRegistry ?? getWorkerNodeRegistry();
    this.extensionContactState = options.extensionContactState ?? getBrowserExtensionContactState();
    this.extensionCommandStore = options.extensionCommandStore ?? getBrowserExtensionCommandStore();
    this.toolRevealStore = options.toolRevealStore ?? getBrowserToolRevealStore();
    this.extensionTabStore = options.extensionTabStore ?? getBrowserExtensionTabStore();
    this.reliabilityEvents = options.reliabilityEvents ?? getBrowserReliabilityEvents();
    this.localExtensionHealth = options.localExtensionHealth
      ?? (() => getBrowserLocalExtensionHealth({
        ...(options.userDataPath ? { userDataPath: options.userDataPath } : {}),
        extensionContactState: this.extensionContactState,
        extensionCommandStore: this.extensionCommandStore,
        countSharedLocalTabs: () =>
          this.extensionTabStore.listTabs().filter((tab) => !tab.nodeId).length,
        now: this.now,
      }));
    this.expectedToolSurface = options.expectedToolSurface ?? expectedBrowserToolSurface;
    this.mcpBridgeAvailable =
      options.mcpBridgeAvailable ?? (() => defaultMcpBridgeAvailableProvider());
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
    const locked = profiles.filter((profile) => profile.status === 'locked').length;
    const errors = profiles.filter((profile) => profile.status === 'error').length;
    const bridgeAvailable = this.mcpBridgeAvailable();
    const localExtension = this.localExtensionHealth();
    const remoteExtensions = this.getRemoteExtensionHealth();
    const expectedSurface = this.expectedToolSurface();
    const mcpSessions = this.toolRevealStore.listSurfaces().map(({ instanceId, surface }) => {
      const reportedNames = new Set(surface.names);
      return {
        instanceId,
        protocolVersion: surface.protocolVersion,
        reportedAt: surface.reportedAt,
        schemaMatch:
          surface.protocolVersion === BROWSER_GATEWAY_RPC_PROTOCOL_VERSION
          && surface.surfaceHash === expectedSurface.surfaceHash,
        ...(surface.revealRestoreFailed ? { revealRestoreFailed: true } : {}),
        toolParity: {
          reportedCount: surface.names.length,
          expectedCount: expectedSurface.names.length,
          missing: expectedSurface.names.filter((name) => !reportedNames.has(name)),
        },
      };
    });
    const warnings: string[] = [];
    for (const session of mcpSessions) {
      if (session.revealRestoreFailed) {
        warnings.push(
          `Browser Gateway MCP bridge for instance ${session.instanceId} could not restore its `
          + 'previously revealed tools after a reconnect; the tool list is smaller than before '
          + '(all tools remain callable by name — re-run browser.tool_search to re-list them).',
        );
      }
      if (!session.schemaMatch || session.toolParity.missing.length > 0) {
        warnings.push(
          `Browser Gateway MCP bridge for instance ${session.instanceId} is contract-skewed `
          + `(schemaMatch=${session.schemaMatch}, missing tools: ${session.toolParity.missing.length}); `
          + 'rebuild aio-mcp before starting a long browser flow.',
        );
      }
    }

    if (!chromeRuntime.available) {
      warnings.push('Google Chrome was not detected for managed Browser Gateway profiles.');
    }
    if (!bridgeAvailable) {
      warnings.push('Browser Gateway MCP bridge is unavailable for provider child processes.');
    }
    if (locked > 0) {
      warnings.push(
        `${locked} Browser Gateway ${locked === 1 ? 'profile is' : 'profiles are'} locked by another Chrome process.`,
      );
    }
    if (errors > 0) {
      warnings.push(
        `${errors} Browser Gateway ${errors === 1 ? 'profile is' : 'profiles are'} in an error state.`,
      );
    }
    // Only warn once the local extension has been set up. A machine that never
    // installed it is not degraded, and warning there would teach agents to
    // ignore the field entirely.
    if (localExtension.installed && localExtension.state !== 'ready') {
      warnings.push(
        `${localExtension.summary}${localExtension.remediation ? ` ${localExtension.remediation}` : ''}`,
      );
    }
    for (const node of remoteExtensions.nodes) {
      if (!node.silent) {
        continue;
      }
      const ageSeconds = node.contactAgeMs !== undefined
        ? `${Math.round(node.contactAgeMs / 1000)}s ago`
        : 'never';
      warnings.push(
        `Browser extension on ${node.nodeName} is not polling (last contact: ${ageSeconds}); `
        + 'commands to that node cannot be delivered until it reconnects.',
      );
    }

    return {
      status: chromeRuntime.available && bridgeAvailable ? 'ready' : 'partial',
      checkedAt: this.now(),
      chromeRuntime,
      localExtension,
      managedProfiles: {
        total: profiles.length,
        running,
        locked,
        errors,
      },
      mcpBridge: {
        available: bridgeAvailable,
      },
      remoteExtensions,
      providerCapabilities: {
        claude: bridgeAvailable ? 'available_via_mcp' : 'legacy_chrome_disabled',
        copilot: bridgeAvailable ? 'available_via_acp_mcp' : 'unconfigured',
        codex: bridgeAvailable ? 'available_via_mcp' : 'unconfigured',
        gemini: 'unconfigured_adapter_injection_missing',
      },
      providerCapabilityDetails: {
        claude: {
          available: bridgeAvailable,
          status: bridgeAvailable ? 'available_via_mcp' : 'legacy_chrome_disabled',
          message: bridgeAvailable
            ? 'Claude can use Browser Gateway MCP tools from provider child processes.'
            : 'Claude raw --chrome access is disabled; Browser Gateway MCP is unavailable for provider child processes.',
        },
        copilot: {
          available: bridgeAvailable,
          status: bridgeAvailable ? 'available_via_acp_mcp' : 'unconfigured',
          message: bridgeAvailable
            ? 'Copilot can use Browser Gateway through the generated ACP MCP configuration.'
            : 'Copilot Browser Gateway access is unconfigured because the MCP bridge is unavailable.',
        },
        codex: {
          available: bridgeAvailable,
          status: bridgeAvailable ? 'available_via_mcp' : 'unconfigured',
          message: bridgeAvailable
            ? 'Codex can use Browser Gateway through injected MCP config in local AIO sessions.'
            : 'Codex Browser Gateway access is unavailable because the Browser Gateway MCP bridge is unavailable.',
        },
        gemini: {
          available: false,
          status: 'unconfigured_adapter_injection_missing',
          message: 'Gemini Browser Gateway is unavailable until adapter MCP injection is implemented.',
        },
      },
      rawLegacyAutomation,
      contract: {
        protocolVersion: BROWSER_GATEWAY_RPC_PROTOCOL_VERSION,
        expectedToolCount: expectedSurface.names.length,
        expectedSurfaceHash: expectedSurface.surfaceHash,
      },
      mcpSessions,
      recentReliabilityEvents: this.reliabilityEvents.recent(30),
      warnings,
    };
  }

  private isRunning(profile: BrowserProfile): boolean {
    return profile.status === 'running' || profile.status === 'starting';
  }

  private getRemoteExtensionHealth(): BrowserGatewayHealthReport['remoteExtensions'] {
    const nodes = this.workerNodeRegistry.getAllNodes()
      .filter((node) =>
        node.capabilities.extensionRelay?.enabled === true ||
        node.capabilities.hasExtensionRelay === true,
      )
      .map((node) => {
        const relay = node.capabilities.extensionRelay;
        const stateLastContactAt = this.extensionContactState.getLastExtensionContactAt(node.id);
        const relayLastContactAt = relay?.lastExtensionContactAt;
        const lastContactAt = latestTimestamp(stateLastContactAt, relayLastContactAt);
        const enabled = relay?.enabled ?? Boolean(node.capabilities.hasExtensionRelay);
        const running = relay?.running ?? Boolean(node.capabilities.hasExtensionRelay);
        const contact = describeBrowserExtensionContact(
          node.id,
          lastContactAt,
          this.now(),
          BROWSER_EXTENSION_CONTACT_FRESH_MS,
        );
        const silent = enabled && running ? contact.silent : false;
        const lastDisconnect = this.extensionContactState.getLastDisconnect?.(node.id);
        const { queueKey, ...queue } = this.extensionCommandStore.describeQueue(
          browserExtensionQueueKeyForNode(node.id),
        );
        void queueKey;
        return {
          nodeId: node.id,
          nodeName: node.name,
          enabled,
          running,
          silent,
          lastContactAt,
          ...(lastContactAt !== undefined
            ? { contactAgeMs: Math.max(0, this.now() - lastContactAt) }
            : {}),
          queue,
          contactGaps: this.extensionContactState.getContactGapStats(node.id),
          ...(lastDisconnect ? { lastDisconnect } : {}),
          serviceWorkerRestarts: this.serviceWorkerRestartCount(
            node.id,
            relay?.extensionReloadedAt,
          ),
          registration: relay?.registration,
          lastRegistrationCheckAt: relay?.lastRegistrationCheckAt,
        };
      });
    return {
      total: nodes.length,
      ready: nodes.filter((node) => node.enabled && node.running && !node.silent).length,
      silent: nodes.filter((node) => node.silent).length,
      nodes,
    };
  }

  private serviceWorkerRestartCount(nodeId: string, extensionStartedAt: number | undefined): number {
    if (extensionStartedAt === undefined) {
      return this.serviceWorkerRestartsByNode.get(nodeId) ?? 0;
    }
    const previous = this.extensionStartedAtByNode.get(nodeId);
    if (previous !== undefined && previous !== extensionStartedAt) {
      this.serviceWorkerRestartsByNode.set(
        nodeId,
        (this.serviceWorkerRestartsByNode.get(nodeId) ?? 0) + 1,
      );
    }
    this.extensionStartedAtByNode.set(nodeId, extensionStartedAt);
    return this.serviceWorkerRestartsByNode.get(nodeId) ?? 0;
  }
}

function latestTimestamp(...values: Array<number | undefined>): number | undefined {
  const timestamps = values.filter((value): value is number => typeof value === 'number');
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

export function getBrowserHealthService(): BrowserHealthService {
  return BrowserHealthService.getInstance();
}
