/**
 * HookEngine - Rule engine for pre/post tool use hooks
 * Based on validated architecture from Claude Code hookify plugin
 */

import { EventEmitter } from 'events';
import {
  HookRule,
  HookCondition,
  HookContext,
  HookResult,
  HookEvent,
  ConditionOperator,
} from '../../shared/types/hook.types';
import { builtInHookRules } from './built-in-rules';
import { getLogger } from '../logging/logger';

const logger = getLogger('HookEngine');

export class HookEngine extends EventEmitter {
  private static instance: HookEngine | null = null;
  private rules: Map<string, HookRule> = new Map();
  private regexCache: Map<string, RegExp> = new Map();

  static getInstance(): HookEngine {
    if (!this.instance) {
      this.instance = new HookEngine();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() {
    super();
    this.loadBuiltInRules();
  }

  private loadBuiltInRules(): void {
    for (const rule of builtInHookRules) {
      this.rules.set(rule.id, rule);
    }
  }

  // ============ Rule Management ============

  registerRule(rule: HookRule): void {
    this.rules.set(rule.id, rule);
    this.emit('hook:registered', rule);
  }

  updateRule(ruleId: string, updates: Partial<HookRule>): HookRule | undefined {
    const existing = this.rules.get(ruleId);
    if (!existing) return undefined;

    const updated = {
      ...existing,
      ...updates,
      id: existing.id, // Prevent ID change
      createdAt: existing.createdAt, // Prevent creation time change
      source: existing.source, // Prevent source change
      updatedAt: Date.now(),
    };

    this.rules.set(ruleId, updated);
    this.emit('hook:updated', updated);
    return updated;
  }

  removeRule(ruleId: string): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;

    // Don't allow removing built-in rules
    if (rule.source === 'built-in') {
      // Instead, disable it
      this.updateRule(ruleId, { enabled: false });
      return true;
    }

    const deleted = this.rules.delete(ruleId);
    if (deleted) {
      this.emit('hook:deleted', rule);
    }
    return deleted;
  }

  getRules(event?: HookEvent): HookRule[] {
    return Array.from(this.rules.values())
      .filter((r) => r.enabled)
      .filter((r) => !event || r.event === event || r.event === 'all');
  }

  getAllRules(): HookRule[] {
    return Array.from(this.rules.values());
  }

  getRule(ruleId: string): HookRule | undefined {
    return this.rules.get(ruleId);
  }

  // ============ Evaluation ============

  evaluate(context: HookContext): HookResult {
    const applicableRules = this.getRules(context.event);
    const matchedRules: HookRule[] = [];

    for (const rule of applicableRules) {
      if (this.ruleMatches(rule, context)) {
        matchedRules.push(rule);
      }
    }

    if (matchedRules.length === 0) {
      return { matched: false };
    }

    // Blocking rules take priority
    const blockingRules = matchedRules.filter((r) => r.action === 'block');
    if (blockingRules.length > 0) {
      const result: HookResult = {
        matched: true,
        action: 'block',
        message: blockingRules.map((r) => `**[${r.name}]**\n${r.message}`).join('\n\n'),
        rules: blockingRules,
      };
      this.emit('hook:blocked', { rules: blockingRules, context, result });
      return result;
    }

    // Otherwise return warnings
    const warningRules = matchedRules.filter((r) => r.action === 'warn');
    const result: HookResult = {
      matched: true,
      action: 'warn',
      message: warningRules.map((r) => `**[${r.name}]**\n${r.message}`).join('\n\n'),
      rules: warningRules,
    };
    this.emit('hook:warned', { rules: warningRules, context, result });
    return result;
  }

  // ============ Matching Logic ============

  private ruleMatches(rule: HookRule, context: HookContext): boolean {
    // Check lightweight `if` predicates first (short-circuit before expensive evaluation)
    // This avoids unnecessary executor spawns when the predicate doesn't match.
    // A failing predicate (e.g. bad regex) blocks the rule rather than letting it pass,
    // matching the principle of least privilege (flagged by GPT-5.4 review).
    if (rule.if && rule.if.length > 0) {
      try {
        if (!rule.if.every((cond) => this.conditionMatches(cond, context))) {
          return false;
        }
      } catch (err) {
        logger.warn('Hook `if` predicate threw — blocking rule as precaution', {
          ruleId: rule.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    }

    // Check tool matcher
    if (rule.toolMatcher && context.toolName) {
      const pattern = this.getRegex(rule.toolMatcher);
      if (!pattern.test(context.toolName)) {
        return false;
      }
    }

    // All conditions must match (AND logic)
    return rule.conditions.every((cond) => this.conditionMatches(cond, context));
  }

  private conditionMatches(condition: HookCondition, context: HookContext): boolean {
    const value = this.extractField(condition.field, context);
    if (value === undefined) return false;

    const valueStr = String(value);

    switch (condition.operator) {
      case 'regex_match':
        return this.getRegex(condition.pattern).test(valueStr);

      case 'contains':
        return valueStr.includes(condition.pattern);

      case 'not_contains':
        return !valueStr.includes(condition.pattern);

      case 'equals':
        return valueStr === condition.pattern;

      case 'starts_with':
        return valueStr.startsWith(condition.pattern);

      case 'ends_with':
        return valueStr.endsWith(condition.pattern);

      default:
        return false;
    }
  }

  private extractField(field: string, context: HookContext): unknown {
    // Support nested fields with dot notation
    const parts = field.split('.');
    let value: unknown = context;

    for (const part of parts) {
      if (value === null || value === undefined) return undefined;
      value = (value as Record<string, unknown>)[part];
    }

    return value;
  }

  private getRegex(pattern: string): RegExp {
    if (!this.regexCache.has(pattern)) {
      try {
        this.regexCache.set(pattern, new RegExp(pattern, 'i'));
      } catch {
        // Invalid regex - treat as literal match
        this.regexCache.set(pattern, new RegExp(this.escapeRegex(pattern), 'i'));
      }
    }
    return this.regexCache.get(pattern)!;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ============ Utilities ============

  clearCache(): void {
    this.regexCache.clear();
  }

  resetToBuiltIn(): void {
    this.rules.clear();
    this.regexCache.clear();
    this.loadBuiltInRules();
  }

  // ============ Import/Export ============

  exportRules(source?: 'built-in' | 'project' | 'user'): HookRule[] {
    return Array.from(this.rules.values()).filter((r) => !source || r.source === source);
  }

  importRules(rules: HookRule[], overwrite = false): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;

    for (const rule of rules) {
      if (!overwrite && this.rules.has(rule.id)) {
        skipped++;
        continue;
      }

      this.rules.set(rule.id, rule);
      imported++;
    }

    if (imported > 0) {
      this.emit('hook:imported', { imported, skipped });
    }

    return { imported, skipped };
  }
}

// Singleton accessor
let hookEngineInstance: HookEngine | null = null;

export function getHookEngine(): HookEngine {
  if (!hookEngineInstance) {
    hookEngineInstance = HookEngine.getInstance();
  }
  return hookEngineInstance;
}

export function _resetHookEngineForTesting(): void {
  hookEngineInstance = null;
  HookEngine._resetForTesting();
}
