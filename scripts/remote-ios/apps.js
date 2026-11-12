'use strict';
/**
 * The iPhone apps whose simulator builds go to the test Mac, and how to build each one there from a snapshot of its
 * repository. A repository is matched by its real git folder, as scripts/remote-checks/projects.js does, so a copy
 * with the same name doesn't count and its Plan Queue worktrees do. Nothing under ~/work/ebrd ever goes. Adding an app
 * needs James to name it.
 *
 * Left out on purpose:
 * - paid-video-calls-ios-shell is not in git, and its web files are copied in from ../paid-video-calls, outside it.
 * - DockAnchor is a macOS app.
 *
 * Each recipe runs on the test Mac, from the repository's root unless it says otherwise:
 * - `install` once per change to `installInputs` (or to the command itself), from the root.
 * - `web` builds the web files, and `sync` copies them into the iPhone project, both from `folder`.
 * - xcodebuild then builds `scheme` from `xcode`, relative to `folder`, for the slot's simulator, with no signing.
 * Node comes from `nodeFile` in the snapshot, or `nodeVersion`. `pnpm` is corepack's, which Node 24 still ships, so it
 * is the version a repository names in `packageManager`.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanGitEnv } = require('../remote-checks/snapshot');

const PNPM_INSTALL = 'pnpm install --frozen-lockfile';

const APPS = [
  {
    id: 'heyfocus',
    repository: 'work/heyfocus',
    folder: '.',
    nodeVersion: '24',
    installInputs: ['package-lock.json', 'package.json'],
    install: 'npm ci --no-audit --no-fund',
    web: 'npm run build',
    sync: 'npx cap sync ios',
    xcode: { project: 'ios/App/App.xcodeproj' },
    scheme: 'App',
    bundleId: 'com.heyfocus.app',
  },
  {
    id: '12steps',
    repository: 'work/12steps',
    folder: 'apps/web',
    nodeFile: '.node-version',
    installInputs: ['pnpm-lock.yaml', 'package.json', 'apps/web/package.json'],
    // The repository's .npmrc never leaves this Mac, so its two settings come with the command.
    install: `${PNPM_INSTALL} --config.auto-install-peers=true --config.strict-peer-dependencies=false`,
    web: 'pnpm run build:native',
    sync: 'pnpm exec cap sync ios',
    xcode: { project: 'ios/App/App.xcodeproj' },
    scheme: 'App',
    bundleId: 'com.twelvesteps.app',
  },
  {
    id: 'binsout',
    repository: 'work/micro-businesses/binsout',
    folder: 'mobile/capacitor-shell',
    nodeVersion: '24',
    installInputs: ['mobile/capacitor-shell/package-lock.json', 'mobile/capacitor-shell/package.json'],
    install: 'cd mobile/capacitor-shell && npm ci --no-audit --no-fund',
    // The shell loads https://binsout.uk/, so there is no web build: www/ is committed.
    web: 'true',
    sync: 'npx cap sync ios',
    xcode: { project: 'ios/App/App.xcodeproj' },
    scheme: 'App',
    bundleId: 'uk.binsout.app',
  },
  {
    id: 'mytrademail',
    repository: 'work/easy-tech/mytrademail',
    folder: 'frontend',
    matches: ['frontend/ios'],
    nodeVersion: '24',
    installInputs: ['frontend/package-lock.json', 'frontend/package.json'],
    install: 'cd frontend && npm ci --no-audit --no-fund',
    web: 'npm run cap:build:ios:mtm',
    sync: 'true',
    xcode: { project: 'ios/App/App.xcodeproj' },
    scheme: 'App',
    bundleId: 'uk.co.mytrademail.app',
  },
  {
    id: 'mytrademail-sbe',
    repository: 'work/easy-tech/mytrademail',
    folder: 'frontend',
    matches: ['frontend/ios-sbe'],
    nodeVersion: '24',
    installInputs: ['frontend/package-lock.json', 'frontend/package.json'],
    install: 'cd frontend && npm ci --no-audit --no-fund',
    web: 'npm run cap:build:ios:sbe',
    sync: 'true',
    xcode: { project: 'ios-sbe/App/App.xcodeproj' },
    scheme: 'App',
    bundleId: 'email.simplebusiness.app',
  },
  {
    id: 'undistilled-member',
    repository: 'work/undistilled',
    folder: 'apps/member',
    nodeFile: '.nvmrc',
    installInputs: ['package-lock.json', 'package.json', 'apps/member/package.json'],
    install: 'npm ci --no-audit --no-fund',
    // Its own script builds, syncs and checks what it synced.
    web: 'npm run cap:sync:ios',
    sync: 'true',
    xcode: { project: 'ios/App/App.xcodeproj' },
    scheme: 'App',
    bundleId: 'uk.co.communitytech.undistilled.local',
  },
  {
    id: 'app-studio-template',
    repository: 'work/app-studio',
    folder: 'template/app',
    nodeVersion: '24',
    installInputs: ['pnpm-lock.yaml', 'package.json', 'template/app/package.json'],
    install: PNPM_INSTALL,
    // As App Studio's own device test builds it (studio/src/apps/device-smoke.ts): the device environment.
    web: 'pnpm run prebuild && pnpm exec ng build --configuration smoke',
    // The template's native projects are never committed: they are made as its own native-build-check.sh makes them.
    // Its set-up step expects both, though only the iPhone one is built here.
    sync: 'pnpm exec cap add ios && pnpm exec cap add android && APP_STUDIO_DEVICE_TEST=1 pnpm exec cap sync ios && ../../node_modules/.bin/tsx ../../studio/src/apps/native-setup.ts "$PWD"',
    xcode: { project: 'ios/App/App.xcodeproj' },
    scheme: 'App',
    bundleId: 'uk.appstudio.template',
  },
  {
    id: 'app-studio-demo',
    repository: 'work/app-studio',
    folder: 'apps/demo-app',
    nodeVersion: '24',
    installInputs: ['pnpm-lock.yaml', 'package.json', 'apps/demo-app/package.json'],
    install: PNPM_INSTALL,
    web: 'pnpm run prebuild && pnpm exec ng build --configuration smoke',
    sync: 'APP_STUDIO_DEVICE_TEST=1 pnpm exec cap sync ios && ../../node_modules/.bin/tsx ../../studio/src/apps/native-setup.ts "$PWD"',
    xcode: { project: 'ios/App/App.xcodeproj' },
    scheme: 'App',
    bundleId: 'test.appstudio.demoapp',
  },
];

/** Never sent, whatever the list says. */
const NEVER_UNDER = ['work/ebrd'];

