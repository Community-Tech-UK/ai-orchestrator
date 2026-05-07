import type { OperatorRunGraph } from '../../shared/types/operator.types';
import { getOperatorDatabase } from './operator-database';
import { OperatorRunStore } from './operator-run-store';

export class OperatorRunRunner {
  private static instance: OperatorRunRunner | null = null;

  static getInstance(): OperatorRunRunner {
    this.instance ??= new OperatorRunRunner();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  cancel(runId: string): OperatorRunGraph {
    const store = new OperatorRunStore(getOperatorDatabase().db);
    const graph = store.getRunGraph(runId);
    if (!graph) {
      throw new Error(`Operator run not found: ${runId}`);
    }

    const now = Date.now();
    for (const node of graph.nodes) {
      if (node.status === 'queued' || node.status === 'running' || node.status === 'waiting') {
        store.updateNode(node.id, {
          status: 'cancelled',
          completedAt: now,
          error: 'Cancelled by user',
        });
      }
    }
    store.updateRun(runId, {
      status: 'cancelled',
      completedAt: now,
      error: 'Cancelled by user',
    });
    store.appendEvent({
      runId,
      kind: 'state-change',
      payload: {
        status: 'cancelled',
        source: 'operator-run-runner',
      },
    });
    return store.getRunGraph(runId)!;
  }
}

export function getOperatorRunRunner(): OperatorRunRunner {
  return OperatorRunRunner.getInstance();
}
