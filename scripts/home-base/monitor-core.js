'use strict';

const net = require('node:net');
const { createHash } = require('node:crypto');
const LATE_MS = 30 * 60_000;
const RUN_STATUSES = new Set(['pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled']);
const RESULTS = new Set(['no_change', 'done', 'needs_attention']);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const nullableTimestamp = value => value === null || timestamp(value);
const limit = value => Number.isSafeInteger(value) && value > 0;

function initialMonitorState() {
  return { version: 1, downSince: null, outageNotified: false, enabledById: {}, activeAlerts: [], outbox: [] };
}

function validateGatewayUrl(value) {
  if (typeof value !== 'string') throw new Error('A literal Tailscale gateway URL is required');
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ip = net.isIP(host);
  const octets = host.split('.').map(Number);
  const tailnet = ip === 4 ? octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
    : ip === 6 && host.startsWith('fd7a:115c:a1e0:');
  if (!tailnet || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || !url.port) {
    throw new Error('Use a literal Tailscale address with a port and no credentials or extra URL parts');
  }
  return url;
}

/** Refuse an incomplete list rather than make a misleading healthy claim. */
function validateJobs(value) {
  if (!Array.isArray(value) || value.length >= 100) throw new Error('The authenticated automation list is invalid or may be truncated');
  const ids = new Set();
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id)
      || typeof item.name !== 'string' || !item.name || item.name.length > 200 || typeof item.enabled !== 'boolean'
      || !nullableTimestamp(item.nextRunAt) || !limit(item.maxRunMinutes)) {
      throw new Error('The authenticated automation list is invalid or from an older build');
    }
    ids.add(item.id);
    const run = item.lastRun;
    if (run === null) continue;
    if (!run || !RUN_STATUSES.has(run.status) || !timestamp(run.at) || typeof run.paused !== 'boolean'
      || !(run.maxRunMinutes === null || limit(run.maxRunMinutes)) || !nullableTimestamp(run.deadlineAt)
      || !(run.result === null || (run.result && RESULTS.has(run.result.outcome) && typeof run.result.notify === 'boolean'))) {
      throw new Error('The authenticated last-run projection is invalid or from an older build');
    }
  }
  return value;
}

function validateMonitorState(state) {
  if (!state || state.version !== 1 || !nullableTimestamp(state.downSince) || typeof state.outageNotified !== 'boolean'
    || !state.enabledById || typeof state.enabledById !== 'object' || Array.isArray(state.enabledById)
    || Object.values(state.enabledById).some(value => typeof value !== 'boolean')
    || !Array.isArray(state.activeAlerts) || state.activeAlerts.some(value => typeof value !== 'string')
    || !Array.isArray(state.outbox) || state.outbox.length > 1000
    || state.outbox.some(alert => !alert || typeof alert.id !== 'string' || typeof alert.subject !== 'string' || typeof alert.text !== 'string')) {
    throw new Error('The saved monitor state is invalid; inspect it before continuing');
  }
  return state;
}

function appendAlert(state, key, subject, text, now) {
  if (state.outbox.length >= 1000) throw new Error('The monitor outbox is full; repair its mail route');
  const id = createHash('sha256').update(`${key}:${now}`).digest('hex').slice(0, 24);
  if (!state.outbox.some(alert => alert.id === id)) state.outbox.push({ id, subject, text });
}

function jobProblems(item, previous, now) {
  const problems = [];
  const add = (key, text) => problems.push({ key: `${item.id}:${key}`, text: `${item.name.replace(/\s+/g, ' ')}: ${text}` });
  const disabledKey = `${item.id}:disabled`;
  if (!item.enabled && (previous.enabledById[item.id] === true || previous.activeAlerts.includes(disabledKey))) {
    add('disabled', 'was switched off.');
  }
  if (item.enabled && item.nextRunAt !== null && now - item.nextRunAt >= LATE_MS) {
    add(`late:${item.nextRunAt}`, 'its next scheduled run is at least 30 minutes late.');
  }
  const run = item.lastRun;
  if (!run) return problems;
  if (run.status === 'failed' || run.status === 'skipped') add(`${run.status}:${run.at}`, `its last run ${run.status}.`);
  if (run.result?.outcome === 'needs_attention') add(`attention:${run.at}`, 'its last run reported that it needs attention.');
  if (run.status === 'running') {
    if (run.paused) add(`paused:${run.at}`, 'its run is paused.');
    else if (run.deadlineAt !== null && now >= run.deadlineAt) add(`timeout:${run.at}`, 'its run is past its saved run limit.');
    else if (run.maxRunMinutes === null) add(`timing:${run.at}`, 'its running limit is unavailable; check the home base.');
  }
  return problems;
}

function evaluateMonitorCheck(previous, observation, now) {
  const state = { ...previous, outbox: [...previous.outbox] };
  const peer = observation.peerReachable ? 'The other computer answered the independent probe.'
    : 'The PC could not reach either the home base or the other computer; this may be a connection problem on the PC.';
  if (observation.jobs === undefined) {
    state.downSince ??= now;
    if (!state.outageNotified && now - state.downSince >= LATE_MS) {
      appendAlert(state, `outage:${state.downSince}`, 'The PC cannot reach the home base',
        `The PC could not reach the home base with its saved device token for at least 30 minutes. ${peer}`, now);
      state.outageNotified = true;
    }
    return state;
  }
  if (state.outageNotified) {
    appendAlert(state, `recovery:${state.downSince}`, 'The home base is reachable again',
      'The PC can read the home base automation list with its saved device token again.', now);
  }
  state.downSince = null;
  state.outageNotified = false;
  const problems = observation.jobs.flatMap(item => jobProblems(item, previous, now));
  const added = problems.filter(problem => !previous.activeAlerts.includes(problem.key));
  state.activeAlerts = problems.map(problem => problem.key);
  state.enabledById = Object.fromEntries(observation.jobs.map(item => [item.id, item.enabled]));
  if (added.length) {
    appendAlert(state, `jobs:${added.map(problem => problem.key).sort().join('|')}`, 'Home-base jobs need attention',
      `${added.map(problem => problem.text).join('\n')}\n\n${observation.peerReachable ? 'The other computer answered the independent probe.' : 'The other computer did not answer the independent probe; the home base did answer.'}`, now);
  }
  return state;
}

function acknowledgeAlert(state, id) {
  return { ...state, outbox: state.outbox.filter(alert => alert.id !== id) };
}

module.exports = {
  initialMonitorState,
  evaluateMonitorCheck,
  validateGatewayUrl,
  validateJobs,
  validateMonitorState,
  acknowledgeAlert,
};
