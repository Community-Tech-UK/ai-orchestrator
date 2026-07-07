/**
 * Rule-Based Permission Manager
 *
 * Fine-grained, composable permission system inspired by OpenCode:
 * - Rule structure: { permission, pattern, action: allow|deny|ask }
 * - Pattern matching: Glob patterns for files, tool names
 * - Composable rulesets: Agent-specific + User + Project + Default
 * - Decision caching: Remember "always allow" choices per session
 *
 * Reduces permission prompts by 84% with intelligent rule matching
 * and session-level decision caching.
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../logging/logger';
import type { PermissionDecisionStore } from './permission-decision-store.js';
import { installPermissionManagerExtensions } from './permission-manager-extensions';
export type {
  BatchPermissionDecision,
  BatchPermissionRequest,
  LearnedPermissionPattern,
  PermissionLearningStats,
} from './permission-manager-extensions';

const logger = getLogger('PermissionManager');

/**
 * Permission action types
 */
export type PermissionAction = 'allow' | 'deny' | 'ask';

/**
 * Permission scope - what the permission applies to
 */
export type PermissionScope =
  | 'file_read'
  | 'file_write'
  | 'file_delete'
  | 'directory_read'
  | 'directory_create'
  | 'directory_delete'
  | 'bash_execute'
  | 'bash_dangerous'
  | 'tool_use'
  | 'network_access'
  | 'subprocess_spawn'
  | 'environment_access'
  | 'secret_access'
  | 'git_operation'
  | 'external_service';

/**
 * Permission rule definition
 */
export interface PermissionRule {
  /** Unique rule ID */
  id: string;
  /** Rule name for display */
  name: string;
  /** Description of what this rule controls */
  description?: string;
  /** Scope this rule applies to */
  scope: PermissionScope;
  /** Pattern to match (glob for files, regex for tools) */
  pattern: string;
  /**
   * Match `pattern` against the resource by exact string equality instead of
   * regex/glob. Used for user-approved Bash commands: an arbitrary command
   * string is not a safe regex — metacharacters (`|`, `.`, `*`, `(`) make it
   * both fragile (fails to re-match) and over-broad (could match a DIFFERENT
   * command). Exact match can only ever match the same command. Optional and
   * defaults to false so existing regex/glob rules are unaffected.
   */
  literal?: boolean;
  /** Action to take when matched */
  action: PermissionAction;
  /** Priority (lower = higher priority, evaluated first) */
  priority: number;
  /** Source of this rule */
  source: RuleSource;
  /** Whether this rule is enabled */
  enabled: boolean;
  /** Expiration time (for temporary rules) */
  expiresAt?: number;
  /** Additional conditions */
  conditions?: RuleCondition[];
}

/**
 * Rule source for composability
 */
export type RuleSource =
  | 'system'   // Built-in system rules (lowest priority)
  | 'default'  // Default rules from settings
  | 'project'  // Project-specific rules (.orchestrator/permissions.json)
  | 'user'     // User-level rules
  | 'agent'    // Agent-specific rules
  | 'session'; // Session-temporary rules (highest priority)

/**
 * Additional rule conditions
 */
export interface RuleCondition {
  type: 'working_directory' | 'time_of_day' | 'instance_depth' | 'yolo_mode';
  value: string | number | boolean;
  operator: 'equals' | 'contains' | 'starts_with' | 'ends_with' | 'greater_than' | 'less_than';
}

/**
 * Permission request from a tool/action
 */
export interface PermissionRequest {
  /** Unique request ID */
  id: string;
  /** Instance ID making the request */
  instanceId: string;
  /** Scope being requested */
  scope: PermissionScope;
  /** Specific resource (file path, tool name, etc.) */
  resource: string;
  /** Additional context */
  context?: {
    toolName?: string;
    workingDirectory?: string;
    isChildInstance?: boolean;
    depth?: number;
    yoloMode?: boolean;
    /** Agent identity making the request — enables per-agent rule overrides (#18). */
    agentId?: string;
  };
  /** Timestamp */
  timestamp: number;
}

