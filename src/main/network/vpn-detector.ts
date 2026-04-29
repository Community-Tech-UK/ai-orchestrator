import { EventEmitter } from 'events';
import * as os from 'node:os';
import * as net from 'node:net';

export type ProbeMode = 'disabled' | 'reachable-means-vpn' | 'unreachable-means-vpn';

export interface VpnDetectorConfig {
  pattern: RegExp;
  treatExistingAsVpn: boolean;
  probeMode: ProbeMode;
  probeHost?: string;
  probeIntervalSec?: number;
  forceFirstScanVpnTreatment?: boolean;
  diagnosticsEnabled?: boolean;
}

export interface DetectorEvent {
  at: number;
  interfacesAdded: string[];
  interfacesRemoved: string[];
  matchedPattern: string | null;
  decision: 'no-change' | 'pause' | 'resume' | 'flap-suppressed' | 'detector-error';
  note?: string;
}

const POLL_MS = 2000;
const HEARTBEAT_MS = 10_000;
const RING_BUFFER_MAX = 50;
const PROBE_TIMEOUT_MS = 5000;

export class VpnDetector extends EventEmitter {
  private static instance: VpnDetector | null = null;

  private cfg: VpnDetectorConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private activeVpnIfaces = new Set<string>();
  private knownNonVpnIfaces = new Set<string>();
  private interfaceSignalActive = false;
  private probeSignalActive = false;
  private probeKnown = false;
  private probeNonAffirmativeCount = 0;
  private removalTickCount = 0;
  private lastEmittedVpnUp = false;
  private firstEvaluationComplete = false;
  private ringBuffer: DetectorEvent[] = [];

  constructor(cfg: VpnDetectorConfig) {
    super();
    this.cfg = cfg;
  }

  static getInstance(cfg: VpnDetectorConfig): VpnDetector {
    if (!this.instance) this.instance = new VpnDetector(cfg);
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance?.stop();
    this.instance = null;
  }

  recentEvents(): DetectorEvent[] {
    return [...this.ringBuffer];
  }

  getLastTickAt(): number {
    return this.lastTickAt;
  }

  isVpnActive(): boolean {
    return this.interfaceSignalActive || this.probeSignalActive;
  }

  probeKnownNow(): boolean {
    return this.probeKnown;
  }

  isHeartbeatStale(): boolean {
    return Date.now() - this.lastTickAt > HEARTBEAT_MS;
  }

  start(): void {
    if (this.timer) return;
    this.init();
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.startProbeIfConfigured();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopProbe();
  }

  updatePattern(pattern: RegExp): void {
    this.cfg = { ...this.cfg, pattern };
    this.reclassifyCurrentInterfaces();
    this.tick();
  }

  updateConfig(cfg: VpnDetectorConfig): void {
    const wasRunning = this.timer !== null;
    this.stop();
    this.cfg = cfg;
    this.activeVpnIfaces.clear();
    this.knownNonVpnIfaces.clear();
    this.interfaceSignalActive = false;
    this.probeSignalActive = false;
    this.probeKnown = false;
    this.probeNonAffirmativeCount = 0;
    this.removalTickCount = 0;
    this.lastEmittedVpnUp = false;
    this.firstEvaluationComplete = false;
    if (wasRunning) this.start();
  }

  startProbeIfConfigured(): void {
    if (!this.isProbeConfigured()) return;
    if (this.probeTimer) clearInterval(this.probeTimer);

    void this.runProbe();
    this.probeTimer = setInterval(
      () => void this.runProbe(),
      (this.cfg.probeIntervalSec ?? 30) * 1000
    );
  }

