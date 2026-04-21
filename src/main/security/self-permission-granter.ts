/**
 * SelfPermissionGranter — Writes permission rules to the user's Claude CLI
 * settings file (`~/.claude/settings.json`).
 *
 * Context:
 *   Claude CLI has an internal guard for its own config files that
 *   `--dangerously-skip-permissions` (YOLO mode) does NOT bypass. When Claude
 *   tries to modify `~/.claude/settings*.json`, the CLI refuses with a
 *   tool_result error ("Claude requested permissions to write to … but you
 *   haven't granted it yet.").
 *
 *   The documented escape hatch is to add an allow-rule to `permissions.allow`
 *   in `~/.claude/settings.json`. The rule is picked up at CLI startup, so
 *   after writing the rule the instance must be respawned (`--resume`).
 *
 * Responsibilities:
 *   - Parse existing `~/.claude/settings.json` (or create it if missing)
 *   - Append a rule to `permissions.allow`, preserving every other field
 *   - Deduplicate — idempotent for the same (tool, pattern)
 *   - Refuse to overwrite malformed JSON (returns an error result)
 *   - Atomic write (tmp file + rename)
 *   - Append to an audit log so the user can review what was granted
 *
 * Not a replacement for PermissionManager — this writes to the CLI's own
 * config, not the orchestrator's permissions.json. PermissionManager still
 * records the orchestrator-side decision via `recordUserDecision()`.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getLogger } from '../logging/logger';

const logger = getLogger('SelfPermissionGranter');

// Claude CLI permission tool names we map to. Keep this conservative —
// unknown CLI actions fall back to the most-specific file tool when a path
// is present, or fail-closed when nothing sensible can be written.
export type ClaudeCliToolName = 'Write' | 'Edit' | 'Read' | 'Bash';

export interface GrantInput {
  /**
   * The CLI action reported in the permission denial (e.g. 'write', 'edit',
   * 'modify', 'read', 'bash'). Case-insensitive. If the original tool name
   * is available (e.g. 'Edit'), pass it via `toolName` for an authoritative
   * mapping.
   */
  action?: string;
  /**
   * Canonical Claude CLI tool name, when the caller already knows it
   * (typically from the `tool_use` that was denied). Preferred over `action`.
   */
  toolName?: string;
  /**
   * Absolute file path the CLI was denied access to. Required for Write/Edit/Read.
   * For Bash, this is the raw command.
   */
  path?: string;
  /**
   * When true, write a tree-scoped rule (e.g. `Edit(/dir/**)`) instead of an
   * exact-path rule. Default: false (user's answer: "just this file").
   */
  scopeTree?: boolean;
  /** For audit logging. */
  instanceId?: string;
  /** For audit logging. */
  requestId?: string;
}

export type GrantOutcome =
  | {
      ok: true;
      /** The pattern string that now lives in `permissions.allow`. */
      rulePattern: string;
      /** Absolute path to the settings file that was updated. */
      settingsFile: string;
      /**
       * True when the rule was already present — the file was not modified,
       * but the grant is still considered successful (idempotent).
       */
      alreadyExisted: boolean;
    }
  | {
      ok: false;
      /** A short, user-safe error code. */
      code:
        | 'NO_HOME_DIR'
        | 'SETTINGS_UNREADABLE'
        | 'SETTINGS_INVALID_JSON'
        | 'SETTINGS_NOT_OBJECT'
        | 'WRITE_FAILED'
        | 'UNSUPPORTED_ACTION';
      message: string;
      /** Path we attempted to touch, when relevant. */
      settingsFile?: string;
    };

export interface GrantAuditEntry {
  timestamp: string;
  instanceId?: string;
  requestId?: string;
  toolName: ClaudeCliToolName;
  rulePattern: string;
  path?: string;
  settingsFile: string;
  alreadyExisted: boolean;
}

export interface SelfPermissionGranterOptions {
  /**
   * Override the settings file path. Default: `<home>/.claude/settings.json`.
   */
  settingsFile?: string;
  /**
   * Override the audit log path. Default:
   *   <userData>/self-permission-audit.log when Electron is available,
   *   otherwise <home>/.ai-orchestrator/self-permission-audit.log.
   */
  auditLogFile?: string;
  /**
   * Override the home-directory resolver (useful for tests).
   */
  homeDirProvider?: () => string | null;
}

// ---------- Action → ToolName mapping ------------------------------------

const ACTION_MAP: Record<string, ClaudeCliToolName> = {
  // Writes / creates
  write: 'Write',
  create: 'Write',
  new: 'Write',
  add: 'Write',
  // Edits / modifications
  edit: 'Edit',
  modify: 'Edit',
  update: 'Edit',
  change: 'Edit',
  overwrite: 'Edit',
  replace: 'Edit',
  patch: 'Edit',
  // Reads
  read: 'Read',
  view: 'Read',
  open: 'Read',
  load: 'Read',
  // Bash
  bash: 'Bash',
  execute: 'Bash',
  run: 'Bash',
  command: 'Bash',
  shell: 'Bash',
};

