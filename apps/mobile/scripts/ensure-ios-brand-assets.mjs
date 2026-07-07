#!/usr/bin/env node
/**
 * Copies the tracked brand assets (resources/) into the gitignored iOS
 * project. The ios/ tree is regenerable (`npx cap add ios`), which previously
 * left the stock Capacitor icon/splash shipping on the phone — this makes the
 * brand assets survive a regeneration. Runs as part of `npm run sync`.
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ASSETS = [
  {
    source: 'resources/AppIcon-1024.png',
    targets: ['ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'],
  },
  {
    source: 'resources/Splash-2732.png',
    targets: [
      'ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png',
      'ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png',
      'ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png',
    ],
  },
];

async function fileBytes(path) {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

export async function ensureIosBrandAssets(projectRoot = PROJECT_ROOT) {
  let copied = 0;
  for (const { source, targets } of ASSETS) {
    const sourcePath = resolve(projectRoot, source);
    const sourceBytes = await fileBytes(sourcePath);
    if (!sourceBytes) {
      console.warn(`Skipping missing brand asset ${source}`);
      continue;
    }
    for (const target of targets) {
      const targetPath = resolve(projectRoot, target);
      const targetBytes = await fileBytes(targetPath);
      if (targetBytes && targetBytes.equals(sourceBytes)) {
        continue;
      }
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      copied += 1;
      console.log(`Installed ${source} -> ${target}`);
    }
  }
  if (copied === 0) {
    console.log('iOS brand assets already up to date');
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;

if (invokedPath === import.meta.url) {
  ensureIosBrandAssets().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
