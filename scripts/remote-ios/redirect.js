#!/usr/bin/env node
'use strict';
/**
 * Decides, for shim.sh, whether xcodebuild, xcrun simctl or maestro runs here. shim.sh only asks inside a Harness
 * agent session; James's own Terminal, Xcode and scripts never reach this.
 *
 * Exits 64 after printing the aio-ios command to use instead, when the work is iPhone simulator work in an app on the
 * test Mac's list and the test Mac can take it. Exits 0 otherwise, and shim.sh runs the real tool: App Store builds
 * and read-only queries quietly; everything else with one line saying why it is running here.
 */

const os = require('os');
const { findApp } = require('./apps');
const { SIM_SUBCOMMANDS } = require('./sim-args');
const { findTestMac, probe } = require('./test-mac');
const { appendRunLog, isLoopRun } = require('../remote-checks/route');

const REDIRECTED = 64;
const RUN_HERE = 0;

/** xcodebuild's actions. */
const XCODEBUILD_ACTIONS = new Set([
  'build', 'clean', 'build-for-testing', 'test', 'test-without-building', 'analyze', 'archive', 'docbuild', 'install', 'installsrc',
]);
/** xcodebuild modes that build nothing for the simulator: exports, frameworks, queries and set-up. */
const XCODEBUILD_OTHER_MODES = new Set([
  '-exportArchive', '-exportNotarizedApp', '-create-xcframework', '-showBuildSettings', '-list', '-version', '-showsdks',
  '-showdestinations', '-resolvePackageDependencies', '-help', '-usage', '-license', '-checkFirstLaunchStatus',
  '-runFirstLaunch', '-downloadPlatform', '-downloadAllPlatforms', '-exportLocalizations', '-importLocalizations',
  '-showTestPlans', '-showComponent',
]);
/** A simulator's id. A real iPhone's has another shape, such as 00008120-001A2B3C4D5E6F7A. */
const SIMULATOR_ID = /(?:^|,)id=[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}(?:,|$)/i;
/** maestro runs here for these, which drive no device. */
const MAESTRO_HERE = new Set(['-v', '--version', '-h', '--help', 'check-syntax', 'login', 'logout', 'cloud', 'list-cloud-devices', 'bugreport', 'download-samples']);
/** maestro test options that take a value, so it isn't read as a flow. */
const MAESTRO_VALUE_OPTIONS = new Set(['--format', '--output', '--test-output-dir', '--debug-output', '--config', '--udid', '--device',
  '-p', '--platform', '--include-tags', '--exclude-tags', '--shard-split', '--shard-all', '--test-suite-name', '--screen-size']);
/** xcrun options that take a value. */
const XCRUN_VALUE_OPTIONS = new Set(['-sdk', '--sdk', '-toolchain', '--toolchain']);

function shellWord(word) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** simctl's own arguments, or null when xcrun is running another tool. */
function simctlArgs(args) {
  for (let at = 0; at < args.length; at += 1) {
    if (XCRUN_VALUE_OPTIONS.has(args[at])) at += 1;
    else if (!args[at].startsWith('-')) return args[at] === 'simctl' ? args.slice(at + 1) : null;
  }
  return null;
}

/**
 * Only a simulator build goes, as that is all `aio-ios build` does: one that names a simulator destination or SDK, or
 * names neither, which is the compile check agents usually mean. Archives and exports need the signing kept off the
 * test Mac; device builds, XCTest runs, `clean` on its own, frameworks and queries stay here as well.
 */
function isSimulatorBuild(args) {
  if (args.some(arg => XCODEBUILD_OTHER_MODES.has(arg))) return false;
  const actions = args.filter(arg => XCODEBUILD_ACTIONS.has(arg));
  if (actions.length && (!actions.includes('build') || actions.some(action => action !== 'build' && action !== 'clean'))) return false;
  const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] ?? '' : null);
  const destination = value('-destination');
  if (destination !== null) return /simulator/i.test(destination) || SIMULATOR_ID.test(destination);
  const sdk = value('-sdk');
  return sdk === null || sdk.startsWith('iphonesimulator');
}

