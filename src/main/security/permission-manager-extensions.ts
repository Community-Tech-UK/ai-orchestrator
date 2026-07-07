import type {
  PermissionAction,
  PermissionDecision,
  PermissionManager,
  PermissionRequest,
  PermissionScope,
} from './permission-manager';

export interface BatchPermissionRequest {
  batchId: string;
  requests: PermissionRequest[];
  timestamp: number;
}

export interface BatchPermissionDecision {
  batchId: string;
  decisions: PermissionDecision[];
  aggregateAction: 'allow_all' | 'deny_all' | 'mixed' | 'ask';
  decidedAt: number;
}

export interface LearnedPermissionPattern {
  id: string;
  scope: PermissionScope;
  pattern: string;
  recommendedAction: PermissionAction;
  confidence: number;
  sampleCount: number;
  lastUpdated: number;
  approved: boolean;
}

export interface PermissionLearningStats {
  totalPatterns: number;
  approvedPatterns: number;
  pendingPatterns: number;
  suggestionsMade: number;
  suggestionsAccepted: number;
  accuracyRate: number;
}

declare module './permission-manager' {
  interface PermissionManager {
    checkBatchPermissions(batch: BatchPermissionRequest): BatchPermissionDecision;
    recordBatchDecision(
      sessionId: string,
      batch: BatchPermissionRequest,
      action: 'allow_all' | 'deny_all',
      scope: 'once' | 'session' | 'always'
    ): void;
    getPendingBatch(sessionId: string): BatchPermissionRequest | null;
    getPendingBatches(): BatchPermissionRequest[];
    queuePermission(request: PermissionRequest): void;
    processBatchQueue(sessionId: string): BatchPermissionRequest | null;
    recordBatchDecisionForPending(
      action: 'allow_all' | 'deny_all',
      scope: 'once' | 'session' | 'always'
    ): number;
    recordDecisionByRequestId(
      requestId: string,
      action: 'allow' | 'deny',
      scope: 'once' | 'session' | 'always'
    ): boolean;
    getLearnedPatterns(): LearnedPermissionPattern[];
    approveLearnedPattern(patternId: string): boolean;
    rejectLearnedPattern(patternId: string): boolean;
    getLearningStats(): PermissionLearningStats;
    recordDecisionForLearning(decision: PermissionDecision): void;
  }
}

const permissionQueues = new Map<string, PermissionRequest[]>();
const BATCH_WINDOW_MS = 100;
const batchTimers = new Map<string, NodeJS.Timeout>();
const learnedPatterns = new Map<string, LearnedPermissionPattern>();
const decisionHistory: Array<{ decision: PermissionDecision; timestamp: number }> = [];
const MAX_HISTORY_SIZE = 1000;
let suggestionsStats = { made: 0, accepted: 0 };