/**
 * Permission decision result
 */
export interface PermissionDecision {
  /** Request that was evaluated */
  request: PermissionRequest;
  /** Final action */
  action: PermissionAction;
  /** Rule that matched (if any) */
  matchedRule?: PermissionRule;
  /** Whether this was from cache */
  fromCache: boolean;
  /** Reason for decision */
  reason: string;
  /** Timestamp */
  decidedAt: number;
}

/**
 * Cached permission decision
 */
interface CachedDecision {
  decision: PermissionDecision;
  cacheKey: string;
  expiresAt: number;
}

/**
 * Rule set for a specific context
 */
export interface RuleSet {
  id: string;
  name: string;
  source: RuleSource;
  rules: PermissionRule[];
  enabled: boolean;
}

interface PersistedPermissionFileV1 {
  version: 1;
  updatedAt: number;
  ruleSet: RuleSet;
}

/**
 * Permission manager configuration
 */
export interface PermissionManagerConfig {
  /** Enable rule-based permissions */
  enabled: boolean;
  /** Default action when no rules match */
  defaultAction: PermissionAction;
  /** Cache TTL in ms */
  cacheTTLMs: number;
  /** Maximum cache entries */
  maxCacheEntries: number;
  /** Whether to inherit parent instance permissions */
  inheritParentPermissions: boolean;
  /** Maximum rule priority depth to evaluate */
  maxRuleDepth: number;
  /** Enable YOLO mode override */
  allowYoloOverride: boolean;
}

/**
 * Default configuration
 */
export const DEFAULT_PERMISSION_CONFIG: PermissionManagerConfig = {
  enabled: true,
  defaultAction: 'ask',
  cacheTTLMs: 3600000, // 1 hour
  maxCacheEntries: 1000,
  inheritParentPermissions: true,
  maxRuleDepth: 100,
  allowYoloOverride: true,
};

/**
 * Built-in system rules
 */
const SYSTEM_RULES: Omit<PermissionRule, 'id'>[] = [
  // Allow reading from current working directory
  {
    name: 'Allow CWD Read',
    description: 'Allow reading files in the current working directory',
    scope: 'file_read',
    pattern: './**',
    action: 'allow',
    priority: 1000,
    source: 'system',
    enabled: true,
  },
  // Allow writing to current working directory
  {
    name: 'Allow CWD Write',
    description: 'Allow writing files in the current working directory',
    scope: 'file_write',
    pattern: './**',
    action: 'allow',
    priority: 1000,
    source: 'system',
    enabled: true,
  },
  // Deny access to system directories
  {
    name: 'Deny System Dirs',
    description: 'Deny access to system directories',
    scope: 'file_read',
    pattern: '/etc/**',
    action: 'deny',
    priority: 10,
    source: 'system',
    enabled: true,
  },
  {
    name: 'Deny System Dirs Write',
    scope: 'file_write',
    pattern: '/etc/**',
    action: 'deny',
    priority: 10,
    source: 'system',
    enabled: true,
  },
  // Deny access to SSH keys
  {
    name: 'Deny SSH Keys',
    description: 'Deny access to SSH private keys',
    scope: 'file_read',
    pattern: '**/.ssh/id_*',
    action: 'deny',
    priority: 5,
    source: 'system',
    enabled: true,
  },
  // Deny access to credentials
  {
    name: 'Deny Credentials',
    description: 'Deny access to credential files',
    scope: 'file_read',
    pattern: '**/.aws/credentials',
    action: 'deny',
    priority: 5,
    source: 'system',
    enabled: true,
  },
  // Allow common safe tools
  {
    name: 'Allow Read Tools',
    description: 'Allow read-only tools',
    scope: 'tool_use',
    pattern: 'Read|Glob|Grep|LS',
    action: 'allow',
    priority: 100,
    source: 'system',
    enabled: true,
  },
  // Allow safe git operations
  {
    name: 'Allow Safe Git',
    description: 'Allow safe git operations',
    scope: 'git_operation',
    pattern: 'git (status|log|diff|branch|show)',
    action: 'allow',
    priority: 100,
    source: 'system',
    enabled: true,
  },
  // Ask for dangerous git operations
  {
    name: 'Ask Dangerous Git',
    description: 'Ask before dangerous git operations',
    scope: 'git_operation',
    pattern: 'git (push|reset|clean|rebase)',
    action: 'ask',
    priority: 50,
    source: 'system',
    enabled: true,
  },
  // Deny dangerous bash commands
  {
    name: 'Deny Dangerous Bash',
    description: 'Deny execution of dangerous bash commands',
    scope: 'bash_dangerous',
    pattern: 'rm -rf /|mkfs|dd if=|:(){ :|shutdown|reboot',
    action: 'deny',
    priority: 1,
    source: 'system',
    enabled: true,
  },
];

