import { randomUUID } from 'node:crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';
import type {
  LocalAiEndpointIdentity,
  LocalAiTarget,
  LocalAiTargetConfig,
  LocalAiTargetLifecycleOptions,
  LocalAiTargetPatch,
} from '../../shared/types/local-ai-guard.types';
import {
  LocalAiEndpointIdentitySchema,
  LocalAiTargetConfigSchema,
  LocalAiTargetPatchSchema,
  LocalAiTargetSchema,
} from '../../shared/validation/local-ai-guard.schemas';
import { getLogger } from '../logging/logger';
import {
  mapLocalAiTargetRow,
  type LocalAiRepositoryLogger,
  type LocalAiTargetRow,
} from './local-ai-row-mappers';

export class LocalAiTargetRepository {
  private readonly listeners = new Set<(target: LocalAiTarget) => void>();

  constructor(
    private readonly db: SqliteDriver = getRLMDatabase().getRawDb(),
    private readonly logger: LocalAiRepositoryLogger = getLogger('LocalAiTargetRepository'),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  create(config: LocalAiTargetConfig): LocalAiTarget {
    const parsedConfig = LocalAiTargetConfigSchema.parse(config);
    const now = this.currentTimestamp();
    const target = LocalAiTargetSchema.parse({
      ...parsedConfig,
      id: randomUUID(),
      label: this.labelFor(parsedConfig),
      createdAt: now,
      updatedAt: now,
      ...(parsedConfig.lifecycle === 'retired' ? { retiredAt: now } : {}),
    });
    this.insert(target);
    this.notify(target);
    return target;
  }

  update(targetId: string, patch: LocalAiTargetPatch): LocalAiTarget {
    const current = this.require(targetId);
    const parsedPatch = LocalAiTargetPatchSchema.parse(patch);
    const config = LocalAiTargetConfigSchema.parse({ ...this.configForStorage(current), ...parsedPatch });
    const now = Math.max(this.currentTimestamp(), current.updatedAt);
    const target = LocalAiTargetSchema.parse({
      ...config,
      id: current.id,
      label: current.label,
      createdAt: current.createdAt,
      updatedAt: now,
      ...(config.lifecycle === 'paused' && current.pausedUntil !== undefined
        ? { pausedUntil: current.pausedUntil }
        : {}),
      ...(config.lifecycle === 'retired' ? { retiredAt: current.retiredAt ?? now } : {}),
    });
    this.write(target);
    this.notify(target);
    return target;
  }

  get(targetId: string): LocalAiTarget | undefined {
    const row = this.db.prepareCached('SELECT * FROM local_ai_targets WHERE id = ?').get<LocalAiTargetRow>(targetId);
    return row ? mapLocalAiTargetRow(row, this.logger) : undefined;
  }

  findByEndpoint(identity: LocalAiEndpointIdentity): LocalAiTarget | undefined {
    const parsed = LocalAiEndpointIdentitySchema.parse(identity);
    const workerNodeId = parsed.location.type === 'worker' ? parsed.location.nodeId : '';
    const row = this.db.prepareCached(`
      SELECT * FROM local_ai_targets
      WHERE location_type = ? AND worker_node_id = ? AND provider = ? AND endpoint_id = ? AND base_url = ?
        AND lifecycle != 'retired'
      LIMIT 1
    `).get<LocalAiTargetRow>(parsed.location.type, workerNodeId, parsed.provider, parsed.endpointId, parsed.baseUrl);
    return row ? mapLocalAiTargetRow(row, this.logger) : undefined;
  }

  list(options: { includeRetired?: boolean } = {}): LocalAiTarget[] {
    const rows = options.includeRetired
      ? this.db.prepareCached('SELECT * FROM local_ai_targets ORDER BY created_at ASC LIMIT 1000').all<LocalAiTargetRow>()
      : this.db.prepareCached(`
          SELECT * FROM local_ai_targets WHERE lifecycle != 'retired' ORDER BY created_at ASC LIMIT 1000
        `).all<LocalAiTargetRow>();
    return rows.flatMap((row) => {
      const target = mapLocalAiTargetRow(row, this.logger);
      return target ? [target] : [];
    });
  }

  subscribe(listener: (target: LocalAiTarget) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setLifecycle(
    targetId: string,
    lifecycle: 'enrolled' | 'paused' | 'retired',
    options: LocalAiTargetLifecycleOptions = {},
  ): LocalAiTarget {
    const current = this.require(targetId);
    const observedAt = this.currentTimestamp();
    const updatedAt = Math.max(observedAt, current.updatedAt);
    const pausedUntil = options.pausedUntil;
    if (lifecycle !== 'paused' && pausedUntil !== undefined) {
      throw new RangeError('A Local AI pause deadline requires the paused lifecycle');
    }
    if (
      pausedUntil !== undefined
      && (!Number.isSafeInteger(pausedUntil) || pausedUntil <= updatedAt)
    ) {
      throw new RangeError('Local AI pause deadline must be a future safe-integer timestamp');
    }
    const target = LocalAiTargetSchema.parse({
      ...current,
      lifecycle,
      updatedAt,
      ...(lifecycle === 'paused' && pausedUntil !== undefined ? { pausedUntil } : {}),
      ...(lifecycle === 'retired' ? { retiredAt: updatedAt } : {}),
    });
    if (lifecycle === 'enrolled') {
      delete target.pausedUntil;
      delete target.retiredAt;
    } else if (lifecycle === 'retired') {
      delete target.pausedUntil;
    } else {
      delete target.retiredAt;
      if (pausedUntil === undefined) delete target.pausedUntil;
    }
    this.write(target);
    this.notify(target);
    return target;
  }

  private require(targetId: string): LocalAiTarget {
    const target = this.get(targetId);
    if (!target) throw new Error(`Local AI target not found: ${targetId}`);
    return target;
  }

  private insert(target: LocalAiTarget): void {
    this.db.prepareCached(`
      INSERT INTO local_ai_targets (
        id, label, lifecycle, location_type, worker_node_id, provider, endpoint_id, base_url,
        config_json, paused_until, retired_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...this.values(target));
  }

  private write(target: LocalAiTarget): void {
    this.db.prepareCached(`
      UPDATE local_ai_targets SET
        label = ?, lifecycle = ?, location_type = ?, worker_node_id = ?, provider = ?, endpoint_id = ?, base_url = ?,
        config_json = ?, paused_until = ?, retired_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      target.label,
      target.lifecycle,
      target.location.type,
      target.location.type === 'worker' ? target.location.nodeId : '',
      target.provider,
      target.endpointId,
      target.baseUrl,
      JSON.stringify(this.configForStorage(target)),
      target.pausedUntil ?? null,
      target.retiredAt ?? null,
      target.updatedAt,
      target.id,
    );
  }

  private values(target: LocalAiTarget): unknown[] {
    return [
      target.id,
      target.label,
      target.lifecycle,
      target.location.type,
      target.location.type === 'worker' ? target.location.nodeId : '',
      target.provider,
      target.endpointId,
      target.baseUrl,
      JSON.stringify(this.configForStorage(target)),
      target.pausedUntil ?? null,
      target.retiredAt ?? null,
      target.createdAt,
      target.updatedAt,
    ];
  }

  private configForStorage(target: LocalAiTarget): LocalAiTargetConfig {
    const { id: _id, label: _label, createdAt: _createdAt, updatedAt: _updatedAt, pausedUntil: _pausedUntil, retiredAt: _retiredAt, ...config } = target;
    void _id;
    void _label;
    void _createdAt;
    void _updatedAt;
    void _pausedUntil;
    void _retiredAt;
    return config;
  }

  private labelFor(config: LocalAiTargetConfig): string {
    const label = config.location.type === 'worker'
      ? `${config.location.nodeId}: ${config.endpointId}`
      : config.endpointId;
    return label.slice(0, 256);
  }

  private notify(target: LocalAiTarget): void {
    for (const listener of this.listeners) {
      try {
        listener(target);
      } catch {
        // Repository writes are authoritative; observers are fail-soft.
      }
    }
  }

  private currentTimestamp(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('Local AI repository clock must return a non-negative safe integer');
    }
    return now;
  }
}
