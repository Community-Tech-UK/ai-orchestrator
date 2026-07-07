#!/usr/bin/env node
/**
 * Installs managed native sources from resources/native/ into the gitignored
 * iOS project. resources/native/ is the SOURCE OF TRUTH — the ios/ copies are
 * overwritten on every `npm run sync`, so hand-edits belong in resources/.
 *
 * (The HarnessWidgets extension sources are NOT copied here: that target only
 * exists after the one-time Xcode setup in docs/mobile-app/
 * live-activities-setup.md, which adds the file by reference from resources/.)
 */
import { copyFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCES = [
  {
    source: 'resources/native/AppDelegate.swift',
    target: 'ios/App/App/AppDelegate.swift',
  },
];

async function fileText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function ensureIosNativeSources(projectRoot = PROJECT_ROOT) {
  let copied = 0;
  for (const { source, target } of SOURCES) {
    const sourcePath = resolve(projectRoot, source);
    const targetPath = resolve(projectRoot, target);
    const sourceText = await fileText(sourcePath);
    if (sourceText === null) {
      console.warn(`Skipping missing native source ${source}`);
      continue;
    }
    const targetText = await fileText(targetPath);
    if (targetText === sourceText) continue;
    await copyFile(sourcePath, targetPath);
    copied += 1;
    console.log(`Installed ${source} -> ${target}`);
  }
  if (copied === 0) {
    console.log('iOS native sources already up to date');
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;

if (invokedPath === import.meta.url) {
  ensureIosNativeSources().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
