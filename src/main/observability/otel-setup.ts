/**
 * OpenTelemetry Tracer Setup
 *
 * Initializes the tracer provider with configurable span exporters.
 * Uses BasicTracerProvider from sdk-trace-base to avoid heavy auto-instrumentation.
 */

import { trace, type Tracer } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { getLogger } from '../logging/logger';

const logger = getLogger('OtelSetup');

let initialized = false;

export interface TracerOptions {
  endpoint?: string;
  serviceName?: string;
  serviceVersion?: string;
}

export function initTracer(options?: TracerOptions): Tracer {
  if (!initialized) {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options?.serviceName ?? 'ai-orchestrator',
      [ATTR_SERVICE_VERSION]: options?.serviceVersion ?? '1.0.0',
    });

    const exporter = options?.endpoint
      ? new OTLPTraceExporter({ url: options.endpoint })
      : new ConsoleSpanExporter();

    const provider = new BasicTracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    trace.setGlobalTracerProvider(provider);

    if (options?.endpoint) {
      logger.info(`OpenTelemetry exporting to ${options.endpoint}`);
    } else {
      logger.info('OpenTelemetry using console exporter (no endpoint configured)');
    }

    initialized = true;
  }

  return trace.getTracer(options?.serviceName ?? 'ai-orchestrator');
}

export function getOrchestratorTracer(): Tracer {
  return trace.getTracer('ai-orchestrator');
}

export function _resetOtelForTesting(): void {
  initialized = false;
}
