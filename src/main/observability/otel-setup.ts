/**
 * OpenTelemetry Tracer Setup
 *
 * Initializes the tracer provider with configurable span exporters.
 * Uses BasicTracerProvider from sdk-trace-base to avoid heavy auto-instrumentation.
 */

import { trace, type Tracer } from '@opentelemetry/api';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { getLogger } from '../logging/logger';
import { LocalTraceFileExporter } from './local-trace-exporter';

const logger = getLogger('OtelSetup');

let initialized = false;
let provider: BasicTracerProvider | null = null;

export interface TracerOptions {
  endpoint?: string;
  serviceName?: string;
  serviceVersion?: string;
  traceFilePath?: string;
  enableConsoleExporter?: boolean;
}

export function initTracer(options?: TracerOptions): Tracer {
  if (!initialized) {
    const endpoint = options?.endpoint
      ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
      ?? process.env['ORCHESTRATOR_OTEL_ENDPOINT'];
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options?.serviceName ?? 'ai-orchestrator',
      [ATTR_SERVICE_VERSION]: options?.serviceVersion ?? '1.0.0',
    });

    const exporters: SpanExporter[] = [
      new LocalTraceFileExporter(options?.traceFilePath),
    ];
    if (endpoint) {
      exporters.push(new OTLPTraceExporter({ url: endpoint }));
    } else if (options?.enableConsoleExporter) {
      exporters.push(new ConsoleSpanExporter());
    }

    // Use BatchSpanProcessor for all exporters to avoid blocking the event loop
    // per span (SimpleSpanProcessor calls export synchronously on each span.end()).
    provider = new BasicTracerProvider({
      resource,
      spanProcessors: exporters.map((exporter) => new BatchSpanProcessor(exporter)),
    });

    trace.setGlobalTracerProvider(provider);

    logger.info('OpenTelemetry initialized', {
      endpoint,
      traceFilePath: options?.traceFilePath,
      consoleExporter: Boolean(options?.enableConsoleExporter && !endpoint),
    });

    initialized = true;
  }

  return trace.getTracer(options?.serviceName ?? 'ai-orchestrator');
}

export function getOrchestratorTracer(): Tracer {
  return trace.getTracer('ai-orchestrator');
}

export async function shutdownTracer(): Promise<void> {
  await provider?.shutdown();
  provider = null;
  initialized = false;
}

export function _resetOtelForTesting(): void {
  provider = null;
  initialized = false;
}