export function installPermissionManagerExtensions(
  PermissionManagerCtor: typeof import('./permission-manager').PermissionManager,
): void {
  PermissionManagerCtor.prototype.checkBatchPermissions = function(
    this: PermissionManager,
    batch: BatchPermissionRequest,
  ): BatchPermissionDecision {
    const decisions: PermissionDecision[] = [];
    let allowCount = 0;
    let denyCount = 0;
    let askCount = 0;

    for (const request of batch.requests) {
      const decision = this.checkPermission(request);
      decisions.push(decision);
      switch (decision.action) {
        case 'allow': allowCount++; break;
        case 'deny': denyCount++; break;
        case 'ask': askCount++; break;
      }
    }

    const aggregateAction: BatchPermissionDecision['aggregateAction'] =
      askCount > 0
        ? 'ask'
        : allowCount === batch.requests.length
          ? 'allow_all'
          : denyCount === batch.requests.length
            ? 'deny_all'
            : 'mixed';

    const result: BatchPermissionDecision = {
      batchId: batch.batchId,
      decisions,
      aggregateAction,
      decidedAt: Date.now(),
    };
    this.emit('batch_permission:decided', result);
    return result;
  };

  PermissionManagerCtor.prototype.queuePermission = function(
    this: PermissionManager,
    request: PermissionRequest,
  ): void {
    const sessionId = request.instanceId;
    const queue = permissionQueues.get(sessionId) ?? [];
    permissionQueues.set(sessionId, queue);
    queue.push(request);

    const existingTimer = batchTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.emit('batch_ready', { sessionId });
      batchTimers.delete(sessionId);
    }, BATCH_WINDOW_MS);

    batchTimers.set(sessionId, timer);
  };

  PermissionManagerCtor.prototype.processBatchQueue = function(
    this: PermissionManager,
    sessionId: string,
  ): BatchPermissionRequest | null {
    const queue = permissionQueues.get(sessionId);
    if (!queue || queue.length === 0) {
      return null;
    }
    const batch: BatchPermissionRequest = {
      batchId: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      requests: [...queue],
      timestamp: Date.now(),
    };
    permissionQueues.delete(sessionId);
    return batch;
  };

  PermissionManagerCtor.prototype.getPendingBatch = function(
    this: PermissionManager,
    sessionId: string,
  ): BatchPermissionRequest | null {
    const queue = permissionQueues.get(sessionId);
    if (!queue || queue.length === 0) {
      return null;
    }
    return {
      batchId: `pending-${sessionId}`,
      requests: [...queue],
      timestamp: Date.now(),
    };
  };

  PermissionManagerCtor.prototype.getPendingBatches = function(): BatchPermissionRequest[] {
    return Array.from(permissionQueues.entries()).map(([sessionId, queue]) => ({
      batchId: `pending-${sessionId}`,
      requests: [...queue],
      timestamp: Date.now(),
    }));
  };

  PermissionManagerCtor.prototype.recordBatchDecision = function(
    this: PermissionManager,
    sessionId: string,
    batch: BatchPermissionRequest,
    action: 'allow_all' | 'deny_all',
    scope: 'once' | 'session' | 'always',
  ): void {
    const permissionAction: PermissionAction = action === 'allow_all' ? 'allow' : 'deny';
    for (const request of batch.requests) {
      this.recordUserDecision(sessionId, request, permissionAction, scope);
    }
    permissionQueues.delete(sessionId);
    const timer = batchTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      batchTimers.delete(sessionId);
    }
    this.emit('batch_decision:recorded', {
      sessionId,
      batchId: batch.batchId,
      action,
      scope,
      count: batch.requests.length,
    });
  };

  PermissionManagerCtor.prototype.recordBatchDecisionForPending = function(
    this: PermissionManager,
    action: 'allow_all' | 'deny_all',
    scope: 'once' | 'session' | 'always',
  ): number {
    let count = 0;
    for (const [sessionId, queue] of permissionQueues.entries()) {
      if (queue.length === 0) {
        continue;
      }
      const batch: BatchPermissionRequest = {
        batchId: `pending-${sessionId}`,
        requests: [...queue],
        timestamp: Date.now(),
      };
      this.recordBatchDecision(sessionId, batch, action, scope);
      count += batch.requests.length;
    }
    return count;
  };

  PermissionManagerCtor.prototype.recordDecisionByRequestId = function(
    this: PermissionManager,
    requestId: string,
    action: 'allow' | 'deny',
    scope: 'once' | 'session' | 'always',
  ): boolean {
    for (const [sessionId, queue] of permissionQueues.entries()) {
      const index = queue.findIndex((request) => request.id === requestId);
      if (index === -1) {
        continue;
      }
      const [request] = queue.splice(index, 1);
      if (!request) {
        return false;
      }
      this.recordUserDecision(sessionId, request, action, scope);
      if (queue.length === 0) {
        permissionQueues.delete(sessionId);
        const timer = batchTimers.get(sessionId);
        if (timer) {
          clearTimeout(timer);
          batchTimers.delete(sessionId);
        }
      }
      return true;
    }
    return false;
  };

  PermissionManagerCtor.prototype.recordDecisionForLearning = function(
    this: PermissionManager,
    decision: PermissionDecision,
  ): void {
    decisionHistory.push({ decision, timestamp: Date.now() });
    if (decisionHistory.length > MAX_HISTORY_SIZE) {
      decisionHistory.splice(0, decisionHistory.length - MAX_HISTORY_SIZE);
    }
    if (decisionHistory.length % 10 === 0) {
      (this as PermissionManager & { analyzePatterns: () => void }).analyzePatterns();
    }
  };

  (PermissionManagerCtor.prototype as PermissionManager & { analyzePatterns: () => void }).analyzePatterns = function(
    this: PermissionManager,
  ): void {
    const patternGroups = new Map<string, {
      allow: number;
      deny: number;
      resources: string[];
      scope: PermissionScope;
    }>();

    for (const { decision } of decisionHistory) {
      if (decision.action === 'ask') continue;
      const key = `${decision.request.scope}:${extractPatternBase(decision.request.resource)}`;
      const group = patternGroups.get(key) ?? {
        allow: 0,
        deny: 0,
        resources: [],
        scope: decision.request.scope,
      };
      patternGroups.set(key, group);
      if (decision.action === 'allow') group.allow++;
      else if (decision.action === 'deny') group.deny++;
      if (!group.resources.includes(decision.request.resource)) {
        group.resources.push(decision.request.resource);
      }
    }

    for (const [key, group] of patternGroups) {
      const total = group.allow + group.deny;
      if (total < 3) continue;
      const existingPattern = learnedPatterns.get(key);
      const recommendedAction: PermissionAction = group.allow > group.deny ? 'allow' : 'deny';
      const confidence = Math.max(group.allow, group.deny) / total;
      if (confidence < 0.7) continue;

      const pattern: LearnedPermissionPattern = {
        id: existingPattern?.id || `learned-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        scope: group.scope,
        pattern: derivePattern(group.resources),
        recommendedAction,
        confidence,
        sampleCount: total,
        lastUpdated: Date.now(),
        approved: existingPattern?.approved || false,
      };

      learnedPatterns.set(key, pattern);
      if (!existingPattern) {
        suggestionsStats.made++;
        this.emit('pattern:learned', pattern);
      }
    }
  };

  PermissionManagerCtor.prototype.getLearnedPatterns = function(): LearnedPermissionPattern[] {
    return Array.from(learnedPatterns.values());
  };

  PermissionManagerCtor.prototype.approveLearnedPattern = function(
    this: PermissionManager,
    patternId: string,
  ): boolean {
    for (const [key, pattern] of learnedPatterns) {
      if (pattern.id === patternId) {
        pattern.approved = true;
        pattern.lastUpdated = Date.now();
        const userRuleSetId = ensureUserRuleSet(this);
        this.addRule(userRuleSetId, {
          name: `Learned: ${pattern.scope} ${pattern.pattern}`,
          description: `Auto-learned from ${pattern.sampleCount} decisions (${Math.round(pattern.confidence * 100)}% confidence)`,
          scope: pattern.scope,
          pattern: pattern.pattern,
          action: pattern.recommendedAction,
          priority: 30,
          source: 'user',
          enabled: true,
        });
        suggestionsStats.accepted++;
        this.emit('pattern:approved', pattern);
        return true;
      }
    }
    return false;
  };

  PermissionManagerCtor.prototype.rejectLearnedPattern = function(
    this: PermissionManager,
    patternId: string,
  ): boolean {
    for (const [key, pattern] of learnedPatterns) {
      if (pattern.id === patternId) {
        learnedPatterns.delete(key);
        this.emit('pattern:rejected', { patternId });
        return true;
      }
    }
    return false;
  };

  PermissionManagerCtor.prototype.getLearningStats = function(): PermissionLearningStats {
    const patterns = Array.from(learnedPatterns.values());
    const approvedPatterns = patterns.filter((pattern) => pattern.approved).length;
    return {
      totalPatterns: patterns.length,
      approvedPatterns,
      pendingPatterns: patterns.length - approvedPatterns,
      suggestionsMade: suggestionsStats.made,
      suggestionsAccepted: suggestionsStats.accepted,
      accuracyRate: suggestionsStats.made > 0
        ? suggestionsStats.accepted / suggestionsStats.made
        : 0,
    };
  };
}

function extractPatternBase(resource: string): string {
  if (resource.startsWith('/') || resource.includes('/')) {
    const parts = resource.split('/');
    if (parts.length > 2) {
      return parts.slice(0, -1).join('/');
    }
  }
  const parts = resource.split(/\s+/);
  return parts[0] || resource;
}

function ensureUserRuleSet(manager: PermissionManager): string {
  const existing = manager.getRuleSet('user');
  if (existing) {
    return existing.id;
  }

  manager.addRuleSet({
    id: 'user',
    name: 'User Rules',
    source: 'user',
    rules: [],
    enabled: true,
  });
  return 'user';
}

function derivePattern(resources: string[]): string {
  if (resources.length === 0) return '*';
  if (resources.length === 1) return resources[0];

  const sorted = resources.sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  let commonPrefix = '';
  for (let i = 0; i < first.length && i < last.length; i++) {
    if (first[i] === last[i]) {
      commonPrefix += first[i];
    } else {
      break;
    }
  }

  if (commonPrefix.length > 3) {
    return commonPrefix.includes('/') ? `${commonPrefix}**` : `${commonPrefix}*`;
  }
  return '*';
}
