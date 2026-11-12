#!/usr/bin/env node
'use strict';
/**
 * Where test runs and checks happened, per day, from the run log.
 *
 *   node scripts/remote-checks/report.js [--since YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');
const { readConfig, remoteChecksDir } = require('./route');

const KIND_NAMES = {
  full: 'full test runs',
  targeted: 'long test lists',
  commit: 'commit-time tests',
  project: "other projects' tests",
  local: 'small test runs',
  checks: 'checks',
  ios: 'iPhone builds and simulators',
};

/** Every run in the log folder, the older file first. */
function readRuns(dir) {
  const text = ['runs.old.jsonl', 'runs.jsonl'].map((name) => {
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      return '';
    }
  }).join('\n');
  return text.split('\n').flatMap(line => {
    try {
      const run = JSON.parse(line);
      return typeof run.at === 'string' && typeof run.ranOn === 'string' ? [run] : [];
    } catch {
      return [];
    }
  });
}

/**
 * `{ day: { kind: { machine: { runs, minutes } } } }` plus fall-back reasons per day. `names` turns a
 * host into what a person calls it.
 */
function summarise(runs, since = '', names = {}) {
  const days = {};
  for (const run of runs) {
    const day = run.at.slice(0, 10);
    if (day < since) continue;
    const entry = days[day] ??= { kinds: {}, fellBack: {} };
    const kind = KIND_NAMES[run.kind ?? 'full'] ?? run.kind;
    const machine = run.ranOn === 'mac' ? 'this Mac' : run.ranOn === 'none' ? 'no computer (not run)' : names[run.ranOn] ?? run.ranOn;
    const cell = (entry.kinds[kind] ??= {})[machine] ??= { runs: 0, minutes: 0 };
    cell.runs += 1;
    cell.minutes += (run.tookMs ?? 0) / 60_000;
    if (run.fellBackBecause) entry.fellBack[run.fellBackBecause] = (entry.fellBack[run.fellBackBecause] ?? 0) + 1;
  }
  return days;
}

function format(days) {
  const lines = [];
  for (const day of Object.keys(days).sort()) {
    lines.push(day);
    for (const [kind, machines] of Object.entries(days[day].kinds)) {
      const parts = Object.entries(machines).map(([machine, cell]) =>
        `${cell.runs} on ${machine} (${Math.round(cell.minutes)} min)`);
      lines.push(`  ${kind}: ${parts.join(', ')}`);
    }
    for (const [reason, count] of Object.entries(days[day].fellBack)) {
      lines.push(`  ran here ${count}x because ${reason}`);
    }
  }
  return lines.length ? lines.join('\n') : 'No runs recorded.';
}

if (require.main === module) {
  const at = process.argv.indexOf('--since');
  const since = at >= 0 ? process.argv[at + 1] ?? '' : '';
  let config = null;
  try {
    config = readConfig();
  } catch {
    /* a broken config only costs the friendly name */
  }
  const names = Object.fromEntries((config?.machines ?? []).map(machine => [machine.host, machine.label]));
  console.log(format(summarise(readRuns(remoteChecksDir()), since, names)));
}

module.exports = { format, readRuns, summarise };
