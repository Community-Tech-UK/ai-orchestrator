/**
 * Windows-only resolution of a bare CLI command (e.g. `claude`, `codex`,
 * `copilot`) to a launcher that can be spawned directly with `shell: false`.
 *
 * WHY: On Windows `spawn('<cli>', args, { shell: true })` runs the npm-generated
 * `<cli>.cmd` / `<cli>.ps1` shim through cmd.exe. Node's shell-mode argument
 * handling (DEP0190) concatenates args without escaping, so the embedded
 * newlines in a multi-line `--system-prompt` (or any arg with shell
 * metacharacters) terminate the cmd.exe command line and silently drop every
 * argument after it — including `--mcp-config`. The spawned agent then never
 * registers its MCP servers (chrome-devtools, etc.).
 *
 * Two npm shim shapes exist in the wild, both handled here:
 *   1. Native-binary launcher (current Claude Code):
 *        claude.cmd:  "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
 *      → spawn that `.exe` directly.
 *   2. Node-script launcher (codex, copilot, most npm CLIs):
 *        codex.cmd:   "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
 *                     (where %_prog% is "%dp0%\node.exe" or "node")
 *      → spawn `node.exe` with the `.js` script as the first arg.
 *
 * With `shell: false` each argv element is passed to the target verbatim — no
 * shell layer, no quote stripping, no command-line truncation.
 *
 * Resolution is best-effort: callers MUST fall back to the existing shell spawn
 * when this returns `null` so spawning can never regress on an unexpected
 * install layout.
 */

import { existsSync, readFileSync } from 'fs';
import { win32 as pathWin32 } from 'path';
import { buildCliPath } from '../cli-environment';
import type { SpawnTarget } from './base-cli-adapter';

const LAUNCHER_EXTENSIONS = ['.exe', '.cmd', '.ps1', '.bat'] as const;

/** A directly-spawnable launcher: `command` plus args prepended before the caller's args. */
export interface WindowsCliLauncher {
  command: string;
  prefixArgs: string[];
}

/** Final spawn decision: command/args plus the `shell`/`detached` flags to use. */
export interface ResolvedSpawn {
  command: string;
  args: string[];
  shell: boolean;
  detached: boolean;
}

/**
 * One-shot Windows launcher resolution (no caching) for callers that spawn
 * directly rather than through {@link BaseCliAdapter.resolveSpawnTarget} — e.g.
 * the spawn-worker offload thread. On win32 + shell it maps the shim to a
 * directly-spawnable launcher with `shell:false`; off-Windows / shell-false, or
 * on any resolution failure, it preserves the original shell-shim spawn.
 */
export function resolveWindowsSpawn(
  command: string,
  args: string[],
  shell: boolean,
  env: NodeJS.ProcessEnv,
): ResolvedSpawn {
  if (process.platform !== 'win32' || !shell) {
    return { command, args, shell, detached: !shell };
  }
  const launcher = resolveWindowsCliLauncher(command, env);
  if (!launcher) {
    return { command, args, shell: true, detached: false };
  }
  const target = buildWindowsShellFreeTarget(launcher, args);
  return {
    command: target.command,
    args: target.args,
    shell: false,
    detached: target.detached ?? false,
  };
}

/** Minimal logger surface used by {@link logWindowsLauncherResolution}. */
interface SpawnLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

/**
 * Build a `shell:false` spawn target from a resolved launcher. `detached:false`
 * preserves prior Windows semantics; the process tree is killed via
 * `taskkill /T /F` (pid-based), which doesn't need a process group.
 */
export function buildWindowsShellFreeTarget(
  launcher: WindowsCliLauncher,
  args: string[],
): SpawnTarget {
  return {
    command: launcher.command,
    args: [...launcher.prefixArgs, ...args],
    shell: false,
    detached: false,
  };
}

/** Log the outcome of a Windows launcher resolution (info on hit, warn on miss). */
export function logWindowsLauncherResolution(
  log: SpawnLogger,
  adapter: string,
  command: string,
  launcher: WindowsCliLauncher | null,
): void {
  if (launcher) {
    log.info('Resolved Windows CLI launcher for direct shell:false spawn', {
      adapter,
      command,
      resolved: launcher.command,
      viaNode: launcher.prefixArgs.length > 0,
    });
  } else {
    log.warn(
      'Could not resolve Windows CLI launcher; falling back to shell:true shim spawn (args may be mangled)',
      { adapter, command },
    );
  }
}

