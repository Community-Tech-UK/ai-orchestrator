import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyze } from './analyze';
import { compare, compareBaselines, markerChanges, initBaseline, measure, readBaseline, tighten, transfer, writeBaseline, type Baseline } from './baseline.js';
import { checkLedger, compareLedgers, qualifying, readLedger, recordNew, retire, writeLedger, type Ledger } from './wording-ledger.js';
import { EXEMPT_REASONS, normalizePath } from './types';
import { RULE_CATALOGUE } from './rules';

export interface CliResult { exitCode: number; output: string }
export function parseArgs(args: string[]): Record<string, string[]> {
  const arities: Record<string, number> = { '--warn': 0, '--tighten': 0, '--init': 0, '--force': 0, '--transfer': 2, '--rule': 1, '--count': 1, '--exempt': 2, '--record-wording': 0, '--retire': 1, '--reason': 1, '--against': 1, '--root': 1, '--baseline': 1, '--ledger': 1, '--json': 0, '--list': 1 };
  const result: Record<string, string[]> = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!; const arity = arities[flag];
    if (arity === undefined || result[flag]) throw new Error('Unknown or repeated option: ' + flag);
    const values = args.slice(index + 1, index + 1 + arity);
    if (values.length !== arity || values.some(value => value.startsWith('--'))) throw new Error('Missing value: ' + flag);
    result[flag] = values; index += arity;
  }
  return result;
}
export function runAudit(args: string[]): CliResult {
  try {
    const flags = parseArgs(args); const root = resolve(flags['--root']?.[0] ?? process.cwd()); const analysis = analyze(root);
    const errors = analysis.violations.filter(violation => violation.code === 'H12');
    if (flags['--json']) return { exitCode: errors.length ? 1 : 0, output: JSON.stringify(analysis, (_key, value) => typeof value === 'object' && value && ('sourceFile' in value || 'statements' in value) ? undefined : value, 2) + '\n' };
    const folders = new Map<string, { controls: number; tooltips: number; violations: number }>();
    for (const fact of analysis.facts) {
      const folder = fact.ownerFile.split('/').slice(0, 6).join('/');
      const row = folders.get(folder) ?? { controls: 0, tooltips: 0, violations: 0 };
      row.controls += Number(fact.control); row.tooltips += Number(fact.tooltip); folders.set(folder, row);
    }
    for (const violation of analysis.violations) { const folder = violation.ownerFile.split('/').slice(0, 6).join('/'); const row = folders.get(folder); if (row) row.violations++; }
    const lines = ['UI hints audit', ...Object.entries(analysis.counts).map(([name, count]) => `  ${name}: ${count}`)];
    lines.push(`  icon controls with name and tooltip: ${analysis.facts.filter(fact => fact.iconOnly && fact.name && fact.tooltip).length}/${analysis.counts['iconOnly']} (count-based rules gate, percentages do not)`, 'Per-folder worklist:');
    for (const [folder, row] of folders) lines.push(`  ${folder}: ${row.controls} controls, ${row.tooltips} tooltips, ${row.violations} findings`);
    for (const [code, rule] of Object.entries(RULE_CATALOGUE)) lines.push(`  ${code}: ${analysis.violations.filter(violation => violation.code === code).length} ${rule.title} (${rule.status})`);
    const selected = flags['--list']?.[0];
    if (selected && !RULE_CATALOGUE[selected as keyof typeof RULE_CATALOGUE]) throw new Error('Unknown rule: ' + selected);
    for (const violation of analysis.violations.filter(violation => violation.code === 'H12' || violation.code === selected)) lines.push(`${violation.code} ${violation.file}:${violation.line} ${violation.message}. ${RULE_CATALOGUE[violation.code].fix}`);
    return { exitCode: errors.length ? 1 : 0, output: lines.join('\n') + '\n' };
  } catch (error) { return { exitCode: 1, output: String(error) + '\n' }; }
}
export function runCheck(args: string[]): CliResult {
  let warn = false;
  try {
    const flags = parseArgs(args); warn = !!flags['--warn'];
    const baselineMutations = ['--init', '--tighten', '--transfer', '--exempt'].filter(flag => flags[flag]);
    const ledgerMutations = ['--record-wording', '--retire'].filter(flag => flags[flag]);
    const mutations = [...baselineMutations, ...ledgerMutations];
    const exemptTighten = baselineMutations.length === 2 && flags['--exempt'] && flags['--tighten'];
    if (baselineMutations.length > 1 && !exemptTighten || ledgerMutations.length > 1) throw new Error('Use one baseline operation (or --exempt with --tighten) and one ledger operation together');
    if (flags['--force'] && !flags['--init'] || flags['--reason'] && !flags['--retire'] || (flags['--rule'] || flags['--count']) && !flags['--transfer']) throw new Error('Dependent option missing its mutation');
    const root = resolve(flags['--root']?.[0] ?? process.cwd());
    const baselinePath = resolve(flags['--baseline']?.[0] ?? root + '/scripts/ui-hints/baseline.json');
    const ledgerPath = resolve(flags['--ledger']?.[0] ?? root + '/scripts/ui-hints/wording-ledger.json');
    const analysis = analyze(root);
    const integrity = analysis.violations.filter(violation => violation.code === 'H12');
    if (integrity.length) throw new Error(integrity.map(violation => `H12 ${violation.file}:${violation.line} ${violation.message}`).join('\n'));
    if (!existsSync(ledgerPath) && !flags['--init'] && !flags['--record-wording']) throw new Error('Missing wording ledger; run --record-wording after --init');
    const measured = measure(analysis);
    let baseline: Baseline; let ledger: Ledger = existsSync(ledgerPath) ? readLedger(ledgerPath) : [];
    if (flags['--init']) {
      if (existsSync(baselinePath) && !flags['--force']) throw new Error('--init refuses existing record; use --force deliberately');
      baseline = initBaseline(measured);
    } else {
      if (!existsSync(baselinePath)) throw new Error('Missing baseline; run --init');
      baseline = readBaseline(baselinePath);
      if (flags['--transfer']) baseline = transfer(baseline, flags['--transfer'][0]!, flags['--transfer'][1]!, { rule: flags['--rule']?.[0], count: flags['--count'] ? Number(flags['--count'][0]) : undefined });
      if (flags['--exempt']) {
        const [ownerRaw, reason] = flags['--exempt']; const owner = normalizePath(ownerRaw!);
        if (!(EXEMPT_REASONS as readonly string[]).includes(reason!)) throw new Error('Unknown exemption reason');
        const old = baseline.markers[reason!]?.[owner] ?? 0; const current = measured.markers[reason!]?.[owner] ?? 0;
        if (current <= old) throw new Error('No new marker for this owner and reason');
        const increases = compare(measured, baseline).filter(finding => finding.kind === 'new' && !(finding.code === 'marker:' + reason && finding.owner === owner));
        if (increases.length) throw new Error('Cannot exempt while another count went up: ' + JSON.stringify(increases));
        (baseline.markers[reason!] ??= {})[owner] = current;
        baseline = initBaseline(baseline);
      }
      if (flags['--tighten']) baseline = tighten(measured, baseline);
    }
    if (flags['--record-wording']) ledger = recordNew(analysis, ledger);
    if (flags['--retire']) ledger = retire(ledger, flags['--retire'][0]!, flags['--reason']?.[0] ?? '');
    const errors = compare(measured, baseline).map(finding => {
      const hits = analysis.violations.filter(violation => violation.code === finding.code && violation.ownerFile === finding.owner).slice(0, 20).map(violation => `  ${violation.file}:${violation.line} ${violation.message}`).join('\n');
      const rule = RULE_CATALOGUE[finding.code as keyof typeof RULE_CATALOGUE];
      return `${finding.code} ${finding.kind}: ${finding.owner} measured ${finding.measured}, recorded ${finding.recorded}. ${finding.kind === 'stale' ? 'Run --tighten (combine it with --exempt or --retire when that change needs both records).' : rule?.fix ?? 'Fix measurement/exemption integrity.'}${hits ? '\n' + hits : ''}`;
    });
    errors.push(...checkLedger(analysis, ledger));
    const retirements: string[] = [];
    const reviewNotices: string[] = [];
    if (flags['--against']) {
      const readAtRef = (file: string): string | undefined => {
        const repoPath = normalizePath(relative(root, file));
        try { return execFileSync('git', ['show', `${flags['--against']![0]}:${repoPath}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch { // First introduction of a record is allowed; an invalid ref is not.
          execFileSync('git', ['rev-parse', '--verify', flags['--against']![0] + '^{commit}'], { cwd: root, stdio: 'ignore' }); return undefined;
        }
      };
      const beforeBaseline = readAtRef(baselinePath); const beforeLedger = readAtRef(ledgerPath);
      if (beforeBaseline) {
        const previous = JSON.parse(beforeBaseline) as Baseline;
        errors.push(...compareBaselines(previous, baseline).map(finding => `against: ${finding.code} ${finding.kind} ${finding.owner} ${finding.recorded} -> ${finding.measured}`));
        reviewNotices.push(...markerChanges(previous, baseline));
      }
      if (beforeLedger) { const comparison = compareLedgers(JSON.parse(beforeLedger) as Ledger, ledger); errors.push(...comparison.errors); retirements.push(...comparison.retirements); }
    }
    // Write only after validation: failed mutations leave both audit records untouched.
    if (!errors.length && mutations.length) {
      if (baselineMutations.length) writeBaseline(baselinePath, baseline);
      if (ledgerMutations.length) writeLedger(ledgerPath, ledger);
    }
    const reports = analysis.violations.filter(violation => ['H1c', 'H7', 'H8'].includes(violation.code)).map(violation => `${violation.code} advisory ${violation.file}:${violation.line} ${violation.message}`);
    const notices = [...reviewNotices, ...qualifying(analysis).filter(entry => !ledger.some(old => old.id === entry.id)).map(entry => `New qualifying wording ${entry.owner}: ${entry.text}; run --record-wording.`)];
    const totals = Object.fromEntries(Object.entries(measured.rules).map(([code, owners]) => [code, Object.values(owners).reduce((sum, count) => sum + count, 0)]));
    const report = { errors, notices, retirements, reports, totals, markers: analysis.counts['markers'], ledger: ledger.length, retired: ledger.filter(entry => entry.retired).length };
    return { exitCode: errors.length && !warn ? 1 : 0, output: flags['--json'] ? JSON.stringify(report, null, 2) + '\n' : errors.length ? [...errors, ...notices, ...retirements].join('\n') + '\n' : `UI hints OK ${JSON.stringify(totals)}; ${report.markers} markers; ${report.ledger} wording entries (${report.retired} retired); ${reports.length} advisory reports\n${[...notices, ...retirements].join('\n')}${notices.length || retirements.length ? '\n' : ''}` };
  } catch (error) { return { exitCode: warn ? 0 : 1, output: String(error) + '\n' }; }
}
