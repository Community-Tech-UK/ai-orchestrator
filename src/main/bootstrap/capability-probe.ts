import { getLogger } from '../logging/logger';
import { getCliDetectionService } from '../cli/cli-detection';
import { getRemoteNodeConfig } from '../remote-node/remote-node-config';
import { getWorkerNodeConnectionServer } from '../remote-node/worker-node-connection';
import { getBrowserAutomationHealthService } from '../browser-automation/browser-automation-health';
import { getMcpManager } from '../mcp/mcp-manager';
import { getProviderDoctor, type DiagnosisResult, type ProbeResult } from '../providers/provider-doctor';
import { getRLMDatabase } from '../persistence/rlm-database';
import { getSettingsManager } from '../core/config/settings-manager';
import { probeSeatbelt } from '../sandbox/seatbelt';
import { providerName } from '../../shared/display-names';
import { formatHostPort } from '../../shared/remote-node/host-address';
import {
  providerExpectation,
  type ProbedProviderId,
  type ProviderExpectation,
  type ProviderExpectationSettings,
} from './provider-expectation';
import type {
  StartupCapabilityCheck,
  StartupCapabilityReport,
  StartupCapabilityOverallStatus,
  StartupCheckFix,
  StartupCheckProblem,
} from '../../shared/types/startup-capability.types';

const logger = getLogger('CapabilityProbe');

/**
 * Startup is "degraded" only by something the user relies on. The probe keeps
 * to that by giving a tool or feature the user has no use for yet the status
 * `disabled` at the source (see `probeProviders`, `probeSandbox` and the
 * subsystem probes), so a single `degraded` or `unavailable` check is always a
 * real problem, and a critical one is a reason the app cannot work at all.
 */
function summarizeStatus(checks: StartupCapabilityCheck[]): StartupCapabilityOverallStatus {
  if (checks.some((check) => check.critical && check.status === 'unavailable')) {
    return 'failed';
  }

  if (checks.some((check) => check.status === 'degraded' || check.status === 'unavailable')) {
    return 'degraded';
  }

  return 'ready';
}

/** The CLIs the probe looks for, and the key the provider doctor knows each by. */
const PROBED_PROVIDERS: readonly { id: ProbedProviderId; doctorKey: string }[] = [
  { id: 'claude', doctorKey: 'claude-cli' },
  { id: 'codex', doctorKey: 'codex-cli' },
  { id: 'antigravity', doctorKey: 'antigravity' },
  { id: 'copilot', doctorKey: 'copilot' },
  { id: 'cursor', doctorKey: 'cursor' },
];

function joinWithOr(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function providerCheck(
  id: ProbedProviderId,
  status: StartupCapabilityCheck['status'],
  summary: string,
  details: Record<string, unknown> | undefined,
): StartupCapabilityCheck {
  return {
    id: `provider.${id}`,
    label: providerName(id),
    category: 'provider',
    status,
    critical: false,
    summary,
    ...(details ? { details } : {}),
  };
}

/** What a missing tool means for this user, in one sentence. */
function missingProviderSummary(name: string, expectation: ProviderExpectation): string {
  if (expectation === 'default') return `${name} isn't installed, but you've chosen it as a default.`;
  if (expectation === 'account') return `${name} isn't installed, but you have a ${name} account set up in Harness.`;
  return `${name} isn't installed. You only need it to use ${name}.`;
}

/**
 * An installed tool that is not healthy, in plain words. The doctor's own
 * message for the failed probe can hold a shell command or a file path, so it
 * stays in `details`; the sentence only names the kind of problem.
 */
function describeProviderProblem(
  name: string,
  failing: ProbeResult | undefined,
): { summary: string; problem: StartupCheckProblem; fix: StartupCheckFix } {
  switch (failing?.name) {
    case 'cli_installed':
      // Reached only when scanning found the tool but the lighter PATH lookup
      // did not: it exists, but not where Harness looks.
      return {
        summary: `${name} is installed, but Harness can't find it.`,
        problem: 'needs-attention',
        fix: 'setup',
      };
    case 'authenticated':
      return { summary: `${name} isn't signed in.`, problem: 'not-signed-in', fix: 'accounts' };
    case 'account_pool':
      return { summary: `None of your ${name} accounts are ready to use.`, problem: 'not-signed-in', fix: 'accounts' };
    case 'cli_shadow_check':
      return {
        summary: `${name} is installed more than once, with different versions.`,
        problem: 'needs-attention',
        fix: 'setup',
      };
    case undefined:
      // Nothing failed, but not everything passed either: a probe timed out.
      return { summary: `Harness couldn't finish checking ${name}.`, problem: 'check-failed', fix: 'setup' };
    default:
      return { summary: `${name} isn't working properly.`, problem: 'needs-attention', fix: 'setup' };
  }
}

/**
 * How long the browser check waits for a tool server that is still connecting.
 * Servers start in the background early in launch and this check runs once, so
 * judging one mid-connect would raise a warning that is gone seconds later (and
 * stays on screen until the next check). Kept short: a server that hangs should
 * cost a launch no more than this.
 */
const TOOL_SERVER_SETTLE_MS = 2_000;

function toolServersStillConnecting(): Set<string> {
  return new Set(getMcpManager().getServers()
    .filter((server) => server.status === 'connecting')
    .map((server) => server.id));
}

/**
 * Resolves once every tool server that is connecting now has finished, one way
 * or the other, or after `timeoutMs`. Returns at once when none is connecting.
 * A server reports itself connected before its tools are listed, so the wait
 * ends on the last phase ("ready") or on any failure.
 */
function waitForToolServersToSettle(timeoutMs: number): Promise<void> {
  const waiting = toolServersStillConnecting();
  if (waiting.size === 0) return Promise.resolve();

  const mcp = getMcpManager();
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      mcp.off('server:phase', onPhase);
      mcp.off('server:error', onSettled);
      resolve();
    };
    const onSettled = (serverId: string): void => {
      waiting.delete(serverId);
      if (waiting.size === 0) finish();
    };
    const onPhase = (serverId: string, phase: string, state: string): void => {
      if (state === 'failed' || (phase === 'ready' && state === 'succeeded')) onSettled(serverId);
    };
    const timer = setTimeout(finish, timeoutMs);
    mcp.on('server:phase', onPhase);
    mcp.on('server:error', onSettled);
  });
}