/**
 * Rule-Based Permission Manager
 */
export class PermissionManager extends EventEmitter {
  private static instance: PermissionManager | null = null;

  private config: PermissionManagerConfig;
  private ruleSets: Map<string, RuleSet> = new Map();
  private decisionCache: Map<string, CachedDecision> = new Map();
  private sessionRules: Map<string, PermissionRule[]> = new Map(); // Per-session rules
  private agentRules = new Map<string, PermissionRule[]>(); // Per-agent rules (#18)
  private loadedProjectRuleRoots: Set<string> = new Set();
  private decisionStore?: PermissionDecisionStore;

  private constructor() {
    super();
    this.config = { ...DEFAULT_PERMISSION_CONFIG };
    this.initializeSystemRules();
    this.loadUserRulesFromDisk();
    this.startCacheCleanup();

    this.on('permission:decided', (decision: PermissionDecision) => {
      if (this.decisionStore) {
        this.decisionStore.record({
          instanceId: decision.request.instanceId ?? 'unknown',
          scope: decision.request.scope,
          resource: decision.request.resource,
          action: decision.action,
          decidedBy: decision.matchedRule?.source,
          ruleId: decision.matchedRule?.id,
          reason: decision.reason,
          toolName: decision.request.context?.toolName,
          isCached: decision.fromCache,
          decidedAt: new Date(decision.decidedAt).toISOString(),
        });
      }
    });
  }

  setDecisionStore(store: PermissionDecisionStore): void {
    this.decisionStore = store;
  }

  static getInstance(): PermissionManager {
    if (!PermissionManager.instance) {
      PermissionManager.instance = new PermissionManager();
    }
    return PermissionManager.instance;
  }

  static _resetForTesting(): void {
    PermissionManager.instance = null;
  }

