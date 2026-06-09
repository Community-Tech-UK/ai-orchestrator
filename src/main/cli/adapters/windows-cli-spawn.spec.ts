import { beforeEach, describe, expect, it, vi } from 'vitest';

// Virtual filesystem: path -> file contents (presence implies existsSync true).
const files = new Map<string, string>();

vi.mock('fs', () => {
  const existsSync = (p: string) => files.has(normalize(p));
  const readFileSync = (p: string) => {
    const content = files.get(normalize(p));
    if (content === undefined) {
      throw new Error(`ENOENT: ${p}`);
    }
    return content;
  };
  return { existsSync, readFileSync, default: { existsSync, readFileSync } };
});

// Resolver searches the augmented CLI PATH; control it directly.
let cliPath = 'C:\\nvm4w\\nodejs';
vi.mock('../cli-environment', () => ({
  buildCliPath: () => cliPath,
}));

import { resolveWindowsCliLauncher, resolveWindowsSpawn } from './windows-cli-spawn';

// Normalize slashes and collapse doubles so the virtual FS matches regardless
// of how the resolver assembled the path.
function normalize(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase();
}

const DIR = 'C:\\nvm4w\\nodejs';
const NODE_EXE = `${DIR}\\node.exe`;

const CLAUDE_EXE = `${DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const CODEX_JS = `${DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`;
const COPILOT_JS = `${DIR}\\node_modules\\@github\\copilot\\npm-loader.js`;

// Real shims read from the Windows worker node.
const CLAUDE_CMD = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join('\r\n');

const CODEX_CMD = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

const COPILOT_PS1 = [
  '#!/usr/bin/env pwsh',
  '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
  '$exe=""',
  'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) { $exe=".exe" }',
  'if (Test-Path "$basedir/node$exe") {',
  '  & "$basedir/node$exe"  "$basedir/node_modules/@github/copilot/npm-loader.js" $args',
  '} else {',
  '  & "node$exe"  "$basedir/node_modules/@github/copilot/npm-loader.js" $args',
  '}',
  'exit $LASTEXITCODE',
].join('\n');

describe('resolveWindowsCliLauncher', () => {
  beforeEach(() => {
    files.clear();
    cliPath = DIR;
  });

  describe('native-binary shims (claude)', () => {
    it('resolves claude.cmd %dp0% to the real claude.exe (no node prefix)', () => {
      files.set(normalize(`${DIR}\\claude.cmd`), CLAUDE_CMD);
      files.set(normalize(CLAUDE_EXE), 'binary');
      expect(resolveWindowsCliLauncher('claude')).toEqual({
        command: CLAUDE_EXE,
        prefixArgs: [],
      });
    });
  });

  describe('node-script shims (codex / copilot)', () => {
    it('resolves codex.cmd to node.exe + codex.js, ignoring the quoted node.exe', () => {
      files.set(normalize(`${DIR}\\codex.cmd`), CODEX_CMD);
      files.set(normalize(NODE_EXE), 'binary');
      files.set(normalize(CODEX_JS), 'script');
      expect(resolveWindowsCliLauncher('codex')).toEqual({
        command: NODE_EXE,
        prefixArgs: [CODEX_JS],
      });
    });

    it('resolves copilot.ps1 ($basedir + forward slashes) to node.exe + npm-loader.js', () => {
      files.set(normalize(`${DIR}\\copilot.ps1`), COPILOT_PS1);
      files.set(normalize(NODE_EXE), 'binary');
      files.set(normalize(COPILOT_JS), 'script');
      expect(resolveWindowsCliLauncher('copilot')).toEqual({
        command: NODE_EXE,
        prefixArgs: [COPILOT_JS],
      });
    });

    it('falls back to node.exe found elsewhere on PATH when not next to the shim', () => {
      const altNodeDir = 'C:\\nodebin';
      const altNode = `${altNodeDir}\\node.exe`;
      cliPath = `${DIR};${altNodeDir}`;
      files.set(normalize(`${DIR}\\codex.cmd`), CODEX_CMD);
      files.set(normalize(CODEX_JS), 'script');
      files.set(normalize(altNode), 'binary'); // no node.exe next to the shim
      expect(resolveWindowsCliLauncher('codex')).toEqual({
        command: altNode,
        prefixArgs: [CODEX_JS],
      });
    });

    it('returns null when node.exe cannot be found anywhere', () => {
      files.set(normalize(`${DIR}\\codex.cmd`), CODEX_CMD);
      files.set(normalize(CODEX_JS), 'script');
      // No node.exe in the virtual FS.
      expect(resolveWindowsCliLauncher('codex')).toBeNull();
    });

    it('returns null (never the shim node.exe) when a node-script .js target is missing', () => {
      // The .cmd quotes both node.exe and codex.js; codex.js is absent. The
      // result must be null — NOT a false-positive on the quoted node.exe.
      files.set(normalize(`${DIR}\\codex.cmd`), CODEX_CMD);
      files.set(normalize(NODE_EXE), 'binary');
      // CODEX_JS intentionally absent.
      expect(resolveWindowsCliLauncher('codex')).toBeNull();
    });
  });

  describe('direct + edge cases', () => {
    it('returns a directly-found .exe on PATH without reading a shim', () => {
      const directExe = 'C:\\tools\\claude\\claude.exe';
      cliPath = 'C:\\tools\\claude';
      files.set(normalize(directExe), 'binary');
      expect(resolveWindowsCliLauncher('claude')).toEqual({
        command: directExe,
        prefixArgs: [],
      });
    });

    it('uses an absolute .exe command directly when it exists', () => {
      files.set(normalize(CLAUDE_EXE), 'binary');
      expect(resolveWindowsCliLauncher(CLAUDE_EXE)).toEqual({
        command: CLAUDE_EXE,
        prefixArgs: [],
      });
    });

    it('returns null when no launcher is found on PATH', () => {
      expect(resolveWindowsCliLauncher('claude')).toBeNull();
    });

    it('returns null when the shim target does not exist (never guesses)', () => {
      files.set(normalize(`${DIR}\\claude.cmd`), CLAUDE_CMD);
      // claude.exe intentionally absent.
      expect(resolveWindowsCliLauncher('claude')).toBeNull();
    });

    it('searches PATH dirs in order, stopping at the first match', () => {
      const firstDir = 'C:\\first';
      const firstExe = `${firstDir}\\claude.exe`;
      cliPath = `${firstDir};${DIR}`;
      files.set(normalize(firstExe), 'binary');
      files.set(normalize(`${DIR}\\claude.cmd`), CLAUDE_CMD);
      files.set(normalize(CLAUDE_EXE), 'binary');
      expect(resolveWindowsCliLauncher('claude')).toEqual({
        command: firstExe,
        prefixArgs: [],
      });
    });
  });
});

describe('resolveWindowsSpawn (one-shot, used by the offload worker)', () => {
  const originalPlatform = process.platform;
  const setPlatform = (p: string) =>
    Object.defineProperty(process, 'platform', { value: p, configurable: true });

  beforeEach(() => {
    files.clear();
    cliPath = DIR;
  });
  afterEach(() => setPlatform(originalPlatform));

  it('on win32+shell, maps a node-script shim to node.exe + script with shell:false', () => {
    setPlatform('win32');
    files.set(normalize(`${DIR}\\codex.cmd`), CODEX_CMD);
    files.set(normalize(NODE_EXE), 'binary');
    files.set(normalize(CODEX_JS), 'script');
    expect(resolveWindowsSpawn('codex', ['--foo'], true, {})).toEqual({
      command: NODE_EXE,
      args: [CODEX_JS, '--foo'],
      shell: false,
      detached: false,
    });
  });

  it('on win32, falls back to the shell shim (shell:true, detached:false) when unresolved', () => {
    setPlatform('win32');
    expect(resolveWindowsSpawn('codex', ['--foo'], true, {})).toEqual({
      command: 'codex',
      args: ['--foo'],
      shell: true,
      detached: false,
    });
  });

  it('off win32, is identity with detached = !shell and never resolves', () => {
    setPlatform('darwin');
    expect(resolveWindowsSpawn('codex', ['--foo'], true, {})).toEqual({
      command: 'codex',
      args: ['--foo'],
      shell: true,
      detached: false,
    });
    // shell:false branch → detached:true (POSIX process-group semantics).
    expect(resolveWindowsSpawn('codex', ['--foo'], false, {})).toEqual({
      command: 'codex',
      args: ['--foo'],
      shell: false,
      detached: true,
    });
  });
});
