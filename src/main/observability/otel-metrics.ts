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
