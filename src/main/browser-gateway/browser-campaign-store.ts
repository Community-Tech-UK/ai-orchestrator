import { randomUUID } from 'node:crypto';

/**
 * Browser Campaign Store — the human-approved-once envelope for unattended
 * overnight browser automation.
 *
 * A "campaign" is approved a single time by a human (`approvedBy: 'user'`)
 * and then bounds every runtime grant issued under it for the rest of its
 * life: which origins/action classes are in scope, a hard budget on how many
 * actions/submits/new-accounts/uploads it may perform, and a wall-clock
 * expiry capped at 14 hours from creation (an "overnight" window, not an
 * open-ended standing permission). This module owns the campaign lifecycle,
 * counters, and kill switch only — it does NOT issue the short-lived runtime
 * grants themselves (see the grant store/policy for that).
 *
 * Fully injectable (storage, clock, id factory) so it unit-tests deterministically
 * with an in-memory store and no real database.
 */

export interface BrowserCampaignBudget {
  maxActions: number;
  maxSubmits: number;
  maxNewAccounts: number;
  maxUploads: number;
  maxDurationMs: number;
}

export type BrowserCampaignStatus = 'active' | 'paused' | 'killed' | 'completed' | 'expired';

export interface BrowserCampaign {
  id: string;
  label: string;
  profileId: string;
  allowedOrigins: string[];
  allowedActionClasses: string[];
  budget: BrowserCampaignBudget;
  approvedDeclarationHashes: string[];
  status: BrowserCampaignStatus;
  createdAt: number;
  expiresAt: number;
  approvedBy: 'user';
}

export interface BrowserCampaignCounters {
  actions: number;
  submits: number;
  newAccounts: number;
  uploads: number;
}

export type BrowserCampaignActionKind = 'action' | 'submit' | 'newAccount' | 'upload';

export interface CreateBrowserCampaignInput {
  label: string;
  profileId: string;
  allowedOrigins: string[];
  allowedActionClasses: string[];
  budget: BrowserCampaignBudget;
}

export interface BrowserCampaignListFilter {
  status?: BrowserCampaignStatus;
}

export interface RecordActionResult {
  paused: boolean;
  reason?: string;
}

export interface CanProceedResult {
  ok: boolean;
  reason?: string;
}

/** Persists campaigns + their counters. In-memory implementation is the default. */
export interface BrowserCampaignStore {
  put(campaign: BrowserCampaign): void;
  get(id: string): BrowserCampaign | undefined;
  list(): BrowserCampaign[];
  getCounters(id: string): BrowserCampaignCounters | undefined;
  putCounters(id: string, counters: BrowserCampaignCounters): void;
}

export class InMemoryBrowserCampaignStore implements BrowserCampaignStore {
  private readonly campaigns = new Map<string, BrowserCampaign>();
  private readonly counters = new Map<string, BrowserCampaignCounters>();

  put(campaign: BrowserCampaign): void {
    this.campaigns.set(campaign.id, { ...campaign });
  }

  get(id: string): BrowserCampaign | undefined {
    const campaign = this.campaigns.get(id);
    return campaign ? { ...campaign } : undefined;
  }

  list(): BrowserCampaign[] {
    return [...this.campaigns.values()].map((campaign) => ({ ...campaign }));
  }

  getCounters(id: string): BrowserCampaignCounters | undefined {
    const counters = this.counters.get(id);
    return counters ? { ...counters } : undefined;
  }

  putCounters(id: string, counters: BrowserCampaignCounters): void {
    this.counters.set(id, { ...counters });
  }
}

const BLOCKED_ACTION_CLASSES = ['credential', 'payment', 'destructive'];

/** Hard ceiling on how long an unattended campaign may run before it must be re-approved. */
const MAX_CAMPAIGN_DURATION_MS = 14 * 60 * 60 * 1000;

export class BrowserCampaignError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'blocked_action_class'
      | 'expiry_too_long'
      | 'not_found'
      | 'illegal_transition',
  ) {
    super(message);
    this.name = 'BrowserCampaignError';
  }
}

export interface BrowserCampaignServiceOptions {
  store?: BrowserCampaignStore;
  now?: () => number;
  idFactory?: () => string;
  onStateChange?: (campaign: BrowserCampaign) => void;
}

