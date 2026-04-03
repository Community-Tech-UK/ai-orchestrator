/**
 * Orchestrator Tool Registry
 *
 * Loads user/project tools from JS modules and executes them with Zod validation.
 * This is a local implementation inspired by common agent/tool ecosystems, but
 * fully owned by this codebase.
 *
 * Tool locations (global + per-working-directory):
 * - `~/.orchestrator/tools/**.js`
 * - `~/.claude/tools/**.js`
 * - `~/.opencode/tools/**.js`
 * - `<cwd>/.orchestrator/tools/**.js`
 * - `<cwd>/.claude/tools/**.js`
 * - `<cwd>/.opencode/tools/**.js`
 *
 * Tool module contract (CommonJS recommended):
 * - `module.exports = { description, args, execute }`
 * - `description: string`
 * - `args: ZodRawShape | ZodObject` (optional, defaults to empty object)
 * - `execute(args, ctx): Promise<any> | any`
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import z from 'zod';
import { fork } from 'child_process';
import type { ToolSafetyMetadata } from '../../shared/types/tool.types';

export type { ToolSafetyMetadata } from '../../shared/types/tool.types';

export interface ToolContext {
  instanceId: string;
  workingDirectory: string;
}

export interface ToolModule {
  description: string;
  args?: z.ZodRawShape | z.ZodTypeAny;
  /** Whether this tool can run concurrently with other tools (default: true) */
  concurrencySafe?: boolean;
  /** Richer safety metadata — takes precedence over concurrencySafe when present */
  safety?: ToolSafetyMetadata;
  execute: (args: any, ctx: ToolContext) => unknown | Promise<unknown>;
}

/**
 * Return safety metadata for a tool, falling back to legacy concurrencySafe
 * flag for backward compatibility with tools that predate the richer metadata.
 */
export function getToolSafety(tool: ToolModule): ToolSafetyMetadata {
  if (tool.safety) return tool.safety;
  return {
    isConcurrencySafe: tool.concurrencySafe ?? true,
    isReadOnly: false,
    isDestructive: false,
  };
}

interface LoadedTool {
  id: string;
  description: string;
  filePath: string;
  schema: z.ZodTypeAny;
  concurrencySafe: boolean;
}

interface CacheEntry {
  loadedAt: number;
  toolsById: Map<string, LoadedTool>;
  candidatesById: Map<string, LoadedTool[]>;
  scanDirs: string[];
  errors: Array<{ filePath: string; error: string }>;
}

const CACHE_TTL_MS = 10_000;

export class ToolRegistry extends EventEmitter {
  private static instance: ToolRegistry | null = null;
  private cacheByWorkingDir = new Map<string, CacheEntry>();

  static getInstance(): ToolRegistry {
    if (!ToolRegistry.instance) {
      ToolRegistry.instance = new ToolRegistry();
    }
    return ToolRegistry.instance;
  }

  static _resetForTesting(): void {
    ToolRegistry.instance = null;
  }

  private constructor() {
    super();
  }

  private getHomeDir(): string | null {
    try {
      return app.getPath('home');
    } catch {
      return process.env['HOME'] || process.env['USERPROFILE'] || null;
    }
  }

  private getScanRoots(workingDirectory: string): string[] {
    const home = this.getHomeDir();
    const roots: string[] = [];
    if (home) roots.push(home);
    roots.push(workingDirectory);
    return roots;
  }

  private getToolDirs(root: string): string[] {
    return [
      path.join(root, '.orchestrator', 'tools'),
      path.join(root, '.claude', 'tools'),
      path.join(root, '.opencode', 'tools'),
    ];
  }

  private getAllScanDirs(workingDirectory: string): string[] {
    const dirs: string[] = [];
    for (const root of this.getScanRoots(workingDirectory)) {
      dirs.push(...this.getToolDirs(root));
    }
    return dirs;
  }

