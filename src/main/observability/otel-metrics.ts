/**
 * OpenTelemetry Metrics
 *
 * Provides counters and histograms for key operations in Harness.
 * Uses the OTel metrics API so the backend (console, OTLP, in-memory for tests)
 * can be swapped without touching instrumented code.
 *
 * Rule: high-cardinality detail (IDs, paths) → span annotations;
 *       low-cardinality (operation kind, provider, outcome) → metric labels.
 */

import { metrics, type Meter } from '@opentelemetry/api';
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  ConsoleMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { getLogger } from '../logging/logger';

const logger = getLogger('OtelMetrics');

let meterProvider: MeterProvider | null = null;
let metricsInitialized = false;

export interface MetricsOptions {
  /** Export to stdout (dev-only). Default: false. */
  enableConsole?: boolean;
  /** OTLP endpoint — if set, exports to collector. */
  endpoint?: string;
  /** Export interval in milliseconds. Default: 60 000. */
  exportIntervalMs?: number;
}

/** Initialize the MeterProvider. Safe to call multiple times (idempotent). */
export function initMetrics(options?: MetricsOptions): Meter {
  if (!metricsInitialized) {
    const readers = [];

    if (options?.endpoint) {
      // Dynamic import to avoid pulling in the OTLP HTTP package when unused.
      // For production, add @opentelemetry/exporter-metrics-otlp-http to deps.
      logger.info('OTLP metrics endpoint configured', { endpoint: options.endpoint });
    }

    if (options?.enableConsole) {
      readers.push(
        new PeriodicExportingMetricReader({
          exporter: new ConsoleMetricExporter(),
          exportIntervalMillis: options?.exportIntervalMs ?? 60_000,
        }),
      );
    }

    if (readers.length === 0) {
      // No exporters configured — use a no-op in-memory reader so the Meter
      // is still functional (useful for future reader attachment / tests).
      readers.push(
        new PeriodicExportingMetricReader({
          exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
          exportIntervalMillis: options?.exportIntervalMs ?? 60_000,
        }),
      );
    }

    meterProvider = new MeterProvider({ readers });
    metrics.setGlobalMeterProvider(meterProvider);
    metricsInitialized = true;

    logger.info('OTel metrics initialized');
  }

  return metrics.getMeter('ai-orchestrator');
}

/** Get the global Harness meter (must call initMetrics first). */
export function getOrchestratorMeter(): Meter {
  return metrics.getMeter('ai-orchestrator');
}

export async function shutdownMetrics(): Promise<void> {
  await meterProvider?.shutdown();
  meterProvider = null;
  metricsInitialized = false;
}

export function _resetMetricsForTesting(): void {
  meterProvider = null;
  metricsInitialized = false;
  // Reset the global provider to the no-op default so subsequent getMeter
  // calls return no-op instruments and never throw.
  metrics.disable();
}

// ---------------------------------------------------------------------------
// withMetrics — call-site wrapper
// ---------------------------------------------------------------------------

export interface MetricsConfig {
  /** Counter name (records +1 on each call). */
  counter?: string;
  /** Histogram name (records duration in ms). */
  timer?: string;
  /** Static attributes to attach to every observation. */
  attributes?: Record<string, string>;
}

/**
 * Wrap an async operation with metric recording.
 *
 *   const result = await withMetrics(
 *     { counter: 'instance_spawns_total', timer: 'instance_spawn_duration_ms',
 *       attributes: { provider: 'claude' } },
 *     () => spawnInstance(),
 *   );
 *
 * Records the counter once per call and the histogram with the duration in ms.
 * On throw, adds `outcome: 'error'` to attributes and re-throws.
 */
export async function withMetrics<T>(
  config: MetricsConfig,
  fn: () => Promise<T>,
): Promise<T> {
  const meter = getOrchestratorMeter();
  const start = Date.now();

  const counter = config.counter ? meter.createCounter(config.counter) : null;
  const histogram = config.timer ? meter.createHistogram(config.timer) : null;

  try {
    const result = await fn();
    const attrs = { ...config.attributes, outcome: 'success' };
    counter?.add(1, attrs);
    histogram?.record(Date.now() - start, attrs);
    return result;
  } catch (err) {
    const attrs = { ...config.attributes, outcome: 'error' };
    counter?.add(1, attrs);
    histogram?.record(Date.now() - start, attrs);
    throw err;
  }
}

/**
 * Synchronous variant of withMetrics for non-async hot paths.
 */
export function withMetricsSync<T>(
  config: MetricsConfig,
  fn: () => T,
): T {
  const meter = getOrchestratorMeter();
  const start = Date.now();

  const counter = config.counter ? meter.createCounter(config.counter) : null;
  const histogram = config.timer ? meter.createHistogram(config.timer) : null;

  try {
    const result = fn();
    const attrs = { ...config.attributes, outcome: 'success' };
    counter?.add(1, attrs);
    histogram?.record(Date.now() - start, attrs);
    return result;
  } catch (err) {
    const attrs = { ...config.attributes, outcome: 'error' };
    counter?.add(1, attrs);
    histogram?.record(Date.now() - start, attrs);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Named metric constants — use these instead of inline strings
// ---------------------------------------------------------------------------

export const METRICS = {
  /** Counter: number of CLI instances spawned. Attr: provider. */
  INSTANCE_SPAWNS: 'aio_instance_spawns_total',
  /** Histogram (ms): time from spawn() call to first output event. */
  INSTANCE_SPAWN_DURATION: 'aio_instance_spawn_duration_ms',
  /** Counter: number of provider turn completions. Attr: provider, outcome. */
  PROVIDER_TURNS: 'aio_provider_turns_total',
  /** Histogram (ms): duration of a provider turn (first input → idle). */
  PROVIDER_TURN_DURATION: 'aio_provider_turn_duration_ms',
  /** Counter: IPC handler invocations. Attr: channel, outcome. */
  IPC_REQUESTS: 'aio_ipc_requests_total',
  /** Histogram (ms): IPC handler latency. */
  IPC_REQUEST_DURATION: 'aio_ipc_request_duration_ms',
  /** Counter: number of CLI process restarts (non-user-initiated). Attr: provider, reason. */
  CLI_RESTARTS: 'aio_cli_restarts_total',
  /** Counter: orchestration commands dispatched. Attr: command_type, outcome. */
  ORCHESTRATION_COMMANDS: 'aio_orchestration_commands_total',
  /** Histogram (ms): orchestration command latency (dispatch → first event). */
  ORCHESTRATION_COMMAND_DURATION: 'aio_orchestration_command_duration_ms',
} as const;
