import { app, BrowserWindow, powerMonitor } from 'electron';
import { getObservationIngestor } from '../observation';
import { getSessionContinuityManagerIfInitialized } from '../session/session-continuity';
import { getHibernationManager } from '../process/hibernation-manager';
import { getPoolManager } from '../process/pool-manager';
import { getLogger } from '../logging/logger';
import { readPriorWatchdogReport } from '../runtime/main-process-watchdog';
import { getSystemLoadMonitor } from '../runtime/system-load-monitor';
import { getRendererHeartbeatMonitor } from '../logging/renderer-heartbeat-monitor';
import { getEventLoopLagMonitor } from '../runtime/event-loop-lag-monitor';
import { getContextWorkerClient } from '../instance/context-worker-client';
import { getCodemem } from '../codemem';

const logger = getLogger('RuntimeDiagnostics');
const MAIN_PROCESS_MONITOR_INTERVAL_MS = 1000;
const MAIN_PROCESS_STALL_THRESHOLD_MS = 2000;
const POST_RESUME_GRACE_PERIOD_MS = 60_000;
const CPU_SAMPLE_INTERVAL_MS = 60_000;
const CPU_BUSY_THRESHOLD_CORES = 0.5;
const CPU_BUSY_SUSTAINED_SAMPLES = 5;
const CPU_WINDOW_SAMPLES = 15;
const MAX_TOOL_NAMES_PER_CHAT = 40;
const TOOL_SUMMARY_TOP_N = 20;

let runtimeDiagnosticsInstalled = false;

type ActivityValue = number | boolean;
export type CpuActivitySnapshot = Record<string, ActivityValue>;

interface CpuSample {
  at: number;
  cores: number;
  activity: CpuActivitySnapshot;
}

function safeRead<T>(read: () => T | undefined, fallback: T): T {
  try {
    return read() ?? fallback;
  } catch {
    return fallback;
  }
}

export interface MainProcessCpuSamplerOptions {
  cpuUsage?: () => NodeJS.CpuUsage;
  now?: () => number;
  intervalMs?: number;
  thresholdCores?: number;
  sustainedSamples?: number;
  windowSamples?: number;
  /** Cheap counters describing what Harness was doing during the last sample; called once per sample. */
  readActivity?: () => CpuActivitySnapshot;
  log?: Pick<typeof logger, 'info' | 'warn'>;
}

export interface MainProcessCpuSampler {
  stop(): void;
  /** Recent samples, oldest first. */
  samples(): readonly Readonly<CpuSample>[];
}

function roundCores(cores: number): number {
  return Math.round(cores * 100) / 100;
}

/**
 * Samples the main process's own CPU once a minute and warns, once per episode,
 * when it stays above `thresholdCores` for `sustainedSamples` consecutive
 * samples. Local log only.
 */
export function startMainProcessCpuSampler(options: MainProcessCpuSamplerOptions = {}): MainProcessCpuSampler {
  const cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? CPU_SAMPLE_INTERVAL_MS;
  const thresholdCores = options.thresholdCores ?? CPU_BUSY_THRESHOLD_CORES;
  const sustainedSamples = options.sustainedSamples ?? CPU_BUSY_SUSTAINED_SAMPLES;
  const windowSamples = Math.max(options.windowSamples ?? CPU_WINDOW_SAMPLES, sustainedSamples);
  const log = options.log ?? logger;

  const window: CpuSample[] = [];
  let lastUsage = cpuUsage();
  let lastAt = now();
  let consecutiveBusy = 0;
  let episode: { startedAt: number; lastBusyAt: number; peakCores: number } | null = null;

  const readActivity = (): CpuActivitySnapshot => {
    try {
      return options.readActivity?.() ?? {};
    } catch {
      return {};
    }
  };

  const tick = (): void => {
    const usage = cpuUsage();
    const at = now();
    const wallMs = at - lastAt;
    const cpuMicros = (usage.user - lastUsage.user) + (usage.system - lastUsage.system);
    lastUsage = usage;
    lastAt = at;
    const activity = readActivity();
    if (wallMs <= 0) return;

    const cores = cpuMicros / 1000 / wallMs;
    window.push({ at, cores, activity });
    if (window.length > windowSamples) window.shift();

    if (cores <= thresholdCores) {
      consecutiveBusy = 0;
      if (episode) {
        log.info('Main process CPU back to normal', {
          coresNow: roundCores(cores),
          peakCores: roundCores(episode.peakCores),
          busyForMinutes: Math.round((episode.lastBusyAt - episode.startedAt) / 60_000),
          thresholdCores,
        });
        episode = null;
      }
      return;
    }

    consecutiveBusy += 1;
    if (episode) {
      episode.peakCores = Math.max(episode.peakCores, cores);
      episode.lastBusyAt = at;
      return;
    }
    if (consecutiveBusy < sustainedSamples) return;

    const busy = window.slice(-sustainedSamples);
    const peak = busy.reduce((max, sample) => (sample.cores > max.cores ? sample : max));
    const averageCores = busy.reduce((sum, sample) => sum + sample.cores, 0) / busy.length;
    episode = { startedAt: busy[0].at - intervalMs, lastBusyAt: at, peakCores: peak.cores };
    log.warn('Main process CPU stayed high', {
      averageCores: roundCores(averageCores),
      peakCores: roundCores(peak.cores),
      minutes: Math.round((busy.length * intervalMs) / 60_000),
      thresholdCores,
      busiestMinuteActivity: peak.activity,
      latestActivity: activity,
    });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
    samples: () => window.map((sample) => ({ ...sample })),
  };
}

