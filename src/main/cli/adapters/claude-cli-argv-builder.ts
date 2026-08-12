/**
 * Claude CLI argv construction — extracted from `ClaudeCliAdapter.buildArgs()`
 * (originally ~215 lines inline) so this self-contained "spawnOptions ->
 * process argv" translation is independently testable, matching the pattern
 * used for `context-usage-restore.ts` and
 * `instance-communication-recent-respawn-retry.ts`.
 *
 * No behaviour change from the pre-extraction inline version: every branch,
 * ordering, and log line is preserved verbatim, just re-expressed against an
 * explicit input object instead of adapter `this` state. Callers that already
 * know a value (native-resume eligibility, permission-hook eligibility, the
 * detected CLI version) pass it in precomputed — this module does not
 * duplicate that decision logic.
 */

import { nativeSessionIdInUse } from './claude-transcript-registry';
import { buildDeferPermissionHookCommand } from '../hooks/hook-path-resolver';
import { HOST_CLI_CLOUD_SCHEDULER_TOOLS } from './host-cli-tool-policy';
import { EXCLUDE_DYNAMIC_SECTIONS_FLAG } from './claude-cli-feature-probes';
import { getLogger } from '../../logging/logger';
import type {
  ClaudeCliReasoningEffort,
  ClaudeCliSpawnOptions,
  UnifiedReasoningEffort,
} from './claude-cli-adapter.types';

const logger = getLogger('ClaudeCliAdapter');

/** Minimum Claude CLI version that supports the `defer` permission decision.
 *  VALIDATED: defer works in CLI 2.1.98. Conservative estimate for first release.
 *  Canonical source — `claude-cli-adapter.ts` re-exports this for its own
 *  `shouldUsePermissionHook()` and for external callers/tests. */
export const DEFER_MIN_VERSION = '2.1.90';

/** Maps the unified reasoning-effort vocabulary onto the Claude CLI's `--effort` values. */
export function mapClaudeReasoningEffort(
  reasoningEffort: UnifiedReasoningEffort | undefined
): ClaudeCliReasoningEffort | undefined {
  switch (reasoningEffort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'xhigh';
    case 'max':
      return 'max';
    default:
      return undefined;
  }
}

/** The subset of spawn options `buildClaudeSettingsOverlay` reads. */
export type ClaudeSettingsOverlaySpawnOptions = Pick<
  ClaudeCliSpawnOptions,
  'reasoningEffort' | 'fastMode' | 'permissionHookPath'
>;

export function buildClaudeSettingsOverlay(
  spawnOptions: ClaudeSettingsOverlaySpawnOptions,
  permissionHookEnabled: boolean
): string | undefined {
  const settings: {
    ultracode?: true;
    fastMode?: true;
    hooks?: {
      PreToolUse: {
        matcher: string;
        hooks: {
          type: 'command';
          command: string;
        }[];
      }[];
    };
  } = {};

  if (spawnOptions.reasoningEffort === 'workflow') {
    settings.ultracode = true;
  }

  // Fast mode (Opus-only, paid-tier): the CLI reads the `fastMode` settings
  // key. Slash-command toggling (`/fast`) is unavailable in print mode (it
  // would reach the model as plain text), so the settings overlay is the only
  // programmatic surface. If the account can't honor it the CLI emits a "fast
  // mode unavailable" notice on the output stream (auto-reverted by lifecycle).
  if (spawnOptions.fastMode) {
    settings.fastMode = true;
  }

  if (permissionHookEnabled && spawnOptions.permissionHookPath) {
    settings.hooks = {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{
          type: 'command',
          command: buildDeferPermissionHookCommand(spawnOptions.permissionHookPath),
        }],
      }],
    };
  }

  return Object.keys(settings).length > 0 ? JSON.stringify(settings) : undefined;
}

export interface BuildClaudeCliArgsInput {
  spawnOptions: ClaudeCliSpawnOptions;
  sessionId: string | null;
  /** Whether THIS CLI binary accepts `--exclude-dynamic-system-prompt-sections`. */
  excludeDynamicSectionsSupported: boolean | null;
  /** Detected CLI version, or null if not yet probed. */
  cliVersion: string | null;
  disallowedToolsOverride: readonly string[] | null;
  /** Precomputed by the adapter (`shouldUseNativeResume()`) — depends on transcript lookup. */
  shouldUseNativeResume: boolean;
  /** Precomputed by the adapter (`shouldUsePermissionHook()`) — depends on CLI version gating. */
  shouldUsePermissionHook: boolean;
  /**
   * Materializes an inline-JSON arg to a temp-file path on Windows (no-op on
   * POSIX). Injected so this module stays free of the adapter's temp-file
   * lifecycle state.
   */
  materializeInlineJsonArg: (value: string) => string;
}

