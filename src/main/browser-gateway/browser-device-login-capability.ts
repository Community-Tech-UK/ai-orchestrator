import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const DEVICE_METHODS = new Set(['browser.start_device_login', 'browser.read_device_login',
  'browser.cancel_device_login', 'browser.fill_device_login']);
const MAX_OWNERS = 4096;
interface Capability { token: string; generation: string }

export function isBrowserDeviceLoginMethod(method: string): boolean { return DEVICE_METHODS.has(method); }

/** Separate from ordinary browser authority: one opaque generation per prepared spawn. */
export class BrowserDeviceLoginCapability {
  readonly #owners = new Map<string, Capability>();
  constructor(private readonly isKnownLocalInstance: (instanceId: string) => boolean) {}

  mint(instanceId: string): string | null {
    this.prune();
    if (!this.known(instanceId) || (!this.#owners.has(instanceId) && this.#owners.size >= MAX_OWNERS)) return null;
    const entry = { token: randomBytes(32).toString('base64url'), generation: randomUUID() };
    this.#owners.set(instanceId, entry);
    return entry.token;
  }
  get(instanceId: string): string | null { return this.current(instanceId)?.token ?? null; }
  verify(instanceId: string, token: unknown): string | null {
    this.prune();
    const entry = this.current(instanceId);
    if (!entry || typeof token !== 'string' || token.length !== entry.token.length) return null;
    const candidate = Buffer.from(token, 'utf8');
    const expected = Buffer.from(entry.token, 'utf8');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected) ? entry.generation : null;
  }
  isCurrent(instanceId: string, generation: string): boolean {
    const entry = this.current(instanceId);
    return !!entry && entry.generation === generation;
  }
  revoke(instanceId: string): void { this.#owners.delete(instanceId); }
  clear(): void { this.#owners.clear(); }
  private current(instanceId: string): Capability | undefined {
    if (!this.known(instanceId)) { this.revoke(instanceId); return undefined; }
    return this.#owners.get(instanceId);
  }
  private known(instanceId: string): boolean {
    if (!instanceId || instanceId.length > 200) return false;
    try { return this.isKnownLocalInstance(instanceId) === true; } catch { return false; }
  }
  private prune(): void {
    for (const id of this.#owners.keys()) if (!this.known(id)) this.#owners.delete(id);
  }
}

let provider: BrowserDeviceLoginCapability | null = null;
export function setBrowserDeviceLoginCapabilityProvider(next: BrowserDeviceLoginCapability | null): void {
  if (provider !== next) provider?.clear();
  provider = next;
}
export function mintBrowserDeviceLoginCapability(instanceId: string): string | null { return provider?.mint(instanceId) ?? null; }
export function getBrowserDeviceLoginCapability(instanceId: string): string | null { return provider?.get(instanceId) ?? null; }
export function verifyBrowserDeviceLoginCapability(instanceId: string, token: unknown): string | null { return provider?.verify(instanceId, token) ?? null; }
export function isBrowserDeviceLoginGenerationCurrent(instanceId: string, generation: string): boolean { return provider?.isCurrent(instanceId, generation) ?? false; }