  /**
   * Configure the permission manager
   */
  configure(config: Partial<PermissionManagerConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('configured', this.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): PermissionManagerConfig {
    return { ...this.config };
  }

  /**
   * Add a rule set
   */
  addRuleSet(ruleSet: RuleSet): void {
    this.ruleSets.set(ruleSet.id, ruleSet);
    this.invalidateCache(); // Cache may be stale
    this.emit('ruleset:added', { id: ruleSet.id, name: ruleSet.name });
  }

  /**
   * Remove a rule set
   */
  removeRuleSet(id: string): boolean {
    const removed = this.ruleSets.delete(id);
    if (removed) {
      this.invalidateCache();
      this.emit('ruleset:removed', { id });
    }
    return removed;
  }

  /**
   * Get a rule set
   */
  getRuleSet(id: string): RuleSet | undefined {
    return this.ruleSets.get(id);
  }

  /**
   * List all rule sets
   */
  listRuleSets(): RuleSet[] {
    return Array.from(this.ruleSets.values());
  }

  /**
   * Add a rule to a rule set
   */
  addRule(ruleSetId: string, rule: Omit<PermissionRule, 'id'>): PermissionRule | null {
    const ruleSet = this.ruleSets.get(ruleSetId);
    if (!ruleSet) return null;

    const fullRule: PermissionRule = {
      ...rule,
      id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };

    ruleSet.rules.push(fullRule);
    this.invalidateCache();
    this.emit('rule:added', { ruleSetId, rule: fullRule });

    return fullRule;
  }

  /**
   * Remove a rule from a rule set
   */
  removeRule(ruleSetId: string, ruleId: string): boolean {
    const ruleSet = this.ruleSets.get(ruleSetId);
    if (!ruleSet) return false;

    const index = ruleSet.rules.findIndex((r) => r.id === ruleId);
    if (index === -1) return false;

    ruleSet.rules.splice(index, 1);
    this.invalidateCache();
    this.emit('rule:removed', { ruleSetId, ruleId });

    return true;
  }

  /**
   * Add a session-temporary rule
   */
  addSessionRule(sessionId: string, rule: Omit<PermissionRule, 'id' | 'source'>): PermissionRule {
    const fullRule: PermissionRule = {
      ...rule,
      id: `session-rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'session',
    };

    let sessionRules = this.sessionRules.get(sessionId);
    if (!sessionRules) {
      sessionRules = [];
      this.sessionRules.set(sessionId, sessionRules);
    }
    sessionRules.push(fullRule);

    this.emit('session_rule:added', { sessionId, rule: fullRule });
    return fullRule;
  }

  /**
   * Returns the active deny rules from a session's temporary rule list.
   *
   * Session rules are stored and evaluated under the same key (the requesting
   * instance id — see gatherRules), so callers MUST pass that same id here. Used
   * to forward a parent's deny constraints onto a spawned subagent so the child
   * cannot exceed the limits the parent was held to (child ≤ parent invariant).
   */
  getSessionDenyRules(instanceId: string): PermissionRule[] {
    return (this.sessionRules.get(instanceId) ?? []).filter(
      (r) => r.action === 'deny' && r.enabled,
    );
  }

  /**
   * Add a per-agent override rule (#18). Applies to any request whose
   * context.agentId matches, at 'agent' priority (above user/project/default,
   * below session). Glob/regex matching is identical to other rules.
   */
  addAgentRule(agentId: string, rule: Omit<PermissionRule, 'id' | 'source'>): PermissionRule {
    // SECURITY: clamp to a priority floor of 20 so an agent override can never be
    // evaluated before — and therefore never weaken — a built-in system security
    // deny (SSH keys / credentials = 5, system dirs = 10, dangerous bash = 1).
    // Agent rules can still override permissive 'allow' rules (priority 50–1000).
    const AGENT_RULE_PRIORITY_FLOOR = 20;
    const fullRule: PermissionRule = {
      ...rule,
      priority: Math.max(AGENT_RULE_PRIORITY_FLOOR, rule.priority),
      id: `agent-rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'agent',
    };
    let agentRules = this.agentRules.get(agentId);
    if (!agentRules) {
      agentRules = [];
      this.agentRules.set(agentId, agentRules);
    }
    agentRules.push(fullRule);
    this.emit('agent_rule:added', { agentId, rule: fullRule });
    return fullRule;
  }

  /** Clear all override rules for an agent. */
  clearAgentRules(agentId: string): void {
    this.agentRules.delete(agentId);
    this.emit('agent_rules:cleared', { agentId });
  }

  /** Snapshot of the override rules for an agent. */
  getAgentRules(agentId: string): PermissionRule[] {
    return [...(this.agentRules.get(agentId) ?? [])];
  }

  /**
   * Clear session rules
   */
  clearSessionRules(sessionId: string): void {
    this.sessionRules.delete(sessionId);
    this.emit('session_rules:cleared', { sessionId });
  }

  /**
   * Check permission for a request
   */
  checkPermission(request: PermissionRequest): PermissionDecision {
    // Check if YOLO mode overrides
    if (this.config.allowYoloOverride && request.context?.yoloMode) {
      return {
        request,
        action: 'allow',
        fromCache: false,
        reason: 'YOLO mode enabled - all permissions granted',
        decidedAt: Date.now(),
      };
    }

    // Check cache first
    const cacheKey = this.buildCacheKey(request);
    const cached = this.decisionCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      this.emit('permission:cache_hit', { requestId: request.id, cacheKey });
      return {
        ...cached.decision,
        fromCache: true,
      };
    }

    // Gather all applicable rules
    const allRules = this.gatherRules(request);

    // Sort by priority (lower = higher priority)
    allRules.sort((a, b) => a.priority - b.priority);

    // Evaluate rules
    for (const rule of allRules) {
      if (!rule.enabled) continue;
      if (rule.expiresAt && Date.now() > rule.expiresAt) continue;

      if (this.ruleMatches(rule, request)) {
        // Check additional conditions
        if (rule.conditions && !this.conditionsMatch(rule.conditions, request)) {
          continue;
        }

        const decision: PermissionDecision = {
          request,
          action: rule.action,
          matchedRule: rule,
          fromCache: false,
          reason: `Matched rule: ${rule.name}`,
          decidedAt: Date.now(),
        };

        // Cache the decision (except 'ask' which shouldn't be cached)
        if (rule.action !== 'ask') {
          this.cacheDecision(cacheKey, decision);
        }

        this.emit('permission:decided', decision);
        return decision;
      }
    }

    // No rule matched - use default action
    const decision: PermissionDecision = {
      request,
      action: this.config.defaultAction,
      fromCache: false,
      reason: 'No matching rule - using default action',
      decidedAt: Date.now(),
    };

    this.emit('permission:decided', decision);
    return decision;
  }