/** The parts of InstanceManager runtime diagnostics reads. */
export interface RuntimeDiagnosticsInstanceSource {
  getAllInstances(): readonly { status: string }[];
  getProviderEventBusMetrics(): { emitted: number };
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface ToolUseEnvelopeLike {
  instanceId?: string;
  event?: { kind?: string; toolName?: string; toolUseId?: string };
}

interface ChatToolUsage {
  total: number;
  byName: Map<string, number>;
  seenToolUseIds: Set<string>;
}

const HELPER_TOOL_PATTERN = /^mcp__(.+?)__.+$/;

/**
 * Counts each chat's tool calls by name and logs a summary when the chat is
 * removed. Names and counts only; never arguments or results.
 */
export function installChatToolUsageLog(
  source: Pick<RuntimeDiagnosticsInstanceSource, 'on'>,
  log: Pick<typeof logger, 'info'> = logger,
): void {
  const usageByChat = new Map<string, ChatToolUsage>();

  source.on('provider:normalized-event', ((envelope: ToolUseEnvelopeLike) => {
    const event = envelope?.event;
    if (event?.kind !== 'tool_use' || !envelope.instanceId || !event.toolName) return;
    let usage = usageByChat.get(envelope.instanceId);
    if (!usage) {
      usage = { total: 0, byName: new Map<string, number>(), seenToolUseIds: new Set<string>() };
      usageByChat.set(envelope.instanceId, usage);
    }
    if (event.toolUseId) {
      if (usage.seenToolUseIds.has(event.toolUseId)) return;
      usage.seenToolUseIds.add(event.toolUseId);
    }
    usage.total += 1;
    const name = usage.byName.has(event.toolName) || usage.byName.size < MAX_TOOL_NAMES_PER_CHAT
      ? event.toolName
      : '(other)';
    usage.byName.set(name, (usage.byName.get(name) ?? 0) + 1);
  }) as (...args: unknown[]) => void);

  source.on('instance:removed', ((instanceId: string) => {
    const usage = usageByChat.get(instanceId);
    usageByChat.delete(instanceId);
    if (!usage) return;
    const helperServers: Record<string, number> = {};
    let helperToolCalls = 0;
    for (const [name, count] of usage.byName) {
      const server = HELPER_TOOL_PATTERN.exec(name)?.[1];
      if (!server) continue;
      helperToolCalls += count;
      helperServers[server] = (helperServers[server] ?? 0) + count;
    }
    const tools = Object.fromEntries(
      [...usage.byName].sort((a, b) => b[1] - a[1]).slice(0, TOOL_SUMMARY_TOP_N),
    );
    log.info('Chat tool use summary', {
      instanceId,
      toolCalls: usage.total,
      helperToolCalls,
      helperServers,
      tools,
    });
  }) as (...args: unknown[]) => void);
}

function roundMegabytes(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

export function installRuntimeDiagnostics(instances?: RuntimeDiagnosticsInstanceSource): void {
  if (runtimeDiagnosticsInstalled) {
    return;
  }

  runtimeDiagnosticsInstalled = true;

  const priorReport = readPriorWatchdogReport(app.getPath('userData'));
  if (priorReport) {
    logger.warn('Prior run had a main-thread stall detected by watchdog', {
      stallDetectedAt: new Date(priorReport.stallDetectedAt).toISOString(),
      stalledForMs: priorReport.stalledForMs,
      appVersion: priorReport.appVersion,
      lastMetrics: priorReport.lastMetrics,
    });
  }

  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') {
      return;
    }

    const detailRecord = details as unknown as Record<string, unknown>;
    logger.error('Electron child process exited unexpectedly', undefined, {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: detailRecord['name'],
      serviceName: detailRecord['serviceName'],
    });
  });

  process.on('warning', (warning) => {
    logger.warn('Process warning emitted', {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
    });
  });

  let eventLoopStallsSinceCpuSample = 0;
  let lastProviderEventsEmitted = safeRead(() => instances?.getProviderEventBusMetrics().emitted, 0);
  startMainProcessCpuSampler({
    readActivity: () => {
      const providerEventsEmitted = safeRead(() => instances?.getProviderEventBusMetrics().emitted, 0);
      const lag = getEventLoopLagMonitor();
      const activity: CpuActivitySnapshot = {
        activeChats: safeRead(() => instances?.getAllInstances().filter((i) => i.status !== 'terminated').length, 0),
        providerEventsSinceLastSample: Math.max(0, providerEventsEmitted - lastProviderEventsEmitted),
        eventLoopStallsSinceLastSample: eventLoopStallsSinceCpuSample,
        eventLoopLagP95Ms: lag.isRunning ? Math.round(lag.snapshot().p95Ms) : 0,
        eventLoopLagMaxMs: lag.isRunning ? Math.round(lag.snapshot().maxMs) : 0,
        contextWorkerInFlight: safeRead(() => getContextWorkerClient().getMetrics().inFlight, 0),
        codeIndexWorkerInFlight: safeRead(() => getCodemem().indexWorkerGateway.getMetrics().inFlight, 0),
        windowCount: BrowserWindow.getAllWindows().length,
      };
      lastProviderEventsEmitted = providerEventsEmitted;
      eventLoopStallsSinceCpuSample = 0;
      return activity;
    },
  });
  if (instances) {
    installChatToolUsageLog(instances);
  }

  let lastTick = Date.now();
  // True between a suspend/lock-screen and the matching resume/unlock. While the
  // host is suspended the event loop is frozen, so the next (dark-)wake tick sees
  // the whole sleep as an apparent "stall" — that is elapsed wall-clock, not host
  // CPU starvation, and must not be warned on or fed into the watchdog load
  // monitor (which would scale process timeouts on phantom load).
  let systemSuspended = false;
  const noteSystemSuspend = (source: 'suspend' | 'lock-screen'): void => {
    systemSuspended = true;
    logger.info('System power event observed', { source });
    getObservationIngestor().handleSystemSuspend();
    getSessionContinuityManagerIfInitialized()?.handleSystemSuspend();
    getHibernationManager().handleSystemSuspend();
    getPoolManager().handleSystemSuspend();
    getRendererHeartbeatMonitor().handleSystemSuspend();
  };
  const noteSystemResume = (source: 'resume' | 'unlock-screen'): void => {
    systemSuspended = false;
    lastTick = Date.now();
    logger.info('System resumed; deferring background timers', {
      source,
      graceMs: POST_RESUME_GRACE_PERIOD_MS,
    });
    getObservationIngestor().handleSystemResume(POST_RESUME_GRACE_PERIOD_MS);
    getSessionContinuityManagerIfInitialized()?.handleSystemResume(POST_RESUME_GRACE_PERIOD_MS);
    getHibernationManager().handleSystemResume(POST_RESUME_GRACE_PERIOD_MS);
    getPoolManager().handleSystemResume(POST_RESUME_GRACE_PERIOD_MS);
    getRendererHeartbeatMonitor().handleSystemResume();
  };

  powerMonitor.on('suspend', () => {
    noteSystemSuspend('suspend');
  });
  powerMonitor.on('resume', () => {
    noteSystemResume('resume');
  });
  powerMonitor.on('lock-screen', () => {
    noteSystemSuspend('lock-screen');
  });
  powerMonitor.on('unlock-screen', () => {
    noteSystemResume('unlock-screen');
  });

  const timer = setInterval(() => {
    const now = Date.now();
    const stallMs = now - lastTick - MAIN_PROCESS_MONITOR_INTERVAL_MS;
    lastTick = now;

    // A suspend (sleep/lock) explains the gap as elapsed wall-clock, not a stall.
    // StuckProcessDetector resets its own timers on the same signal; do the same
    // here rather than logging phantom multi-minute "stalls" and inflating the
    // watchdog load multiplier.
    if (systemSuspended) {
      return;
    }

    if (stallMs < MAIN_PROCESS_STALL_THRESHOLD_MS) {
      return;
    }

    // Feed the stall into the load monitor so process watchdogs (stream-idle,
    // stuck detection, codex control RPCs) stretch their thresholds while the
    // host is demonstrably starved.
    getSystemLoadMonitor().reportEventLoopStall(stallMs);
    eventLoopStallsSinceCpuSample += 1;

    const memory = process.memoryUsage();
    logger.warn('Main process event loop stall detected', {
      stallMs,
      windowCount: BrowserWindow.getAllWindows().length,
      rssMB: roundMegabytes(memory.rss),
      heapUsedMB: roundMegabytes(memory.heapUsed),
      heapTotalMB: roundMegabytes(memory.heapTotal),
      externalMB: roundMegabytes(memory.external),
      arrayBuffersMB: roundMegabytes(memory.arrayBuffers),
    });
  }, MAIN_PROCESS_MONITOR_INTERVAL_MS);
  timer.unref();
}
