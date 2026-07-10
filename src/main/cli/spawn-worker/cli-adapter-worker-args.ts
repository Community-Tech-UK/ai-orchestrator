import type { UnifiedSpawnOptions } from '../adapters/adapter-factory';
import type { CliMessage } from '../adapters/base-cli-adapter';
import { HOST_CLI_CLOUD_SCHEDULER_TOOLS } from '../adapters/host-cli-tool-policy';
import { wrapRtkAwareness } from '../rtk/rtk-awareness';

function quoteHookArg(hookPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `"${hookPath.replace(/"/g, '""')}"`;
  }
  return `'${hookPath.replace(/'/g, `'\\''`)}'`;
}

function buildDeferPermissionHookCommand(hookPath: string): string {
  return `node ${quoteHookArg(hookPath)}`;
}

export function buildWorkerArgs(
  cliType: 'claude' | 'gemini',
  options: UnifiedSpawnOptions,
  sessionId: string | null,
  message: CliMessage,
  state: { includeGeminiRtkAwareness?: boolean } = {},
): string[] {
  return cliType === 'claude'
    ? buildClaudeArgs(options, sessionId)
    : buildGeminiArgs(options, message, state.includeGeminiRtkAwareness === true);
}

function buildClaudeArgs(options: UnifiedSpawnOptions, sessionId: string | null): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];
  if (options.bare) args.push('--bare');
  if (options.name) args.push('--name', options.name);
  if (options.yoloMode) {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', 'acceptEdits');
    if (options.allowedTools?.length) args.push('--allowedTools', options.allowedTools.join(','));
  }
  if (options.resume && sessionId) {
    args.push('--resume', sessionId);
    if (options.forkSession) args.push('--fork-session');
  } else if (sessionId) {
    args.push('--session-id', sessionId);
  }
  if (options.model) args.push('--model', options.model);
  const effort = mapClaudeReasoningEffort(options.reasoningEffort);
  if (effort) args.push('--effort', effort);
  if (options.yoloMode && options.allowedTools?.length) {
    args.push('--allowedTools', options.allowedTools.join(','));
  }
  const disallowedTools = Array.from(new Set([...HOST_CLI_CLOUD_SCHEDULER_TOOLS, ...(options.disallowedTools ?? [])]));
  if (disallowedTools.length > 0) args.push('--disallowedTools', disallowedTools.join(','));
  // Append by default — `--system-prompt` would REPLACE Claude Code's entire
  // default system prompt; our prompts are overlays (see claude-cli-adapter.ts).
  if (options.systemPrompt && !options.resume) {
    const flag = options.systemPromptMode === 'replace' ? '--system-prompt' : '--append-system-prompt';
    args.push(flag, options.systemPrompt);
  }
  const settingsOverlay = buildClaudeSettingsOverlay(options);
  if (settingsOverlay) args.push('--settings', settingsOverlay);
  if (options.mcpConfig?.length) args.push('--mcp-config', ...options.mcpConfig);
  if (options.chrome === true) args.push('--chrome');
  return args;
}

function buildClaudeSettingsOverlay(options: UnifiedSpawnOptions): string | undefined {
  const settings: {
    ultracode?: true;
    hooks?: {
      PreToolUse: {
        matcher: string;
        hooks: { type: 'command'; command: string }[];
      }[];
    };
  } = {};
  if (options.reasoningEffort === 'workflow') {
    settings.ultracode = true;
  }
  if (!options.yoloMode && options.permissionHookPath) {
    settings.hooks = {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{
          type: 'command',
          command: buildDeferPermissionHookCommand(options.permissionHookPath),
        }],
      }],
    };
  }
  return Object.keys(settings).length > 0 ? JSON.stringify(settings) : undefined;
}

function mapClaudeReasoningEffort(
  effort: UnifiedSpawnOptions['reasoningEffort'],
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return effort;
    default:
      return undefined;
  }
}

function buildGeminiArgs(
  options: UnifiedSpawnOptions,
  message: CliMessage,
  includeRtkAwareness: boolean,
): string[] {
  const args: string[] = [];
  if (options.model) args.push('--model', options.model);
  args.push('--output-format', 'stream-json');
  if (options.yoloMode ?? true) args.push('--yolo');
  if (message.content) {
    const promptParts: string[] = [];
    const systemPrompt = options.systemPrompt?.trim();
    if (systemPrompt) {
      promptParts.push(`[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n[/SYSTEM INSTRUCTIONS]`);
    }
    if (includeRtkAwareness && options.rtk?.enabled && options.rtk.binaryPath) {
      promptParts.push(wrapRtkAwareness());
    }
    promptParts.push(message.content);
    // The explicit separator prevents a leading-dash prompt from being parsed
    // as another Gemini CLI option.
    args.push('--', promptParts.join('\n\n'));
  }
  return args;
}