function gitPath(cwd, ...args) {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', ...args], {
    cwd, encoding: 'utf8', env: cleanGitEnv(), stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function inside(folder, rel) {
  return folder === '.' || rel === folder || rel.startsWith(`${folder}/`);
}

/** True for a folder whose files must never leave this Mac, whatever the list says. */
function neverSent(dir, home = os.homedir()) {
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return false;
  }
  const realHome = fs.realpathSync(home);
  return NEVER_UNDER.some(folder => inside(path.join(realHome, folder), real));
}

/**
 * The app for a folder: `{ app, root }`, or `{ choices }` when the repository has several and the folder doesn't say
 * which, or null when it isn't a listed repository. `appId` picks one by name; it must belong to this repository.
 * `home` and `apps` are only ever different in tests.
 */
function findApp(cwd, { appId, home = os.homedir(), apps = APPS } = {}) {
  let commonDir;
  let root;
  try {
    commonDir = fs.realpathSync(gitPath(cwd, '--git-common-dir'));
    root = fs.realpathSync(gitPath(cwd, '--show-toplevel'));
  } catch {
    return null;
  }
  const realHome = fs.realpathSync(home);
  if (neverSent(root, realHome)) return null;
  const listed = apps.filter(entry => path.join(realHome, entry.repository, '.git') === commonDir);
  if (!listed.length) return null;
  if (appId) {
    const named = listed.find(entry => entry.id === appId);
    return named ? { app: named, root } : { choices: listed.map(entry => entry.id) };
  }
  if (listed.length === 1) return { app: listed[0], root };
  const here = path.relative(root, fs.realpathSync(cwd)).split(path.sep).join('/') || '.';
  const matching = listed.filter(entry => (entry.matches ?? [entry.folder]).some(folder => inside(folder, here)));
  return matching.length === 1 ? { app: matching[0], root } : { choices: listed.map(entry => entry.id) };
}

module.exports = { APPS, findApp, neverSent };
