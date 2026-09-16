/**
 * Cross-session messaging delivery pipeline.
 *
 * Sits above `InstanceManager`, reusing its `sendInput()` for actual delivery
 * so busy-queuing, interrupt recovery, and compaction retry are never
 * duplicated (see the plan's Architecture section). This service owns:
 * name resolution, the consent + project-scope gate, the rate-limit/hop-cap
 * loop guard, provenance wrapping, and the audit write — nothing else may
 * deliver a cross-session message.
 */

import { createHash, randomUUID } from 'node:crypto';
import { getLogger } from '../logging/logger';
import { getOperatorDatabase } from '../operator/operator-database';
import type { AppSettings } from '../../shared/types/settings.types';
import type { Instance } from '../../shared/types/instance.types';
import type {
  CrossSessionMessageResult,
  CrossSessionMessageSendPayload,
  MessageableSession,
  MessageableSessionReason,
} from '@contracts/schemas/instance';
import { buildCrossSessionMessageText } from './cross-session-messaging-provenance';
import { CrossSessionRateLimiter } from './cross-session-messaging-rate-limiter';
import type { InstanceSendInputOptions } from './instance-input-cancellation';

const logger = getLogger('CrossSessionMessagingService');

export interface CrossSessionMessagingDeps {
  getAllInstances: () => Instance[];
  getInstance: (id: string) => Instance | undefined;
  sendInput: (
    instanceId: string,
    message: string,
    attachments: undefined,
    options: InstanceSendInputOptions,
  ) => Promise<void>;
  getSettings: () => AppSettings;
}

type TargetResolution =
  | { kind: 'found'; instance: Instance }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; candidates: Instance[] };

/** Resolves `targetNameOrId`: exact id first, then unique case-insensitive displayName/aiTitle. */
export function resolveTargetInstance(
  instances: Instance[],
  targetNameOrId: string,
): TargetResolution {
  const byId = instances.find((instance) => instance.id === targetNameOrId);
  if (byId) return { kind: 'found', instance: byId };

  const needle = targetNameOrId.toLowerCase();
  const byName = instances.filter(
    (instance) =>
      instance.displayName.toLowerCase() === needle ||
      instance.aiTitle?.toLowerCase() === needle,
  );
  if (byName.length === 1) return { kind: 'found', instance: byName[0] };
  if (byName.length > 1) return { kind: 'ambiguous', candidates: byName };
  return { kind: 'not-found' };
}

export class CrossSessionMessagingService {
  private readonly rateLimiter: CrossSessionRateLimiter;
  /**
   * Last hop count a given instance received as a cross-session message
   * target. Used to detect an immediate relay: an instance forwarding a
   * message it just received bumps the new send's hop count past what it
   * received, so `maxHops` caps the relay chain rather than only the first
   * hop. In-memory and per-process only — see the rate limiter's doc comment.
   */
  private readonly lastReceivedHopCount = new Map<string, number>();

  constructor(private readonly deps: CrossSessionMessagingDeps) {
    const settings = deps.getSettings().interSessionMessaging;
    this.rateLimiter = new CrossSessionRateLimiter({
      ratePerMinute: settings.rateLimitPerMinute,
      maxHops: settings.maxHops,
    });
  }

  /** Rebuilds the rate limiter's configured limits from current settings (cheap; no bucket loss beyond the swap). */
  private currentSettings(): AppSettings['interSessionMessaging'] {
    return this.deps.getSettings().interSessionMessaging;
  }

  async sendMessage(payload: CrossSessionMessageSendPayload): Promise<CrossSessionMessageResult> {
    const source = this.deps.getInstance(payload.sourceInstanceId);
    if (!source) {
      throw new Error(`Source instance ${payload.sourceInstanceId} not found`);
    }

    const settings = this.currentSettings();
    const result = this.evaluate(source, payload.targetNameOrId, settings);
    this.writeAuditRow(source, payload, result);

    if (result.outcome !== 'delivered') {
      return result;
    }

    const hopCount = result.hopCount;
    const wrapped = buildCrossSessionMessageText({
      sourceDisplayName: source.displayName,
      message: payload.message,
    });
    try {
      await this.deps.sendInput(result.targetInstanceId, wrapped, undefined, {
        crossSessionSourceId: source.id,
        crossSessionSourceDisplayName: source.displayName,
        crossSessionHopCount: hopCount,
      });
    } catch (error) {
      logger.error('Cross-session message delivery failed after gates passed', error instanceof Error ? error : undefined, {
        sourceId: source.id,
        targetId: result.targetInstanceId,
      });
      throw error;
    }
    this.lastReceivedHopCount.set(result.targetInstanceId, hopCount);
    return result;
  }

