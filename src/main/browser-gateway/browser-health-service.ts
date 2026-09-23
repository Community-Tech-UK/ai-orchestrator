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
  getBrowserExtensionContactState,
  type BrowserExtensionContactGapStats,
  type BrowserExtensionContactStateReader,
  type BrowserExtensionDisconnectRecord,
} from './browser-extension-contact-state';
import {
  classifyRemoteExtensionContact,
  type RemoteExtensionChannelState,
} from './browser-extension-node-contact';
import { getWorkerNodeConnectionServer } from '../remote-node/worker-node-connection';
import type { WorkerConnectionFlapState } from '../remote-node/worker-connection-flap-monitor';
import {
  browserExtensionQueueKeyForNode,
  getBrowserExtensionCommandStore,
  type BrowserExtensionCommandStore,
  type BrowserExtensionQueueSnapshot,
} from './browser-extension-command-store';
import { isSecretObservationProtectionEnabled } from './browser-secret-observation-stamp';
import {
  secretObservationWarnings,
  toSecretObservationHealth,
  type BrowserSecretObservationHealth,
} from './browser-secret-observation-health';
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
import {
  BROWSER_WORKER_AGENT_TOO_OLD,
  assessRemoteExtensionCommandCapability,
  nodeHasExtensionRelay,
  type BrowserPreDeliveryCapability,
} from './browser-worker-agent-skew';
import {
  BrowserTargetRegistry,
  getBrowserTargetRegistry,
} from './browser-target-registry';
import { getPuppeteerBrowserDriver } from './puppeteer-browser-driver';
import {
  aggregateBrowserRendererState,
  classifyBrowserTargetLiveness,
  type BrowserRendererState,
} from './browser-target-liveness';

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
  /**
   * Secret observation protection: the operator setting the coordinator stamps
   * onto every command, and what the local extension last reported. Remote
   * nodes carry their own report under remoteExtensions.nodes[].secretObservation.
   */
  secretObservationProtection: {
    settingEnabled: boolean;
    local: BrowserSecretObservationHealth;
  };
  managedProfiles: {
    total: number;
    running: number;
    locked: number;
    errors: number;
  };
  renderer: BrowserRendererState;
  targetRenderers: {
    profileId: string;
    targetId: string;
    mode: 'managed' | 'existing-tab';
    renderer: BrowserRendererState;
    clockText?: string;
    clockAgeSeconds?: number;
    suggestedAction?: 'browser.reload';
  }[];
  mcpBridge: {
    available: boolean;
  };
  remoteExtensions: {
    total: number;
    ready: number;
    silent: number;
    nodes: {
      nodeId: string;
      nodeName: string;
      enabled: boolean;
      running: boolean;
      silent: boolean;
      commandsDeliverable: boolean;
      commandsUndeliverableReason?: string;
      /**
       * `relay_not_forwarding`: the worker relay sees extension polls but none
       * reach the coordinator, so commands cannot be delivered.
       * `commands_unanswered`: polls DO reach the coordinator and commands are
       * delivered, but nothing comes back — the service worker is polling
       * without executing. Every clock looks healthy in this state.
       */
      channelState: RemoteExtensionChannelState;
      /** Delivered commands that timed out in a row; omitted when zero. */
      consecutiveUnansweredCommands?: number;
      /** Most recent of the two contact clocks below. */
      lastContactAt?: number;
      /** Milliseconds since the most recent of either contact clock. */
      contactAgeMs?: number;
      /** Since a poll RPC actually reached this coordinator (delivery freshness). */
      coordinatorPollAgeMs?: number;
      /** Since the worker relay last saw the extension on its pipe. */
      relayContactAgeMs?: number;
      /** Worker connection churn: storm flag and live-socket replaces in the window. */
      connectionFlap?: WorkerConnectionFlapState;
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
      /** This node's extension protection state and taint count. */
      secretObservation: BrowserSecretObservationHealth;
    }[];
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
  mcpSessions?: {
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
  }[];
  /** Recent disconnect/skew/rejected-write telemetry (newest last). */
  recentReliabilityEvents?: BrowserReliabilityEvent[];
  warnings: string[];
}

