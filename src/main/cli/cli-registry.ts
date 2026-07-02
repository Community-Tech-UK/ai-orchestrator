/**
 * CLI registry — static metadata for every AI CLI the app can detect, plus the
 * path-resolution helpers used to locate an install on disk. Kept separate from
 * the detection service so the (large) data table and the pure path logic don't
 * inflate cli-detection.ts.
 */

import { getCliAdditionalPaths } from './cli-environment';

/**
 * CLI type identifiers. `gemini` is a deprecated back-compat alias (persisted
 * data / older remote nodes); its live successor is `antigravity` (the `agy`
 * CLI). Legacy `gemini` is normalized to `antigravity` in mapSettingsToDetectionType.
 */
export type CliType = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'copilot' | 'ollama' | 'cursor';

/** CLIs surfaced in CLI Health. `gemini` is excluded — superseded by `antigravity`. */
export const SUPPORTED_CLIS: CliType[] = ['claude', 'codex', 'antigravity', 'copilot', 'ollama', 'cursor'];

/**
 * Registry entry for a CLI tool
 */
export interface CliRegistryEntry {
  name: string;
  command: string;
  displayName: string;
  versionFlag: string;
  versionPattern: RegExp;
  authCheckFlag?: string;
  authPattern?: RegExp;
  capabilities: string[];
  alternativePaths: string[];
}

/**
 * Registry of known CLI tools - only includes CLIs with provider implementations.
 *
 * `alternativePaths` use two portable, scan-time placeholders (see expandAltPath):
 * a leading `~` for the home dir and `%VAR%` for an env reference. They must NOT
 * bake in `process.env[...]` directly — that resolves at module load, where
 * `HOME` is undefined on Windows and would store the literal string "undefined".
 */
export const CLI_REGISTRY: Record<CliType, CliRegistryEntry> = {
  claude: {
    name: 'claude',
    command: 'claude',
    displayName: 'Claude Code',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: [
      'streaming',
      'tool-use',
      'file-access',
      'shell',
      'multi-turn',
      'vision'
    ],
    alternativePaths: [
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      '~/.local/bin/claude'
    ]
  },
  codex: {
    name: 'codex',
    command: 'codex',
    displayName: 'OpenAI Codex CLI',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: [
      'streaming',
      'tool-use',
      'file-access',
      'shell',
      'multi-turn',
      'code-execution'
    ],
    alternativePaths: [
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      '~/.local/bin/codex'
    ]
  },
  gemini: {
    name: 'gemini',
    command: 'gemini',
    displayName: 'Google Gemini CLI',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: ['streaming', 'tool-use', 'file-access', 'shell', 'multi-turn', 'vision', 'large-context'],
    alternativePaths: [
      '/opt/homebrew/bin/gemini',
      '/usr/local/bin/gemini',
      '~/.local/bin/gemini'
    ]
  },
  antigravity: {
    name: 'antigravity',
    command: 'agy',
    displayName: 'Antigravity',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: ['tool-use', 'file-access', 'shell', 'multi-turn', 'large-context'],
    alternativePaths: [
      '~/.local/bin/agy',
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy'
    ]
  },
  copilot: {
    name: 'copilot',
    command: 'copilot',
    displayName: 'GitHub Copilot',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: [
      'streaming',
      'tool-use',
      'file-access',
      'shell',
      'multi-turn',
      'vision',
      'mcp-servers'
    ],
    alternativePaths: [
      '/opt/homebrew/bin/copilot',
      '/usr/local/bin/copilot',
      '~/.local/bin/copilot',
      '~/.npm-global/bin/copilot'
    ]
  },
  cursor: {
    name: 'cursor',
    command: 'cursor-agent',
    displayName: 'Cursor CLI',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: [
      'streaming',
      'tool-use',
      'file-access',
      'shell',
      'multi-turn',
      'vision'
    ],
    alternativePaths: [
      '/opt/homebrew/bin/cursor-agent',
      '/usr/local/bin/cursor-agent',
      '~/.local/bin/cursor-agent',
      '~/.cursor/bin/cursor-agent'
    ]
  },
  ollama: {
    name: 'ollama',
    command: 'ollama',
    displayName: 'Ollama',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: ['streaming', 'multi-turn', 'local'],
    alternativePaths: [
      '/opt/homebrew/bin/ollama',
      '/usr/local/bin/ollama',
      '~/.ollama/bin/ollama',
      '/Applications/Ollama.app/Contents/MacOS/ollama',
      '%LOCALAPPDATA%\\Programs\\Ollama\\ollama.exe',
      '%ProgramFiles%\\Ollama\\ollama.exe',
      '%ProgramFiles(x86)%\\Ollama\\ollama.exe'
    ]
  }
};

/**
 * Executable extensions Windows tries (PATHEXT) when resolving a bare command.
 * npm installs a CLI as a `<cmd>.cmd`/`.ps1` shim (not a bare `<cmd>`), and the
 * official Claude/Codex installers drop a `<cmd>.exe`. The empty string covers
 * the rare extension-less binary. Order mirrors how a shell resolves them.
 */
export const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.ps1', '.bat', ''];

/**
 * Expand a registry alternative-path template into a concrete filesystem path.
 *
 * Handles two portable placeholders so the registry stays platform-neutral and
 * is evaluated at scan time (NOT at module load — `process.env['HOME']` is
 * undefined on Windows, which previously baked the literal string "undefined"
 * into every alt path and broke the file-existence fallback there):
 *   - a leading `~` → the user's home dir (`HOME`, falling back to `USERPROFILE`)
 *   - `%VAR%` → `env['VAR']` (Windows-style env reference, e.g. `%LOCALAPPDATA%`)
 * Returns null when a referenced variable is missing, so callers can skip it
 * instead of probing a path containing a literal "undefined" segment.
 */
export function expandAltPath(template: string, env: NodeJS.ProcessEnv): string | null {
  const home = env['HOME'] || env['USERPROFILE'] || '';
  let result = template;
  if (result.startsWith('~')) {
    if (!home) return null;
    result = home + result.slice(1);
  }
  let missing = false;
  result = result.replace(/%([^%]+)%/g, (_match, name: string) => {
    const value = env[name];
    if (!value) {
      missing = true;
      return '';
    }
    return value;
  });
  return missing ? null : result;
}

/**
 * All concrete on-disk locations to probe for a CLI when the bare-command
 * `--version` spawn fails. Combines the registry's curated alt paths with, on
 * Windows, every known CLI install directory crossed with each executable
 * extension — so an npm shim (`%APPDATA%\npm\claude.cmd`) or native-installer
 * binary (`%USERPROFILE%\.local\bin\claude.exe`) is found even if the bare
 * `claude` probe was killed under fork pressure at startup.
 */
export function getCliCandidatePaths(
  config: CliRegistryEntry,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const candidates: string[] = [];
  for (const template of config.alternativePaths) {
    const expanded = expandAltPath(template, env);
    if (expanded) candidates.push(expanded);
  }

  if (platform === 'win32') {
    for (const dir of getCliAdditionalPaths(env, platform)) {
      for (const ext of WINDOWS_EXECUTABLE_EXTENSIONS) {
        candidates.push(`${dir}\\${config.command}${ext}`);
      }
    }
  }

  return [...new Set(candidates.filter(Boolean))];
}