  /** Pure gate evaluation — does not deliver, only decides outcome. Exposed for `listMessageableSessions`. */
  private evaluate(
    source: Instance,
    targetNameOrId: string,
    settings: AppSettings['interSessionMessaging'],
  ): CrossSessionMessageResult {
    if (!settings.enabled) {
      return { outcome: 'rejected', reason: 'feature-disabled' };
    }

    const resolution = resolveTargetInstance(this.deps.getAllInstances(), targetNameOrId);
    if (resolution.kind === 'not-found') {
      return { outcome: 'not-found', targetNameOrId };
    }
    if (resolution.kind === 'ambiguous') {
      return {
        outcome: 'ambiguous',
        targetNameOrId,
        candidates: resolution.candidates.map((c) => ({ id: c.id, displayName: c.displayName })),
      };
    }

    const target = resolution.instance;
    if (target.id === source.id) {
      return { outcome: 'rejected', reason: 'self-send', targetInstanceId: target.id, targetDisplayName: target.displayName };
    }
    if (target.status === 'terminated') {
      return { outcome: 'rejected', reason: 'target-terminated', targetInstanceId: target.id, targetDisplayName: target.displayName };
    }
    if (target.allowIncomingSessionMessages !== true) {
      return { outcome: 'rejected', reason: 'consent-disabled', targetInstanceId: target.id, targetDisplayName: target.displayName };
    }
    if (source.workingDirectory !== target.workingDirectory && !settings.allowCrossProject) {
      return { outcome: 'rejected', reason: 'cross-project-not-allowed', targetInstanceId: target.id, targetDisplayName: target.displayName };
    }

    const hopCount = (this.lastReceivedHopCount.get(source.id) ?? -1) + 1;
    if (this.rateLimiter.exceedsHopCap(hopCount)) {
      return { outcome: 'rejected', reason: 'hop-cap-exceeded', targetInstanceId: target.id, targetDisplayName: target.displayName };
    }
    if (!this.rateLimiter.tryConsume(source.id, target.id)) {
      return { outcome: 'rejected', reason: 'rate-limited', targetInstanceId: target.id, targetDisplayName: target.displayName };
    }

    return {
      outcome: 'delivered',
      targetInstanceId: target.id,
      targetDisplayName: target.displayName,
      hopCount,
    };
  }

  /**
   * For each live instance other than `sourceInstanceId`, reports whether it
   * is currently reachable and why not otherwise (spec requirement — an agent
   * gets an actionable reason, not a bare failure).
   */
  listMessageableSessions(sourceInstanceId: string): MessageableSession[] {
    const source = this.deps.getInstance(sourceInstanceId);
    const settings = this.currentSettings();
    const instances = this.deps.getAllInstances();

    return instances
      .filter((instance) => instance.status !== 'terminated')
      .map((instance): MessageableSession => {
        const reason = this.reasonFor(source, instance, settings);
        return {
          instanceId: instance.id,
          displayName: instance.displayName,
          reachable: reason === 'reachable',
          reason,
        };
      });
  }

  private reasonFor(
    source: Instance | undefined,
    target: Instance,
    settings: AppSettings['interSessionMessaging'],
  ): MessageableSessionReason {
    if (source && target.id === source.id) return 'self';
    if (!settings.enabled) return 'feature-disabled';
    if (target.allowIncomingSessionMessages !== true) return 'consent-disabled';
    if (source && source.workingDirectory !== target.workingDirectory && !settings.allowCrossProject) {
      return 'cross-project-not-allowed';
    }
    return 'reachable';
  }

  /** Writes exactly one audit row per attempt. Never throws — a write failure must not block or roll back delivery. */
  private writeAuditRow(
    source: Instance,
    payload: CrossSessionMessageSendPayload,
    result: CrossSessionMessageResult,
  ): void {
    try {
      const db = getOperatorDatabase().db;
      const contentHash = createHash('sha256').update(payload.message).digest('hex');
      const targetInstanceId = 'targetInstanceId' in result ? result.targetInstanceId : undefined;
      const targetDisplayName = 'targetDisplayName' in result ? result.targetDisplayName : undefined;
      const hopCount = result.outcome === 'delivered' ? result.hopCount : 0;
      const reason = result.outcome === 'rejected' ? result.reason : result.outcome;
      db.prepare(`
        INSERT INTO session_messages (
          id, source_instance_id, source_display_name, target_instance_id,
          target_display_name, content_length, content_hash, hop_count,
          outcome, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        source.id,
        source.displayName,
        targetInstanceId ?? null,
        targetDisplayName ?? null,
        payload.message.length,
        contentHash,
        hopCount,
        result.outcome,
        reason ?? null,
        Date.now(),
      );
    } catch (error) {
      logger.warn('Failed to write session_messages audit row', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

let instance: CrossSessionMessagingService | null = null;

export function getCrossSessionMessagingService(
  deps?: CrossSessionMessagingDeps,
): CrossSessionMessagingService {
  if (!instance) {
    if (!deps) {
      throw new Error('CrossSessionMessagingService not initialized — call with deps first');
    }
    instance = new CrossSessionMessagingService(deps);
  }
  return instance;
}

export function _resetCrossSessionMessagingServiceForTesting(): void {
  instance = null;
}
