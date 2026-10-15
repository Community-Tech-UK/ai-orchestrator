import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { VerifyFailureKind } from './loop-completion-detector';

export interface VerifyFailureKeys {
  keys: Map<string, number>;
  failedStep?: string;
  parse: 'complete' | 'none';
}

interface ScriptSection {
  step?: string;
  lines: string[];
}

const NPM_SCRIPT_HEADER = /^\s*>\s+\S+@\S+\s+(\S+)\s*$/;
const TSC_DIAGNOSTIC = /^(.+?)\(\d+,\d+\):\s+error\s+(TS\d+):\s*(.*)$/;
const VITEST_DETAIL = /^\s*FAIL\s+(?:\|[^|]+\|\s+)?(.+?\.[cm]?[jt]sx?)\s+>\s+(.+)$/;
const VITEST_QUIET = /^\s*[✗×]\s+(.+?\.[cm]?[jt]sx?)\s+[›>]\s+(.+)$/;
const VITEST_FILE = /^\s*[❯✗×]\s+(?:\|[^|]+\|\s+)?(.+?\.[cm]?[jt]sx?)\s+\(\d+\s+tests?\b/;
const VITEST_BULLET = /^\s*[✗×]\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?\s*$/;
const ESLINT_ERROR = /^\s*\d+:\d+\s+error\s+(.+?)(?:\s{2,}(\S+))?\s*$/;

/**
 * Only command failures in complete, supported runner output can be compared.
 * Counts are retained: an additional identical diagnostic is still new work.
 */
export function extractVerifyFailureKeys(
  output: string,
  options: { truncated: boolean; failureKind: VerifyFailureKind },
): VerifyFailureKeys {
  const keys = new Map<string, number>();
  const none: VerifyFailureKeys = { keys, parse: 'none' };
  if (options.truncated || options.failureKind !== 'command') return none;
  const clean = stripVTControlCharacters(output).replaceAll('\r', '');
  // The quiet runner can itself clip a failure or omit later failures, before
  // the spawn's stream cap is reached. Neither is a complete comparison.
  if (/…\(truncated|…and \d+ more failed test|no usable JSON report/.test(clean)) return none;
  if (hasUnsupportedFailure(clean.split('\n'))) return none;

  const sections: ScriptSection[] = [{ lines: [] }];
  for (const line of clean.split('\n')) {
    const script = NPM_SCRIPT_HEADER.exec(line);
    if (script) sections.push({ step: script[1], lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  let failedStep: string | undefined;
  for (const section of sections) {
    const failures = sectionKeys(section);
    for (const key of failures) keys.set(key, (keys.get(key) ?? 0) + 1);
    if (failures.length > 0) failedStep = section.step;
  }
  // The command failed, but the last executed script gave no supported failure
  // evidence. Earlier diagnostics cannot establish what broke in that script.
  const lastSection = sections[sections.length - 1];
  if (keys.size > 0 && lastSection.step && sectionKeys(lastSection).length === 0) {
    keys.clear();
    return none;
  }
  if (keys.size === 0) return none;
  return { keys, ...(failedStep ? { failedStep } : {}), parse: 'complete' };
}

function hasUnsupportedFailure(lines: readonly string[]): boolean {
  let vitestFile = false;
  for (const line of lines) {
    if (/^\s*[⎯─=-]{2,}\s*(?:Unhandled Errors?|Unhandled Rejections?|Uncaught Exceptions?|Source Errors?)\b/i.test(line)
      || /^\s*Vitest (?:caught \d+ unhandled errors?|found \d+ errors? not related to your test files)\b/i.test(line)) return true;
    if (NPM_SCRIPT_HEADER.test(line)) vitestFile = false;
    if (/^\s*FAIL\s/.test(line) && !VITEST_DETAIL.test(line)) return true;
    if (/^\s*(?:FAILED\s|\[ERROR\]|error\s+TS\d+:)/.test(line)) return true;
    if (VITEST_FILE.test(line)) vitestFile = true;
    if (/^\s*[✗×]\s/.test(line) && !VITEST_QUIET.test(line) && !VITEST_FILE.test(line)
      && !/^\s*[✗×]\s+(?:\d+ of \d+ tests? failed|FAILED\s*[—-])/.test(line)
      && !vitestFile) return true;
  }
  return false;
}

function sectionKeys(section: ScriptSection): string[] {
  const keys: string[] = [];
  const { lines, step } = section;
  // Vitest repeats each failure in the progress tree and the detailed block.
  // Prefer detailed blocks within this script, rather than counting both.
  const hasVitestDetails = lines.some(line => VITEST_DETAIL.test(line));
  let vitestFile: string | undefined;
  let eslintFile: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const tsc = TSC_DIAGNOSTIC.exec(line);
    if (tsc) {
      const message = [tsc[3]];
      while (index + 1 < lines.length && /^\s{2,}\S/.test(lines[index + 1])
        && !/^\s+(?:at |[❯✗×✓]|\d+:\d+)/.test(lines[index + 1])) {
        message.push(lines[++index].trim());
      }
      keys.push(failureKey(step, 'tsc', tsc[1], tsc[2], message.join(' ')));
      continue;
    }
    const detail = VITEST_DETAIL.exec(line);
    if (detail) {
      keys.push(failureKey(step, 'vitest', detail[1], testName(detail[2]), vitestMessage(lines, index)));
      continue;
    }
    const file = VITEST_FILE.exec(line);
    if (file) { vitestFile = file[1]; continue; }
    const quiet = VITEST_QUIET.exec(line);
    if (quiet && !hasVitestDetails) {
      keys.push(failureKey(step, 'vitest', quiet[1], testName(quiet[2]), vitestMessage(lines, index)));
      continue;
    }
    const bullet = VITEST_BULLET.exec(line);
    if (bullet && vitestFile && !hasVitestDetails) {
      keys.push(failureKey(step, 'vitest', vitestFile, testName(bullet[1]), vitestMessage(lines, index)));
      continue;
    }
    // Stylish puts a bare path above its rows, including absolute Windows paths.
    if (/^(?:[A-Za-z]:[/\\]|[/\\.]|[\w@-]).*\.[A-Za-z\d]+$/.test(line.trim())) {
      eslintFile = line.trim();
      continue;
    }
    const lint = ESLINT_ERROR.exec(line);
    if (lint && eslintFile) {
      keys.push(failureKey(step, 'eslint', eslintFile, lint[2] ?? 'parse-error', lint[1]));
    }
  }
  return keys;
}

function vitestMessage(lines: readonly string[], index: number): string {
  for (let next = index + 1; next < Math.min(lines.length, index + 8); next++) {
    const line = lines[next].trim();
    if (!line) continue;
    if (line.startsWith('→')) return line.slice(1).trim();
    if (/^[\w.]*Error:/.test(line)) return line;
    return '';
  }
  return '';
}

function testName(value: string): string {
  return value.replace(/\s+>\s+/g, ' ').replace(/\s+/g, ' ').trim();
}

function failureKey(step: string | undefined, tool: string, file: string, code: string, message: string): string {
  const normalized = message.replace(/^AssertionError:\s*/, '').replace(/\s+/g, ' ').trim();
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  const normalizedFile = file.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  return `${step ?? ''}|${tool}|${normalizedFile}|${code}|${hash}`;
}
