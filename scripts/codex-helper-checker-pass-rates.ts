/**
 * Checker pass rate per helper-trial arm (Oct-2 Phase A, T3 step 1): read-only, from the policy log and
 * `plan_queue_items`. Run: npx tsx scripts/codex-helper-checker-pass-rates.ts --since YYYY-MM-DD
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePolicyLog } from './codex-helper-trial-report.mjs';
interface ItemOutcome { id: string; verdict_json: string | null }
interface ArmCounts { passed: number; failed: number; unknown: number; passRate: number | null }
const empty = (): ArmCounts => ({ passed: 0, failed: 0, unknown: 0, passRate: null });
/** One latest verdict per item, not all checker rounds. Unknown is never a pass. */
export function summarizeCheckerPassRates(items: ItemOutcome[], policies: Record<string, unknown>[]): { arms: { off: ArmCounts; full: ArmCounts }; excludedMixed: number; unassigned: number } {
  const exposures = new Map<string, Set<'off' | 'full'>>();
  for (const policy of policies) {
    if (policy['provider'] !== 'codex' || policy['sessionKind'] !== 'plan-queue' || (policy['helperPolicyApplied'] ?? policy['applied']) !== true || policy['arm'] === 'unassigned'
      || typeof policy['armKey'] !== 'string' || !['off', 'full'].includes(String(policy['level']))) continue;
    const key = policy['armKey']; const levels = exposures.get(key) ?? new Set<'off' | 'full'>();
    levels.add(policy['level'] as 'off' | 'full'); exposures.set(key, levels);
  }
  const result = { arms: { off: empty(), full: empty() }, excludedMixed: 0, unassigned: 0 };
  for (const item of items) {
    const hashed = createHash('sha256').update(item.id).digest('hex');
    const levels = new Set([...(exposures.get(item.id) ?? []), ...(exposures.get(hashed) ?? [])]);
    if (levels.size > 1) { result.excludedMixed++; continue; }
    const [level] = levels; if (!level) { result.unassigned++; continue; }
    const arm = result.arms[level];
    let verdict: unknown;
    try { verdict = item.verdict_json ? (JSON.parse(item.verdict_json) as { verdict?: unknown })?.verdict : null; } catch { verdict = null; }
    if (verdict === 'PASS') arm.passed++;
    else if (verdict === 'FAIL') arm.failed++;
    else arm.unknown++;
  }
  for (const arm of Object.values(result.arms)) if (arm.passed + arm.failed > 0) arm.passRate = arm.passed / (arm.passed + arm.failed);
  return result;
}
function main(): void {
  const arg = (name: string, fallback: string) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] ?? fallback : fallback; };
  const since = Date.parse(arg('since', '2026-10-17')); const until = Date.parse(arg('until', new Date().toISOString()));
  if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) throw new Error('Provide an increasing --since/--until date range');
  const userData = arg('userdata', join(homedir(), 'Library', 'Application Support', 'harness'));
  const policyDir = arg('policy-dir', join(userData, 'session-policy'));
  const { entries, unparsableLines } = parsePolicyLog(policyDir, since, until);
  if (unparsableLines > 0) throw new Error('Incomplete policy evidence');
  const policies = entries.filter(row => row.atMs >= since);
  const db = arg('loop-db', join(userData, 'loop-mode', 'loop-mode.db'));
  const raw = execFileSync('sqlite3', ['-readonly', '-json', db, `SELECT id, verdict_json FROM plan_queue_items WHERE updated_at >= ${since} AND updated_at < ${until}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const items = JSON.parse(raw || '[]') as ItemOutcome[];
  process.stdout.write(JSON.stringify({ since: new Date(since).toISOString(), until: new Date(until).toISOString(), measure: 'Latest checker verdict per item; pass / (pass + fail), with missing verdicts reported separately',
    limitations: ['No per-round history exists yet; this is not an all-round checker pass rate.', 'It is not yet part of the helper trial report.', 'A week of comparable evidence and a settings migration are required before changing the trial default.'],
    ...summarizeCheckerPassRates(items, policies) }, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch { process.stderr.write('Read-only checker report unavailable; no trial conclusion can be drawn\n'); process.exitCode = 1; }
}
