import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { PlanQueueAccountRules, PlanQueueCapabilityGap, PlanQueueCapabilityProbe, PlanQueueCapabilityState, PlanQueueRunConfig } from '@contracts/schemas/plan-queue';

export interface CapabilityRepair {
  id: string;
  identityKey: string;
  repository: string;
  sourceRunId: string;
  state: PlanQueueCapabilityState;
  planPath: string;
  repairRunId: string | null;
  repairItemId: string | null;
  generation: number;
  gap: PlanQueueCapabilityGap;
  config: PlanQueueRunConfig;
  accountRules: PlanQueueAccountRules;
  detail: string;
  probe?: PlanQueueCapabilityProbe;
  probeCheckedTree?: string;
  probeCheckedCommit?: string;
  probeReceipt?: string;
  autoPaused?: boolean;
  operatorPaused?: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface CapabilityOrigin {
  repairId: string;
  itemId: string;
  checkKey: string;
  check: string;
  state: 'waiting' | 'retrying' | 'passed' | 'withdrawn';
  gap: PlanQueueCapabilityGap;
  verification?: { checkpoint: string; evidence: string };
  reportedBy: { instanceId: string; role: 'triage' | 'worker' | 'verifier'; round: number; at: number };
}
interface AttachInput {
  repository: string;
  sourceRunId: string;
  itemId: string;
  gap: PlanQueueCapabilityGap;
  config: PlanQueueRunConfig;
  accountRules: PlanQueueAccountRules;
  planDirectory: string;
  reportedBy: CapabilityOrigin['reportedBy'];
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const read = (row: { record_json: string } | undefined): CapabilityRepair | undefined => row ? JSON.parse(row.record_json) as CapabilityRepair : undefined;
const authority = (config: PlanQueueRunConfig, rules: PlanQueueAccountRules): string => JSON.stringify([
  config.routing, config.startingSessionRoute, config.keepOnThisMac, rules,
  config.baseBranch, config.maxRounds, config.verifierGates, config.postMergeGate,
  config.capabilityRepairExcludedProviders,
]);

export class PlanQueueCapabilityStore {
  constructor(private readonly db: SqliteDriver, private readonly now: () => number = Date.now) {}

  get(id: string): CapabilityRepair | undefined {
    return read(this.db.prepare('SELECT record_json FROM plan_queue_capability_repairs WHERE id = ?').get<{ record_json: string }>(id));
  }

  forRepairItem(itemId: string): CapabilityRepair | undefined {
    return read(this.db.prepare('SELECT record_json FROM plan_queue_capability_repairs WHERE repair_item_id = ?').get<{ record_json: string }>(itemId));
  }

  list(): CapabilityRepair[] {
    return this.db.prepare("SELECT record_json FROM plan_queue_capability_repairs WHERE state NOT IN ('resolved', 'cancelled') ORDER BY created_at, id")
      .all<{ record_json: string }>().map(row => read(row)!);
  }

  forOrigin(itemId: string): CapabilityRepair[] {
    return this.db.prepare(`SELECT r.record_json FROM plan_queue_capability_repairs r
      WHERE EXISTS (SELECT 1 FROM plan_queue_capability_origins o WHERE o.repair_id = r.id AND o.item_id = ?)`)
      .all<{ record_json: string }>(itemId).map(row => read(row)!);
  }

  origins(repairId: string): CapabilityOrigin[] {
    return this.db.prepare(`SELECT repair_id AS repairId, item_id AS itemId, check_key AS checkKey,
      check_name AS "check", state, evidence_json FROM plan_queue_capability_origins WHERE repair_id = ? ORDER BY created_at, item_id, check_key`)
      .all<Omit<CapabilityOrigin, 'gap'> & { evidence_json: string }>(repairId)
      .map(({ evidence_json, ...row }) => ({ ...row, ...JSON.parse(evidence_json) as Pick<CapabilityOrigin, 'gap' | 'verification' | 'reportedBy'> }));
  }