  private async walkJsFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const stack: string[] = [dir];

    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: Array<import('fs').Dirent>;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          stack.push(full);
          continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.js')) {
          out.push(full);
        }
      }
    }
    return out;
  }

  private deriveToolId(toolDir: string, filePath: string): string {
    const rel = path.relative(toolDir, filePath);
    const withoutExt = rel.replace(/\.js$/i, '');
    return withoutExt.split(path.sep).filter(Boolean).join(':');
  }

  private loadModule(filePath: string): ToolModule {
    // Clear require cache so edits are picked up quickly.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      delete require.cache[require.resolve(filePath)];
    } catch {
      /* intentionally ignored: require.resolve may fail for some module paths */
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(filePath);
    const def: ToolModule = (mod && (mod.default || mod)) as ToolModule;
    return def;
  }

  private toLoadedTool(toolId: string, filePath: string, def: ToolModule): LoadedTool | null {
    if (!def || typeof def !== 'object') return null;
    if (typeof def.description !== 'string') return null;
    if (typeof def.execute !== 'function') return null;

    let schema: z.ZodTypeAny;
    if (!def.args) {
      schema = z.object({});
    } else if (def.args instanceof z.ZodType) {
      schema = def.args;
    } else {
      schema = z.object(def.args as z.ZodRawShape);
    }

    return {
      id: toolId,
      description: def.description,
      filePath,
      schema,
      concurrencySafe: def.concurrencySafe !== false, // Default true
    };
  }

  private async loadToolsForWorkingDirectory(workingDirectory: string): Promise<Map<string, LoadedTool>> {
    const toolsById = new Map<string, LoadedTool>();
    const candidatesById = new Map<string, LoadedTool[]>();
    const errors: Array<{ filePath: string; error: string }> = [];

    // Low-to-high priority; later wins.
    const roots = this.getScanRoots(workingDirectory);
    for (const root of roots) {
      const dirs = this.getToolDirs(root);
      for (const toolDir of dirs) {
        const files = await this.walkJsFiles(toolDir);
        for (const filePath of files) {
          const id = this.deriveToolId(toolDir, filePath);
          try {
            const def = this.loadModule(filePath);
            const loaded = this.toLoadedTool(id, filePath, def);
            if (loaded) {
              const existing = candidatesById.get(id) || [];
              existing.push(loaded);
              candidatesById.set(id, existing);
              toolsById.set(id, loaded);
            }
          } catch (e) {
            errors.push({
              filePath,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
    }

    const scanDirs = this.getAllScanDirs(workingDirectory);
    this.cacheByWorkingDir.set(workingDirectory, { loadedAt: Date.now(), toolsById, candidatesById, scanDirs, errors });
    return toolsById;
  }

  private async getTools(workingDirectory: string): Promise<Map<string, LoadedTool>> {
    const cached = this.cacheByWorkingDir.get(workingDirectory);
    const now = Date.now();
    if (cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.toolsById;

    const toolsById = await this.loadToolsForWorkingDirectory(workingDirectory);
    // loadToolsForWorkingDirectory sets cache.
    return toolsById;
  }

  async listTools(workingDirectory: string): Promise<{
    tools: Array<{ id: string; description: string; filePath: string }>;
    candidatesById: Record<string, Array<{ id: string; description: string; filePath: string }>>;
    scanDirs: string[];
    errors: Array<{ filePath: string; error: string }>;
  }> {
    const cached = this.cacheByWorkingDir.get(workingDirectory);
    const now = Date.now();
    if (!cached || now - cached.loadedAt >= CACHE_TTL_MS) {
      await this.loadToolsForWorkingDirectory(workingDirectory);
    }
    const entry = this.cacheByWorkingDir.get(workingDirectory)!;

    const tools = Array.from(entry.toolsById.values())
      .map((t) => ({ id: t.id, description: t.description, filePath: t.filePath }))
      .sort((a, b) => a.id.localeCompare(b.id));

    const candidatesById: Record<string, Array<{ id: string; description: string; filePath: string }>> = {};
    for (const [id, list] of entry.candidatesById.entries()) {
      candidatesById[id] = list.map((t) => ({ id: t.id, description: t.description, filePath: t.filePath }));
    }

    return { tools, candidatesById, scanDirs: entry.scanDirs.slice(), errors: entry.errors.slice() };
  }

  async callTool(params: {
    toolId: string;
    args?: unknown;
    ctx: ToolContext;
  }): Promise<{ ok: boolean; output: unknown; tool?: { id: string; description: string; filePath: string } }> {
    const tools = await this.getTools(params.ctx.workingDirectory);
    const tool = tools.get(params.toolId);
    if (!tool) {
      return { ok: false, output: { error: `Tool not found: ${params.toolId}` } };
    }

    const parsed = tool.schema.safeParse(params.args ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        output: { error: 'Invalid tool arguments', issues: parsed.error.issues },
        tool: { id: tool.id, description: tool.description, filePath: tool.filePath },
      };
    }

    const result = await this.runToolInChildProcess({
      toolFilePath: tool.filePath,
      args: parsed.data,
      ctx: params.ctx,
      timeoutMs: 30_000,
      maxOldSpaceMb: 256,
    });

    if (!result.ok) {
      return {
        ok: false,
        output: { error: result.error },
        tool: { id: tool.id, description: tool.description, filePath: tool.filePath },
      };
    }

    return {
      ok: true,
      output: result.output,
      tool: { id: tool.id, description: tool.description, filePath: tool.filePath },
    };
  }

  private async runToolInChildProcess(params: {
    toolFilePath: string;
    args: unknown;
    ctx: ToolContext;
    timeoutMs: number;
    maxOldSpaceMb: number;
  }): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
    // tool-registry.js lives in dist/main/tools; child script compiles alongside.
    const childScript = path.join(__dirname, 'tool-runner-child.js');

    return await new Promise((resolve) => {
      const child = fork(childScript, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: [`--max-old-space-size=${params.maxOldSpaceMb}`],
      });

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve({ ok: false, error: 'Tool execution timed out' });
      }, params.timeoutMs);

      const progressHandler = (msg: any) => {
        if (msg && msg.type === 'progress') {
          // Forward to caller — stored for streaming executor
          this.emit('tool:progress', {
            toolFilePath: params.toolFilePath,
            message: msg.message,
            timestamp: msg.timestamp,
          });
          return;
        }
        // Final result
        clearTimeout(timer);
        child.off('message', progressHandler);
        try { child.kill(); } catch { /* ignore */ }
        if (msg && msg.ok === true) {
          resolve({ ok: true, output: msg.output });
          return;
        }
        resolve({ ok: false, error: msg?.error ? String(msg.error) : 'Tool execution failed' });
      };

      child.on('message', progressHandler);

      child.once('error', (err) => {
        clearTimeout(timer);
        try { child.kill(); } catch { /* ignore */ }
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });

      try {
        child.send({
          toolFilePath: params.toolFilePath,
          args: params.args,
          ctx: params.ctx,
        });
      } catch (e) {
        clearTimeout(timer);
        try { child.kill(); } catch { /* ignore */ }
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  clearCache(workingDirectory?: string): void {
    if (!workingDirectory) {
      this.cacheByWorkingDir.clear();
      return;
    }
    this.cacheByWorkingDir.delete(workingDirectory);
  }
}

let toolRegistry: ToolRegistry | null = null;
export function getToolRegistry(): ToolRegistry {
  if (!toolRegistry) toolRegistry = ToolRegistry.getInstance();
  return toolRegistry;
}

export function _resetToolRegistryForTesting(): void {
  toolRegistry = null;
  ToolRegistry._resetForTesting();
}
