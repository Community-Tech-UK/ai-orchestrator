#!/usr/bin/env node
/**
 * `npm run audit:ui-words [--hits]`: per-file counts for each wording rule, and with --hits the lines.
 * `--write-baseline` rewrites `ui-vocabulary-baseline.json` (the Rule B ceiling) from today's counts; run it
 * only after a sweep has lowered them.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanUiText } from './extract-ui-text';
import { appNameHits, countByFile, instanceThreadHits, statusWordHits, type UiTextHit } from './ui-text-rules';

const scan = scanUiText(resolve(__dirname, '../..'));
if (process.argv.includes('--write-baseline')) {
  const baseline = { rule: 'instance-thread', counts: countByFile(instanceThreadHits(scan.strings)) };
  writeFileSync(resolve(__dirname, 'ui-vocabulary-baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);
}
const showHits = process.argv.includes('--hits');
const rules: [string, UiTextHit[]][] = [
  ['App name (Rule A)', appNameHits(scan.strings)],
  ['Instance / thread (Rule B)', instanceThreadHits(scan.strings)],
  ['Old status words (Rule E)', statusWordHits(scan.strings)],
];
const out = [`Visited ${scan.filesVisited} files (${scan.rendererFilesVisited} in the renderer); read ${scan.stringsScanned} strings.`];
for (const [title, hits] of rules) {
  out.push('', `${title}: ${hits.length} hits in ${Object.keys(countByFile(hits)).length} files`);
  if (showHits) for (const hit of hits) out.push(`  ${hit.file}:${hit.line}  [${hit.match}]  ${hit.text.slice(0, 110).replace(/\n/g, ' ')}`);
  else for (const [file, count] of Object.entries(countByFile(hits))) out.push(`  ${count}  ${file}`);
}
process.stdout.write(`${out.join('\n')}\n`);