export interface BrowserHealthServiceOptions {
  profileStore?: Pick<BrowserProfileStore, 'listProfiles'>;
  rawAutomationHealthService?: Pick<BrowserAutomationHealthService, 'diagnose'>;
  workerNodeRegistry?: Pick<WorkerNodeRegistry, 'getAllNodes'>;
  extensionContactState?: BrowserExtensionContactStateReader;
  connectionFlapState?: (nodeId: string) => WorkerConnectionFlapState | undefined;
  extensionCommandStore?: Pick<
    BrowserExtensionCommandStore,
    'describeQueue' | 'describePreDeliveryCapability' | 'describeDeliveryHealth'
  > & Partial<Pick<BrowserExtensionCommandStore, 'describeSecretObservation'>>;
  /** The operator's browserSecretObservationProtectionEnabled value. */
  secretObservationSettingEnabled?: () => boolean;
  toolRevealStore?: Pick<BrowserToolRevealStore, 'listSurfaces'>;
  extensionTabStore?: Pick<BrowserExtensionTabStore, 'listTabs'>;
  targetRegistry?: Pick<BrowserTargetRegistry, 'listTargets'>;
  listWedgedTargets?: () => string[];
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
  private readonly connectionFlapState: (nodeId: string) => WorkerConnectionFlapState | undefined;
  private readonly extensionCommandStore: Pick<
    BrowserExtensionCommandStore,
    'describeQueue' | 'describePreDeliveryCapability' | 'describeDeliveryHealth'
  > & Partial<Pick<BrowserExtensionCommandStore, 'describeSecretObservation'>>;
  private readonly secretObservationSettingEnabled: () => boolean;
  private readonly toolRevealStore: Pick<BrowserToolRevealStore, 'listSurfaces'>;
  private readonly extensionTabStore: Pick<BrowserExtensionTabStore, 'listTabs'>;
  private readonly targetRegistry: Pick<BrowserTargetRegistry, 'listTargets'>;
  private readonly listWedgedTargets: () => string[];
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
    this.connectionFlapState = options.connectionFlapState
      ?? ((nodeId) => getWorkerNodeConnectionServer().describeFlapState(nodeId));
    this.extensionCommandStore = options.extensionCommandStore ?? getBrowserExtensionCommandStore();
    this.secretObservationSettingEnabled = options.secretObservationSettingEnabled
      ?? isSecretObservationProtectionEnabled;
    this.toolRevealStore = options.toolRevealStore ?? getBrowserToolRevealStore();
    this.extensionTabStore = options.extensionTabStore ?? getBrowserExtensionTabStore();
    this.targetRegistry = options.targetRegistry ?? getBrowserTargetRegistry();
    this.listWedgedTargets = options.listWedgedTargets
      ?? (() => getPuppeteerBrowserDriver().listWedgedTargets());
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
    const targetRenderers = this.getTargetRendererHealth();
    const renderer = aggregateBrowserRendererState(targetRenderers);
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
      if (node.channelState === 'relay_not_forwarding') {
        warnings.push(
          `Browser extension on ${node.nodeName} is polling the worker relay but no poll has reached the `
          + `coordinator${node.coordinatorPollAgeMs !== undefined ? ` for ${Math.round(node.coordinatorPollAgeMs / 1000)}s` : ''}`
          + `${node.connectionFlap?.stormActive ? ` (connection flap storm: ${node.connectionFlap.replacesInWindow} socket replaces)` : ''}; `
          + 'commands cannot be delivered. Run browser.recover_extension to reset the worker connection.',
        );
        continue;
      }
      if (node.silent) {
        const ageSeconds = node.contactAgeMs !== undefined
          ? `${Math.round(node.contactAgeMs / 1000)}s ago`
          : 'never';
        warnings.push(
          `Browser extension on ${node.nodeName} is not polling (last contact: ${ageSeconds}); `
          + 'commands to that node cannot be delivered until it reconnects.',
        );
        continue;
      }
      if (node.commandsDeliverable) {
        continue;
      }
      warnings.push(
        node.commandsUndeliverableReason?.startsWith(BROWSER_WORKER_AGENT_TOO_OLD)
          ? node.commandsUndeliverableReason
          : `Browser extension on ${node.nodeName} is polling but rejecting every command`
            + `${node.commandsUndeliverableReason ? ` (${node.commandsUndeliverableReason})` : ''}; `
            + `redeploy the worker agent to ${node.nodeName}.`,
      );
    }

    const secretObservationProtection = {
      settingEnabled: this.secretObservationSettingEnabled(),
      local: this.secretObservationHealth('local'),
    };
    warnings.push(...secretObservationWarnings(secretObservationProtection.settingEnabled, [
      { name: 'this computer', report: secretObservationProtection.local },
      ...remoteExtensions.nodes.map((node) => ({ name: node.nodeName, report: node.secretObservation })),
    ]));

    const remoteCommandsDeliverable = remoteExtensions.nodes.every(
      (node) => node.commandsDeliverable,
    );
    return {
      status: chromeRuntime.available && bridgeAvailable && remoteCommandsDeliverable
        ? 'ready'
        : 'partial',
      checkedAt: this.now(),
      chromeRuntime,
      localExtension,
      secretObservationProtection,
      managedProfiles: {
        total: profiles.length,
        running,
        locked,
        errors,
      },
      renderer,
      targetRenderers,
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

  private getTargetRendererHealth(): BrowserGatewayHealthReport['targetRenderers'] {
    const now = new Date(this.now());
    const wedgedTargets = new Set(this.listWedgedTargets());
    const managed = this.targetRegistry.listTargets()
      .filter((target): target is typeof target & { profileId: string } =>
        target.mode !== 'existing-tab' && typeof target.profileId === 'string')
      .map((target) => ({
        profileId: target.profileId,
        targetId: target.id,
        mode: 'managed' as const,
        ...classifyBrowserTargetLiveness({
          now,
          managedRendererWedged: wedgedTargets.has(target.id),
        }),
      }));
    const existing = this.extensionTabStore.listTabs().map((target) => ({
      profileId: target.profileId,
      targetId: target.targetId,
      mode: 'existing-tab' as const,
      ...classifyBrowserTargetLiveness({ text: target.text, now }),
    }));
    return [...managed, ...existing];
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
        const enabled = relay?.enabled ?? Boolean(node.capabilities.hasExtensionRelay);
        const running = relay?.running ?? Boolean(node.capabilities.hasExtensionRelay);
        const deliveryHealth = this.extensionCommandStore.describeDeliveryHealth(
          browserExtensionQueueKeyForNode(node.id),
        );
        const clocks = classifyRemoteExtensionContact({
          coordinatorPollAt: this.extensionContactState.getLastExtensionContactAt(node.id),
          relayContactAt: relay?.lastExtensionContactAt,
          nodeConnectedAt: node.connectedAt,
          commandsAnswered: deliveryHealth.commandsAnswered,
          now: this.now(),
        });
        const channelState = enabled && running ? clocks.state : 'fresh';
        const { lastContactAt } = clocks;
        const connectionFlap = this.connectionFlapState(node.id);
        const lastDisconnect = this.extensionContactState.getLastDisconnect?.(node.id);
        const { queueKey, ...queue } = this.extensionCommandStore.describeQueue(
          browserExtensionQueueKeyForNode(node.id),
        );
        void queueKey;
        const capability = assessRemoteExtensionCommandCapability({
          nodeName: node.name,
          hasExtensionRelay: nodeHasExtensionRelay(node),
          ...(relay ? { relay } : {}),
          ...this.preDeliveryCapability(node.id),
        });
        const relayNotForwarding = channelState === 'relay_not_forwarding';
        // A channel that accepts commands and never answers them is not
        // deliverable in any sense the caller cares about. Reporting it as
        // deliverable is what made a 9h outage on windows-pc read as healthy,
        // and it also gated browser.recover_extension shut.
        const commandsUnanswered = channelState === 'commands_unanswered';
        return {
          nodeId: node.id,
          nodeName: node.name,
          enabled,
          running,
          silent: channelState === 'silent',
          channelState,
          commandsDeliverable:
            capability.commandsDeliverable && !relayNotForwarding && !commandsUnanswered,
          ...(capability.reason
            ? { commandsUndeliverableReason: capability.reason }
            : relayNotForwarding
              ? { commandsUndeliverableReason: 'relay_not_forwarding' }
              : commandsUnanswered
                ? { commandsUndeliverableReason: 'commands_unanswered' }
                : {}),
          ...(deliveryHealth.consecutiveUnanswered > 0
            ? { consecutiveUnansweredCommands: deliveryHealth.consecutiveUnanswered }
            : {}),
          lastContactAt,
          ...(lastContactAt !== undefined
            ? { contactAgeMs: Math.max(0, this.now() - lastContactAt) }
            : {}),
          ...(clocks.coordinatorPollAgeMs !== undefined ? { coordinatorPollAgeMs: clocks.coordinatorPollAgeMs } : {}),
          ...(clocks.relayContactAgeMs !== undefined ? { relayContactAgeMs: clocks.relayContactAgeMs } : {}),
          ...(connectionFlap ? { connectionFlap } : {}),
          queue,
          contactGaps: this.extensionContactState.getContactGapStats(node.id),
          ...(lastDisconnect ? { lastDisconnect } : {}),
          serviceWorkerRestarts: this.serviceWorkerRestartCount(
            node.id,
            relay?.extensionReloadedAt,
          ),
          registration: relay?.registration,
          lastRegistrationCheckAt: relay?.lastRegistrationCheckAt,
          secretObservation: this.secretObservationHealth(browserExtensionQueueKeyForNode(node.id)),
        };
      });
    return {
      total: nodes.length,
      ready: nodes.filter((node) =>
        node.enabled && node.running && !node.silent && node.commandsDeliverable
      ).length,
      silent: nodes.filter((node) => node.silent).length,
      nodes,
    };
  }

  private secretObservationHealth(queueKey: string): BrowserSecretObservationHealth {
    return toSecretObservationHealth(
      this.extensionCommandStore.describeSecretObservation?.(queueKey),
      this.now(),
    );
  }

  private preDeliveryCapability(nodeId: string): {
    preDelivery?: BrowserPreDeliveryCapability;
  } {
    const preDelivery = this.extensionCommandStore.describePreDeliveryCapability?.(
      browserExtensionQueueKeyForNode(nodeId),
    );
    return preDelivery ? { preDelivery } : {};
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

export function getBrowserHealthService(): BrowserHealthService {
  return BrowserHealthService.getInstance();
}