const ZERO_COUNTERS: BrowserCampaignCounters = {
  actions: 0,
  submits: 0,
  newAccounts: 0,
  uploads: 0,
};

const BUDGET_KEY_BY_KIND: Record<BrowserCampaignActionKind, keyof BrowserCampaignBudget> = {
  action: 'maxActions',
  submit: 'maxSubmits',
  newAccount: 'maxNewAccounts',
  upload: 'maxUploads',
};

const COUNTER_KEY_BY_KIND: Record<BrowserCampaignActionKind, keyof BrowserCampaignCounters> = {
  action: 'actions',
  submit: 'submits',
  newAccount: 'newAccounts',
  upload: 'uploads',
};

export class BrowserCampaignService {
  private readonly store: BrowserCampaignStore;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly onStateChange?: (campaign: BrowserCampaign) => void;

  constructor(options: BrowserCampaignServiceOptions = {}) {
    this.store = options.store ?? new InMemoryBrowserCampaignStore();
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.onStateChange = options.onStateChange;
  }

  create(input: CreateBrowserCampaignInput): BrowserCampaign {
    const blocked = input.allowedActionClasses.find((actionClass) =>
      BLOCKED_ACTION_CLASSES.includes(actionClass),
    );
    if (blocked) {
      throw new BrowserCampaignError(
        `Action class '${blocked}' cannot be pre-approved for an unattended campaign`,
        'blocked_action_class',
      );
    }

    const createdAt = this.now();
    const expiresAt = createdAt + input.budget.maxDurationMs;
    if (expiresAt > createdAt + MAX_CAMPAIGN_DURATION_MS) {
      throw new BrowserCampaignError(
        `Campaign expiry cannot exceed ${MAX_CAMPAIGN_DURATION_MS}ms (14h) from creation`,
        'expiry_too_long',
      );
    }

    const campaign: BrowserCampaign = {
      id: this.idFactory(),
      label: input.label,
      profileId: input.profileId,
      allowedOrigins: [...input.allowedOrigins],
      allowedActionClasses: [...input.allowedActionClasses],
      budget: { ...input.budget },
      approvedDeclarationHashes: [],
      status: 'active',
      createdAt,
      expiresAt,
      approvedBy: 'user',
    };

    this.store.put(campaign);
    this.store.putCounters(campaign.id, { ...ZERO_COUNTERS });
    this.emitStateChange(campaign);
    return campaign;
  }

  get(id: string): BrowserCampaign | undefined {
    return this.store.get(id);
  }

  list(filter: BrowserCampaignListFilter = {}): BrowserCampaign[] {
    const all = this.store.list();
    return filter.status ? all.filter((campaign) => campaign.status === filter.status) : all;
  }

  getCounters(id: string): BrowserCampaignCounters | undefined {
    return this.store.getCounters(id);
  }

  recordAction(id: string, kind: BrowserCampaignActionKind): RecordActionResult {
    const campaign = this.requireCampaign(id);
    const counters = this.store.getCounters(id) ?? { ...ZERO_COUNTERS };

    const kindsToIncrement: BrowserCampaignActionKind[] =
      kind === 'submit' ? ['submit', 'action'] : [kind];

    let paused = false;
    let reason: string | undefined;
    for (const incrementKind of kindsToIncrement) {
      const counterKey = COUNTER_KEY_BY_KIND[incrementKind];
      const budgetKey = BUDGET_KEY_BY_KIND[incrementKind];
      counters[counterKey] += 1;
      if (counters[counterKey] >= campaign.budget[budgetKey]) {
        paused = true;
        reason ??= `Budget exhausted for '${incrementKind}' (${counters[counterKey]}/${campaign.budget[budgetKey]})`;
      }
    }

    this.store.putCounters(id, counters);

    if (paused && campaign.status === 'active') {
      const updated: BrowserCampaign = { ...campaign, status: 'paused' };
      this.store.put(updated);
      this.emitStateChange(updated);
    }

    return paused ? { paused: true, reason } : { paused: false };
  }