  stopProbe(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  private init(): void {
    const current = this.currentInterfaceNames();
    const matching = this.matchingInterfaces(current);
    const treatAsVpn = this.cfg.forceFirstScanVpnTreatment || this.cfg.treatExistingAsVpn;

    if (treatAsVpn) {
      this.activeVpnIfaces = new Set(matching);
    } else {
      this.knownNonVpnIfaces = new Set(matching);
    }

    this.lastTickAt = Date.now();
    this.recomputeAggregateAndEmit();
    if (!this.isProbeConfigured()) this.emitFirstEvaluationComplete();
  }

  private tick(): void {
    let current: string[];
    try {
      current = this.currentInterfaceNames();
    } catch (error) {
      this.recordEvent({ decision: 'detector-error', note: String(error) });
      this.emit('detector-error', error);
      return;
    }

    const matching = this.matchingInterfaces(current);

    for (const name of [...this.knownNonVpnIfaces]) {
      if (!current.includes(name)) this.knownNonVpnIfaces.delete(name);
    }

    const newMatches = matching.filter(
      (name) => !this.activeVpnIfaces.has(name) && !this.knownNonVpnIfaces.has(name)
    );
    const goneVpn = [...this.activeVpnIfaces].filter((name) => !current.includes(name));

    let decision: DetectorEvent['decision'] = 'no-change';
    if (newMatches.length > 0) {
      for (const name of newMatches) this.activeVpnIfaces.add(name);
      this.removalTickCount = 0;
      decision = 'pause';
    } else if (goneVpn.length > 0) {
      this.removalTickCount += 1;
      if (this.removalTickCount >= 2) {
        for (const name of goneVpn) this.activeVpnIfaces.delete(name);
        this.removalTickCount = 0;
        decision = 'resume';
      } else {
        decision = 'flap-suppressed';
      }
    } else {
      this.removalTickCount = 0;
    }

    this.lastTickAt = Date.now();
    this.recordEvent({
      decision,
      interfacesAdded: newMatches,
      interfacesRemoved: goneVpn,
    });
    this.recomputeAggregateAndEmit();
  }

  private async runProbe(): Promise<void> {
    if (!this.cfg.probeHost) return;
    const reachable = await this.tcpProbe(this.cfg.probeHost);
    const affirmative =
      this.cfg.probeMode === 'reachable-means-vpn'
        ? reachable
        : this.cfg.probeMode === 'unreachable-means-vpn'
          ? !reachable
          : false;
    this.onProbeResult(affirmative);
  }

  protected onProbeResult(affirmative: boolean): void {
    const wasKnown = this.probeKnown;
    this.probeKnown = true;

    if (affirmative) {
      this.probeSignalActive = true;
      this.probeNonAffirmativeCount = 0;
    } else {
      this.probeNonAffirmativeCount += 1;
      if (this.probeNonAffirmativeCount >= 2) {
        this.probeSignalActive = false;
        this.probeNonAffirmativeCount = 0;
      }
    }

    this.recomputeAggregateAndEmit();
    if (!wasKnown) {
      this.emit('first-probe-completed');
      this.emitFirstEvaluationComplete();
    }
  }

  protected async tcpProbe(hostPort: string): Promise<boolean> {
    const parsed = this.parseHostPort(hostPort);
    if (!parsed) return false;

    return new Promise<boolean>((resolve) => {
      const socket = net.createConnection(parsed.port, parsed.host);
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, PROBE_TIMEOUT_MS);

      socket.once('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  private recomputeAggregateAndEmit(): void {
    this.interfaceSignalActive = this.activeVpnIfaces.size > 0;
    const vpnUp = this.isVpnActive();

    if (!vpnUp && this.isProbeConfigured() && !this.probeKnown) return;

    if (vpnUp !== this.lastEmittedVpnUp) {
      this.lastEmittedVpnUp = vpnUp;
      this.emit(vpnUp ? 'vpn-up' : 'vpn-down', { sources: this.signalSources() });
    }
  }

  private reclassifyCurrentInterfaces(): void {
    const current = this.currentInterfaceNames();
    const matching = this.matchingInterfaces(current);
    this.activeVpnIfaces = new Set([...this.activeVpnIfaces].filter((name) => matching.includes(name)));
    this.knownNonVpnIfaces = new Set(
      [...this.knownNonVpnIfaces].filter((name) => matching.includes(name))
    );
  }

  private currentInterfaceNames(): string[] {
    return Object.keys(os.networkInterfaces());
  }

  private matchingInterfaces(names: string[]): string[] {
    return names.filter((name) => {
      this.cfg.pattern.lastIndex = 0;
      return this.cfg.pattern.test(name);
    });
  }

  private signalSources(): string[] {
    const sources: string[] = [];
    if (this.interfaceSignalActive) sources.push('interface');
    if (this.probeSignalActive) sources.push('probe');
    return sources;
  }

  private recordEvent(partial: Partial<DetectorEvent> & { decision: DetectorEvent['decision'] }): void {
    const event: DetectorEvent = {
      at: Date.now(),
      interfacesAdded: partial.interfacesAdded ?? [],
      interfacesRemoved: partial.interfacesRemoved ?? [],
      matchedPattern: this.cfg.pattern.source,
      decision: partial.decision,
      note: partial.note,
    };
    this.ringBuffer.push(event);
    if (this.ringBuffer.length > RING_BUFFER_MAX) this.ringBuffer.shift();
  }

  private emitFirstEvaluationComplete(): void {
    if (this.firstEvaluationComplete) return;
    this.firstEvaluationComplete = true;
    this.emit('first-evaluation-complete');
  }

  private isProbeConfigured(): boolean {
    return this.cfg.probeMode !== 'disabled' && Boolean(this.cfg.probeHost);
  }

  private parseHostPort(hostPort: string): { host: string; port: number } | null {
    if (hostPort.startsWith('[')) {
      const closing = hostPort.indexOf(']');
      if (closing <= 1 || hostPort[closing + 1] !== ':') return null;
      const host = hostPort.slice(1, closing);
      const port = Number(hostPort.slice(closing + 2));
      return Number.isInteger(port) && port > 0 ? { host, port } : null;
    }

    const separator = hostPort.lastIndexOf(':');
    if (separator <= 0 || separator === hostPort.length - 1) return null;
    const host = hostPort.slice(0, separator);
    const port = Number(hostPort.slice(separator + 1));
    return Number.isInteger(port) && port > 0 ? { host, port } : null;
  }
}

export function getVpnDetector(cfg?: VpnDetectorConfig): VpnDetector {
  if (cfg) return VpnDetector.getInstance(cfg);
  const instance = VpnDetector['instance'];
  if (!instance) throw new Error('VpnDetector not initialised; pass cfg on first call');
  return instance;
}
