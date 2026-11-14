/**
 * Records what the main process is doing when it keeps freezing.
 *
 * RuntimeDiagnostics notices event-loop stalls but can only report their
 * length: the log lines around a stall rarely name the code that held the
 * thread. When stalls repeat (STALLS_TO_TRIGGER within STALL_WINDOW_MS), this
 * takes a short V8 CPU profile through the in-process inspector, saves it as a
 * `.cpuprofile` (opens in Chrome DevTools' Performance panel) under
 * `<userData>/diagnostics/main-stall-profiles`, and logs the hottest functions
 * with the call path that reached them, so the cause is in app.log directly.
 *
 * V8 samples from its own thread, so a profile running across a stall records
 * the JavaScript that was blocking. At most one capture per COOLDOWN_MS; only
 * the newest KEEP_PROFILES files are kept. Profiles hold function names and
 * source locations only, never user data, and stay on this machine.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Profiler } from 'node:inspector';
import { Session } from 'node:inspector/promises';
import { getLogger } from '../logging/logger';

const logger = getLogger('MainProcessStallProfiler');

const STALLS_TO_TRIGGER = 3;
const STALL_WINDOW_MS = 60_000;
const CAPTURE_MS = 30_000;
const COOLDOWN_MS = 30 * 60_000;
const KEEP_PROFILES = 5;
/** Microseconds between samples; coarse enough to keep the profile small. */
const SAMPLING_INTERVAL_US = 5_000;
const HOT_FRAME_COUNT = 8;
const STACK_DEPTH = 6;

export interface HotFrame {
  /** `functionName file:line`, or a V8 pseudo-frame such as `(garbage collector)`. */
  frame: string;
  selfMs: number;
  /** Share of the busy (non-idle) time, in percent. */
  busyPercent: number;
  /** Callers of the heaviest node for this frame, nearest first. */
  calledFrom: string[];
}

export interface CpuProfileSummary {
  sampledMs: number;
  /** Share of the capture the thread was running rather than idle, in percent. */
  busyPercent: number;
  hotFrames: HotFrame[];
}

export interface MainProcessStallProfilerOptions {
  outputDir: string;
  now?: () => number;
  captureProfile?: (durationMs: number) => Promise<Profiler.Profile>;
  log?: Pick<typeof logger, 'warn'>;
}

export class MainProcessStallProfiler {
  private readonly outputDir: string;
  private readonly now: () => number;
  private readonly captureProfile: (durationMs: number) => Promise<Profiler.Profile>;
  private readonly log: Pick<typeof logger, 'warn'>;
  private recentStalls: number[] = [];
  private capturing = false;
  private lastCaptureAt: number | null = null;

  constructor(options: MainProcessStallProfilerOptions) {
    this.outputDir = options.outputDir;
    this.now = options.now ?? Date.now;
    this.captureProfile = options.captureProfile ?? captureInProcessCpuProfile;
    this.log = options.log ?? logger;
  }

  /**
   * Call once per detected stall. Starts a capture when stalls are repeating
   * and returns it (it never rejects); otherwise returns null.
   */
  noteStall(): Promise<void> | null {
    const at = this.now();
    this.recentStalls = this.recentStalls.filter((stallAt) => at - stallAt <= STALL_WINDOW_MS);
    this.recentStalls.push(at);
    if (this.capturing || this.recentStalls.length < STALLS_TO_TRIGGER) return null;
    if (this.lastCaptureAt !== null && at - this.lastCaptureAt < COOLDOWN_MS) return null;

    this.capturing = true;
    this.lastCaptureAt = at;
    this.recentStalls = [];
    return this.captureAndReport(at).finally(() => {
      this.capturing = false;
    });
  }

