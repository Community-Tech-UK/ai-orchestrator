import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

const DEFAULT_PROVIDER_OUTPUT_TTL_MS = 60_000;

/**
 * Tracks provider-originated output envelopes that have already been forwarded
 * over `provider:runtime-event`, so the legacy `instance:output` IPC forwarder
 * can suppress only the matching duplicate renderer payload.
 */
export class ProviderOutputRendererGate {
  private readonly pendingOutputIds = new Map<string, number>();

  constructor(private readonly ttlMs = DEFAULT_PROVIDER_OUTPUT_TTL_MS) {}

  noteEnvelope(envelope: ProviderRuntimeEventEnvelope): void {
    if (envelope.event.kind !== 'output' || !envelope.event.messageId) {
      return;
    }

    this.pruneExpired();
    this.pendingOutputIds.set(
      this.buildKey(envelope.instanceId, envelope.event.messageId),
      Date.now() + this.ttlMs,
    );
  }

  shouldForward(output: { instanceId: string; message?: { id?: string } }): boolean {
    this.pruneExpired();

    const messageId = output.message?.id;
    if (typeof messageId !== 'string' || messageId.length === 0) {
      return true;
    }

    const key = this.buildKey(output.instanceId, messageId);
    if (!this.pendingOutputIds.has(key)) {
      return true;
    }

    this.pendingOutputIds.delete(key);
    return false;
  }

  private pruneExpired(now = Date.now()): void {
    for (const [key, expiresAt] of this.pendingOutputIds) {
      if (expiresAt <= now) {
        this.pendingOutputIds.delete(key);
      }
    }
  }

  private buildKey(instanceId: string, messageId: string): string {
    return `${instanceId}:${messageId}`;
  }
}
