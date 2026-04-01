/**
 * Permission Registry - Promise-based async permission resolution
 *
 * Child instances request permissions; the request returns a Promise.
 * Any code path (UI button, parent auto-approve, timeout) can resolve it.
 *
 * Inspired by CodePilot's permission-registry.ts.
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import type { PermissionRequest, PermissionDecision } from '../../shared/types/permission-registry.types';

const logger = getLogger('PermissionRegistry');

interface PendingEntry {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PermissionRegistry extends EventEmitter {
  private static instance: PermissionRegistry | null = null;
  private pending = new Map<string, PendingEntry>();

  private constructor() { super(); }

  static getInstance(): PermissionRegistry {
    if (!this.instance) this.instance = new PermissionRegistry();
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      for (const entry of this.instance.pending.values()) clearTimeout(entry.timer);
      this.instance.pending.clear();
      this.instance.removeAllListeners();
    }
    this.instance = null;
  }

  requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => this.resolve(request.id, false, 'timeout'), request.timeoutMs);
      this.pending.set(request.id, { request, resolve, timer });
      this.emit('permission:requested', request);
      logger.info('Permission requested', { id: request.id, instanceId: request.instanceId, action: request.action });
    });
  }

  resolve(requestId: string, granted: boolean, decidedBy: PermissionDecision['decidedBy']): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    const decision: PermissionDecision = { requestId, granted, decidedBy, decidedAt: Date.now() };
    entry.resolve(decision);
    this.emit('permission:resolved', decision);
    logger.info('Permission resolved', { requestId, granted, decidedBy });
  }

  getPendingCount(): number { return this.pending.size; }
  listPending(): PermissionRequest[] { return Array.from(this.pending.values()).map(e => e.request); }

  clearForInstance(instanceId: string): void {
    // Collect IDs first to avoid modifying the Map during iteration
    const toResolve = [...this.pending.entries()]
      .filter(([, e]) => e.request.instanceId === instanceId)
      .map(([id]) => id);
    for (const id of toResolve) {
      this.resolve(id, false, 'parent_deny');
    }
  }
}

export function getPermissionRegistry(): PermissionRegistry {
  return PermissionRegistry.getInstance();
}