  canProceed(id: string, now: number = this.now()): CanProceedResult {
    const campaign = this.requireCampaign(id);

    if (campaign.status === 'active' && campaign.expiresAt <= now) {
      const updated: BrowserCampaign = { ...campaign, status: 'expired' };
      this.store.put(updated);
      this.emitStateChange(updated);
      return { ok: false, reason: 'Campaign has expired' };
    }

    if (campaign.status !== 'active') {
      return { ok: false, reason: `Campaign status is '${campaign.status}', not 'active'` };
    }

    const counters = this.store.getCounters(id) ?? { ...ZERO_COUNTERS };
    const exhausted = (Object.keys(BUDGET_KEY_BY_KIND) as BrowserCampaignActionKind[]).find(
      (kind) => counters[COUNTER_KEY_BY_KIND[kind]] >= campaign.budget[BUDGET_KEY_BY_KIND[kind]],
    );
    if (exhausted) {
      return { ok: false, reason: `Budget exhausted for '${exhausted}'` };
    }

    return { ok: true };
  }

  pause(id: string): BrowserCampaign {
    const campaign = this.requireCampaign(id);
    if (campaign.status !== 'active') {
      throw new BrowserCampaignError(
        `Cannot pause a campaign in status '${campaign.status}'`,
        'illegal_transition',
      );
    }
    return this.transition(campaign, 'paused');
  }

  resume(id: string): BrowserCampaign {
    const campaign = this.requireCampaign(id);
    if (campaign.status !== 'paused') {
      throw new BrowserCampaignError(
        `Cannot resume a campaign in status '${campaign.status}'`,
        'illegal_transition',
      );
    }
    if (campaign.expiresAt <= this.now()) {
      throw new BrowserCampaignError('Cannot resume an expired campaign', 'illegal_transition');
    }
    const counters = this.store.getCounters(id) ?? { ...ZERO_COUNTERS };
    const exhausted = (Object.keys(BUDGET_KEY_BY_KIND) as BrowserCampaignActionKind[]).some(
      (kind) => counters[COUNTER_KEY_BY_KIND[kind]] >= campaign.budget[BUDGET_KEY_BY_KIND[kind]],
    );
    if (exhausted) {
      throw new BrowserCampaignError(
        'Cannot resume a campaign with an exhausted budget',
        'illegal_transition',
      );
    }
    return this.transition(campaign, 'active');
  }

  kill(id: string): BrowserCampaign {
    const campaign = this.requireCampaign(id);
    if (isTerminal(campaign.status)) {
      throw new BrowserCampaignError(
        `Cannot kill a campaign already in terminal status '${campaign.status}'`,
        'illegal_transition',
      );
    }
    return this.transition(campaign, 'killed');
  }

  complete(id: string): BrowserCampaign {
    const campaign = this.requireCampaign(id);
    if (isTerminal(campaign.status)) {
      throw new BrowserCampaignError(
        `Cannot complete a campaign already in terminal status '${campaign.status}'`,
        'illegal_transition',
      );
    }
    return this.transition(campaign, 'completed');
  }

  approveDeclarationHash(id: string, hash: string): void {
    const campaign = this.requireCampaign(id);
    if (campaign.approvedDeclarationHashes.includes(hash)) {
      return;
    }
    const updated: BrowserCampaign = {
      ...campaign,
      approvedDeclarationHashes: [...campaign.approvedDeclarationHashes, hash],
    };
    this.store.put(updated);
    this.emitStateChange(updated);
  }

  isDeclarationApproved(id: string, hash: string): boolean {
    return this.requireCampaign(id).approvedDeclarationHashes.includes(hash);
  }

  private transition(campaign: BrowserCampaign, status: BrowserCampaignStatus): BrowserCampaign {
    const updated: BrowserCampaign = { ...campaign, status };
    this.store.put(updated);
    this.emitStateChange(updated);
    return updated;
  }

  private requireCampaign(id: string): BrowserCampaign {
    const campaign = this.store.get(id);
    if (!campaign) {
      throw new BrowserCampaignError(`No campaign found with id '${id}'`, 'not_found');
    }
    return campaign;
  }

  private emitStateChange(campaign: BrowserCampaign): void {
    this.onStateChange?.(campaign);
  }
}

function isTerminal(status: BrowserCampaignStatus): boolean {
  return status === 'killed' || status === 'completed' || status === 'expired';
}
