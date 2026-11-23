/**
 * Whether a checkout holds an application to run checks on.
 *
 * A run started in a parent folder (one that only holds plans, evidence and other repositories) gets an empty
 * check list, so nothing at run start notices that the application is elsewhere. A job that needs the application
 * reports a missing setup, and sending it back to the same folder only repeats the report. The scan looks for a
 * project file at the folder's top and one folder down, which is where a project or a package inside it declares itself.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const PROJECT_FILES = new Set([
  'package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'Package.swift', 'CMakeLists.txt', 'Makefile',
]);
const SKIPPED_FOLDERS = new Set(['node_modules', 'docs', 'dist', 'build']);

async function projectFilesIn(folder: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isFile() && PROJECT_FILES.has(entry.name)).map(entry => path.join(prefix, entry.name));
}

/** The project files found at the top of the folder and one folder down; empty when the folder holds no application. */
export async function findProjectFiles(root: string): Promise<string[]> {
  const found = await projectFilesIn(root, '');
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_FOLDERS.has(entry.name)) continue;
    found.push(...await projectFilesIn(path.join(root, entry.name), entry.name));
  }
  return found;
}