  attach(input: AttachInput): CapabilityRepair {
    const identityKey = digest(JSON.stringify([input.repository, input.gap.capabilityKey, input.gap.platform, input.gap.provider, input.gap.repairRepository ?? input.repository]));
    return this.db.transaction(() => {
      // A cancelled request stays cancelled; a repeated tool report is not an explicit resume.
      let repair = read(this.db.prepare(`SELECT record_json FROM plan_queue_capability_repairs
        WHERE identity_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get<{ record_json: string }>(identityKey));
      if (repair && repair.state !== 'resolved' && authority(repair.config, repair.accountRules) !== authority(input.config, input.accountRules)) {
        throw new Error('This capability already has a repair with different account or computer restrictions. Its owner must arrange the handoff; this run was not attached.');
      }
      if (repair && repair.state !== 'resolved' && repair.gap.classification !== input.gap.classification) throw new Error('The existing repair has a different boundary classification. Its owner must resolve that evidence conflict.');
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM plan_queue_capability_origins WHERE item_id = ?').get<{ count: number }>(input.itemId)!.count;
      const existing = repair && repair.state !== 'resolved' && this.origins(repair.id).some(origin => origin.itemId === input.itemId && origin.checkKey === digest(input.gap.check.trim().toLowerCase()));
      if (count >= 32 && !existing) throw new Error('This item has reached its capability report limit (32).');
      if (!repair || repair.state === 'resolved') {
        const id = randomUUID();
        repair = { id, identityKey, repository: input.repository, sourceRunId: input.sourceRunId,
          state: 'investigating', planPath: path.join(input.repository, input.planDirectory, `capability-${id}_plan.md`),
          repairRunId: null, repairItemId: null, generation: (repair?.generation ?? 0) + 1,
          gap: structuredClone(input.gap), config: structuredClone(input.config), accountRules: structuredClone(input.accountRules),
          detail: 'Investigating the missing test control.', createdAt: this.now(), updatedAt: this.now() };
        this.save(repair);
      }
      this.db.prepare(`INSERT INTO plan_queue_capability_origins
        (repair_id, item_id, check_key, check_name, state, evidence_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?)
        ON CONFLICT(repair_id, item_id, check_key) DO UPDATE SET evidence_json = excluded.evidence_json, updated_at = excluded.updated_at`)
        .run(repair.id, input.itemId, digest(input.gap.check.trim().toLowerCase()), input.gap.check,
          JSON.stringify({ gap: input.gap, reportedBy: input.reportedBy }), this.now(), this.now());
      return repair;
    })();
  }

  save(repair: CapabilityRepair): void {
    const saved = { ...repair, updatedAt: this.now() };
    this.db.prepare(`INSERT INTO plan_queue_capability_repairs
      (id, identity_key, repository, source_run_id, state, plan_path, repair_run_id, repair_item_id, record_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, repair_run_id = excluded.repair_run_id,
      repair_item_id = excluded.repair_item_id, record_json = excluded.record_json, updated_at = excluded.updated_at`)
      .run(saved.id, saved.identityKey, saved.repository, saved.sourceRunId, saved.state, saved.planPath,
        saved.repairRunId, saved.repairItemId, JSON.stringify(saved), saved.createdAt, saved.updatedAt);
  }

  setOriginState(origin: CapabilityOrigin, state: CapabilityOrigin['state']): void {
    this.db.prepare(`UPDATE plan_queue_capability_origins SET state = ?, updated_at = ?
      WHERE repair_id = ? AND item_id = ? AND check_key = ?`).run(state, this.now(), origin.repairId, origin.itemId, origin.checkKey);
  }

  recordCheck(origin: CapabilityOrigin, verification: NonNullable<CapabilityOrigin['verification']>): void {
    this.db.prepare('UPDATE plan_queue_capability_origins SET evidence_json = ?, updated_at = ? WHERE repair_id = ? AND item_id = ? AND check_key = ?')
      .run(JSON.stringify({ gap: origin.gap, reportedBy: origin.reportedBy, verification }), this.now(), origin.repairId, origin.itemId, origin.checkKey);
  }

  atomic<T>(work: () => T): T { return this.db.transaction(work)(); }
}
