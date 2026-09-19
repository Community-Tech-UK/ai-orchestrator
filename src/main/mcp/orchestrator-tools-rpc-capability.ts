import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Mints and verifies process-local, instance-bound capability tokens for
 * `aio-mcp orchestrator-tools` children (env var
 * `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY`).
 *
 * Before this existed, the RPC server authenticated a caller by instance id
 * alone — guessable, and visible to any process that can read another
 * instance's env. A capability closes that hole: the signing secret is a
 * random 32-byte value generated once per Electron main-process lifetime and
 * never leaves this module, so a token minted for one instance id cannot be
 * reused to authenticate a request naming a different instance id, and a
 * child spawned under a previous app run (a different secret) is
 * automatically rejected once its socket connects to this run's server.
 *
 * There is deliberately no per-instance storage to revoke on instance death:
 * the token is a pure function of (process secret, instanceId), so it stays
 * mathematically reproducible for the app's lifetime. That is safe because
 * `OrchestratorToolsRpcServer.handleRequest` always checks
 * `isKnownLocalInstance(instanceId)` first — once an instance is torn down
 * and removed from the instance manager, that check alone rejects every
 * request for it regardless of whether the (still "valid") token is replayed.
 */
export class OrchestratorToolsRpcInstanceCapability {
  private readonly secret = randomBytes(32);

  /**
   * Mints the capability for `instanceId`. Returns null when the caller does
   * not recognize the id as a live local instance — defense in depth so a
   * bogus/guessed id is never handed a usable token.
   */
  mint(instanceId: string, isKnownLocalInstance: (instanceId: string) => boolean): string | null {
    return isKnownLocalInstance(instanceId) ? this.sign(instanceId) : null;
  }

  /**
   * Constant-time verification. Fails closed: an absent, empty, or
   * mismatched token is rejected. Comparing fixed-length HMAC digests (rather
   * than the raw token) means an unequal-length candidate can never take a
   * different code path than an equal-length one.
   */
  verify(instanceId: string, token: string | undefined): boolean {
    if (!token) return false;
    const expected = Buffer.from(this.sign(instanceId), 'utf8');
    const actual = Buffer.from(token, 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private sign(instanceId: string): string {
    return createHmac('sha256', this.secret).update(instanceId, 'utf8').digest('base64url');
  }
}