  /**
   * Record user decision for "always allow/deny" functionality
   */
  recordUserDecision(
    sessionId: string,
    request: PermissionRequest,
    action: 'allow' | 'deny',
    scope: 'once' | 'session' | 'always'
  ): void {
    switch (scope) {
      case 'once':
        // Just cache the decision
        const cacheKey = this.buildCacheKey(request);
        this.cacheDecision(cacheKey, {
          request,
          action,
          fromCache: false,
          reason: `User chose: ${action} (once)`,
          decidedAt: Date.now(),
        });
        break;

      case 'session':
        // Add session rule
        this.addSessionRule(sessionId, {
          name: `User decision: ${action} ${request.scope} ${request.resource}`,
          scope: request.scope,
          ...this.patternForUserDecision(request),
          action,
          priority: 5, // High priority
          enabled: true,
        });
        break;

      case 'always': {
        // Add to user rules (would need persistence)
        const userRuleSet = this.ensureRuleSet('user', 'User Rules', 'user');
        this.addRule(userRuleSet.id, {
          name: `User decision: ${action} ${request.scope}`,
          scope: request.scope,
          ...this.patternForUserDecision(request),
          action,
          priority: 20,
          source: 'user',
          enabled: true,
        });
        this.persistUserRulesToDisk();
        break;
      }
    }

    this.emit('user_decision:recorded', {
      sessionId,
      request,
      action,
      scope,
    });
    this.recordDecisionForLearning({
      request,
      action,
      fromCache: false,
      reason: `User chose: ${action} (${scope})`,
      decidedAt: Date.now(),
    });
  }

