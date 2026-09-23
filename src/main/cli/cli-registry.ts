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
export type CliType = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'copilot' | 'ollama' | 'cursor' | 'grok' | 'opencode';

/** CLIs surfaced in CLI Health. `gemini` is excluded — superseded by `antigravity`. */
export const SUPPORTED_CLIS: CliType[] = ['claude', 'codex', 'antigravity', 'copilot', 'ollama', 'cursor', 'grok', 'opencode'];

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
  /**
   * Directories the CLI's *own* installer maintains as a second copy of an
   * install that already appears elsewhere on PATH — not a rival install a
   * user forgot about.
   *
   * Grok is the motivating case: `npm i -g @xai-official/grok` drops the usual
   * shim in the node bin dir, then its postinstall unpacks the same versioned
   * binary into `$GROK_HOME/bin` (default `~/.grok/bin`) and appends that dir
   * to the shell profile. Both copies are therefore present on every npm-based
   * grok install, at the same version, by design — reporting the second as a
   * redundant copy is a permanent false positive, and "remove it" advice the
   * next `npm update -g` would undo.
   *
   * A copy here is tagged `installerCopy` only when its version matches the
   * install found first outside these directories (see `tagInstallerMirrors`):
   * it stays visible in the copy
   * list and in diagnostics, but stops counting as a redundant install. A
   * genuinely stale copy — e.g. a postinstall that failed and left an older
   * binary behind — is left untagged and still surfaces as a version
   * conflict, and a directory that holds the *only* install (native
   * installer, no npm shim) is reported as that install. These directories are
   * also scanned for this CLI (so a relocated `$GROK_HOME` is found) but never
   * added to the spawn PATH other CLIs share.
   *
   * An ordered fallback list, not a union: the installer writes to the first
   * entry whose placeholders all resolve, as grok's postinstall does with
   * `$GROK_HOME ?? ~/.grok`. Same placeholder syntax as `alternativePaths`,
   * but these are directories.
   */
  installerMirrorDirs?: string[];
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
    versionPattern: /(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/,
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
  grok: {
    name: 'grok',
    command: 'grok',
    displayName: 'Grok Build',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: [
      'streaming',
      'tool-use',
      'file-access',
      'shell',
      'multi-turn',
      'mcp-servers',
    ],
    alternativePaths: [
      '~/.grok/bin/grok',
      '~/.grok/bin/grok.exe',
      '/opt/homebrew/bin/grok',
      '/usr/local/bin/grok',
      '~/.local/bin/grok',
      '%LOCALAPPDATA%\\grok\\bin\\grok.exe',
      '%USERPROFILE%\\.grok\\bin\\grok.exe',
    ],
    // Written by @xai-official/grok's own postinstall: `$GROK_HOME/bin` when
    // GROK_HOME is set, otherwise `~/.grok/bin` — one or the other, never
    // both, exactly as the package resolves it.
    installerMirrorDirs: [
      '%GROK_HOME%/bin',
      '~/.grok/bin',
    ],
  },
  opencode: {
    name: 'opencode',
    command: 'opencode',
    displayName: 'OpenCode',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: [
      'streaming',
      'tool-use',
      'file-access',
      'shell',
      'multi-turn',
      'mcp-servers',
    ],
    alternativePaths: [
      // opencode.ai/install writes the binary to `$HOME/.opencode/bin`.
      '~/.opencode/bin/opencode',
      '/opt/homebrew/bin/opencode',
      '/usr/local/bin/opencode',
      '~/.local/bin/opencode',
      '~/.npm-global/bin/opencode',
      '%APPDATA%\\npm\\opencode.cmd',
      '%USERPROFILE%\\.opencode\\bin\\opencode.exe',
    ],
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

/**
 * Normalize a path for directory comparison: one separator style, no repeated
 * or trailing separators, and case-folded on Windows (whose filesystem is
 * case-insensitive, so `C:\Users\X\.grok\bin` and `c:/users/x/.grok/bin` are
 * the same directory).
 *
 * Collapsing repeats matters: a PATH entry written with a trailing slash makes
 * the scanner build `<dir>//<cmd>`, and `$GROK_HOME` may arrive with one too.
 * Leading `//` is preserved — on Windows that is a UNC root, not a repeat.
 */
function normalizePathForComparison(value: string, platform: NodeJS.Platform): string {
  const unified = value
    .replace(/\\/g, '/')
    .replace(/(?!^)\/{2,}/g, '/')
    .replace(/(?!^)\/+$/, '');
  return platform === 'win32' ? unified.toLowerCase() : unified;
}

/**
 * The concrete directories a CLI's own installer mirrors an install into (see
 * `CliRegistryEntry.installerMirrorDirs`), expanded at scan time and
 * normalized for comparison. Templates referencing an unset variable are
 * skipped rather than probed as a literal.
 */
export function getInstallerMirrorDirs(
  config: CliRegistryEntry,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [...new Set(
    expandInstallerMirrorDirs(config, env)
      .map((dir) => normalizePathForComparison(dir, platform)),
  )];
}

/**
 * The same directories as `getInstallerMirrorDirs`, expanded but not
 * normalized — real paths to probe on disk. The install scan adds these to
 * its search list for this CLI only, so a relocated `$GROK_HOME` is found
 * without putting it on the spawn PATH that every CLI shares.
 */
export function expandInstallerMirrorDirs(
  config: CliRegistryEntry,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // Ordered alternatives, not a union: the installer writes to exactly one
  // place, the first template whose placeholders all resolve — as grok's
  // postinstall does with `$GROK_HOME ?? ~/.grok`. With GROK_HOME set, a
  // ~/.grok/bin copy is a leftover a reinstall never touches, so it must not
  // be treated as installer-owned.
  for (const template of config.installerMirrorDirs ?? []) {
    const expanded = expandAltPath(template, env);
    if (expanded) return [expanded];
  }
  return [];
}

/**
 * True when `installPath` is an executable sitting directly inside one of
 * `mirrorDirs` (as returned by `getInstallerMirrorDirs`).
 */
export function isInstallerMirrorPath(
  installPath: string,
  mirrorDirs: string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (mirrorDirs.length === 0) return false;
  const normalized = normalizePathForComparison(installPath, platform);
  const lastSeparator = normalized.lastIndexOf('/');
  if (lastSeparator < 0) return false;
  const parentDir = normalized.slice(0, lastSeparator);
  return mirrorDirs.includes(parentDir);
}