/** `{ action, rest }` for the aio-ios command that does this, or null when it isn't simulator work. */
function suggestion(tool, args) {
  if (tool === 'xcodebuild') return isSimulatorBuild(args) ? { action: 'build', rest: [] } : null;
  if (tool === 'xcrun') {
    const sim = simctlArgs(args);
    if (!sim || !sim.length || sim[0] === 'help' || sim.includes('--help')) return null;
    if (SIM_SUBCOMMANDS.includes(sim[0])) return { action: 'sim', rest: sim };
    if (sim[0] === 'spawn' && sim.includes('log')) return { action: 'logs', rest: [] };
    return { action: 'run', rest: [] };
  }
  if (tool === 'maestro') {
    if (args.some(arg => MAESTRO_HERE.has(arg))) return null;
    const at = args.indexOf('test');
    if (at < 0) return { action: 'test', rest: ['<flow files>'] };
    const values = [];
    const flows = [];
    for (let next = at + 1; next < args.length; next += 1) {
      if (args[next] === '-e' || args[next] === '--env') values.push('--env', args[(next += 1)] ?? '');
      else if (args[next].startsWith('-')) next += MAESTRO_VALUE_OPTIONS.has(args[next]) ? 1 : 0;
      else flows.push(args[next]);
    }
    return { action: 'test', rest: [...values, ...(flows.length ? flows : ['<flow files>'])] };
  }
  return null;
}

/**
 * `{ code, message, log }`: the exit code for shim.sh, a line for the agent (or null), and a run log entry when iPhone
 * work in a listed app ran here.
 */
function decide({ tool, args, cwd, env = process.env, home = os.homedir(), apps = undefined, check = probe }) {
  const wanted = suggestion(tool, args);
  if (!wanted) return { code: RUN_HERE, message: null, log: null };
  const found = findApp(cwd, { home, apps });
  const here = (reason, app) => ({
    code: RUN_HERE,
    message: `${tool}: running on this Mac because ${reason}.`,
    log: app ? { project: app, kind: 'ios', action: tool, ranOn: 'mac', exitCode: null, fellBackBecause: reason } : null,
  });
  if (!found) return here("this repository isn't on the test Mac's list (scripts/remote-ios/apps.js in ai-orchestrator)", null);
  const appId = found.app?.id ?? found.choices[0];
  if (env.AIO_IOS_LOCAL === '1') return here('AIO_IOS_LOCAL=1 asked for it', appId);
  const place = findTestMac(env);
  if (!place.machine) return here(place.reason, appId);
  const answer = check(place.machine, { env });
  if (!answer.ok) return here(answer.reason, appId);
  const appOption = found.choices && wanted.action !== 'sim' ? ['--app', `<${found.choices.join('|')}>`] : [];
  const command = ['aio-ios', wanted.action, ...appOption, ...wanted.rest].map(word => (word.startsWith('<') ? word : shellWord(word))).join(' ');
  return {
    code: REDIRECTED,
    message: `iPhone builds and simulators run on the test Mac. Use: ${command}   (aio-ios help lists the commands)`,
    log: null,
  };
}

if (require.main === module) {
  const [tool, ...args] = process.argv.slice(2);
  let outcome;
  try {
    outcome = decide({ tool, args, cwd: process.cwd() });
  } catch (err) {
    // The tool still has to work: run it here, saying why.
    outcome = { code: RUN_HERE, message: `${tool}: running on this Mac because the redirect failed (${err.message}).`, log: null };
  }
  if (outcome.message) process.stderr.write(`${outcome.message}\n`);
  if (outcome.log) appendRunLog({ at: new Date().toISOString(), loop: isLoopRun(), tookMs: 0, waitedMs: 0, ...outcome.log });
  process.exitCode = outcome.code;
}

module.exports = { REDIRECTED, decide, suggestion };
