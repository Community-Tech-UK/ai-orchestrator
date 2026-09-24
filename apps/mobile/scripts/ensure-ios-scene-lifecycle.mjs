#!/usr/bin/env node
/**
 * Adds a UIApplicationSceneManifest to the gitignored iOS Info.plist so the app
 * launches through the UIScene lifecycle. iOS 27 terminates apps built with the
 * iOS 27 SDK that still use the app-delegate-only lifecycle (EXC_BREAKPOINT in
 * `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`), and the
 * Capacitor 7 template ships without a manifest.
 *
 * The scene loads Main.storyboard (initial view controller: CAPBridgeViewController)
 * and is driven by `SceneDelegate` in resources/native/AppDelegate.swift. The
 * legacy `UIMainStoryboardFile` key is removed because the scene storyboard
 * replaces it.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IOS_INFO_PLIST = 'ios/App/App/Info.plist';

const SCENE_MANIFEST_KEY = '<key>UIApplicationSceneManifest</key>';

const SCENE_MANIFEST = `\t${SCENE_MANIFEST_KEY}
\t<dict>
\t\t<key>UIApplicationSupportsMultipleScenes</key>
\t\t<false/>
\t\t<key>UISceneConfigurations</key>
\t\t<dict>
\t\t\t<key>UIWindowSceneSessionRoleApplication</key>
\t\t\t<array>
\t\t\t\t<dict>
\t\t\t\t\t<key>UISceneConfigurationName</key>
\t\t\t\t\t<string>Default Configuration</string>
\t\t\t\t\t<key>UISceneDelegateClassName</key>
\t\t\t\t\t<string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>
\t\t\t\t\t<key>UISceneStoryboardFile</key>
\t\t\t\t\t<string>Main</string>
\t\t\t\t</dict>
\t\t\t</array>
\t\t</dict>
\t</dict>`;

const LEGACY_MAIN_STORYBOARD = /\n[ \t]*<key>UIMainStoryboardFile<\/key>\s*<string>[^<]*<\/string>/;

export function withSceneLifecycle(plist) {
  let updated = plist.replace(LEGACY_MAIN_STORYBOARD, '');
  if (updated.includes(SCENE_MANIFEST_KEY)) {
    return updated;
  }
  if (!updated.includes('\n</dict>')) {
    throw new Error('Cannot add UIApplicationSceneManifest: Info.plist is missing </dict>');
  }
  updated = updated.replace(/\n<\/dict>/, `\n${SCENE_MANIFEST}\n</dict>`);
  return updated;
}

export async function ensureIosSceneLifecycle(projectRoot = PROJECT_ROOT) {
  const plistPath = resolve(projectRoot, IOS_INFO_PLIST);
  const original = await readFile(plistPath, 'utf8');
  const updated = withSceneLifecycle(original);

  if (updated !== original) {
    await writeFile(plistPath, updated);
    console.log(`Updated ${IOS_INFO_PLIST} to the UIScene lifecycle`);
  } else {
    console.log(`${IOS_INFO_PLIST} already uses the UIScene lifecycle`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;

if (invokedPath === import.meta.url) {
  ensureIosSceneLifecycle().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