export function buildClaudeCliArgs(input: BuildClaudeCliArgsInput): string[] {
  const { spawnOptions, sessionId, materializeInlineJsonArg } = input;
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose'
  ];

  // Bare mode — skip hooks, LSP, plugins, auto-memory for faster startup (~14%).
  // Requires explicit ANTHROPIC_API_KEY; OAuth/keychain auth is skipped.
  if (spawnOptions.bare) {
    args.push('--bare');
  }

  // Session display name — makes /resume and debugging easier
  if (spawnOptions.name) {
    args.push('--name', spawnOptions.name);
  }

  // Move per-machine dynamic sections from system prompt to first user message
  // for better cross-instance prompt cache hit rates. Only pass the flag to a CLI
  // that actually supports it (detected from --help in primeCliVersion); an older
  // CLI — e.g. on a remote worker node — rejects the unknown option and the spawn
  // fails. Strict `=== true`: omit when support is unconfirmed (safe — just loses
  // the optimization). Live-verified against a Windows worker (2026-06-03).
  if (spawnOptions.excludeDynamicSystemPromptSections
      && input.excludeDynamicSectionsSupported === true) {
    args.push(EXCLUDE_DYNAMIC_SECTIONS_FLAG);
  }

  const permissionHookEnabled = !spawnOptions.yoloMode && input.shouldUsePermissionHook;

  // YOLO mode - auto-approve all permissions
  if (spawnOptions.yoloMode) {
    logger.warn('YOLO mode enabled for Claude CLI instance', {
      sessionId,
      model: spawnOptions.model
    });
    args.push('--dangerously-skip-permissions');
  } else {
    // Use acceptEdits mode to auto-approve file operations (Read, Write, Edit, etc.)
    // while still requiring approval for potentially dangerous operations like Bash
    logger.debug('NON-YOLO mode: using --permission-mode acceptEdits');
    args.push('--permission-mode', 'acceptEdits');

    // Layer defer hook on top for tools that acceptEdits doesn't auto-approve.
    // The hook intercepts matched tools (Bash, etc.) and returns `defer` to pause
    // execution, allowing the orchestrator to surface approval UI.
    // VALIDATED: --permission-mode and PreToolUse hooks work simultaneously.
    if (!permissionHookEnabled && spawnOptions.permissionHookPath && input.cliVersion) {
      logger.info('Skipping defer permission hook for unsupported Claude CLI version', {
        version: input.cliVersion,
        minimumVersion: DEFER_MIN_VERSION,
        sessionId,
      });
    }

    // Only pass --allowedTools if explicitly configured (e.g., by agent profiles).
    // By default, allow all tools — restrictions are handled via --disallowedTools.
    if (spawnOptions.allowedTools && spawnOptions.allowedTools.length > 0) {
      args.push('--allowedTools', spawnOptions.allowedTools.join(','));
    }
  }

  const settingsOverlay = buildClaudeSettingsOverlay(spawnOptions, permissionHookEnabled);
  if (settingsOverlay) {
    args.push('--settings', materializeInlineJsonArg(settingsOverlay));
  }

  if (input.shouldUseNativeResume) {
    args.push('--resume', sessionId!);
    // Fork session creates a new session ID while preserving conversation history
    if (spawnOptions.forkSession) {
      args.push('--fork-session');
    }
  } else if (sessionId) {
    // B7: resume was requested but the transcript is missing for this cwd/id —
    // start a fresh session under the same id rather than failing on --resume.
    // Upstream replay re-seeds conversation context.
    if (spawnOptions.resume) {
      logger.info('Skipping --resume: no transcript for session under current cwd', {
        sessionId,
        cwd: spawnOptions.workingDirectory,
      });
    }
    // Reusing the id is only safe while the CLI has never minted it. When it
    // has (a transcript we can't resume from under this cwd), passing it is a
    // guaranteed exit-1; let the CLI assign a fresh id instead — the adapter
    // adopts the authoritative one from the init message either way.
    if (nativeSessionIdInUse(sessionId)) {
      logger.info('Skipping --session-id: id already in use by an unreachable transcript', {
        sessionId,
        cwd: spawnOptions.workingDirectory,
      });
    } else {
      args.push('--session-id', sessionId);
    }
  }

  if (spawnOptions.model) {
    args.push('--model', spawnOptions.model);
  }

  // WS14: automatic overload fallback. Never pass a fallback equal to the
  // primary — the CLI rejects that pairing.
  if (spawnOptions.fallbackModel && spawnOptions.fallbackModel !== spawnOptions.model) {
    args.push('--fallback-model', spawnOptions.fallbackModel);
  }

  // WS14: structured output for one-shot utility calls (review verdicts).
  if (spawnOptions.jsonSchema) {
    args.push('--json-schema', materializeInlineJsonArg(spawnOptions.jsonSchema));
  }

  const mappedReasoningEffort = mapClaudeReasoningEffort(spawnOptions.reasoningEffort);
  if (mappedReasoningEffort) {
    args.push('--effort', mappedReasoningEffort);
  }

  if (spawnOptions.maxTokens) {
    args.push('--max-tokens', spawnOptions.maxTokens.toString());
  }

  // Agentic-turn backstop. Bounds runaway sessions (outer caps bound
  // iterations/wall-clock, not turns within a single print-mode run).
  if (spawnOptions.maxTurns && spawnOptions.maxTurns > 0) {
    args.push('--max-turns', spawnOptions.maxTurns.toString());
  }

  // Only add user-specified allowedTools if in YOLO mode (already handled above for non-YOLO)
  if (
    spawnOptions.yoloMode &&
    spawnOptions.allowedTools &&
    spawnOptions.allowedTools.length > 0
  ) {
    args.push('--allowedTools', spawnOptions.allowedTools.join(','));
  }

  // Always deny the host CLI's cloud-scheduler tools, merged with any caller-supplied
  // denylist and deduped. Enforced here — the single chokepoint every process launch
  // (cold, warm-start, resume, replay, continuity-recovery) passes through — so the
  // guarantee holds even for spawn paths that don't wire `disallowedTools` (e.g. a
  // consumed warm-start adapter whose spawnOptions only carry the working directory).
  const disallowedTools = Array.from(
    new Set<string>([
      ...HOST_CLI_CLOUD_SCHEDULER_TOOLS,
      ...(spawnOptions.disallowedTools ?? []),
      // D2 (#6): transient per-send override (loop cap wrap-up tools-disable).
      ...(input.disallowedToolsOverride ?? []),
    ]),
  );
  if (disallowedTools.length > 0) {
    args.push('--disallowedTools', disallowedTools.join(','));
  }

  // Don't pass system prompt when resuming - the session already has one
  // and Claude CLI doesn't support changing it mid-session.
  // Default is APPEND: `--system-prompt` REPLACES Claude Code's entire default
  // system prompt (tool guidance, safety, todo machinery) and also disables
  // --exclude-dynamic-system-prompt-sections. Our orchestration prompt and
  // agent profiles are written as overlays (agent.types.ts documents
  // systemPrompt as "to prepend"), so they must ride on top of the default,
  // not supplant it. Only explicit systemPromptMode: 'replace' (minimal
  // one-shot spawns like title generation) uses the replacing flag.
  if (spawnOptions.systemPrompt && !spawnOptions.resume) {
    const flag = spawnOptions.systemPromptMode === 'replace'
      ? '--system-prompt'
      : '--append-system-prompt';
    args.push(flag, spawnOptions.systemPrompt);
  }

  // MCP server configurations (file paths or inline JSON strings). On Windows
  // inline JSON is materialized to a temp file path — see materializeInlineJsonArg.
  if (spawnOptions.mcpConfig && spawnOptions.mcpConfig.length > 0) {
    args.push(
      '--mcp-config',
      ...spawnOptions.mcpConfig.map((entry) => materializeInlineJsonArg(entry)),
    );
  }

  // Beta headers (API key users only) — e.g. context-1m-2025-08-07
  if (spawnOptions.betas && spawnOptions.betas.length > 0) {
    args.push('--betas', ...spawnOptions.betas);
  }

  if (spawnOptions.chrome === true) {
    args.push('--chrome');
  }

  logger.debug('buildArgs complete', {
    yoloMode: spawnOptions.yoloMode,
    argCount: args.length,
    resume: spawnOptions.resume ?? false,
    forkSession: spawnOptions.forkSession ?? false,
    model: spawnOptions.model,
    reasoningEffort: spawnOptions.reasoningEffort ?? null,
    mappedReasoningEffort: mappedReasoningEffort ?? null,
    hasSystemPrompt: Boolean(spawnOptions.systemPrompt && !spawnOptions.resume),
    allowedToolsCount: spawnOptions.allowedTools?.length ?? 0,
    disallowedToolsCount: spawnOptions.disallowedTools?.length ?? 0,
    mcpConfigCount: spawnOptions.mcpConfig?.length ?? 0,
    betasCount: spawnOptions.betas?.length ?? 0,
    chrome: spawnOptions.chrome ?? 'unset',
    bare: spawnOptions.bare ?? false,
    name: spawnOptions.name ?? null,
    excludeDynamicSystemPromptSections: spawnOptions.excludeDynamicSystemPromptSections ?? false,
    hasPermissionHook: input.shouldUsePermissionHook,
    hookPathConfigured: Boolean(spawnOptions.permissionHookPath),
    cliVersion: input.cliVersion ?? null,
  });

  return args;
}
