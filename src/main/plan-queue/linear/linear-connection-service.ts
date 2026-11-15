/**
 * The Plan Queue's view of its Linear connection: which connector it uses, who that signs in as, and whether Linear
 * work may start. Nothing new is stored. The state is held in memory and worked out from the saved setting
 * (`planQueueLinearConnection`) and a real "who am I" call, because the connector's own status cannot be trusted after
 * a restart (it says "signed in" until a call fails).
 *
 * - One check at a time: callers that ask while one is running share its answer.
 * - A result belongs to the saved connection it was read for. A check that finished after a Confirm or Forget, or
 *   after the setting changed, is dropped, so it can never overwrite newer state.
 * - After a restart the state is "checking" until the first check finishes, and "checking" is not usable.
 * - "Cannot be reached" tries again by itself after 1, 2 and then every 5 minutes.
 * - A sign-in failure raises the connector's own notice (`ConnectorAuthService`). This file adds none for it.
 *   "Someone else" and "connector changed" raise one notice each time the state is entered, when a run is held by it.
 */
import type {
  PlanQueueLinearConnectionSnapshot,
  PlanQueueLinearConnectionState,
  PlanQueueLinearConnectorChoice,
  PlanQueueLinearIdentity,
  PlanQueueLinearListResult,
  PlanQueueLinearUnreachableCause,
  PlanQueueLinearConnectorProblem,
} from '@contracts/schemas/plan-queue';
import type { PlanQueueLinearConnection } from '@contracts/schemas/plan-queue';
import type { OrchestratorMcpServer } from '../../../shared/types/mcp-orchestrator.types';
import { getLogger } from '../../logging/logger';
import { callLinearToolOnConnector, type LinearCallDependencies } from './linear-call';
import { checkLinearConnectorRecord } from './linear-connector-address';
import { linearConnectionReason } from './linear-connection-reason';
import { isLinearCallError, type LinearCallError } from './linear-errors';
import { LinearWhoAmISchema, type LinearWhoAmI } from './linear-result-schemas';

const logger = getLogger('PlanQueueLinearConnection');

/** A result older than this is checked again the next time a start check asks. */
export const LINEAR_CHECK_MAX_AGE_MS = 5 * 60 * 1000;
/** Waits before each automatic try while Linear cannot be reached; the last one repeats. */
export const LINEAR_RETRY_DELAYS_MS: readonly number[] = [60_000, 120_000, 300_000];

export interface LinearConnectionDependencies {
  readConnection(): PlanQueueLinearConnection;
  /** Saves through the settings manager and announces the change so the page updates. */
  saveConnection(connection: PlanQueueLinearConnection): void;
  listConnectors(): OrchestratorMcpServer[];
  getConnector(id: string): OrchestratorMcpServer | null;
  /** Tests pass the fake connector's call dependencies; the app leaves it out. */
  call?: LinearCallDependencies;
  notify(notice: { title: string; body: string; fingerprint: Record<string, unknown> }): void;
  /** Returns a function that cancels the timer. */
  schedule(run: () => void, delayMs: number): () => void;
  now(): number;
}

type Outcome =
  | { state: 'ready' }
  | { state: 'someone-else' }
  | { state: 'needs-sign-in' }
  | { state: 'connector-changed'; connectorProblem: PlanQueueLinearConnectorProblem }
  | { state: 'unreachable'; unreachableCause: PlanQueueLinearUnreachableCause; retryAfterMs?: number };

interface CheckResult {
  /** The saved connection this result is for. */
  key: string;
  outcome: Outcome;
  checkedAt: number;
  /** Counts each time the state is entered, so a notice can be raised once per entry. */
  entry: number;
  retryAt: number | null;
}

const NOTICE_STATES: readonly PlanQueueLinearConnectionState[] = ['someone-else', 'connector-changed'];

function connectionKey(connection: NonNullable<PlanQueueLinearConnection>): string {
  return JSON.stringify([connection.connectorId, connection.userId]);
}

function describeFailure(error: unknown): Outcome {
  if (!isLinearCallError(error)) return { state: 'unreachable', unreachableCause: 'unreachable' };
  return outcomeForCallError(error);
}

function outcomeForCallError(error: LinearCallError): Outcome {
  switch (error.code) {
    case 'needs-sign-in':
      return { state: 'needs-sign-in' };
    case 'connector-unavailable':
      return { state: 'connector-changed', connectorProblem: error.connectorProblem ?? 'gone' };
    case 'unexpected-result':
      return { state: 'unreachable', unreachableCause: 'unexpected' };
    case 'not-set-up':
    case 'unreachable':
      return {
        state: 'unreachable',
        unreachableCause: error.rateLimited ? 'rate-limited' : 'unreachable',
        retryAfterMs: error.retryAfterMs,
      };
  }
}

