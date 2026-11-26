import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatMoneyExact, formatMoneyPlain } from './format-money';

describe('money presentation', () => {
  it.each([
    [0.7302072, '$0.73'],
    [0.001, 'under 1 cent'],
    [0.004999, 'under 1 cent'],
    [0.005, '$0.01'],
    [0, '$0.00'],
    [12.4, '$12.40'],
    [1e-21, 'under 1 cent'],
  ] satisfies [number, string][])('presents %s in plain cents', (value, expected) => {
    expect(formatMoneyPlain(value)).toBe(expected);
  });

  it('keeps the full supplied precision in Details', () => {
    expect(formatMoneyExact(0.7302072)).toBe('$0.7302072');
    expect(formatMoneyExact(0.1 + 0.2)).toBe('$0.30000000000000004');
    expect(formatMoneyExact(1e-21)).toBe('$1e-21');
  });
});

/**
 * Part 7g guard: renderer money precision belongs in the shared formatter.
 * Include Intl options and toPrecision: checking only toFixed missed the
 * Local AI panel's separate high-precision currency formatter.
 */
describe('money precision guard', () => {
  const EXACT_VALUE_TOOLTIPS = new Set([resolve(process.cwd(), 'src/renderer/app/shared/utils/format-money.ts')]);

  function precisionLines(source: string): number[] {
    const moneySource = /\bcurrency\s*:|\bformat(?:Money|Usd|Cost)/.test(source);
    return source.split('\n').flatMap((line, index) => {
      const fixed = line.match(/\.toFixed\(\s*(\d+)\s*\)/);
      const fractions = line.match(/(?:maximum|minimum)FractionDigits\s*:\s*(\d+)/);
      const precise = fixed && Number(fixed[1]) > 2
        || moneySource && (/\.toPrecision\(/.test(line)
          || /(?:maximum|minimum)SignificantDigits\s*:/.test(line)
          || fractions && Number(fractions[1]) > 2);
      return precise && (moneySource || /\$(?!\{)/.test(line)) ? [index + 1] : [];
    });
  }

  it('catches currency precision spread across Intl options and toPrecision', () => {
    expect(precisionLines("new Intl.NumberFormat('en-US', {\n currency: 'USD',\n maximumFractionDigits: 20,\n});")).toEqual([3]);
    expect(precisionLines('function formatUsd(value) {\n return value.toPrecision(15);\n}')).toEqual([2]);
    expect(precisionLines('`$${value.toFixed(5)}`')).toEqual([1]);
    expect(precisionLines("new Intl.NumberFormat('en-US', { currency: 'USD', maximumSignificantDigits: 15 });")).toEqual([1]);
    expect(precisionLines("new Intl.NumberFormat('en-US', { currency: 'USD', maximumFractionDigits: 2 });")).toEqual([]);
    expect(precisionLines('const size = value.toPrecision(4);')).toEqual([]);
    expect(precisionLines('const size = `${value.toFixed(3)}`;')).toEqual([]);
  });

  it('has no ad-hoc high-precision renderer money formatter', () => {
    const root = resolve(process.cwd(), 'src/renderer');
    const offenders: string[] = [];
    const stack = [root];
    while (stack.length) {
      const current = stack.pop()!;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        if (!/\.(ts|html)$/.test(entry.name)) continue;
        if (entry.name.endsWith('.spec.ts')) continue;
        if (EXACT_VALUE_TOOLTIPS.has(full)) continue;
        const source = readFileSync(full, 'utf8');
        const lines = source.split('\n');
        for (const line of precisionLines(source)) offenders.push(`${full}:${line}: ${lines[line - 1].trim()}`);
      }
    }
    expect(offenders, 'Money is shown in cents; exact figures go in the hover only').toEqual([]);
  });
});
