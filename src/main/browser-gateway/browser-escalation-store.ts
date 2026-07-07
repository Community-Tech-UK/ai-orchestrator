/**
 * Browser Escalation Queue — the human-in-the-loop safety valve for unattended
 * overnight browser automation.
 *
 * When an autonomous campaign hits a genuine hard stop it cannot resolve on
 * its own (a captcha, an unavailable 2FA code, an unfamiliar legal
 * declaration, a payment form, a failed re-login, a fill-plan verify diff, or
 * some other unrecognised challenge), it should NOT block the rest of the
 * night's work. Instead it calls `raise()`, which:
 *   - records a pending escalation the caller can hand off to a human, and
 *   - returns `{ parked: true }` — the signal that this site's task is
 *     parked so the caller can move on to other campaigns/targets.
 *
 * A human triages the queue later (`list`, `resolve`, `skip`).
 *
 * Fully injectable (storage, clock, id factory, notify hook) so it unit-tests
 * against an in-memory store with no timers and deterministic ids. No
 * `electron` import, no DB import — this module is worker-safe; wiring a real
 * persistence layer and a push-notification `notify` hook happens elsewhere.
 */

export type BrowserEscalationKind =
  | 'captcha'
  | 'two_factor_unavailable'
  | 'legal_declaration'
  | 'payment'
  | 'relogin_failed'
  | 'verify_diff'
  | 'unknown_challenge';

export type BrowserEscalationStatus = 'pending' | 'resolved' | 'skipped';

export interface BrowserEscalation {
  id: string;
  campaignId?: string;
  profileId: string;
  targetId?: string;
  kind: BrowserEscalationKind;
  reason: string;
  url?: string;
  screenshotArtifactId?: string;
  status: BrowserEscalationStatus;
  createdAt: number;
  resolvedAt?: number;
  resolutionNote?: string;
}

export interface RaiseEscalationInput {
  campaignId?: string;
  profileId: string;
  targetId?: string;
  kind: BrowserEscalationKind;
  reason: string;
  url?: string;
  screenshotArtifactId?: string;
}

/** The non-blocking signal returned to the caller: this task is parked, keep going. */
export interface RaiseEscalationResult {
  escalationId: string;
  parked: true;
}

export interface EscalationListFilter {
  campaignId?: string;
  profileId?: string;
  status?: BrowserEscalationStatus;
}

/** Persists escalation records (a SQLite table in production). */
export interface EscalationRecordStore {
  insert(escalation: BrowserEscalation): void;
  get(id: string): BrowserEscalation | undefined;
  list(filter?: EscalationListFilter): BrowserEscalation[];
  update(escalation: BrowserEscalation): void;
}

/** In-memory default implementation, exported for reuse in tests and lightweight callers. */
export class InMemoryEscalationRecordStore implements EscalationRecordStore {
  private readonly records = new Map<string, BrowserEscalation>();

  insert(escalation: BrowserEscalation): void {
    this.records.set(escalation.id, { ...escalation });
  }

  get(id: string): BrowserEscalation | undefined {
    const found = this.records.get(id);
    return found ? { ...found } : undefined;
  }

  list(filter: EscalationListFilter = {}): BrowserEscalation[] {
    return [...this.records.values()]
      .filter((record) => filter.campaignId === undefined || record.campaignId === filter.campaignId)
      .filter((record) => filter.profileId === undefined || record.profileId === filter.profileId)
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((record) => ({ ...record }));
  }

  update(escalation: BrowserEscalation): void {
    if (!this.records.has(escalation.id)) {
      return;
    }
    this.records.set(escalation.id, { ...escalation });
  }
}

export class BrowserEscalationError extends Error {
  constructor(
    message: string,
    readonly code: 'escalation_not_found' | 'already_resolved' | 'already_skipped',
  ) {
    super(message);
    this.name = 'BrowserEscalationError';
  }
}

export interface BrowserEscalationServiceOptions {
  /** Persistence layer. Default: a fresh in-memory store. */
  store?: EscalationRecordStore;
  now?: () => number;
  /** Escalation id generator. Default: a deterministic in-process counter. */
  idFactory?: () => string;
  /** Fired synchronously on every `raise()` (e.g. to send a push notification). */
  notify?: (escalation: BrowserEscalation) => void;
}

const DEFAULT_ID_PREFIX = 'esc';

export class BrowserEscalationService {
  private readonly store: EscalationRecordStore;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly notify?: (escalation: BrowserEscalation) => void;
  private counter = 0;

  constructor(options: BrowserEscalationServiceOptions = {}) {
    this.store = options.store ?? new InMemoryEscalationRecordStore();
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => `${DEFAULT_ID_PREFIX}-${++this.counter}`);
    this.notify = options.notify;
  }

  /**
   * Record a hard stop and park the site's task. Never throws for a
   * well-formed input — an escalation should always be recordable, even if
   * the notify hook is what later fails to page someone.
   */
  raise(input: RaiseEscalationInput): RaiseEscalationResult {
    const escalation: BrowserEscalation = {
      id: this.idFactory(),
      campaignId: input.campaignId,
      profileId: input.profileId,
      targetId: input.targetId,
      kind: input.kind,
      reason: input.reason,
      url: input.url,
      screenshotArtifactId: input.screenshotArtifactId,
      status: 'pending',
      createdAt: this.now(),
    };
    this.store.insert(escalation);
    this.notify?.(escalation);
    return { escalationId: escalation.id, parked: true };
  }

  list(filter: EscalationListFilter = {}): BrowserEscalation[] {
    return this.store.list(filter);
  }

  /** Mark an escalation as resolved by a human (the task can now be retried/continued). */
  resolve(id: string, note?: string): BrowserEscalation {
    return this.transition(id, 'resolved', note);
  }

  /** Mark an escalation as permanently skipped (the task will not be retried). */
  skip(id: string, note?: string): BrowserEscalation {
    return this.transition(id, 'skipped', note);
  }

  /** Count of still-open escalations, optionally scoped to one campaign. */
  pending(campaignId?: string): number {
    return this.store.list({ campaignId, status: 'pending' }).length;
  }

  private transition(
    id: string,
    status: Extract<BrowserEscalationStatus, 'resolved' | 'skipped'>,
    note?: string,
  ): BrowserEscalation {
    const existing = this.store.get(id);
    if (!existing) {
      throw new BrowserEscalationError(`No escalation found with id ${id}`, 'escalation_not_found');
    }
    if (existing.status === 'resolved') {
      throw new BrowserEscalationError(`Escalation ${id} is already resolved`, 'already_resolved');
    }
    if (existing.status === 'skipped') {
      throw new BrowserEscalationError(`Escalation ${id} is already skipped`, 'already_skipped');
    }
    const updated: BrowserEscalation = {
      ...existing,
      status,
      resolvedAt: this.now(),
      resolutionNote: note,
    };
    this.store.update(updated);
    return updated;
  }
}
