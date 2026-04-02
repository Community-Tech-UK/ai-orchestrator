/**
 * Tool List Filter - Pre-model deny rule filtering.
 * Inspired by Claude Code's filterToolsByDenyRules().
 */

export interface FilterableTool {
  id: string;
  description: string;
}

export interface DenyRule {
  pattern: string;
  type: 'blanket' | 'runtime';
}

export class ToolListFilter {
  private blanketPatterns: string[];
  private runtimePatterns: string[];

  constructor(private rules: DenyRule[]) {
    this.blanketPatterns = rules.filter(r => r.type === 'blanket').map(r => r.pattern);
    this.runtimePatterns = rules.filter(r => r.type === 'runtime').map(r => r.pattern);
  }

  filterForModel<T extends FilterableTool>(tools: T[]): T[] {
    return tools.filter(tool => !this.matchesAny(tool.id, this.blanketPatterns));
  }

  isRuntimeDenied(toolId: string): boolean {
    return this.matchesAny(toolId, this.runtimePatterns);
  }

  isBlanketDenied(toolId: string): boolean {
    return this.matchesAny(toolId, this.blanketPatterns);
  }

  private matchesAny(toolId: string, patterns: string[]): boolean {
    return patterns.some(pattern => this.matchPattern(toolId, pattern));
  }

  private matchPattern(toolId: string, pattern: string): boolean {
    if (toolId === pattern) return true;
    if (toolId.startsWith(pattern + '__') || toolId.startsWith(pattern + ':')) return true;
    if (pattern.includes('*')) {
      const regexStr = '^' + pattern.replace(/\*/g, '.*') + '$';
      return new RegExp(regexStr).test(toolId);
    }
    return false;
  }
}
