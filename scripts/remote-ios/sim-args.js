'use strict';
/**
 * `aio-ios sim` takes the arguments `xcrun simctl` would, so an agent can repeat a command from the iOS workflow
 * reference with `aio-ios sim` in front. This turns them into what remote-ios.sh runs on the test Mac: the device
 * becomes @DEVICE@ (the session's simulator there, whatever was named here), files to send become @IN@/<name>, and
 * files to make become @OUT@/<name>, which are copied back to the paths given here.
 */

const fs = require('fs');
const path = require('path');

/** The subcommands that may run, each with the device as its first argument except `list` and `launch`. */
const SIM_SUBCOMMANDS = [
  'list', 'io', 'openurl', 'push', 'privacy', 'launch', 'terminate', 'uninstall', 'get_app_container', 'addmedia',
  'status_bar', 'ui', 'location',
];

/** `launch` options that would stream the app's output until it quits, which a job can't wait for. */
const LAUNCH_REFUSED = /^--(?:console|console-pty|stdout|stderr)(?:=|$)/;

class SimArgsRefused extends Error {}

/**
 * `{ remoteArgs, inputs: [{ local, name }], outputs: [{ name, local }] }`. Throws SimArgsRefused, saying why, for
 * anything off the list.
 */
function mapSimArgs(args, cwd) {
  const [sub, ...rest] = args;
  if (!SIM_SUBCOMMANDS.includes(sub)) {
    throw new SimArgsRefused(`simctl ${sub ?? '(nothing)'} isn't available through aio-ios sim. It takes: ${SIM_SUBCOMMANDS.join(', ')}. `
      + 'To build, install and launch the app, use: aio-ios run');
  }
  const inputs = [];
  const outputs = [];
  const send = (given) => {
    const local = path.resolve(cwd, given);
    if (!fs.existsSync(local) || !fs.statSync(local).isFile()) throw new SimArgsRefused(`${given} is not a file here`);
    const name = `${inputs.length + 1}-${path.basename(local)}`;
    inputs.push({ local, name });
    return `@IN@/${name}`;
  };
  const make = (given) => {
    const name = `${outputs.length + 1}-${path.basename(given)}`;
    outputs.push({ name, local: path.resolve(cwd, given) });
    return `@OUT@/${name}`;
  };

  if (sub === 'list') return { remoteArgs: args, inputs, outputs };
  if (sub === 'launch') {
    const at = rest.findIndex(arg => !arg.startsWith('-'));
    if (at < 0) throw new SimArgsRefused('simctl launch needs a device and a bundle id');
    const refused = rest.slice(0, at).find(arg => LAUNCH_REFUSED.test(arg));
    if (refused) throw new SimArgsRefused(`${refused} waits for the app to quit; use aio-ios logs to read its output`);
    return { remoteArgs: [sub, ...rest.slice(0, at), '@DEVICE@', ...rest.slice(at + 1)], inputs, outputs };
  }
  if (!rest.length) throw new SimArgsRefused(`simctl ${sub} needs a device, such as booted`);
  const [, ...after] = rest;
  let mapped = after;
  if (sub === 'io') {
    const operation = after[0];
    if (operation !== 'screenshot' && operation !== 'recordVideo') {
      throw new SimArgsRefused('aio-ios sim io takes screenshot or recordVideo');
    }
    const file = after.at(-1);
    if (after.length < 2 || file.startsWith('-')) throw new SimArgsRefused(`simctl io ${operation} needs a file to write`);
    mapped = [...after.slice(0, -1), make(file)];
  } else if (sub === 'push') {
    const file = after.at(-1);
    if (!file) throw new SimArgsRefused('simctl push needs a payload file');
    mapped = [...after.slice(0, -1), send(file)];
  } else if (sub === 'addmedia') {
    if (!after.length) throw new SimArgsRefused('simctl addmedia needs at least one file');
    mapped = after.map(send);
  }
  return { remoteArgs: [sub, '@DEVICE@', ...mapped], inputs, outputs };
}

module.exports = { SIM_SUBCOMMANDS, SimArgsRefused, mapSimArgs };
