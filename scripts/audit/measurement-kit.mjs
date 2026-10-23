// Read-only audit rules: label observed/modelled; coverage first; >=3 repeats;
// ±3% is noise; exclude research sweeps; deduplicate message IDs; read/write/output
// mix accompanies every ratio. Only normalized, explicitly classified exports enter.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const kinds = new Set(['human', 'queue', 'loop', 'scheduled', 'research-sweep']);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const emit = row => process.stdout.write(JSON.stringify(row) + '\n');

async function scan(file) {
  const coverage = { kind: 'coverage', observed: true, lines: 0, accepted: 0, invalid: 0, duplicates: 0, researchExcluded: 0, contextMeasured: 0, toolMeasured: 0 };
  const seen = new Set();
  const events = [];
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    coverage.lines++;
    let row;
    try { row = JSON.parse(line); } catch { coverage.invalid++; continue; }
    if (!row || !kinds.has(row.sessionKind) || typeof row.messageId !== 'string' || !row.messageId || typeof row.sessionId !== 'string' || !row.sessionId || !['timestamp', 'readTokens', 'writeTokens', 'outputTokens'].every(key => number(row[key]))) { coverage.invalid++; continue; }
    if (row.sessionKind === 'research-sweep') { coverage.researchExcluded++; continue; }
    if (seen.has(row.messageId)) { coverage.duplicates++; continue; }
    seen.add(row.messageId);
    coverage.accepted++;
    if (number(row.contextTokens)) coverage.contextMeasured++;
    if (typeof row.toolName === 'string') coverage.toolMeasured++;
    events.push(row);
  }
  return { coverage, events };
}

function result(mode, events, ceiling) {
  const mix = events.reduce((sum, row) => ({ read: sum.read + row.readTokens, write: sum.write + row.writeTokens, output: sum.output + row.outputTokens }), { read: 0, write: 0, output: 0 });
  const base = { kind: 'result', mix, noisePercent: 3 };
  if (mode === 'context-ceiling-replay') {
    const measured = events.filter(row => number(row.contextTokens) && row.contextTokens > 0);
    const observedInput = measured.reduce((sum, row) => sum + row.readTokens + row.writeTokens, 0);
    const inputTokens = measured.reduce((sum, row) => sum + (row.readTokens + row.writeTokens) * Math.min(1, ceiling / row.contextTokens), 0);
    return { ...base, observed: { inputTokens: observedInput, requests: measured.length }, modelled: { inputTokens, ceiling, ratio: observedInput ? inputTokens / observedInput : null, limitation: 'Per-request ceiling bound only; excludes summary calls, retries and quality effects. This is not a forecast of actual savings.' } };
  }
  if (mode === 'composition-scan') {
    const components = Object.create(null);
    for (const row of events) {
      const key = typeof row.component === 'string' ? row.component : 'unclassified';
      const group = components[key] ?? { read: 0, write: 0, output: 0 };
      group.read += row.readTokens; group.write += row.writeTokens; group.output += row.outputTokens;
      Object.defineProperty(components, key, { value: group, enumerable: true, configurable: true, writable: true });
    }
    return { ...base, observed: { components, cacheReadRatio: mix.read + mix.write ? mix.read / (mix.read + mix.write) : null } };
  }
  const polls = events.filter(row => typeof row.toolName === 'string' && /(?:poll|wait|read_node_output|get_.*status)/i.test(row.toolName));
  const last = new Map();
  let repeatedWithinMinute = 0;
  for (const row of [...polls].sort((a, b) => a.timestamp - b.timestamp)) {
    const key = JSON.stringify([row.sessionId, row.toolName]);
    const prior = last.get(key);
    if (prior !== undefined && row.timestamp - prior <= 60_000) repeatedWithinMinute++;
    last.set(key, row.timestamp);
  }
  return { ...base, observed: { polls: polls.length, repeatedWithinMinute, pollMessageRatio: events.length ? polls.length / events.length : null, limitation: 'Tool-name classification counts messages, not nested tool calls. Repeated polls are not necessarily avoidable.' } };
}

export async function runAudit(mode, args = process.argv.slice(2)) {
  try {
    const [file, ...flags] = args;
    let repeats = 3;
    let ceiling = 272_000;
    for (let i = 0; i < flags.length; i += 2) {
      const value = Number(flags[i + 1]);
      if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) throw new Error('Flags need positive integer values.');
      if (flags[i] === '--repeats') repeats = value;
      else if (flags[i] === '--ceiling') ceiling = value;
      else throw new Error(`Unknown flag: ${flags[i]}`);
    }
    if (!file || repeats < 3 || repeats > 100) throw new Error('Usage: <script> normalized.jsonl [--repeats 3..100] [--ceiling 272000]');
    let first;
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const started = performance.now();
      const { coverage, events } = await scan(file);
      emit({ ...coverage, repeat }); // Always before any ratio or model.
      const report = result(mode, events, ceiling);
      const signature = JSON.stringify({ coverage, report });
      first ??= signature;
      if (signature !== first) throw new Error('Input changed between repeats; discard this run.');
      emit({ ...report, repeat, elapsedMs: performance.now() - started });
    }
    emit({ kind: 'interpretation', repeats, rule: 'Differences within ±3% are noise; repeated scans measure stability, not independent samples.' });
  } catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
}
