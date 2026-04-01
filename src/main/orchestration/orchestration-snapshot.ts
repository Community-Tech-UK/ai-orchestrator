/**
 * Orchestration Snapshot Manager - Snapshot-subscription model for UI state
 *
 * Maintains a live snapshot of orchestration state. UI subscribers pull
 * the latest snapshot on connect/reconnect instead of replaying events.
 *
 * Inspired by CodePilot's SessionStreamSnapshot pattern.
 */

import { EventEmitter } from 'events';
import type {
  OrchestrationSnapshot, ChildSnapshot, DebateSnapshot,
  VerificationSnapshot, PendingActionSnapshot, PendingPermissionSnapshot,
} from '../../shared/types/orchestration-snapshot.types';

export class OrchestrationSnapshotManager extends EventEmitter {
  private static instance: OrchestrationSnapshotManager | null = null;
  /** Internal state uses Map for O(1) lookup; converted to Record in getSnapshot() */
  private activeChildren = new Map<string, ChildSnapshot[]>();
  private activeDebates: DebateSnapshot[] = [];
  private activeVerifications: VerificationSnapshot[] = [];
  private pendingActions: PendingActionSnapshot[] = [];
  private pendingPermissions: PendingPermissionSnapshot[] = [];
  private lastUpdated = Date.now();

  private constructor() {
    super();
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
      activeChildren: Object.fromEntries(this.activeChildren),
      activeDebates: [...this.activeDebates],
      activeVerifications: [...this.activeVerifications],
      pendingActions: [...this.pendingActions],
      pendingPermissions: [...this.pendingPermissions],
      lastUpdated: this.lastUpdated,
    };
  }

  addChild(parentId: string, child: ChildSnapshot): void {
    const children = this.activeChildren.get(parentId) ?? [];
    children.push(child);
    this.activeChildren.set(parentId, children);
    this.touch();
  }

  removeChild(parentId: string, childId: string): void {
    const children = this.activeChildren.get(parentId);
    if (children) {
      this.activeChildren.set(parentId, children.filter(c => c.childId !== childId));
      this.touch();
    }
  }

  updateChild(parentId: string, childId: string, update: Partial<ChildSnapshot>): void {
    const children = this.activeChildren.get(parentId);
    if (children) {
      const idx = children.findIndex(c => c.childId === childId);
      if (idx >= 0) { children[idx] = { ...children[idx], ...update }; this.touch(); }
    }
  }

  addDebate(debate: DebateSnapshot): void { this.activeDebates.push(debate); this.touch(); }
  updateDebate(debateId: string, update: Partial<DebateSnapshot>): void {
    const idx = this.activeDebates.findIndex(d => d.debateId === debateId);
    if (idx >= 0) { this.activeDebates[idx] = { ...this.activeDebates[idx], ...update }; this.touch(); }
  }
  removeDebate(debateId: string): void {
    this.activeDebates = this.activeDebates.filter(d => d.debateId !== debateId); this.touch();
  }

  addVerification(v: VerificationSnapshot): void { this.activeVerifications.push(v); this.touch(); }
  updateVerification(id: string, update: Partial<VerificationSnapshot>): void {
    const idx = this.activeVerifications.findIndex(v => v.verificationId === id);
    if (idx >= 0) { this.activeVerifications[idx] = { ...this.activeVerifications[idx], ...update }; this.touch(); }
  }
  removeVerification(id: string): void {
    this.activeVerifications = this.activeVerifications.filter(v => v.verificationId !== id); this.touch();
  }

  addPendingAction(a: PendingActionSnapshot): void { this.pendingActions.push(a); this.touch(); }
  removePendingAction(id: string): void { this.pendingActions = this.pendingActions.filter(a => a.requestId !== id); this.touch(); }

  addPendingPermission(p: PendingPermissionSnapshot): void { this.pendingPermissions.push(p); this.touch(); }
  removePendingPermission(id: string): void { this.pendingPermissions = this.pendingPermissions.filter(p => p.requestId !== id); this.touch(); }

  clearForInstance(instanceId: string): void {
    this.activeChildren.delete(instanceId);
    // Collect keys first to avoid mutation during iteration
    const parentIds = [...this.activeChildren.keys()];
    for (const parentId of parentIds) {
      const children = this.activeChildren.get(parentId)!;
      this.activeChildren.set(parentId, children.filter(c => c.childId !== instanceId));
    }
    this.pendingActions = this.pendingActions.filter(a => a.instanceId !== instanceId);
    this.pendingPermissions = this.pendingPermissions.filter(p => p.instanceId !== instanceId);
    this.touch();
  }

  private touch(): void {
    this.lastUpdated = Date.now();
    this.emit('snapshot:updated', this.getSnapshot());
  }
}

export function getOrchestrationSnapshotManager(): OrchestrationSnapshotManager {
  return OrchestrationSnapshotManager.getInstance();
}