/** Prefer `toolName` when it's a recognized Claude CLI tool name. */
function resolveToolName(input: GrantInput): ClaudeCliToolName | null {
  if (input.toolName) {
    const normalized = input.toolName.trim();
    if (['Write', 'Edit', 'Read', 'Bash'].includes(normalized)) {
      return normalized as ClaudeCliToolName;
    }
    // Lowercase version — fall through the action map
    const lower = normalized.toLowerCase();
    if (lower in ACTION_MAP) return ACTION_MAP[lower]!;
  }
  if (input.action) {
    const lower = input.action.trim().toLowerCase();
    if (lower in ACTION_MAP) return ACTION_MAP[lower]!;
  }
  // No authoritative mapping. If we still have a path, best-effort "Edit".
  if (input.path && input.path.includes('/')) return 'Edit';
  return null;
}

// ---------- Settings file I/O --------------------------------------------

/**
 * Subset of the Claude CLI settings schema we touch. Unknown fields are
 * preserved via `Record<string, unknown>` spread — we never remove anything.
 */
interface SettingsShape extends Record<string, unknown> {
  permissions?: {
    allow?: unknown;
    // Unknown subfields (deny, ask, defaultMode, …) are preserved verbatim.
    [key: string]: unknown;
  };
}

// ---------- Rule pattern construction ------------------------------------

function buildRulePattern(
  tool: ClaudeCliToolName,
  target: string | undefined,
  scopeTree: boolean,
): string {
  if (!target) {
    // Tool-only rule (e.g. allow all Bash) — unusual, log-worthy.
    return tool;
  }
  const trimmed = target.trim();
  if (tool === 'Bash') {
    // Bash patterns are command strings; we never apply scopeTree.
    return `${tool}(${trimmed})`;
  }
  if (scopeTree) {
    const dir = path.dirname(trimmed);
    return `${tool}(${dir}/**)`;
  }
  return `${tool}(${trimmed})`;
}

// ---------- Granter -------------------------------------------------------

export class SelfPermissionGranter extends EventEmitter {
  private readonly opts: SelfPermissionGranterOptions;
  private auditLogFailed = false;

  constructor(options: SelfPermissionGranterOptions = {}) {
    super();
    this.opts = options;
  }

  /**
   * Apply (or confirm) a permission rule in `~/.claude/settings.json`.
   *
   * Always returns a structured result — never throws for expected failure
   * modes (missing home dir, malformed JSON, write failure). Callers should
   * surface `result.message` to the user when `ok === false`.
   */
  grant(input: GrantInput): GrantOutcome {
    const tool = resolveToolName(input);
    if (!tool) {
      return {
        ok: false,
        code: 'UNSUPPORTED_ACTION',
        message: `Cannot derive a Claude CLI tool from action='${input.action ?? ''}' toolName='${input.toolName ?? ''}'`,
      };
    }

    const settingsFile = this.resolveSettingsFile();
    if (!settingsFile) {
      return {
        ok: false,
        code: 'NO_HOME_DIR',
        message: 'Could not locate the user home directory to read ~/.claude/settings.json',
      };
    }

    const rulePattern = buildRulePattern(tool, input.path, input.scopeTree === true);

    const parsedResult = this.readSettings(settingsFile);
    if (!parsedResult.ok) {
      return { ...parsedResult, settingsFile };
    }

    const settings = parsedResult.data;
    const existingAllow = this.readAllowArray(settings);

    if (existingAllow.includes(rulePattern)) {
      logger.info('Rule already present in settings.json — skipping write', {
        settingsFile,
        rulePattern,
      });
      this.writeAuditEntry({
        timestamp: new Date().toISOString(),
        instanceId: input.instanceId,
        requestId: input.requestId,
        toolName: tool,
        rulePattern,
        path: input.path,
        settingsFile,
        alreadyExisted: true,
      });
      return { ok: true, rulePattern, settingsFile, alreadyExisted: true };
    }

    const nextAllow = [...existingAllow, rulePattern];
    const nextSettings: SettingsShape = {
      ...settings,
      permissions: {
        ...(settings.permissions ?? {}),
        allow: nextAllow,
      },
    };

    const writeResult = this.writeSettings(settingsFile, nextSettings);
    if (!writeResult.ok) {
      return { ...writeResult, settingsFile };
    }

    this.writeAuditEntry({
      timestamp: new Date().toISOString(),
      instanceId: input.instanceId,
      requestId: input.requestId,
      toolName: tool,
      rulePattern,
      path: input.path,
      settingsFile,
      alreadyExisted: false,
    });

    this.emit('grant', {
      rulePattern,
      settingsFile,
      toolName: tool,
      path: input.path,
      instanceId: input.instanceId,
      requestId: input.requestId,
    });

    logger.info('Added permission rule to settings.json', {
      settingsFile,
      rulePattern,
    });
    return { ok: true, rulePattern, settingsFile, alreadyExisted: false };
  }

  // ---------- internals ----------

  private resolveSettingsFile(): string | null {
    if (this.opts.settingsFile) return this.opts.settingsFile;
    const home = this.resolveHomeDir();
    if (!home) return null;
    return path.join(home, '.claude', 'settings.json');
  }