  private async captureAndReport(startedAt: number): Promise<void> {
    try {
      const profile = await this.captureProfile(CAPTURE_MS);
      const file = path.join(
        this.outputDir,
        `main-stall-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.cpuprofile`,
      );
      await fs.mkdir(this.outputDir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(profile), 'utf8');
      await this.pruneOldProfiles();
      this.log.warn('Main process stall profile captured', { file, ...summarizeCpuProfile(profile) });
    } catch (error) {
      this.log.warn('Main process stall profile could not be captured', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async pruneOldProfiles(): Promise<void> {
    const names = (await fs.readdir(this.outputDir))
      .filter((name) => name.startsWith('main-stall-') && name.endsWith('.cpuprofile'))
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_PROFILES))) {
      await fs.rm(path.join(this.outputDir, name), { force: true });
    }
  }
}

async function captureInProcessCpuProfile(durationMs: number): Promise<Profiler.Profile> {
  const session = new Session();
  session.connect();
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
    await session.post('Profiler.start');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, durationMs).unref();
    });
    const { profile } = await session.post('Profiler.stop');
    return profile;
  } finally {
    session.disconnect();
  }
}

const IGNORED_FRAMES = new Set(['(root)', '(idle)']);

function frameLabel(node: Profiler.ProfileNode): string {
  const { functionName, url, lineNumber } = node.callFrame;
  const name = functionName || '(anonymous)';
  if (!url) return name;
  // Last three path segments are enough to find the file without leaking the home folder.
  const shortUrl = url.replace(/^file:\/\//, '').split(/[\\/]/).slice(-3).join('/');
  return `${name} ${shortUrl}:${lineNumber + 1}`;
}

/** Self time per function, heaviest first, with the call path that reached it. */
export function summarizeCpuProfile(profile: Profiler.Profile, topN = HOT_FRAME_COUNT): CpuProfileSummary {
  const samples = profile.samples ?? [];
  const sampledMs = Math.max(0, (profile.endTime - profile.startTime) / 1000);
  const msPerSample = samples.length > 0 ? sampledMs / samples.length : 0;

  const nodes = new Map<number, Profiler.ProfileNode>();
  const parents = new Map<number, number>();
  for (const node of profile.nodes) {
    nodes.set(node.id, node);
    for (const child of node.children ?? []) parents.set(child, node.id);
  }

  const hitsByNode = new Map<number, number>();
  for (const id of samples) hitsByNode.set(id, (hitsByNode.get(id) ?? 0) + 1);

  let busyHits = 0;
  const byFrame = new Map<string, { hits: number; heaviestNode: number; heaviestHits: number }>();
  for (const [id, hits] of hitsByNode) {
    const node = nodes.get(id);
    if (!node || IGNORED_FRAMES.has(node.callFrame.functionName)) continue;
    busyHits += hits;
    const label = frameLabel(node);
    const entry = byFrame.get(label) ?? { hits: 0, heaviestNode: id, heaviestHits: 0 };
    entry.hits += hits;
    if (hits > entry.heaviestHits) {
      entry.heaviestNode = id;
      entry.heaviestHits = hits;
    }
    byFrame.set(label, entry);
  }

  const hotFrames = [...byFrame]
    .sort((left, right) => right[1].hits - left[1].hits)
    .slice(0, topN)
    .map(([frame, entry]) => {
      const calledFrom: string[] = [];
      let parentId = parents.get(entry.heaviestNode);
      while (parentId !== undefined && calledFrom.length < STACK_DEPTH) {
        const parent = nodes.get(parentId);
        if (!parent || IGNORED_FRAMES.has(parent.callFrame.functionName)) break;
        calledFrom.push(frameLabel(parent));
        parentId = parents.get(parentId);
      }
      return {
        frame,
        selfMs: Math.round(entry.hits * msPerSample),
        busyPercent: busyHits > 0 ? Math.round((entry.hits / busyHits) * 1000) / 10 : 0,
        calledFrom,
      };
    });

  return {
    sampledMs: Math.round(sampledMs),
    busyPercent: samples.length > 0 ? Math.round((busyHits / samples.length) * 1000) / 10 : 0,
    hotFrames,
  };
}
