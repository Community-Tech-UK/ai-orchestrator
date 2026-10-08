import { execFile } from 'child_process';
import type { WorkerHostHealthProcess, WorkerHostHealthSample } from '../shared/types/worker-node.types';
import {
  PROCESS_HANDLE_WARNING_THRESHOLD,
  UDP_ENDPOINT_WARNING_THRESHOLD,
} from '../main/remote-node/node-outage-tracker';

/**
 * Windows host resource sampler.
 *
 * Context (2026-10-08 investigation): the browser computer dropped off twice
 * with its worker process alive but unable to reach the coordinator, and once
 * hung hard. Windows logged UDP ephemeral-port exhaustion (Tcpip 4266) twice
 * that day, and one service held ~127k handles. A single snapshot the next
 * morning was too late to name the culprit, so this keeps a rolling record:
 * one `[HostHealth]` line every few minutes in the worker log, and the latest
 * sample in the heartbeat capabilities so the coordinator can report what the
 * host looked like just before a drop.
 *
 * Dependency-light like `worker-runtime-vitals.ts` (no electron, no logger).
 */

export const DEFAULT_HOST_HEALTH_INTERVAL_MS = 5 * 60_000;
/** First sample shortly after start, off the startup critical path. */
export const DEFAULT_HOST_HEALTH_FIRST_DELAY_MS = 30_000;
const SAMPLE_TIMEOUT_MS = 30_000;
const TOP_N = 3;

// A failed query must fail the whole sample (exit 1): reporting an empty
// result as "0 ports in use" would overwrite the last real sample with a
// healthy-looking one, most likely during the very port exhaustion it watches.
export const HOST_HEALTH_SAMPLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $procs = @(Get-Process)',
  '  $udp = @(Get-NetUDPEndpoint)',
  '  $tcp = @(Get-NetTCPConnection)',
  '} catch { exit 1 }',
  '$names = @{}; foreach ($p in $procs) { $names[[int]$p.Id] = $p.ProcessName }',
  `$topUdp = @($udp | Group-Object OwningProcess | Sort-Object Count -Descending | Select-Object -First ${TOP_N} | ForEach-Object { @{ name = [string]$names[[int]$_.Name]; pid = [int]$_.Name; count = [int]$_.Count } })`,
  `$topHandles = @($procs | Sort-Object HandleCount -Descending | Select-Object -First ${TOP_N} | ForEach-Object { @{ name = [string]$_.ProcessName; pid = [int]$_.Id; count = [int]$_.HandleCount } })`,
  '@{ udp = $udp.Count; tcp = $tcp.Count; topUdp = $topUdp; topHandles = $topHandles } | ConvertTo-Json -Compress -Depth 4',
].join('\n');

/** Runs the sampling script and resolves its stdout. */
export type HostHealthCommandRunner = () => Promise<string>;

export interface HostHealthSamplingOptions {
  platform?: NodeJS.Platform;
  intervalMs?: number;
  firstDelayMs?: number;
  runCommand?: HostHealthCommandRunner;
  now?: () => number;
  emit?: (level: 'info' | 'warn', sample: WorkerHostHealthSample) => void;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

let latestSample: WorkerHostHealthSample | undefined;

/** The most recent successful sample, reported in heartbeat capabilities. */
export function getLatestHostHealthSample(): WorkerHostHealthSample | undefined {
  return latestSample;
}

export function _resetHostHealthSamplerForTesting(): void {
  latestSample = undefined;
}

export function runPowerShellSample(): Promise<string> {
  // -EncodedCommand avoids any quoting through the Windows command line.
  const encoded = Buffer.from(HOST_HEALTH_SAMPLE_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: SAMPLE_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** Parse the script's JSON into a bounded sample, or undefined when unusable. */
export function parseHostHealthOutput(stdout: string, sampledAt: number): WorkerHostHealthSample | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  const udpEndpoints = count(raw['udp']);
  const tcpConnections = count(raw['tcp']);
  if (udpEndpoints === undefined || tcpConnections === undefined) return undefined;
  return {
    sampledAt,
    udpEndpoints,
    tcpConnections,
    topUdpOwners: processes(raw['topUdp']),
    topHandleHolders: processes(raw['topHandles']),
  };
}

export function isHostHealthAbnormal(sample: WorkerHostHealthSample): boolean {
  return sample.udpEndpoints > UDP_ENDPOINT_WARNING_THRESHOLD
    || sample.topHandleHolders.some((holder) => holder.count > PROCESS_HANDLE_WARNING_THRESHOLD);
}

export function formatHostHealth(sample: WorkerHostHealthSample): string {
  return `[HostHealth] ${JSON.stringify(sample)}`;
}

/**
 * Start sampling on Windows. Returns a stop function; a no-op elsewhere.
 * Samples never overlap, and a failed sample keeps the previous one.
 */
export function startHostHealthSampling(options: HostHealthSamplingOptions = {}): () => void {
  if ((options.platform ?? process.platform) !== 'win32') return () => undefined;
  const intervalMs = options.intervalMs ?? DEFAULT_HOST_HEALTH_INTERVAL_MS;
  const runCommand = options.runCommand ?? runPowerShellSample;
  const now = options.now ?? Date.now;
  const setTimeoutFn = options.setTimeout ?? setTimeout;
  const clearTimeoutFn = options.clearTimeout ?? clearTimeout;
  const emit = options.emit ?? ((level: 'info' | 'warn', sample: WorkerHostHealthSample): void => {
    const line = formatHostHealth(sample);
    if (level === 'warn') console.warn(line);
    else console.info(line);
  });

  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    handle = setTimeoutFn(() => void tick(), delayMs);
    (handle as { unref?: () => void }).unref?.();
  };

  const tick = async (): Promise<void> => {
    try {
      const sample = parseHostHealthOutput(await runCommand(), now());
      if (sample && !stopped) {
        latestSample = sample;
        emit(isHostHealthAbnormal(sample) ? 'warn' : 'info', sample);
      }
    } catch {
      // Telemetry must never take the worker down.
    } finally {
      // Re-arm only after this sample finishes, so a slow host cannot stack runs.
      schedule(intervalMs);
    }
  };

  schedule(options.firstDelayMs ?? DEFAULT_HOST_HEALTH_FIRST_DELAY_MS);
  return (): void => {
    stopped = true;
    if (handle !== undefined) clearTimeoutFn(handle);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function processes(value: unknown): WorkerHostHealthProcess[] {
  // ConvertTo-Json emits a lone object instead of a one-element array.
  const list = Array.isArray(value) ? value : isRecord(value) ? [value] : [];
  const result: WorkerHostHealthProcess[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const pid = count(entry['pid']);
    const held = count(entry['count']);
    if (pid === undefined || held === undefined) continue;
    const name = typeof entry['name'] === 'string' && entry['name'] ? entry['name'].slice(0, 256) : `pid ${pid}`;
    result.push({ name, pid, count: held });
    if (result.length === TOP_N) break;
  }
  return result;
}
