/**
 * Wake-Up Context Builder
 *
 * Generates compact L0 + L1 initialization context for cold-starting AI agents.
 * Inspired by mempalace's 4-layer memory stack.
 *
 * L0 (Identity, ~100 tokens): Fixed persona description
 * L1 (Essential Story, ~500-800 tokens): Top-importance hints grouped by room
 *
 * Total wake-up cost: ~600-900 tokens
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import type {
  WakeContext,
  ContextLayer,
  WakeHint,
  WakeContextConfig,
} from '../../shared/types/wake-context.types';
import { DEFAULT_WAKE_CONTEXT_CONFIG } from '../../shared/types/wake-context.types';
import type { WakeHintRow } from '../persistence/rlm-database.types';

const logger = getLogger('WakeContextBuilder');

const DEFAULT_IDENTITY = 'AI orchestrator assistant. Coordinates multiple AI agents for complex tasks.';

interface AddHintOptions {
  importance?: number;
  room?: string;
  sourceReflectionId?: string;
  sourceSessionId?: string;
}

export class WakeContextBuilder extends EventEmitter {
  private static instance: WakeContextBuilder | null = null;
  private config: WakeContextConfig;
  private identityText: string;
  private contextCache = new Map<string, WakeContext>();

  static getInstance(): WakeContextBuilder {
    if (!this.instance) {
      this.instance = new WakeContextBuilder();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.removeAllListeners();
      this.instance = null;
    }
  }

  private constructor() {
    super();
    this.config = { ...DEFAULT_WAKE_CONTEXT_CONFIG };
    this.identityText = DEFAULT_IDENTITY;
    logger.info('WakeContextBuilder initialized');
  }

  configure(config: Partial<WakeContextConfig>): void {
    this.config = { ...this.config, ...config };
    this.invalidateCache();
  }

  private get db() {
    return getRLMDatabase().getRawDb();
  }

  private invalidateCache(): void {
    this.contextCache.clear();
  }

  // ============ Identity (L0) ============

  setIdentity(text: string): void {
    this.identityText = text;
    this.invalidateCache();
    logger.info('Identity updated');
  }

  getIdentity(): string {
    return this.identityText;
  }

  private generateL0(): ContextLayer {
    const content = this.identityText;
    return {
      level: 'L0',
      content,
      tokenEstimate: estimateTokens(content),
      generatedAt: Date.now(),
    };
  }

  // ============ Hints Management ============

  addHint(content: string, options: AddHintOptions = {}): string {
    const id = `hint_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const importance = options.importance ?? 5;

    this.db.prepare(`
      INSERT INTO wake_hints (id, content, importance, room, source_reflection_id, source_session_id, created_at, last_used, usage_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      id,
      content,
      importance,
      options.room ?? 'general',
      options.sourceReflectionId ?? null,
      options.sourceSessionId ?? null,
      now,
      now,
    );

    this.invalidateCache();
    this.emit('wake:hint-added', { id, content, importance });
    return id;
  }

  getHint(id: string): WakeHint | undefined {
    const row = this.db.prepare('SELECT * FROM wake_hints WHERE id = ?').get(id) as WakeHintRow | undefined;
    if (!row) return undefined;
    return rowToHint(row);
  }

  removeHint(id: string): void {
    this.db.prepare('DELETE FROM wake_hints WHERE id = ?').run(id);
    this.invalidateCache();
  }

  listHints(room?: string): WakeHint[] {
    const rows = room
      ? this.db.prepare(`
          SELECT * FROM wake_hints
          WHERE room = ? OR room = 'general'
          ORDER BY importance DESC, created_at DESC
        `).all(room) as WakeHintRow[]
      : this.db.prepare(`
          SELECT * FROM wake_hints
          ORDER BY importance DESC, created_at DESC
        `).all() as WakeHintRow[];
    return rows.map(rowToHint);
  }

  // ============ Essential Story (L1) ============

  private generateL1(wing?: string): ContextLayer {
    // Fetch top hints by importance, optionally filtered by wing (room match or 'general')
    const limit = this.config.l1MaxHints;
    const rows = wing
      ? this.db.prepare(`
          SELECT * FROM wake_hints
          WHERE room = ? OR room = 'general'
          ORDER BY importance DESC, created_at DESC
          LIMIT ?
        `).all(wing, limit) as WakeHintRow[]
      : this.db.prepare(`
          SELECT * FROM wake_hints
          ORDER BY importance DESC, created_at DESC
          LIMIT ?
        `).all(limit) as WakeHintRow[];

    if (rows.length === 0) {
      return {
        level: 'L1',
        content: '## L1 — ESSENTIAL STORY\nNo knowledge stored yet.',
        tokenEstimate: 10,
        generatedAt: Date.now(),
      };
    }

    // Group by room
    const byRoom = new Map<string, WakeHintRow[]>();
    for (const row of rows) {
      const existing = byRoom.get(row.room) ?? [];
      existing.push(row);
      byRoom.set(row.room, existing);
    }

    // Build formatted output with character budget
    const maxChars = this.config.l1MaxTokens * 4; // ~4 chars per token
    const snippetMax = this.config.l1SnippetMaxChars;
    const lines = ['## L1 — ESSENTIAL STORY', ''];
    let totalChars = lines.join('\n').length;

    for (const [room, hints] of byRoom.entries()) {
      const roomHeader = `[${room}]`;
      if (totalChars + roomHeader.length + 2 > maxChars) {
        lines.push('... (more in deep search)');
        break;
      }
      lines.push(roomHeader);
      totalChars += roomHeader.length + 1;

      for (const hint of hints) {
        let snippet = hint.content.replace(/\n/g, ' ').trim();
        if (snippet.length > snippetMax) {
          snippet = snippet.slice(0, snippetMax - 3) + '...';
        }
        const line = `  - ${snippet}`;

        if (totalChars + line.length + 1 > maxChars) {
          lines.push('  ... (more in deep search)');
          totalChars += 30;
          break;
        }

        lines.push(line);
        totalChars += line.length + 1;

        // Update usage tracking
        this.db.prepare(`
          UPDATE wake_hints SET last_used = ?, usage_count = usage_count + 1 WHERE id = ?
        `).run(Date.now(), hint.id);
      }

      lines.push('');
      totalChars += 1;
    }

    const content = lines.join('\n').trim();
    return {
      level: 'L1',
      content,
      tokenEstimate: estimateTokens(content),
      generatedAt: Date.now(),
    };
  }

  // ============ Full Wake Context ============

  generateWakeContext(wing?: string): WakeContext {
    // Check cache (keyed by wing to avoid cross-project contamination)
    const now = Date.now();
    const cacheKey = wing ?? '__global__';
    const cached = this.contextCache.get(cacheKey);
    if (cached && (now - cached.generatedAt) < this.config.regenerateIntervalMs) {
      return cached;
    }

    const identity = this.generateL0();
    const essentialStory = this.generateL1(wing);

    const ctx: WakeContext = {
      identity,
      essentialStory,
      totalTokens: identity.tokenEstimate + essentialStory.tokenEstimate,
      wing,
      generatedAt: now,
    };

    this.contextCache.set(cacheKey, ctx);

    this.emit('wake:context-generated', { totalTokens: ctx.totalTokens, wing });
    logger.debug('Wake context generated', { totalTokens: ctx.totalTokens });

    return ctx;
  }

  /**
   * Get the wake-up context as a single injectable string.
   * This is what gets prepended to agent system prompts.
   */
  getWakeUpText(wing?: string): string {
    const ctx = this.generateWakeContext(wing);
    return `${ctx.identity.content}\n\n${ctx.essentialStory.content}`;
  }
}

/** Convenience getter */
export function getWakeContextBuilder(): WakeContextBuilder {
  return WakeContextBuilder.getInstance();
}

// ============ Helpers ============

function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

function rowToHint(row: WakeHintRow): WakeHint {
  return {
    id: row.id,
    content: row.content,
    importance: row.importance,
    room: row.room,
    sourceReflectionId: row.source_reflection_id ?? undefined,
    sourceSessionId: row.source_session_id ?? undefined,
    createdAt: row.created_at,
    lastUsed: row.last_used,
    usageCount: row.usage_count,
  };
}