  private resolveHomeDir(): string | null {
    if (this.opts.homeDirProvider) {
      try {
        return this.opts.homeDirProvider();
      } catch {
        return null;
      }
    }
    // Prefer Electron's app.getPath('home') when available (packaged apps
    // with customized HOME semantics). Fall back to os.homedir() for tests
    // and for the main process before Electron is ready.
    try {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { app } = require('electron') as { app?: { getPath?: (name: string) => string } };
      if (app?.getPath) return app.getPath('home');
      /* eslint-enable @typescript-eslint/no-require-imports */
    } catch {
      /* intentionally ignored: Electron is not available (tests, bare Node) */
    }
    try {
      return os.homedir() || null;
    } catch {
      return null;
    }
  }

  private readSettings(
    settingsFile: string,
  ):
    | { ok: true; data: SettingsShape }
    | { ok: false; code: 'SETTINGS_UNREADABLE' | 'SETTINGS_INVALID_JSON' | 'SETTINGS_NOT_OBJECT'; message: string } {
    if (!fs.existsSync(settingsFile)) {
      // File absent — start with an empty object, which becomes a minimal
      // `{ permissions: { allow: [...] } }` after write.
      return { ok: true, data: {} };
    }
    let raw: string;
    try {
      raw = fs.readFileSync(settingsFile, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        code: 'SETTINGS_UNREADABLE',
        message: `Could not read settings.json: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (raw.trim().length === 0) {
      return { ok: true, data: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        code: 'SETTINGS_INVALID_JSON',
        message: `settings.json contains invalid JSON — refusing to overwrite. ${err instanceof Error ? err.message : ''}`.trim(),
      };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        code: 'SETTINGS_NOT_OBJECT',
        message: 'settings.json root is not an object — refusing to overwrite.',
      };
    }
    return { ok: true, data: parsed as SettingsShape };
  }

  private readAllowArray(settings: SettingsShape): string[] {
    const permissions = settings.permissions;
    if (!permissions || typeof permissions !== 'object') return [];
    const allow = (permissions as { allow?: unknown }).allow;
    if (!Array.isArray(allow)) return [];
    return allow.filter((entry): entry is string => typeof entry === 'string');
  }

  private writeSettings(
    settingsFile: string,
    nextSettings: SettingsShape,
  ): { ok: true } | { ok: false; code: 'WRITE_FAILED'; message: string } {
    const dir = path.dirname(settingsFile);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        code: 'WRITE_FAILED',
        message: `Could not create ~/.claude directory: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Atomic write: write to a sibling temp file, then rename. This keeps
    // the live settings.json uncorrupted if the process dies mid-write.
    const tmpFile = `${settingsFile}.orchestrator-${process.pid}-${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(nextSettings, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      });
    } catch (err) {
      return {
        ok: false,
        code: 'WRITE_FAILED',
        message: `Could not write temp settings file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      fs.renameSync(tmpFile, settingsFile);
    } catch (err) {
      // Best-effort cleanup
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* intentionally ignored: best-effort cleanup */
      }
      return {
        ok: false,
        code: 'WRITE_FAILED',
        message: `Could not rename temp settings file into place: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { ok: true };
  }

  // ---------- audit log ----------

  private resolveAuditLogFile(): string | null {
    if (this.opts.auditLogFile) return this.opts.auditLogFile;
    try {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { app } = require('electron') as { app?: { getPath?: (name: string) => string } };
      if (app?.getPath) {
        return path.join(app.getPath('userData'), 'self-permission-audit.log');
      }
      /* eslint-enable @typescript-eslint/no-require-imports */
    } catch {
      /* intentionally ignored: Electron not available */
    }
    const home = this.resolveHomeDir();
    if (!home) return null;
    return path.join(home, '.ai-orchestrator', 'self-permission-audit.log');
  }

  private writeAuditEntry(entry: GrantAuditEntry): void {
    const auditFile = this.resolveAuditLogFile();
    if (!auditFile) return;
    try {
      fs.mkdirSync(path.dirname(auditFile), { recursive: true });
      fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      });
      this.auditLogFailed = false;
    } catch (err) {
      // Log once per run to avoid spam — audit failures are non-fatal.
      if (!this.auditLogFailed) {
        this.auditLogFailed = true;
        logger.warn('Failed to append self-permission audit entry', {
          auditFile,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

// ---------- Singleton -----------------------------------------------------

let instance: SelfPermissionGranter | null = null;

export function getSelfPermissionGranter(): SelfPermissionGranter {
  if (!instance) {
    instance = new SelfPermissionGranter();
  }
  return instance;
}

/** Testing only — drops the singleton so the next `getSelfPermissionGranter()` rebuilds. */
export function _resetSelfPermissionGranterForTesting(): void {
  instance = null;
}

/** Testing only — inject a pre-configured instance (e.g. with a temp dir). */
export function _setSelfPermissionGranterForTesting(next: SelfPermissionGranter | null): void {
  instance = next;
}