/**
 * Resolve `command` (typically a bare CLI name like `"claude"`) to a launcher
 * that can be spawned with `shell: false` on Windows, or `null` if it cannot be
 * resolved (caller should fall back to the shell shim).
 */
export function resolveWindowsCliLauncher(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): WindowsCliLauncher | null {
  // Already an absolute .exe path that exists — nothing to resolve.
  if (
    pathWin32.isAbsolute(command)
    && command.toLowerCase().endsWith('.exe')
    && existsSync(command)
  ) {
    return { command, prefixArgs: [] };
  }

  const launcher = findLauncher(command, env);
  if (!launcher) {
    return null;
  }
  if (launcher.toLowerCase().endsWith('.exe')) {
    return { command: launcher, prefixArgs: [] };
  }

  let text: string;
  try {
    text = readFileSync(launcher, 'utf-8');
  } catch {
    return null;
  }
  const shimDir = pathWin32.dirname(launcher);

  // The shim type is decided by whether it invokes a `.js` script. A node-script
  // shim (codex, copilot, …) also contains a quoted `node.exe`, so it must NEVER
  // fall through to the `.exe` branch below — that would wrongly pick the
  // runtime's node.exe as the target and silently drop the script. So if a `.js`
  // token is present we commit to the node-script path and return null on
  // failure (caller falls back to the shell shim) rather than guessing.
  const jsMatch = text.match(/["']([^"'\r\n]*\.js)["']/i);
  if (jsMatch) {
    const scriptPath = resolvePlaceholders(jsMatch[1], shimDir);
    if (!scriptPath || !existsSync(scriptPath)) {
      return null;
    }
    const nodeExe = resolveNodeExe(shimDir, env);
    return nodeExe ? { command: nodeExe, prefixArgs: [scriptPath] } : null;
  }

  // Native-binary shim (e.g. claude.exe). Scan every quoted `.exe` and take the
  // first real one that isn't the node runtime — defensive against a shim that
  // mentions node.exe without a `.js` (we'd otherwise mis-target it).
  for (const match of text.matchAll(/["']([^"'\r\n]*\.exe)["']/gi)) {
    const exePath = resolvePlaceholders(match[1], shimDir);
    if (!exePath || pathWin32.basename(exePath).toLowerCase() === 'node.exe') {
      continue;
    }
    if (existsSync(exePath)) {
      return { command: exePath, prefixArgs: [] };
    }
  }

  return null;
}

/**
 * Locate the `<command>` launcher (`.exe` / `.cmd` / `.ps1` / `.bat`) on the
 * augmented CLI PATH — the same PATH the adapter spawns with — mirroring how the
 * OS would otherwise resolve it.
 */
function findLauncher(command: string, env: NodeJS.ProcessEnv): string | null {
  const base = pathWin32.basename(command).replace(/\.(exe|cmd|ps1|bat)$/i, '');
  if (!base) {
    return null;
  }

  const dirs = pathDirs(env);
  for (const dir of dirs) {
    for (const ext of LAUNCHER_EXTENSIONS) {
      const candidate = pathWin32.join(dir, `${base}${ext}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Resolve the `node.exe` a node-script shim would use: prefer the one next to
 * the shim (`%dp0%\node.exe`, as the shim itself prefers), else the first on PATH.
 */
function resolveNodeExe(shimDir: string, env: NodeJS.ProcessEnv): string | null {
  const local = pathWin32.join(shimDir, 'node.exe');
  if (existsSync(local)) {
    return local;
  }
  for (const dir of pathDirs(env)) {
    const candidate = pathWin32.join(dir, 'node.exe');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return buildCliPath(env, 'win32')
    .split(';')
    .map((dir) => dir.trim())
    .filter(Boolean);
}

/**
 * Replace shim path placeholders (cmd `%dp0%` / `%~dp0`, PowerShell `$basedir`
 * / `$PSScriptRoot`) with the shim's directory and normalize to a Windows path.
 * Returns `null` if any unresolved placeholder remains.
 */
function resolvePlaceholders(raw: string, shimDir: string): string | null {
  const value = raw
    .replace(/%~?dp0%?/gi, `${shimDir}\\`)
    .replace(/\$\{?PSScriptRoot\}?/gi, shimDir)
    .replace(/\$basedir/gi, shimDir);

  // Bail if an unhandled %VAR% or $var token survived — we can't trust the path.
  if (/%[^%]*%/.test(value) || /\$\w/.test(value)) {
    return null;
  }
  return pathWin32.normalize(value);
}