export class LinearConnectionService {
  /** Bumped by Confirm and Forget. Work that started under an older number must not write. */
  private version = 0;
  private result: CheckResult | null = null;
  private inFlight: Promise<PlanQueueLinearConnectionSnapshot> | null = null;
  private cancelRetry: (() => void) | null = null;
  private consecutiveUnreachable = 0;
  private entries = 0;
  private noticedEntry = 0;

  constructor(private readonly deps: LinearConnectionDependencies) {}

  /** The current state, worked out now. Starts no check. */
  snapshot(): PlanQueueLinearConnectionSnapshot {
    const connection = this.deps.readConnection();
    if (!connection) return this.build('not-set-up', null, null);
    const result = this.result && this.result.key === connectionKey(connection) ? this.result : null;
    return this.build(result?.outcome.state ?? 'checking', connection, result);
  }

  private build(
    state: PlanQueueLinearConnectionState,
    connection: PlanQueueLinearConnection,
    result: CheckResult | null,
  ): PlanQueueLinearConnectionSnapshot {
    const connector = connection ? this.deps.getConnector(connection.connectorId) : null;
    const outcome = result?.outcome;
    const connectorProblem = outcome?.state === 'connector-changed' ? outcome.connectorProblem : null;
    const unreachableCause = outcome?.state === 'unreachable' ? outcome.unreachableCause : null;
    return {
      state,
      usable: state === 'ready',
      reason: linearConnectionReason({
        state,
        connectorName: connector?.name ?? null,
        connectorProblem,
        unreachableCause,
      }),
      connectorId: connection?.connectorId ?? null,
      connectorName: connector?.name ?? null,
      userName: connection?.userName ?? null,
      workspaceName: connection?.workspaceName ?? null,
      checkedAt: result?.checkedAt ?? null,
      connectorProblem,
      unreachableCause,
      retryAt: state === 'unreachable' ? (result?.retryAt ?? null) : null,
    };
  }

  /**
   * What a start check asks on behalf of a Linear run: why it may not start new work now, or null. Asking starts a new
   * check when there is no result or it is older than five minutes, and raises the one notice for a state that needs
   * James's attention (someone else, or the connector changed) when a run is being held by it.
   */
  reasonToHold(): string | null {
    const snapshot = this.snapshot();
    this.refreshIfStale(snapshot);
    if (snapshot.usable) return null;
    this.noticeIfDue(snapshot);
    return snapshot.reason;
  }

  /** Starts a check when there is no result yet or the last one is older than five minutes. */
  private refreshIfStale(snapshot: PlanQueueLinearConnectionSnapshot): void {
    if (snapshot.state === 'not-set-up') return;
    const age = snapshot.checkedAt === null ? Infinity : this.deps.now() - snapshot.checkedAt;
    if (age > LINEAR_CHECK_MAX_AGE_MS) void this.check();
  }

  private noticeIfDue(snapshot: PlanQueueLinearConnectionSnapshot): void {
    const result = this.result;
    if (!result || !NOTICE_STATES.includes(snapshot.state) || result.entry <= this.noticedEntry) return;
    this.noticedEntry = result.entry;
    this.deps.notify({
      title: 'Linear work is paused',
      body: snapshot.reason ?? '',
      fingerprint: { state: snapshot.state, connectorId: snapshot.connectorId, entry: result.entry },
    });
  }

  /** A caller's own Linear call failed: check again straight away, sharing any check already running. */
  noteCallFailure(): void {
    void this.check();
  }

  /** Checks the saved connection now. Callers that ask while a check is running share its answer. Never rejects. */
  check(): Promise<PlanQueueLinearConnectionSnapshot> {
    if (!this.deps.readConnection()) return Promise.resolve(this.snapshot());
    if (this.inFlight) return this.inFlight;
    const running = this.runCheck(this.version).finally(() => {
      if (this.inFlight === running) this.inFlight = null;
    });
    this.inFlight = running;
    return running;
  }

  private async runCheck(version: number): Promise<PlanQueueLinearConnectionSnapshot> {
    const connection = this.deps.readConnection();
    if (!connection) return this.snapshot();
    let outcome: Outcome;
    try {
      const who = await this.whoAmI(connection.connectorId);
      outcome = who.user.id === connection.userId ? { state: 'ready' } : { state: 'someone-else' };
    } catch (error) {
      outcome = describeFailure(error);
      if (!isLinearCallError(error)) logger.warn('Linear check failed unexpectedly', { error: String(error) });
    }
    // Confirm or Forget happened while this was running, so its answer is about an older connection.
    if (version !== this.version) return this.snapshot();
    this.record(connectionKey(connection), outcome);
    return this.snapshot();
  }

