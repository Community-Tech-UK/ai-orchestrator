/**
 * Provider Event Stress Smoke Script
 *
 * Simulates a high-volume provider event burst through the EventLoopLagMonitor
 * and BoundedAsyncQueue to establish a baseline before main-process offload.
 *
 * Usage:
 *   npm run smoke:provider-events
 *   npm run smoke:provider-events -- --count=50000 --mix=output:80,context:10,status:10
 */

import { randomUUID } from 'node:crypto';
import { EventLoopLagMonitor } from '../src/main/runtime/event-loop-lag-monitor';
import { BoundedAsyncQueue } from '../src/main/runtime/bounded-async-queue';
import type {
  ProviderRuntimeEventEnvelope,
  ProviderEventKind,
} from '../packages/contracts/src/types/provider-runtime-events';

function parseArgs(): { count: number; mix: Record<string, number> } {
  const args = process.argv.slice(2);
  let count = 10_000;
  const mix: Record<string, number> = { output: 80, context: 10, status: 10 };

  for (const arg of args) {
    const countMatch = /^--count=(\d+)$/.exec(arg);
    if (countMatch) { count = parseInt(countMatch[1], 10); continue; }
    const mixMatch = /^--mix=(.+)$/.exec(arg);
    if (mixMatch) {
      for (const p of mixMatch[1].split(',')) {
        const [k, v] = p.split(':');
        if (k && v) mix[k] = parseInt(v, 10);
      }
    }
  }
  return { count, mix };
}

function buildDistribution(mix: Record<string, number>): ProviderEventKind[] {
  const dist: ProviderEventKind[] = [];
  for (const [kind, weight] of Object.entries(mix)) {
    for (let i = 0; i < weight; i++) dist.push(kind as ProviderEventKind);
  }
  return dist;
}

function makeEnvelope(kind: ProviderEventKind, seq: number): ProviderRuntimeEventEnvelope {
  const base = {
    eventId: randomUUID(),
    seq,
    timestamp: Date.now(),
    provider: 'claude' as const,
    instanceId: 'stress-test-instance',
    sessionId: 'stress-test-session',
  };
  switch (kind) {
    case 'output':
      return { ...base, event: { kind: 'output', content: `chunk-${seq}`, messageType: 'assistant' } };
    case 'context':
      return { ...base, event: { kind: 'context', used: seq * 10, total: 200_000, percentage: Math.min(100, seq / 200) } };
    case 'status':
      return { ...base, event: { kind: 'status', status: seq % 2 === 0 ? 'busy' : 'idle' } };
    default:
      return { ...base, event: { kind: 'output', content: `chunk-${seq}`, messageType: 'assistant' } };
  }
}

async function main(): Promise<void> {
  const { count, mix } = parseArgs();
  const dist = buildDistribution(mix);
  const monitor = new EventLoopLagMonitor({ resolutionMs: 5, fallbackIntervalMs: 50 });

  console.log('Provider Event Stress Smoke');
  console.log('===========================');
  console.log(`Events: ${count.toLocaleString()}  Mix: ${JSON.stringify(mix)}\n`);

  let rendererForwarded = 0;
  let traceRecorded = 0;

  const rendererQueue = new BoundedAsyncQueue<ProviderRuntimeEventEnvelope>({
    name: 'stress-renderer',
    maxSize: 5_000,
    concurrency: 4,
    process: async () => { rendererForwarded++; },
  });

  const traceQueue = new BoundedAsyncQueue<ProviderRuntimeEventEnvelope>({
    name: 'stress-trace',
    maxSize: 10_000,
    concurrency: 2,
    process: async () => { traceRecorded++; },
  });

  monitor.start();
  const kindCounts: Record<string, number> = {};
  const wallStart = Date.now();

  for (let i = 0; i < count; i++) {
    const kind = dist[i % dist.length];
    const envelope = makeEnvelope(kind, i);
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    rendererQueue.enqueue(envelope);
    traceQueue.enqueue(envelope);
  }

  const enqueueDurationMs = Date.now() - wallStart;
  await Promise.all([rendererQueue.flush(10_000), traceQueue.flush(10_000)]);
  const totalMs = Date.now() - wallStart;

  const lag = monitor.snapshot();
  monitor.stop();

  const rm = rendererQueue.metrics();
  const tm = traceQueue.metrics();

  console.log('Results');
  console.log('-------');
  console.log(`Enqueue duration:    ${enqueueDurationMs} ms`);
  console.log(`Total wall-clock:    ${totalMs} ms`);
  console.log(`Throughput:          ${Math.round(count / (totalMs / 1000)).toLocaleString()} events/s\n`);

  console.log('Event counts by kind:');
  for (const [kind, n] of Object.entries(kindCounts)) {
    console.log(`  ${kind.padEnd(12)}: ${n.toLocaleString()}`);
  }

  console.log('\nEvent-loop lag:');
  console.log(`  Native histogram:  ${lag.usingNativeHistogram}`);
  console.log(`  max:               ${lag.maxMs.toFixed(2)} ms`);
  console.log(`  p95:               ${lag.p95Ms.toFixed(2)} ms`);
  console.log(`  p99:               ${lag.p99Ms.toFixed(2)} ms`);
  console.log(`  mean:              ${lag.meanMs.toFixed(2)} ms`);
  console.log(`  samples:           ${lag.sampleCount}`);

  console.log('\nRenderer queue:');
  console.log(`  forwarded:         ${rendererForwarded.toLocaleString()}`);
  console.log(`  dropped:           ${rm.dropped}  failed: ${rm.failed}`);

  console.log('\nTrace queue:');
  console.log(`  recorded:          ${traceRecorded.toLocaleString()}`);
  console.log(`  dropped:           ${tm.dropped}  failed: ${tm.failed}`);

  let hasFailure = false;
  if (lag.p95Ms > 50) {
    console.error(`\nFAIL: p95 lag ${lag.p95Ms.toFixed(2)} ms > 50 ms threshold`);
    hasFailure = true;
  }
  if (lag.maxMs > 250) {
    console.warn(`\nWARN: max lag ${lag.maxMs.toFixed(2)} ms > 250 ms (expected before offload tasks)`);
  }

  if (!hasFailure) {
    console.log('\nSmoke: OK (baseline captured — re-run after offload tasks to compare)');
  }

  process.exit(hasFailure ? 1 : 0);
}

main().catch((err) => {
  console.error('Stress smoke failed:', err);
  process.exit(1);
});
