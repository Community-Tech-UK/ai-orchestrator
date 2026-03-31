/**
 * Orchestration Snapshot Manager - Snapshot-subscription model for UI state
 *
 * Maintains a live snapshot of orchestration state. UI subscribers pull
 * the latest snapshot on connect/reconnect instead of replaying events.
 *
 * Inspired by CodePilot's SessionStreamSnapshot pattern.
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import type {
  OrchestrationSnapshot, ChildSnapshot, DebateSnapshot,
  VerificationSnapshot, PendingActionSnapshot, PendingPermissionSnapshot,
} from '../../shared/types/orchestration-snapshot.types';

const logger = getLogger('OrchestrationSnapshot');

export class OrchestrationSnapshotManager extends EventEmitter {
  private static instance: OrchestrationSnapshotManager | null = null;
  private snapshot: OrchestrationSnapshot;

  private constructor() {
    super();
    this.snapshot = {
      activeChildren: new Map(), activeDebates: [], activeVerifications: [],
      pendingActions: [], pendingPermissions: [], lastUpdated: Date.now(),
    };
  }

  static getInstance(): OrchestrationSnapshotManager {
    if (!this.instance) this.instance = new OrchestrationSnapshotManager();
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) this.instance.removeAllListeners();
    this.instance = null;
  }

  getSnapshot(): OrchestrationSnapshot {
    return {
      activeChildren: new Map(this.snapshot.activeChildren),
      activeDebates: [...this.snapshot.activeDebates],
      activeVerifications: [...this.snapshot.activeVerifications],
      pendingActions: [...this.snapshot.pendingActions],
      pendingPermissions: [...this.snapshot.pendingPermissions],
      lastUpdated: this.snapshot.lastUpdated,
    };
  }

  addChild(parentId: string, child: ChildSnapshot): void {
    const children = this.snapshot.activeChildren.get(parentId) ?? [];
    children.push(child);
    this.snapshot.activeChildren.set(parentId, children);
    this.touch();
  }

  removeChild(parentId: string, childId: string): void {
    const children = this.snapshot.activeChildren.get(parentId);
    if (children) {
      this.snapshot.activeChildren.set(parentId, children.filter(c => c.childId !== childId));
      this.touch();
    }
  }

  updateChild(parentId: string, childId: string, update: Partial<ChildSnapshot>): void {
    const children = this.snapshot.activeChildren.get(parentId);
    if (children) {
      const idx = children.findIndex(c => c.childId === childId);
      if (idx >= 0) { children[idx] = { ...children[idx], ...update }; this.touch(); }
    }
  }

  addDebate(debate: DebateSnapshot): void { this.snapshot.activeDebates.push(debate); this.touch(); }
  updateDebate(debateId: string, update: Partial<DebateSnapshot>): void {
    const idx = this.snapshot.activeDebates.findIndex(d => d.debateId === debateId);
    if (idx >= 0) { this.snapshot.activeDebates[idx] = { ...this.snapshot.activeDebates[idx], ...update }; this.touch(); }
  }
  removeDebate(debateId: string): void {
    this.snapshot.activeDebates = this.snapshot.activeDebates.filter(d => d.debateId !== debateId); this.touch();
  }

  addVerification(v: VerificationSnapshot): void { this.snapshot.activeVerifications.push(v); this.touch(); }
  updateVerification(id: string, update: Partial<VerificationSnapshot>): void {
    const idx = this.snapshot.activeVerifications.findIndex(v => v.verificationId === id);
    if (idx >= 0) { this.snapshot.activeVerifications[idx] = { ...this.snapshot.activeVerifications[idx], ...update }; this.touch(); }
  }
  removeVerification(id: string): void {
    this.snapshot.activeVerifications = this.snapshot.activeVerifications.filter(v => v.verificationId !== id); this.touch();
  }

  addPendingAction(a: PendingActionSnapshot): void { this.snapshot.pendingActions.push(a); this.touch(); }
  removePendingAction(id: string): void { this.snapshot.pendingActions = this.snapshot.pendingActions.filter(a => a.requestId !== id); this.touch(); }

  addPendingPermission(p: PendingPermissionSnapshot): void { this.snapshot.pendingPermissions.push(p); this.touch(); }
  removePendingPermission(id: string): void { this.snapshot.pendingPermissions = this.snapshot.pendingPermissions.filter(p => p.requestId !== id); this.touch(); }

  clearForInstance(instanceId: string): void {
    this.snapshot.activeChildren.delete(instanceId);
    for (const [parentId, children] of this.snapshot.activeChildren) {
      this.snapshot.activeChildren.set(parentId, children.filter(c => c.childId !== instanceId));
    }
    this.snapshot.pendingActions = this.snapshot.pendingActions.filter(a => a.instanceId !== instanceId);
    this.snapshot.pendingPermissions = this.snapshot.pendingPermissions.filter(p => p.instanceId !== instanceId);
    this.touch();
  }

  private touch(): void {
    this.snapshot.lastUpdated = Date.now();
    this.emit('snapshot:updated', this.getSnapshot());
    logger.debug('Snapshot updated', { lastUpdated: this.snapshot.lastUpdated });
  }
}

export function getOrchestrationSnapshotManager(): OrchestrationSnapshotManager {
  return OrchestrationSnapshotManager.getInstance();
}