  private record(key: string, outcome: Outcome): void {
    const previous = this.result?.key === key ? this.result.outcome.state : null;
    const entry = previous === outcome.state && this.result ? this.result.entry : ++this.entries;
    const retryAt = this.scheduleRetryFor(outcome);
    this.result = { key, outcome, checkedAt: this.deps.now(), entry, retryAt };
  }

  private scheduleRetryFor(outcome: Outcome): number | null {
    this.cancelRetry?.();
    this.cancelRetry = null;
    if (outcome.state !== 'unreachable') {
      this.consecutiveUnreachable = 0;
      return null;
    }
    const base = LINEAR_RETRY_DELAYS_MS[Math.min(this.consecutiveUnreachable, LINEAR_RETRY_DELAYS_MS.length - 1)];
    this.consecutiveUnreachable += 1;
    // Linear's own request for a longer wait wins over the schedule.
    const delay = Math.max(base, outcome.retryAfterMs ?? 0);
    this.cancelRetry = this.deps.schedule(() => {
      this.cancelRetry = null;
      void this.check();
    }, delay);
    return this.deps.now() + delay;
  }

  /** The Harness connectors at Linear's address, and the saved connection's state. The page asking starts a stale check. */
  list(): PlanQueueLinearListResult {
    const connectors: PlanQueueLinearConnectorChoice[] = [];
    for (const record of this.deps.listConnectors()) {
      const check = checkLinearConnectorRecord(record);
      if (check.ok) {
        connectors.push({ connectorId: record.id, name: record.name, problem: null, problemReason: null });
        continue;
      }
      // A connector that is at Linear's address but cannot be used yet is shown with its reason, not hidden.
      if (check.problem === 'read-only') {
        connectors.push({ connectorId: record.id, name: record.name, problem: 'read-only', problemReason: check.reason });
      } else if (check.problem === 'off' && checkLinearConnectorRecord({ ...record, autoConnect: true }).ok) {
        connectors.push({ connectorId: record.id, name: record.name, problem: 'off', problemReason: check.reason });
      }
    }
    const connection = this.snapshot();
    this.refreshIfStale(connection);
    return { connectors, connection };
  }

  /** Asks a connector who it signs in as. Saves nothing. */
  async identify(connectorId: string): Promise<PlanQueueLinearIdentity> {
    const who = await this.whoAmI(connectorId);
    return {
      connectorId,
      userId: who.user.id,
      userName: who.user.name,
      userEmail: who.user.email,
      workspaceName: who.workspace.name,
    };
  }

  /**
   * Saves the connection, but only if the connector still signs in as the user James was shown. It asks "who am I" a
   * second time and saves what that answer says, never what the page sent.
   */
  async confirm(connectorId: string, shownUserId: string): Promise<PlanQueueLinearConnectionSnapshot> {
    const version = this.begin();
    const who = await this.whoAmI(connectorId);
    if (who.user.id !== shownUserId)
      throw new Error('The Linear sign-in changed since it was shown to you. Check who it signs in as again.');
    if (version !== this.version)
      throw new Error('The Linear connection was changed while this was being confirmed. Try again.');
    const connection: PlanQueueLinearConnection = {
      connectorId,
      userId: who.user.id,
      userName: who.user.name.trim() || who.user.email || who.user.id,
      workspaceName: who.workspace.name.trim() || who.workspace.id,
      confirmedAt: this.deps.now(),
    };
    this.deps.saveConnection(connection);
    // The second read has just proved this connection, so it starts out ready instead of "checking".
    this.record(connectionKey(connection), { state: 'ready' });
    return this.snapshot();
  }

  /** Clears the saved connection. */
  forget(): PlanQueueLinearConnectionSnapshot {
    this.begin();
    this.deps.saveConnection(null);
    this.result = null;
    this.dispose();
    this.consecutiveUnreachable = 0;
    return this.snapshot();
  }

  /** Starts a change of connection: a check or Confirm that began earlier may no longer write. */
  private begin(): number {
    this.version += 1;
    this.inFlight = null;
    return this.version;
  }

  private whoAmI(connectorId: string): Promise<LinearWhoAmI> {
    return callLinearToolOnConnector(connectorId, 'whoami', {}, LinearWhoAmISchema, this.deps.call);
  }

  /** Stops the retry timer. */
  dispose(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
  }
}
