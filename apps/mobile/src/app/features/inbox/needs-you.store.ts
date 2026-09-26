import { DestroyRef, Injectable, InjectionToken, computed, effect, inject, signal, untracked } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Router } from '@angular/router';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type { MobileInstanceDto, MobilePromptDto, MobileSnapshot, PairedHost } from '../../core/models';

export type HostAttentionState = 'checking' | 'online' | 'offline' | 'unauthorized';

export interface HostAttentionView {
  readonly id: string;
  readonly name: string;
  readonly status: HostAttentionState;
}

export interface NeedsYouItem {
  readonly key: string;
  readonly kind: 'prompt' | 'completion';
  readonly hostId: string;
  readonly hostName: string;
  readonly instanceId: string;
  readonly workingDirectory: string;
  readonly title: string;
  readonly message: string;
  readonly createdAt: number;
}

interface ProbeResult {
  readonly status: Exclude<HostAttentionState, 'checking'>;
  readonly prompts: readonly MobilePromptDto[];
  readonly instances: readonly MobileInstanceDto[];
}

export interface HostAttentionProbeEnvironment {
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly subscribeForeground: (listener: (foreground: boolean) => void) => () => void;
}

const PROBE_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 300_000;
const PROBE_TIMEOUT_MS = 15_000;

function browserForegroundSubscription(listener: (foreground: boolean) => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const changed = () => listener(document.visibilityState !== 'hidden');
  document.addEventListener('visibilitychange', changed);
  changed();
  return () => document.removeEventListener('visibilitychange', changed);
}

function nativeForegroundSubscription(listener: (foreground: boolean) => void): () => void {
  let disposed = false;
  let remove: (() => Promise<void>) | undefined;
  void import('@capacitor/app').then(async ({ App }) => {
    if (disposed) return;
    const handle = await App.addListener('appStateChange', ({ isActive }) => listener(isActive));
    if (disposed) void handle.remove();
    else remove = () => handle.remove();
  });
  return () => {
    disposed = true;
    if (remove) void remove();
  };
}

export const HOST_ATTENTION_PROBE_ENVIRONMENT = new InjectionToken<HostAttentionProbeEnvironment>(
  'HOST_ATTENTION_PROBE_ENVIRONMENT',
  {
    providedIn: 'root',
    factory: () => ({
      fetch: (input, init) => globalThis.fetch(input, init),
      subscribeForeground: (listener) => Capacitor.isNativePlatform()
        ? nativeForegroundSubscription(listener)
        : browserForegroundSubscription(listener),
    }),
  },
);

function endpoint(host: PairedHost): string {
  return `${host.secure ? 'https' : 'http'}://${host.host}:${host.port}`;
}

function isSnapshot(value: unknown): value is MobileSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MobileSnapshot>;
  return typeof candidate.hostName === 'string'
    && Array.isArray(candidate.instances)
    && candidate.instances.every(isInstance);
}

function isInstance(value: unknown): value is MobileInstanceDto {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MobileInstanceDto>;
  return typeof candidate.id === 'string'
    && typeof candidate.displayName === 'string'
    && typeof candidate.workingDirectory === 'string'
    && typeof candidate.lastActivity === 'number'
    && Number.isFinite(candidate.lastActivity)
    && typeof candidate.hasUnreadCompletion === 'boolean';
}

function isPrompts(value: unknown): value is MobilePromptDto[] {
  return Array.isArray(value) && value.every((prompt) => {
    if (!prompt || typeof prompt !== 'object') return false;
    const candidate = prompt as Partial<MobilePromptDto>;
    return typeof candidate.id === 'string'
      && typeof candidate.instanceId === 'string'
      && typeof candidate.requestId === 'string'
      && typeof candidate.title === 'string'
      && typeof candidate.message === 'string'
      && typeof candidate.createdAt === 'number'
      && Number.isFinite(candidate.createdAt);
  });
}

