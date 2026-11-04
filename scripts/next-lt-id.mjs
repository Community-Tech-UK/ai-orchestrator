#!/usr/bin/env node
import { readFileSync } from 'node:fs';

// Optional path lets a queue worker read the authoritative root register,
// which may contain newer entries than the worker's checkout.
const register = process.argv[2]
  ?? new URL('../docs/plans/livetest-remediation-register.md', import.meta.url);

const tableCells = line => line.trim().split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());

try {
  const lines = readFileSync(register, 'utf8').split(/\r?\n/);
  const header = lines.findIndex((line) =>
    /^\|\s*ID\s*\|\s*Priority\s*\|\s*Required fix\s*\|\s*Evidence source\s*\|\s*Retest source\s*\|\s*$/.test(line));
  let maximum = null;
  if (header !== -1) {
    let delimiter = header + 1;
    while (lines[delimiter]?.trim() === '') delimiter++;
    if (!/^\|(?:\s*:?-{3,}:?\s*\|){5}\s*$/.test(lines[delimiter] ?? '')) {
      throw new Error('Malformed remediation index: missing five-column delimiter');
    }
    for (let row = delimiter + 1; row < lines.length; row++) {
      const line = lines[row];
      if (line.trim() === '') continue;
      if (!line.trimStart().startsWith('|')) break;
      const cells = tableCells(line);
      let next = row + 1;
      while (lines[next]?.trim() === '') next++;
      const rule = lines[next]?.trim() ?? '';
      const separators = tableCells(rule);
      // Only a real header/delimiter pair ends the index, regardless of its
      // header text. A malformed body row cannot hide later allocated IDs.
      if (cells.length && line.trimEnd().endsWith('|') && rule.startsWith('|') && rule.endsWith('|')
        && separators.length === cells.length && separators.every(cell => /^:?-{3,}:?$/.test(cell))) break;
      const ids = cells[0];
      if (!/^LT-\d+(?:\s*,\s*LT-\d+)*$/.test(ids ?? '')) throw new Error('Malformed remediation index: invalid LT ID or table boundary');
      // The standing register has legacy ID/priority/fix rows without evidence columns.
      if (!line.trimEnd().endsWith('|') || cells.length < 3 || cells.length > 5 || cells.some(cell => !cell)) {
        throw new Error('Malformed remediation index: incomplete index row');
      }
      for (const match of ids.matchAll(/LT-(\d+)/g)) {
        const id = BigInt(match[1]);
        if (id < 1n) throw new Error('Malformed remediation index: invalid LT ID');
        if (maximum === null || id > maximum) maximum = id;
      }
    }
  }
  if (maximum === null) throw new Error('No LT IDs found in the remediation index');
  console.log(`LT-${String(maximum + 1n).padStart(3, '0')}`);
} catch (error) {
  console.error(`next-lt-id: ${error.message}`);
  process.exitCode = 1;
}
