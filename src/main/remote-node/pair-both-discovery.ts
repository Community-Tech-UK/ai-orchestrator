import { Bonjour, type Browser, type Service, type ServiceConfig } from 'bonjour-service';
import { PairBothCandidateSchema } from '@contracts/schemas/remote-node';
import type { PairBothCandidate } from '../../shared/types/pair-both.types';

export const PAIR_BOTH_DISCOVERY_SERVICE_TYPE = 'aio-worker-pair';

const DEFAULT_DISCOVERY_TIMEOUT_MS = 3_000;
const CREDENTIAL_LIKE_KEY = /(?:token|secret|credential|payload)/i;

interface BonjourLike {
  publish(options: ServiceConfig): Service;
  find(options: { type: string }, onUp?: (service: Service) => void): Browser;
  unpublishAll(callback?: CallableFunction): void;
  destroy(callback?: CallableFunction): void;
}

export interface PairBothDiscoveryPublisherOptions {
  createBonjour?: () => BonjourLike;
}

export interface PairBothDiscoveryBrowserOptions {
  createBonjour?: () => BonjourLike;
  now?: () => number;
}

export interface PairBothDiscoverOptions {
  timeoutMs?: number;
}

export class PairBothDiscoveryPublisher {
  private readonly createBonjour: () => BonjourLike;
  private bonjour: BonjourLike | null = null;
  private service: Service | null = null;

  constructor(options: PairBothDiscoveryPublisherOptions = {}) {
    this.createBonjour = options.createBonjour ?? (() => new Bonjour());
  }

  publish(candidate: PairBothCandidate): void {
    this.unpublish();
    const bonjour = this.createBonjour();
    this.bonjour = bonjour;
    this.service = bonjour.publish({
      name: `Harness ${candidate.friendlyName}`,
      type: PAIR_BOTH_DISCOVERY_SERVICE_TYPE,
      port: candidate.port,
      txt: {
        product: candidate.product,
        protocol: candidate.protocol,
        protocolVersion: candidate.protocolVersion,
        pairingSessionId: candidate.pairingSessionId,
        friendlyName: candidate.friendlyName,
        namespace: candidate.namespace,
        coordinatorPublicKey: candidate.coordinatorPublicKey,
        expiresAt: String(candidate.expiresAt),
        host: candidate.host,
      },
    });
  }

  unpublish(): void {
    const bonjour = this.bonjour;
    this.bonjour = null;
    this.service = null;
    bonjour?.unpublishAll();
    bonjour?.destroy();
  }

  get isPublished(): boolean {
    return this.service !== null;
  }
}

export class PairBothDiscoveryBrowser {
  private readonly createBonjour: () => BonjourLike;
  private readonly now: () => number;

  constructor(options: PairBothDiscoveryBrowserOptions = {}) {
    this.createBonjour = options.createBonjour ?? (() => new Bonjour());
    this.now = options.now ?? Date.now;
  }

  discover(options: PairBothDiscoverOptions = {}): Promise<PairBothCandidate[]> {
    const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
    const bonjour = this.createBonjour();
    const candidates = new Map<string, PairBothCandidate>();
    let browser: Browser | null = null;

    return new Promise((resolve) => {
      const cleanup = (): void => {
        browser?.stop();
        bonjour.destroy();
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve([...candidates.values()]);
      }, timeoutMs);

      browser = bonjour.find(
        { type: PAIR_BOTH_DISCOVERY_SERVICE_TYPE },
        (service: Service) => {
          const candidate = candidateFromService(service, this.now());
          if (candidate) {
            candidates.set(candidate.id, candidate);
          }
        },
      );

      timer.unref?.();
    });
  }
}

function candidateFromService(service: Service, now: number): PairBothCandidate | null {
  const txt = txtRecord(service.txt);
  if (!txt || hasCredentialLikeTxtKey(txt)) {
    return null;
  }

  const port = service.port;
  const host = firstNonEmpty(
    txtValue(txt, 'host'),
    firstAddress(service.addresses),
    service.host,
  );
  const expiresAt = numberValue(txt, 'expiresAt');
  const pairingSessionId = txtValue(txt, 'pairingSessionId');
  if (!host || !expiresAt || expiresAt <= now || !pairingSessionId) {
    return null;
  }

  const addresses = uniqueNonEmpty([
    ...(service.addresses ?? []),
    host,
  ]);
  const candidate = {
    id: `pair-both:${pairingSessionId}:${host}:${port}`,
    product: txtValue(txt, 'product'),
    protocol: txtValue(txt, 'protocol'),
    protocolVersion: txtValue(txt, 'protocolVersion'),
    pairingSessionId,
    friendlyName: txtValue(txt, 'friendlyName'),
    namespace: txtValue(txt, 'namespace'),
    port,
    coordinatorPublicKey: txtValue(txt, 'coordinatorPublicKey'),
    expiresAt,
    host,
    addresses,
  };
  const parsed = PairBothCandidateSchema.safeParse(candidate);
  return parsed.success ? parsed.data as PairBothCandidate : null;
}

function txtRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasCredentialLikeTxtKey(txt: Record<string, unknown>): boolean {
  return Object.keys(txt).some((key) => CREDENTIAL_LIKE_KEY.test(key));
}

function txtValue(txt: Record<string, unknown>, key: string): string | undefined {
  const value = txt[key];
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (Buffer.isBuffer(value)) {
    const text = value.toString('utf8').trim();
    return text || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function numberValue(txt: Record<string, unknown>, key: string): number | undefined {
  const value = txtValue(txt, key);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstAddress(addresses: string[] | undefined): string | undefined {
  return addresses?.find((address) => address.trim().length > 0);
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value && value.trim().length > 0)?.trim();
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
