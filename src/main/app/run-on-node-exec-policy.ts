import {
  NODE_EXEC_BROWSER_POLICY_ERROR,
  normalizedCommandBasename,
} from './run-on-node-posix-policy';

const POWERSHELL_EXECUTABLES = new Set([
  'powershell', 'powershell.exe',
]);
const POWERSHELL_HARMLESS_FLAGS = new Set([
  '-mta', '-noexit', '-nologo', '-noninteractive', '-noprofile', '-sta',
]);
const POWERSHELL_HARMLESS_VALUE_OPTIONS = new Set([
  '-configurationname', '-executionpolicy', '-inputformat', '-outputformat',
  '-settingsfile', '-windowstyle', '-workingdirectory',
]);
const DISALLOWED_CODE_INTERPRETERS = new Set([
  'bun', 'bun.exe', 'deno', 'deno.exe', 'node', 'node.exe',
]);
const PYTHON_INTERPRETERS = /^(?:py|python\d*(?:\.\d+)?)(?:\.exe)?$/iu;
const ALLOWED_DIRECT_EXECUTABLES = new Set([
  ...POWERSHELL_EXECUTABLES,
  'curl', 'curl.exe',
]);

function hasTrustedExecutableLocation(executable: string): boolean {
  if (!/[\\/]/u.test(executable)) return true;
  const normalized = executable.replace(/\\/gu, '/').toLowerCase();
  return /^\/(?:usr\/)?bin\/[^/]+$/u.test(normalized)
    || /^[a-z]:\/windows\/(?:system32\/windows(?:powershell\/v1\.0\/)?|system32\/)[^/]+$/u
      .test(normalized);
}

function isPowerShellOption(token: string, option: 'encodedcommand' | 'file'): boolean {
  const name = token.match(/^[-/\u2010-\u2015\u2212]([a-z]+)$/iu)?.[1]?.toLowerCase();
  return name !== undefined && (
    (option === 'encodedcommand' && (name === 'ec' || option.startsWith(name)))
    || (option === 'file' && (name === 'f' || option.startsWith(name)))
  );
}

function isProtectedBrowserLiteral(value: string): boolean {
  return /^(?:chrome|chrome\.exe|chromium|chromium-browser|google-chrome(?:-stable)?|msedge|msedge\.exe|microsoft-edge(?:-stable)?)$/iu
    .test(normalizedCommandBasename(value.trim()));
}

function splitPowerShellStatements(source: string): string[] {
  const statements: string[] = [];
  let statement = '';
  let quote: '\'' | '"' | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (quote === '\'') {
      statement += char;
      if (char === '\'' && source[index + 1] === '\'') {
        statement += source[++index];
      } else if (char === '\'') {
        quote = undefined;
      }
      continue;
    }
    if (char === '`') {
      const escaped = source[index + 1];
      if (!escaped || !['`', '$', '\'', '"'].includes(escaped)) {
        throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
      }
      statement += char + escaped;
      index += 1;
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? undefined : '"';
      statement += char;
      continue;
    }
    if (!quote && (char === ';' || char === '\n' || char === '\r')) {
      if (statement.trim()) statements.push(statement.trim());
      statement = '';
      continue;
    }
    statement += char;
  }
  if (quote) throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

function assertLiteralPowerShellArguments(value: string): void {
  let quote: '\'' | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? '';
    if (quote === '\'') {
      if (char === '\'' && value[index + 1] === '\'') index += 1;
      else if (char === '\'') quote = undefined;
      continue;
    }
    if (char === '`') {
      const escaped = value[index + 1];
      if (!escaped || !['`', '$', '\'', '"'].includes(escaped)) {
        throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
      }
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"') {
      if (!quote) quote = char;
      else if (quote === char) quote = undefined;
      continue;
    }
    if (char === '$' || (!quote && /[<>|&(){}\[\],#@]/u.test(char))) {
      throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
    }
  }
  if (quote) throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
}

/**
 * A deliberately small non-launching PowerShell grammar. This is an allowlist,
 * not a general PowerShell safety scan: only literal output/error statements
 * and a literal numeric exit code can execute through node.exec.
 */
export function assertSafePowerShellSource(source: string): void {
  const statements = splitPowerShellStatements(source);
  if (statements.length === 0) throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
  for (const statement of statements) {
    const exitMatch = /^exit\s+([0-9]|[1-9][0-9]{1,2})$/iu.exec(statement);
    if (exitMatch) continue;
    const outputMatch = /^(?:write-(?:error|host|output|verbose|warning))\b(.*)$/iu.exec(statement);
    if (!outputMatch) throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
    assertLiteralPowerShellArguments(outputMatch[1] ?? '');
  }
}

function assertPowerShellInvocation(args: readonly string[]): void {
  for (let index = 0; index < args.length;) {
    const token = args[index] ?? '';
    const lower = token.toLowerCase();
    if (isPowerShellOption(token, 'encodedcommand') || lower === '-encodedarguments') {
      throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
    }
    if (isPowerShellOption(token, 'file')) {
      const scriptPath = args[index + 1]?.trim() ?? '';
      if (!scriptPath || scriptPath === '-' || !/\.ps1$/iu.test(scriptPath)) {
        throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
      }
      if (args.slice(index + 2).some(isProtectedBrowserLiteral)) {
        throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
      }
      return;
    }
    const optionName = token.match(/^[-/\u2010-\u2015\u2212]([a-z]+)$/iu)?.[1]?.toLowerCase();
    if (optionName === 'cwa' || optionName?.startsWith('commandw')) {
      throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
    }
    if (optionName && (optionName === 'c' || 'command'.startsWith(optionName))) {
      assertSafePowerShellSource(args.slice(index + 1).join(' '));
      return;
    }
    if (POWERSHELL_HARMLESS_FLAGS.has(lower)) {
      index += 1;
      continue;
    }
    if (POWERSHELL_HARMLESS_VALUE_OPTIONS.has(lower) && args[index + 1] !== undefined) {
      index += 2;
      continue;
    }
    if (token.startsWith('-') || token.startsWith('/')) {
      throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
    }
    assertSafePowerShellSource(args.slice(index).join(' '));
    return;
  }
  throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
}

function assertSafeCurlArgs(args: readonly string[]): void {
  let urlCount = 0;
  for (const arg of args) {
    if (/^https:\/\/[^\s]+$/iu.test(arg)) {
      urlCount += 1;
      continue;
    }
    if (!['--fail', '--head', '--show-error', '--silent', '-f', '-I', '-S', '-s']
      .includes(arg)) {
      throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
    }
  }
  if (urlCount === 0) throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
}

/**
 * Pure allowlist policy shared by coordinator and worker service-RPC boundaries.
 * Only registered non-interpreters and a small literal PowerShell subgrammar are
 * admitted. This is an execution grammar and defense-in-depth boundary, not an OS sandbox.
 */
export function assertNodeExecArgvPolicy(executable: string, args: readonly string[]): void {
  const basename = normalizedCommandBasename(executable);
  if (/\.ps1$/iu.test(basename)) throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
  if (DISALLOWED_CODE_INTERPRETERS.has(basename) || PYTHON_INTERPRETERS.test(basename)) {
    throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
  }
  if (!ALLOWED_DIRECT_EXECUTABLES.has(basename)) {
    throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
  }
  if (!hasTrustedExecutableLocation(executable)) {
    throw new Error(NODE_EXEC_BROWSER_POLICY_ERROR);
  }
  if (POWERSHELL_EXECUTABLES.has(basename)) assertPowerShellInvocation(args);
  if (basename === 'curl' || basename === 'curl.exe') assertSafeCurlArgs(args);
}