/** The reason a configured browser tool is not running yet, from the facts the health check gathered. */
function browserNotRunningReason(health: {
  runtimeAvailable: boolean;
  nodeAvailable: boolean;
  inAppConfigured: boolean;
  inAppConnected: boolean;
  inAppToolCount: number;
}, stillConnecting: boolean): string {
  if (!health.runtimeAvailable) return 'no supported browser (Chrome, Chromium or Edge) was found on this computer.';
  if (!health.nodeAvailable) return "Node.js isn't installed, and the browser tools need it.";
  if (health.inAppConfigured && !health.inAppConnected) {
    return stillConnecting ? 'the browser tool server is still connecting.' : "the browser tool server isn't connected.";
  }
  if (health.inAppConnected && health.inAppToolCount === 0) {
    return 'the browser tool server is connected but offers no browser tools.';
  }
  return "the browser tools aren't ready yet.";
}

export class CapabilityProbe {
  private static instance: CapabilityProbe | null = null;
  private lastReport: StartupCapabilityReport | null = null;

  static getInstance(): CapabilityProbe {
    if (!this.instance) {
      this.instance = new CapabilityProbe();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Re-runs every startup check. `force` additionally bypasses the CLI
   * detection cache — required when the user has just changed something
   * outside the app (installed a CLI, ran `claude auth login` in a terminal)
   * and asked the Doctor to re-check.
   */
  async run(options: { force?: boolean } = {}): Promise<StartupCapabilityReport> {
    const generatedAt = Date.now();
    const checks: StartupCapabilityCheck[] = [];

    checks.push(await this.probeNativeDatabase());
    checks.push(...await this.probeProviders(options.force ?? false));
    checks.push(await this.probeRemoteNodes());
    checks.push(await this.probeBrowserAutomation());
    checks.push(await this.probeSandbox());

    const report: StartupCapabilityReport = {
      status: summarizeStatus(checks),
      generatedAt,
      checks,
    };

    this.lastReport = report;
    logger.info('Startup capability probe completed', {
      status: report.status,
      checks: report.checks.map((check) => ({
        id: check.id,
        status: check.status,
      })),
    });
    return report;
  }

  getLastReport(): StartupCapabilityReport | null {
    return this.lastReport;
  }

  /**
   * WS13 hardened run mode readiness. Runs a real no-op under sandbox-exec
   * (binary existing is not enough). Hardened mode is opt-in per session and
   * fails closed at spawn time, so nothing at startup depends on it: a Mac that
   * cannot run it is `disabled` with the reason in `details`, never a startup
   * warning.
   */
  private async probeSandbox(): Promise<StartupCapabilityCheck> {
    const base = {
      id: 'subsystem.sandbox',
      label: 'Hardened mode',
      category: 'subsystem' as const,
      critical: false,
    };
    if (process.platform !== 'darwin') {
      return {
        ...base,
        status: 'disabled',
        summary: "Hardened mode only works on a Mac, so it's off here.",
      };
    }
    const probe = await probeSeatbelt();
    return probe.supported
      ? { ...base, status: 'ready', summary: 'Hardened mode works on this Mac.' }
      : {
          ...base,
          status: 'disabled',
          summary: "Hardened mode can't run on this Mac right now, so a session that asks for it won't start.",
          details: { reason: probe.reason ?? 'unknown' },
        };
  }

  private async probeNativeDatabase(): Promise<StartupCapabilityCheck> {
    try {
      const db = getRLMDatabase().getRawDb();
      db.prepare('SELECT 1').get();
      return {
        id: 'native.sqlite',
        label: 'Local database',
        category: 'native',
        status: 'ready',
        critical: true,
        summary: "Harness's local database is working.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        id: 'native.sqlite',
        label: 'Local database',
        category: 'native',
        status: 'unavailable',
        critical: true,
        summary: "Harness couldn't open its local database.",
        details: { error: message, fix: 'setup' satisfies StartupCheckFix },
      };
    }
  }

  /** The settings that say which tools the user relies on; null when they cannot be read. */
  private readExpectationSettings(): ProviderExpectationSettings | null {
    try {
      const all = getSettingsManager().getAll();
      return {
        defaultCli: all.defaultCli,
        automationDefaultCli: all.automationDefaultCli,
        providerAccountProfiles: all.providerAccountProfiles,
        copilotAccountProfiles: all.copilotAccountProfiles,
      };
    } catch (error) {
      logger.warn('Startup probe could not read settings; treating every optional tool as unused', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async probeProviders(forceRefresh = false): Promise<StartupCapabilityCheck[]> {
    const detection = await getCliDetectionService().detectAll(forceRefresh);
    const available = new Set(detection.available.map((cli) => cli.name));
    const doctor = getProviderDoctor();
    const settings = this.readExpectationSettings();

    const diagnoses = await Promise.all(PROBED_PROVIDERS.map(async (provider) => {
      try {
        return {
          provider,
          diagnosis: await doctor.diagnose(provider.doctorKey),
        };
      } catch (error) {
        return {
          provider,
          diagnosis: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));

    const checks: StartupCapabilityCheck[] = diagnoses.map(({ provider, diagnosis, error }) => {
      const name = providerName(provider.id);
      const detectedAvailable = available.has(provider.id);
      // ProviderDoctor's `cli_installed` probe uses the lighter `which <cmd>` and
      // is much less prone to flakes than CliDetectionService's spawn-based
      // version probe. If detection's cached scan missed the CLI (e.g. its
      // `--version` spawn timed out under fork pressure at startup) but the
      // doctor's `which` confirms the binary is on PATH, treat the provider as
      // installed. Without this defense in depth, a single bad detection scan
      // can falsely say a working provider isn't installed.
      const doctorSaysInstalled = diagnosis?.probes.some(
        (probe) => probe.name === 'cli_installed' && probe.status === 'pass',
      ) ?? false;
      const installed = detectedAvailable || doctorSaysInstalled;
      const expectation = providerExpectation(provider.id, settings);
      if (!installed) {
        // An absent detection result is not proof of a missing binary: version
        // detection can time out, and the doctor may not have answered either.
        const confirmedMissing = diagnosis?.overall === 'not-installed' || diagnosis?.probes.some(
          (probe) => probe.name === 'cli_installed' && probe.status === 'fail' && probe.errorKind === 'cli_not_found',
        );
        if (!confirmedMissing) {
          return providerCheck(provider.id, expectation ? 'degraded' : 'disabled', `Harness couldn't finish checking ${name}.`, {
            problem: 'check-failed' satisfies StartupCheckProblem,
            fix: 'setup' satisfies StartupCheckFix,
            ...(error ? { error } : {}),
          });
        }
        // Not installed is a problem only for someone who wants the tool; for
        // everyone else it is simply not set up, and startup says nothing.
        const details: Record<string, unknown> = {
          problem: 'not-installed' satisfies StartupCheckProblem,
          fix: 'setup' satisfies StartupCheckFix,
          ...(diagnosis ? { recommendations: diagnosis.recommendations } : error ? { error } : {}),
        };
        return providerCheck(
          provider.id,
          expectation ? 'degraded' : 'disabled',
          missingProviderSummary(name, expectation),
          details,
        );
      }

      if (!diagnosis) {
        return providerCheck(provider.id, expectation ? 'degraded' : 'disabled', `${name} is installed, but Harness couldn't check it.`, {
          problem: 'check-failed' satisfies StartupCheckProblem,
          fix: 'setup' satisfies StartupCheckFix,
          ...(error ? { error } : {}),
        });
      }

      return this.installedProviderCheck(provider.id, name, diagnosis, expectation);
    });

    const anyReady = checks.some((check) => check.status === 'ready');
    // A check that could not finish says nothing about whether its tool works, so
    // "none is ready" is a finding only when every tool was actually answered for.
    // Calling it unavailable would stop the composer from sending (see
    // `run-readiness.ts`) over a probe that merely timed out.
    const someNotChecked = !anyReady && checks.some((check) => check.details?.['problem'] === 'check-failed');
    checks.unshift({
      id: 'provider.any',
      label: 'AI tools',
      category: 'provider',
      status: anyReady ? 'ready' : someNotChecked ? 'degraded' : 'unavailable',
      critical: true,
      summary: anyReady
        ? 'At least one AI tool is ready to use.'
        : someNotChecked
          ? "Harness couldn't finish checking your AI tools."
          : `No AI tool is ready to use yet. Set up at least one of ${joinWithOr(
            PROBED_PROVIDERS.map(({ id }) => providerName(id)),
          )}.`,
      details: {
        available: [...available],
        ...(anyReady ? {} : { fix: 'setup' satisfies StartupCheckFix }),
        ...(someNotChecked ? { problem: 'check-failed' satisfies StartupCheckProblem } : {}),
      },
    });

    return checks;
  }

  private installedProviderCheck(
    id: ProbedProviderId,
    name: string,
    diagnosis: DiagnosisResult,
    expectation: ProviderExpectation,
  ): StartupCapabilityCheck {
    if (diagnosis.overall === 'healthy') {
      return providerCheck(id, 'ready', `${name} is ready.`, {
        overall: diagnosis.overall,
        recommendations: diagnosis.recommendations,
      });
    }

    const failing = diagnosis.probes.find((probe) => probe.status === 'fail');
    const { summary, problem, fix } = describeProviderProblem(name, failing);
    return providerCheck(id, expectation ? 'degraded' : 'disabled', summary, {
      overall: diagnosis.overall,
      recommendations: diagnosis.recommendations,
      problem,
      fix,
      ...(failing ? { problemMessage: failing.message } : {}),
    });
  }

  /**
   * The switch is `remoteNodesEnabled`; the live state is whether the server is
   * listening. A switch that is on with nothing listening is the one case worth
   * a warning: the user turned it on and expects other computers to connect.
   * The server starts during app initialization, before this probe runs.
   */
  private async probeRemoteNodes(): Promise<StartupCapabilityCheck> {
    const config = getRemoteNodeConfig();
    const base = {
      id: 'subsystem.remote-nodes',
      label: 'Other computers',
      category: 'subsystem' as const,
      critical: false,
    };
    if (!config.enabled) {
      return {
        ...base,
        status: 'disabled',
        summary: 'Connecting your other computers is switched off.',
      };
    }

    const address = formatHostPort(config.serverHost, config.serverPort);
    const running = getWorkerNodeConnectionServer().isRunning();
    const details = {
      namespace: config.namespace,
      requireTls: Boolean(config.tlsCertPath && config.tlsKeyPath),
      running,
    };
    if (!running) {
      return {
        ...base,
        status: 'degraded',
        summary: `On, but not running yet: Harness isn't listening on ${address}.`,
        details: { ...details, fix: 'remote-computers' satisfies StartupCheckFix },
      };
    }

    return {
      ...base,
      status: 'ready',
      summary: `Running: other computers can connect on ${address}.`,
      details,
    };
  }

  private async probeBrowserAutomation(): Promise<StartupCapabilityCheck> {
    const base = {
      id: 'subsystem.browser-automation',
      label: 'Browser automation',
      category: 'subsystem' as const,
      critical: false,
    };
    try {
      await waitForToolServersToSettle(TOOL_SERVER_SETTLE_MS);
      const health = await getBrowserAutomationHealthService().diagnose();
      const browserAutomationConfigured = health.configDetected || health.inAppConfigured;
      const details = {
        runtimeAvailable: health.runtimeAvailable,
        inAppConfigured: health.inAppConfigured,
        inAppConnected: health.inAppConnected,
        browserToolNames: health.browserToolNames,
        warnings: health.warnings,
        suggestions: health.suggestions,
      };

      if (!browserAutomationConfigured) {
        return {
          ...base,
          status: 'disabled',
          summary: "Browser tools aren't set up. You only need them if you want agents to use a browser.",
          details,
        };
      }

      if (health.status === 'ready') {
        return {
          ...base,
          status: 'ready',
          summary: 'Running: agents can use the browser tools.',
          details,
        };
      }

      return {
        ...base,
        status: 'degraded',
        summary: `On, but not running yet: ${browserNotRunningReason(health, toolServersStillConnecting().size > 0)}`,
        details: { ...details, fix: 'browser' satisfies StartupCheckFix },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...base,
        status: 'degraded',
        summary: "Harness couldn't check the browser tools.",
        details: { error: message, fix: 'browser' satisfies StartupCheckFix },
      };
    }
  }
}

let capabilityProbe: CapabilityProbe | null = null;

export function getCapabilityProbe(): CapabilityProbe {
  if (!capabilityProbe) {
    capabilityProbe = CapabilityProbe.getInstance();
  }
  return capabilityProbe;
}