/** Foreground-only REST projection for hosts which do not own the active socket. */
@Injectable({ providedIn: 'root' })
export class NeedsYouStore {
  private readonly hosts = inject(HostStore);
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);
  private readonly environment = inject(HOST_ATTENTION_PROBE_ENVIRONMENT);
  private readonly initialized = signal(false);
  private readonly foreground = signal(true);
  private readonly probeResults = signal<Readonly<Record<string, ProbeResult>>>({});
  private readonly targets = new Map<string, PairedHost>();
  private readonly generations = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly controllers = new Map<string, AbortController>();
  private unsubscribeForeground: (() => void) | null = null;

  readonly hostStates = computed<HostAttentionView[]>(() => this.hosts.hosts().map((host) => ({
    id: host.id,
    name: host.name,
    status: this.stateFor(host.id),
  })));

  readonly items = computed<NeedsYouItem[]>(() => {
    const activeId = this.hosts.activeId();
    const activeReady = activeId !== null
      && this.gateway.dataHostId() === activeId
      && this.gateway.state() === 'connected';
    return this.hosts.hosts().flatMap((host) => {
      if (host.id === activeId) {
        if (!activeReady) return [];
        return this.toItems(host, this.gateway.prompts(), this.gateway.snapshot()?.instances ?? []);
      }
      const result = this.probeResults()[host.id];
      return result?.status === 'online' ? this.toItems(host, result.prompts, result.instances) : [];
    }).sort((left, right) => right.createdAt - left.createdAt || left.key.localeCompare(right.key));
  });

  constructor() {
    effect(() => {
      if (!this.initialized()) return;
      const foreground = this.foreground();
      const hosts = this.hosts.hosts();
      const activeId = this.hosts.activeId();
      untracked(() => {
        if (!foreground) {
          this.invalidateAll();
          return;
        }
        this.syncTargets(hosts, activeId);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.unsubscribeForeground?.();
      this.unsubscribeForeground = null;
      this.invalidateAll();
    });
  }

  init(): void {
    if (this.initialized()) return;
    this.unsubscribeForeground = this.environment.subscribeForeground((foreground) => {
      this.foreground.set(foreground);
      if (!foreground) this.invalidateAll();
    });
    this.initialized.set(true);
  }

  stateFor(hostId: string): HostAttentionState {
    if (!this.hosts.hosts().some((host) => host.id === hostId)) return 'checking';
    if (hostId === this.hosts.activeId()) {
      if (this.gateway.dataHostId() !== hostId) return 'checking';
      const state = this.gateway.state();
      if (state === 'connected') return 'online';
      if (state === 'unauthorized') return 'unauthorized';
      return state === 'disconnected' ? 'offline' : 'checking';
    }
    return this.probeResults()[hostId]?.status ?? 'checking';
  }

  async open(item: NeedsYouItem): Promise<void> {
    if (!this.hosts.hosts().some((host) => host.id === item.hostId)) return;
    if (this.hosts.activeId() !== item.hostId) await this.hosts.setActive(item.hostId);
    if (this.hosts.activeId() !== item.hostId) return;
    await this.router.navigate([
      '/projects', item.workingDirectory || '__no_workspace__', 'sessions', item.instanceId,
    ]);
  }

  private syncTargets(hosts: readonly PairedHost[], activeId: string | null): void {
    const targets = new Map(hosts.filter((host) => host.id !== activeId).map((host) => [host.id, host]));
    for (const id of [...this.targets.keys()]) {
      const host = targets.get(id);
      if (!host || this.targets.get(id) !== host) this.invalidate(id);
    }
    for (const host of targets.values()) {
      if (this.targets.get(host.id) !== host) {
        this.targets.set(host.id, host);
        this.failures.set(host.id, 0);
      }
      if (!this.timers.has(host.id) && !this.controllers.has(host.id) && !this.probeResults()[host.id]) {
        this.schedule(host.id, 0);
      }
    }
  }

  private schedule(hostId: string, delay: number): void {
    if (!this.foreground() || this.timers.has(hostId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(hostId);
      void this.probe(hostId);
    }, delay);
    this.timers.set(hostId, timer);
  }

  private async probe(hostId: string): Promise<void> {
    const host = this.hosts.hosts().find((candidate) => candidate.id === hostId);
    if (!host || hostId === this.hosts.activeId() || !this.foreground()) return;
    if (this.targets.get(hostId) !== host) return;
    const generation = this.generations.get(hostId) ?? 0;
    const controller = new AbortController();
    this.controllers.set(hostId, controller);
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const base = endpoint(host);
      const health = await this.environment.fetch(`${base}/health`, { signal: controller.signal });
      if (!health.ok) throw new Error(`Health probe failed (${health.status})`);
      const headers = { authorization: `Bearer ${host.token}` };
      const attentionResults = await Promise.allSettled([
        this.environment.fetch(`${base}/api/prompts`, { headers, signal: controller.signal }),
        this.environment.fetch(`${base}/api/snapshot`, { headers, signal: controller.signal }),
      ]);
      const responses = attentionResults.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []);
      if (responses.some((response) => response.status === 401 || response.status === 403)) {
        this.commitFailure(host, generation, 'unauthorized');
        return;
      }
      if (responses.length !== 2) throw new Error('Attention projection failed');
      const [promptsResponse, snapshotResponse] = responses;
      if (!promptsResponse.ok || !snapshotResponse.ok) throw new Error('Attention projection failed');
      const [prompts, snapshot] = await Promise.all([promptsResponse.json(), snapshotResponse.json()]);
      if (!isPrompts(prompts) || !isSnapshot(snapshot)) throw new Error('Attention projection was malformed');
      if (!this.isCurrent(host, generation)) return;
      this.failures.set(hostId, 0);
      this.setResult(hostId, { status: 'online', prompts, instances: snapshot.instances });
      this.schedule(hostId, PROBE_INTERVAL_MS);
    } catch {
      if (this.isCurrent(host, generation)) this.commitFailure(host, generation, 'offline');
    } finally {
      clearTimeout(timeout);
      if (this.controllers.get(hostId) === controller) this.controllers.delete(hostId);
    }
  }

  private commitFailure(
    host: PairedHost,
    generation: number,
    status: 'offline' | 'unauthorized',
  ): void {
    if (!this.isCurrent(host, generation)) return;
    const failureCount = (this.failures.get(host.id) ?? 0) + 1;
    this.failures.set(host.id, failureCount);
    this.setResult(host.id, { status, prompts: [], instances: [] });
    const delay = Math.min(PROBE_INTERVAL_MS * (2 ** Math.max(0, failureCount - 1)), MAX_BACKOFF_MS);
    this.schedule(host.id, delay);
  }

  private isCurrent(host: PairedHost, generation: number): boolean {
    const current = this.hosts.hosts().find((candidate) => candidate.id === host.id);
    return this.foreground()
      && this.hosts.activeId() !== host.id
      && current === host
      && this.targets.get(host.id) === host
      && (this.generations.get(host.id) ?? 0) === generation;
  }

  private setResult(hostId: string, result: ProbeResult): void {
    this.probeResults.update((results) => ({ ...results, [hostId]: result }));
  }

  private invalidate(hostId: string): void {
    const timer = this.timers.get(hostId);
    if (timer) clearTimeout(timer);
    this.timers.delete(hostId);
    this.controllers.get(hostId)?.abort();
    this.controllers.delete(hostId);
    this.targets.delete(hostId);
    this.failures.delete(hostId);
    this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1);
    this.probeResults.update((results) => {
      if (!(hostId in results)) return results;
      const next = { ...results };
      delete next[hostId];
      return next;
    });
  }

  private invalidateAll(): void {
    const ids = new Set([
      ...this.targets.keys(), ...this.timers.keys(), ...this.controllers.keys(),
      ...Object.keys(this.probeResults()),
    ]);
    for (const id of ids) this.invalidate(id);
  }

  private toItems(
    host: PairedHost,
    prompts: readonly MobilePromptDto[],
    instances: readonly MobileInstanceDto[],
  ): NeedsYouItem[] {
    const instanceById = new Map(instances.map((instance) => [instance.id, instance]));
    const promptItems = prompts.map((prompt): NeedsYouItem => {
      const instance = instanceById.get(prompt.instanceId);
      return {
        key: JSON.stringify([host.id, 'prompt', prompt.instanceId, prompt.requestId, prompt.id]),
        kind: 'prompt', hostId: host.id, hostName: host.name, instanceId: prompt.instanceId,
        workingDirectory: instance?.workingDirectory ?? '__no_workspace__',
        title: prompt.title, message: prompt.message ?? 'Approval requested', createdAt: prompt.createdAt,
      };
    });
    const completions = instances.filter((instance) => instance.hasUnreadCompletion).map((instance): NeedsYouItem => ({
      key: JSON.stringify([host.id, 'completion', instance.id]),
      kind: 'completion', hostId: host.id, hostName: host.name, instanceId: instance.id,
      workingDirectory: instance.workingDirectory || '__no_workspace__',
      title: instance.displayName || 'Session completed', message: 'Completed and ready to review',
      createdAt: instance.lastActivity,
    }));
    return [...promptItems, ...completions];
  }
}