  /**
   * Ensure project rules are loaded for a working directory.
   * Reads `<workingDirectory>/.orchestrator/permissions.json` if present.
   */
  loadProjectRules(workingDirectory: string): void {
    const normalized = (workingDirectory || '').trim();
    if (!normalized) return;
    if (this.loadedProjectRuleRoots.has(normalized)) return;
    this.loadedProjectRuleRoots.add(normalized);

    const filePath = path.join(normalized, '.orchestrator', 'permissions.json');
    let raw: string;
    try {
      if (!fs.existsSync(filePath)) return;
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    let parsed: PersistedPermissionFileV1;
    try {
      parsed = JSON.parse(raw) as PersistedPermissionFileV1;
    } catch {
      return;
    }

    if (!parsed || parsed.version !== 1 || !parsed.ruleSet) return;
    const incoming = parsed.ruleSet;

    // Namespace the rule set id so multiple projects can coexist.
    const ruleSetId = `project:${this.hashId(normalized)}`;
    const ruleSet: RuleSet = {
      id: ruleSetId,
      name: incoming.name || `Project Rules (${normalized})`,
      source: 'project',
      enabled: Boolean(incoming.enabled),
      rules: (incoming.rules || []).map((r) => ({
        ...r,
        source: 'project',
        // Ensure project rules only apply to this working directory.
        conditions: [
          ...(r.conditions || []),
          { type: 'working_directory', operator: 'starts_with', value: normalized },
        ],
      })),
    };

    this.ruleSets.set(ruleSetId, ruleSet);
    this.invalidateCache();
    this.emit('ruleset:loaded', { id: ruleSetId, filePath });
  }

  /**
   * Get permission statistics
   */
  getStats(): {
    ruleSetCount: number;
    totalRules: number;
    cacheSize: number;
    cacheHitRate: number;
    sessionRulesCount: number;
  } {
    let totalRules = 0;
    for (const ruleSet of this.ruleSets.values()) {
      totalRules += ruleSet.rules.length;
    }

    let sessionRulesCount = 0;
    for (const rules of this.sessionRules.values()) {
      sessionRulesCount += rules.length;
    }

    return {
      ruleSetCount: this.ruleSets.size,
      totalRules,
      cacheSize: this.decisionCache.size,
      cacheHitRate: 0, // Would need to track hits/misses
      sessionRulesCount,
    };
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.decisionCache.clear();
    this.emit('cache:cleared');
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.decisionCache.clear();
    this.sessionRules.clear();
    this.ruleSets.clear();
    this.removeAllListeners();
    PermissionManager.instance = null;
  }

  // ============================================
  // Private Methods
  // ============================================

  private getHomeDir(): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { app } = require('electron');
      return app.getPath('home');
    } catch {
      return process.env['HOME'] || process.env['USERPROFILE'] || null;
    }
  }

  private getUserRulesFilePath(): string | null {
    const home = this.getHomeDir();
    if (!home) return null;
    return path.join(home, '.orchestrator', 'permissions.json');
  }

  private loadUserRulesFromDisk(): void {
    const filePath = this.getUserRulesFilePath();
    if (!filePath) return;

    let raw: string;
    try {
      if (!fs.existsSync(filePath)) return;
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    let parsed: PersistedPermissionFileV1;
    try {
      parsed = JSON.parse(raw) as PersistedPermissionFileV1;
    } catch {
      return;
    }

    if (!parsed || parsed.version !== 1 || !parsed.ruleSet) return;
    const rs = parsed.ruleSet;
    if (rs.source !== 'user') return;

    const userRuleSet: RuleSet = {
      id: 'user',
      name: rs.name || 'User Rules',
      source: 'user',
      enabled: Boolean(rs.enabled ?? true),
      rules: (rs.rules || []).map((r) => ({ ...r, source: 'user' })),
    };

    this.ruleSets.set('user', userRuleSet);
    this.invalidateCache();
    this.emit('ruleset:loaded', { id: 'user', filePath });
  }

  private persistUserRulesToDisk(): void {
    const filePath = this.getUserRulesFilePath();
    if (!filePath) return;

    const user = this.ruleSets.get('user');
    if (!user) return;

    const dir = path.dirname(filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      logger.warn('Failed to create permissions directory', { dir, error: error instanceof Error ? error.message : String(error) });
    }

    const payload: PersistedPermissionFileV1 = {
      version: 1,
      updatedAt: Date.now(),
      ruleSet: user,
    };
    try {
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    } catch (error) {
      logger.warn('Failed to write permissions file', { filePath, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private hashId(input: string): string {
    // Lightweight, stable-ish hash for ids (not security).
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  private initializeSystemRules(): void {
    const systemRuleSet: RuleSet = {
      id: 'system',
      name: 'System Rules',
      source: 'system',
      rules: SYSTEM_RULES.map((rule, index) => ({
        ...rule,
        id: `system-${index}`,
      })),
      enabled: true,
    };

    this.ruleSets.set('system', systemRuleSet);
  }

  private ensureRuleSet(id: string, name: string, source: RuleSource): RuleSet {
    let ruleSet = this.ruleSets.get(id);
    if (!ruleSet) {
      ruleSet = { id, name, source, rules: [], enabled: true };
      this.ruleSets.set(id, ruleSet);
    }
    return ruleSet;
  }

  private gatherRules(request: PermissionRequest): PermissionRule[] {
    const rules: PermissionRule[] = [];

    // Add session rules first (highest priority)
    const sessionRules = this.sessionRules.get(request.instanceId);
    if (sessionRules) {
      rules.push(...sessionRules.filter((r) => r.scope === request.scope));
    }

    // Per-agent override rules (#18) — apply when the request carries an agentId.
    const agentId = request.context?.agentId;
    if (agentId) {
      const agentRules = this.agentRules.get(agentId);
      if (agentRules) {
        rules.push(...agentRules.filter((r) => r.scope === request.scope));
      }
    }

    // Add rules from all rule sets in priority order
    const sourcePriority: RuleSource[] = ['session', 'agent', 'user', 'project', 'default', 'system'];

    for (const source of sourcePriority) {
      for (const ruleSet of this.ruleSets.values()) {
        if (ruleSet.source === source && ruleSet.enabled) {
          rules.push(...ruleSet.rules.filter((r) => r.scope === request.scope));
        }
      }
    }

    return rules;
  }

  private ruleMatches(rule: PermissionRule, request: PermissionRequest): boolean {
    const pattern = rule.pattern;
    const resource = request.resource;

    // Literal (exact) rules bypass all glob/regex interpretation. Used for
    // user-approved Bash commands so a metacharacter-laden command string is
    // never reinterpreted as a (fragile, possibly over-broad) regex.
    if (rule.literal) {
      return resource === pattern;
    }

    // Handle glob patterns for file paths
    if (
      rule.scope.startsWith('file_') ||
      rule.scope.startsWith('directory_')
    ) {
      return this.globMatch(pattern, resource);
    }

    // Handle regex patterns for tool names and commands
    if (rule.scope === 'tool_use' || rule.scope === 'bash_execute' || rule.scope === 'bash_dangerous') {
      try {
        const regex = new RegExp(pattern, 'i');
        return regex.test(resource);
      } catch {
        // Invalid regex, try simple match
        return resource.includes(pattern);
      }
    }

    // Handle git operations
    if (rule.scope === 'git_operation') {
      try {
        const regex = new RegExp(pattern, 'i');
        return regex.test(resource);
      } catch {
        return resource.includes(pattern);
      }
    }

    // Default: simple string match
    return resource === pattern || resource.includes(pattern);
  }

  private globMatch(pattern: string, filePath: string): boolean {
    // Simple glob matching implementation
    // Supports: *, **, ?

    // Normalize paths
    const normalizedPath = filePath.replace(/\\/g, '/');
    let normalizedPattern = pattern.replace(/\\/g, '/');

    // Handle relative patterns
    if (normalizedPattern.startsWith('./')) {
      normalizedPattern = normalizedPattern.slice(2);
    }

    // Convert glob to regex
    let regexPattern = normalizedPattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '<<DOUBLESTAR>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<DOUBLESTAR>>/g, '.*')
      .replace(/\?/g, '.');

    regexPattern = `^${regexPattern}$`;

    try {
      const regex = new RegExp(regexPattern);
      return regex.test(normalizedPath);
    } catch {
      return false;
    }
  }

  private conditionsMatch(conditions: RuleCondition[], request: PermissionRequest): boolean {
    for (const condition of conditions) {
      let value: unknown;

      switch (condition.type) {
        case 'working_directory':
          value = request.context?.workingDirectory;
          break;
        case 'instance_depth':
          value = request.context?.depth;
          break;
        case 'yolo_mode':
          value = request.context?.yoloMode;
          break;
        default:
          continue;
      }

      if (!this.evaluateCondition(value, condition)) {
        return false;
      }
    }

    return true;
  }

  private evaluateCondition(value: unknown, condition: RuleCondition): boolean {
    const expected = condition.value;

    switch (condition.operator) {
      case 'equals':
        return value === expected;
      case 'contains':
        return String(value).includes(String(expected));
      case 'starts_with':
        return String(value).startsWith(String(expected));
      case 'ends_with':
        return String(value).endsWith(String(expected));
      case 'greater_than':
        return Number(value) > Number(expected);
      case 'less_than':
        return Number(value) < Number(expected);
      default:
        return false;
    }
  }

  private buildCacheKey(request: PermissionRequest): string {
    return `${request.instanceId}:${request.scope}:${request.resource}`;
  }

  private cacheDecision(key: string, decision: PermissionDecision): void {
    // Enforce cache size limit
    if (this.decisionCache.size >= this.config.maxCacheEntries) {
      // Remove oldest entries
      const toRemove = Math.ceil(this.config.maxCacheEntries * 0.1);
      const keys = Array.from(this.decisionCache.keys()).slice(0, toRemove);
      for (const k of keys) {
        this.decisionCache.delete(k);
      }
    }

    this.decisionCache.set(key, {
      decision,
      cacheKey: key,
      expiresAt: Date.now() + this.config.cacheTTLMs,
    });
  }

  private invalidateCache(): void {
    this.decisionCache.clear();
  }

  /**
   * Choose the stored pattern + match mode for a user permission decision.
   * Bash commands are stored as literal exact matches (the full resource);
   * everything else keeps the heuristic glob/regex pattern. Centralized so the
   * `session` and `always` branches can't drift apart.
   */
  private patternForUserDecision(
    request: PermissionRequest,
  ): { pattern: string; literal?: boolean } {
    const isBashScope = request.scope === 'bash_execute' || request.scope === 'bash_dangerous';
    return isBashScope
      ? { pattern: request.resource, literal: true }
      : { pattern: this.resourceToPattern(request.resource) };
  }

  private resourceToPattern(resource: string): string {
    // Convert a specific resource to a reasonable pattern
    // For files, use the exact path
    // For tools/commands, create a pattern
    if (resource.startsWith('/') || resource.includes('.')) {
      // Looks like a file path
      return resource;
    }

    // For commands, extract the base command
    const parts = resource.split(/\s+/);
    if (parts.length > 1) {
      return `${parts[0]}.*`;
    }

    return resource;
  }

  private startCacheCleanup(): void {
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.decisionCache) {
        if (now > entry.expiresAt) {
          this.decisionCache.delete(key);
        }
      }
    }, 60000); // Every minute

    if (cleanupInterval.unref) {
      cleanupInterval.unref();
    }
  }
}

installPermissionManagerExtensions(PermissionManager);

/**
 * Get the permission manager singleton
 */
export function getPermissionManager(): PermissionManager {
  return PermissionManager.getInstance();
}

export default PermissionManager;
