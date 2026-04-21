/**
 * Agent Tree Persistence - Save and restore full agent hierarchy trees
 *
 * Inspired by Codex's rollout persistence where the entire agent tree
 * is persisted to a state DB and reconstructed via BFS on resume.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import { generateId } from '../../shared/utils/id-generator';
import type {
  AgentTreeNode,
  AgentTreeSnapshot,
  SpawnEdge,
} from '../../shared/types/agent-tree.types';
import { AGENT_TREE_SCHEMA_VERSION } from '../../shared/types/agent-tree.types';
import { getProjectStoragePaths } from '../storage/project-storage-paths';

const logger = getLogger('AgentTreePersistence');

interface InstanceData {
  id: string;
  displayName: string;
  parentId: string | null;
  childrenIds: string[];
  depth: number;
  status: string;
  provider: string;
  currentModel?: string;
  workingDirectory: string;
  agentId?: string;
  sessionId: string;
  totalTokensUsed: number;
  createdAt: number;
}

export class AgentTreePersistence {
  private static instance: AgentTreePersistence | null = null;
  private initialized = false;
  private readonly storagePaths = getProjectStoragePaths();

  private constructor() {
    // Singleton
  }

  static getInstance(): AgentTreePersistence {
    if (!this.instance) {
      this.instance = new AgentTreePersistence();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
  }

  private async findSnapshotFile(snapshotId: string): Promise<string | null> {
    const projectsRoot = this.storagePaths.getProjectsRoot();
    let projects: string[] = [];
    try {
      projects = await fs.readdir(projectsRoot);
    } catch {
      return null;
    }

    for (const project of projects) {
      const candidate = path.join(projectsRoot, project, 'agent-trees', `${snapshotId}.json`);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // Keep searching
      }
    }

    return null;
  }

  /**
   * Build a snapshot from current instance state via BFS from root.
   */
  buildSnapshot(
    rootId: string,
    instances: InstanceData[],
  ): AgentTreeSnapshot {
    const instanceMap = new Map(instances.map(i => [i.id, i]));
    const nodes: AgentTreeNode[] = [];
    const edges: SpawnEdge[] = [];
    let totalTokens = 0;

    const queue = [rootId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      const inst = instanceMap.get(id);
      if (!inst) continue;

      // Compute correct depth via parent chain
      let depth = 0;
      let current = inst;
      while (current.parentId && instanceMap.has(current.parentId)) {
        depth++;
        current = instanceMap.get(current.parentId)!;
      }

      nodes.push({
        instanceId: inst.id,
        displayName: inst.displayName,
        parentId: inst.parentId,
        childrenIds: [...inst.childrenIds],
        depth,
        status: inst.status,
        provider: inst.provider,
        model: inst.currentModel,
        workingDirectory: inst.workingDirectory,
        agentId: inst.agentId,
        sessionId: inst.sessionId,
        hasResult: false,
        createdAt: inst.createdAt,
      });

      totalTokens += inst.totalTokensUsed;

      for (const childId of inst.childrenIds) {
        edges.push({
          parentId: inst.id,
          childId,
          timestamp: instanceMap.get(childId)?.createdAt ?? Date.now(),
          task: '',
        });
        queue.push(childId);
      }
    }

    const root = instanceMap.get(rootId);
    return {
      id: generateId(),
      rootId,
      nodes,
      edges,
      schemaVersion: AGENT_TREE_SCHEMA_VERSION,
      timestamp: Date.now(),
      workingDirectory: root?.workingDirectory ?? '',
      totalInstances: nodes.length,
      totalTokensUsed: totalTokens,
    };
  }

  /**
   * Compute BFS restore order from a snapshot.
   */
  computeRestoreOrder(snapshot: AgentTreeSnapshot, maxDepth?: number): AgentTreeNode[] {
    const nodeMap = new Map(snapshot.nodes.map(n => [n.instanceId, n]));
    const order: AgentTreeNode[] = [];
    const queue = [snapshot.rootId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      const node = nodeMap.get(id);
      if (!node) continue;
      if (maxDepth !== undefined && node.depth > maxDepth) continue;

      order.push(node);
      for (const childId of node.childrenIds) {
        queue.push(childId);
      }
    }
    return order;
  }

  async saveSnapshot(snapshot: AgentTreeSnapshot): Promise<string> {
    await this.initialize();
    const storagePath = this.storagePaths.getAgentTreeRoot(snapshot.workingDirectory || process.cwd());
    await fs.mkdir(storagePath, { recursive: true });
    const filePath = path.join(storagePath, `${snapshot.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    logger.info('Saved agent tree snapshot', {
      id: snapshot.id, rootId: snapshot.rootId, totalInstances: snapshot.totalInstances,
    });
    return filePath;
  }

  async loadSnapshot(snapshotId: string): Promise<AgentTreeSnapshot | null> {
    await this.initialize();
    try {
      const filePath = await this.findSnapshotFile(snapshotId);
      if (!filePath) {
        return null;
      }
      const data = await fs.readFile(filePath, 'utf-8');
      const snapshot = JSON.parse(data) as AgentTreeSnapshot;
      if (snapshot.schemaVersion !== AGENT_TREE_SCHEMA_VERSION) {
        logger.warn('Snapshot schema version mismatch', {
          snapshotId,
          expected: AGENT_TREE_SCHEMA_VERSION,
          got: snapshot.schemaVersion,
        });
        return null;
      }
      return snapshot;
    } catch {
      logger.warn('Failed to load agent tree snapshot', { snapshotId });
      return null;
    }
  }

  async listSnapshots(): Promise<{ id: string; rootId: string; totalInstances: number; timestamp: number }[]> {
    await this.initialize();
    const snapshots: { id: string; rootId: string; totalInstances: number; timestamp: number }[] = [];
    const projectsRoot = this.storagePaths.getProjectsRoot();
    let projects: string[] = [];
    try {
      projects = await fs.readdir(projectsRoot);
    } catch {
      return [];
    }

    for (const project of projects) {
      const storagePath = path.join(projectsRoot, project, 'agent-trees');
      let files: string[] = [];
      try {
        files = await fs.readdir(storagePath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = await fs.readFile(path.join(storagePath, file), 'utf-8');
          const snap = JSON.parse(data) as AgentTreeSnapshot;
          snapshots.push({ id: snap.id, rootId: snap.rootId, totalInstances: snap.totalInstances, timestamp: snap.timestamp });
        } catch { /* skip corrupted */ }
      }
    }
    return snapshots.sort((a, b) => b.timestamp - a.timestamp);
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.initialize();
    const filePath = await this.findSnapshotFile(snapshotId);
    if (!filePath) {
      return;
    }
    try { await fs.unlink(filePath); } catch { /* already deleted */ }
  }
}

export function getAgentTreePersistence(): AgentTreePersistence {
  return AgentTreePersistence.getInstance();
}
