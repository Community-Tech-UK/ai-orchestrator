import { z } from 'zod/v4';

/**
 * Wire contract and bundle rules for installing a branch's browser extension on a
 * browser computer for one test run (`browser.extension.testInstall`). Shared by the
 * coordinator (which refuses early) and the worker (which is the authority).
 */

export const EXTENSION_TEST_MAX_FILES = 64;
export const EXTENSION_TEST_MAX_BYTES = 3 * 1024 * 1024;
export const EXTENSION_TEST_DEFAULT_TTL_MS = 30 * 60_000;
export const EXTENSION_TEST_MIN_TTL_MS = 60_000;
export const EXTENSION_TEST_MAX_TTL_MS = 120 * 60_000;
/** Longest the worker waits for the extension to reload onto the version it was told to expect. */
export const EXTENSION_TEST_RELOAD_WAIT_MS = 90_000;

const FILE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const ALLOWED_EXTENSIONS = new Set(['.js', '.json', '.html', '.css', '.md', '.png']);
const VERSION_PATTERN = /^\d+(?:\.\d+){0,3}$/;

const OwnerIdSchema = z.string().trim().min(1).max(200);

export const ExtensionTestFileSchema = z.object({
  name: z.string().min(1).max(128),
  contentBase64: z.string().max(Math.ceil((EXTENSION_TEST_MAX_BYTES * 4) / 3) + 8),
}).strict();

export const BrowserExtensionTestParamsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('install'),
    ownerId: OwnerIdSchema,
    ttlMs: z.number().int().min(EXTENSION_TEST_MIN_TTL_MS).max(EXTENSION_TEST_MAX_TTL_MS),
    files: z.array(ExtensionTestFileSchema).min(1).max(EXTENSION_TEST_MAX_FILES),
  }).strict(),
  z.object({ action: z.literal('restore'), ownerId: OwnerIdSchema }).strict(),
]);
export type BrowserExtensionTestParams = z.infer<typeof BrowserExtensionTestParamsSchema>;

export const BrowserExtensionTestResultSchema = z.object({
  state: z.enum(['idle', 'active']),
  leaseId: z.string().optional(),
  ownerId: z.string().optional(),
  testVersion: z.string().optional(),
  originalVersion: z.string().optional(),
  expiresAt: z.number().int().nonnegative().optional(),
  /** Version the extension itself last reported to the worker (undefined before first contact). */
  runningExtensionVersion: z.string().optional(),
  /** True when the running extension reported the version the folder now holds. */
  reloadObserved: z.boolean().optional(),
  /** Set on `restore`: true when files were put back, false when there was nothing to restore. */
  restored: z.boolean().optional(),
}).strict();
export type BrowserExtensionTestResult = z.infer<typeof BrowserExtensionTestResultSchema>;

export class ExtensionTestRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExtensionTestRefusal';
  }
}

export interface ExtensionTestBundleFile {
  name: string;
  content: Buffer;
}

export function isSafeExtensionFileName(name: string): boolean {
  if (!FILE_NAME_PATTERN.test(name) || name.includes('..')) return false;
  const dot = name.lastIndexOf('.');
  return dot > 0 && ALLOWED_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/** Numeric dotted-version compare: negative when a < b. Missing parts count as zero. */
export function compareExtensionVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function parseExtensionManifest(content: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf-8').replace(/^﻿/, ''));
  } catch {
    throw new ExtensionTestRefusal('manifest_invalid', 'manifest.json is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ExtensionTestRefusal('manifest_invalid', 'manifest.json must be an object');
  }
  return parsed as Record<string, unknown>;
}

export function manifestVersion(manifest: Record<string, unknown>): string {
  const version = manifest['version'];
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new ExtensionTestRefusal('manifest_invalid', 'manifest.json needs a numeric dotted "version"');
  }
  return version;
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

/** One grant per field of an object, so a value moved to another field is a new grant. */
function addKeyedGrants(out: Set<string>, kind: string, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [field, inner] of Object.entries(value)) {
    for (const item of strings(inner)) out.add(`${kind}.${field}:${item}`);
  }
}

/**
 * A web accessible resource is reachable from the sites and extensions named in the
 * same entry, so each resource is paired with each of its own matches and ids: moving
 * a resource to another entry's hosts is a new grant even though no string is new.
 */
function addWebAccessibleGrants(out: Set<string>, entry: Record<string, unknown>): void {
  const resources = strings(entry['resources']);
  const matches = strings(entry['matches']);
  const ids = strings(entry['extension_ids']);
  const dynamic = entry['use_dynamic_url'] === true;
  for (const resource of resources) {
    for (const match of matches.length > 0 ? matches : ['']) {
      for (const id of ids.length > 0 ? ids : ['']) {
        out.add(`web_accessible_resources:${JSON.stringify([resource, match, id, dynamic])}`);
      }
    }
  }
}

/** Everything Chrome grants this extension on the profile, as comparable `kind:value` strings. */
function grants(manifest: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const key of ['permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions']) {
    for (const value of strings(manifest[key])) out.add(`${key}:${value}`);
  }
  addKeyedGrants(out, 'externally_connectable', manifest['externally_connectable']);
  const resources = manifest['web_accessible_resources'];
  for (const entry of Array.isArray(resources) ? resources : []) {
    if (entry && typeof entry === 'object') addWebAccessibleGrants(out, entry as Record<string, unknown>);
    else for (const value of strings(entry)) out.add(`web_accessible_resources:${value}`);
  }
  const scripts = Array.isArray(manifest['content_scripts']) ? manifest['content_scripts'] : [];
  for (const script of scripts) {
    const matches = script && typeof script === 'object' ? (script as Record<string, unknown>)['matches'] : undefined;
    for (const value of strings(matches)) out.add(`content_scripts:${value}`);
  }
  return out;
}

function serviceWorker(manifest: Record<string, unknown>): unknown {
  const background = manifest['background'];
  return background && typeof background === 'object' ? (background as Record<string, unknown>)['service_worker'] : undefined;
}

/**
 * The test build may not change which extension this is or what it may touch: Chrome
 * keeps the install's granted access on the user's profile, so a build that widens it
 * would be arbitrary new access on a computer holding real sign-ins.
 */
export function assertTestManifestAllowed(
  next: Record<string, unknown>,
  installed: Record<string, unknown>,
): { testVersion: string; originalVersion: string } {
  const testVersion = manifestVersion(next);
  const originalVersion = manifestVersion(installed);
  if (compareExtensionVersions(testVersion, originalVersion) <= 0) {
    throw new ExtensionTestRefusal(
      'version_not_above_installed',
      `Test extension version ${testVersion} must be above the installed ${originalVersion}`,
    );
  }
  for (const key of ['key', 'manifest_version', 'content_security_policy'] as const) {
    if (JSON.stringify(next[key]) !== JSON.stringify(installed[key])) {
      throw new ExtensionTestRefusal('manifest_identity_changed', `Test manifest must keep "${key}" unchanged`);
    }
  }
  if (serviceWorker(next) !== serviceWorker(installed)) {
    throw new ExtensionTestRefusal('manifest_identity_changed', 'Test manifest must keep the same background service worker file');
  }
  const allowed = grants(installed);
  const widened = [...grants(next)].filter((grant) => !allowed.has(grant));
  if (widened.length > 0) {
    throw new ExtensionTestRefusal(
      'permissions_widened',
      `Test manifest asks for access the installed extension does not have: ${widened.slice(0, 5).join(', ')}`,
    );
  }
  return { testVersion, originalVersion };
}

/** Decode and bound a wire bundle. Throws ExtensionTestRefusal; never touches disk. */
export function decodeExtensionTestBundle(
  files: ReadonlyArray<{ name: string; contentBase64: string }>,
): ExtensionTestBundleFile[] {
  const seen = new Set<string>();
  let total = 0;
  const decoded = files.map((file) => {
    if (!isSafeExtensionFileName(file.name)) {
      throw new ExtensionTestRefusal('file_name_refused', `Extension file name is not allowed: ${file.name}`);
    }
    const key = file.name.toLowerCase();
    if (seen.has(key)) throw new ExtensionTestRefusal('file_name_refused', `Duplicate extension file: ${file.name}`);
    seen.add(key);
    const content = Buffer.from(file.contentBase64, 'base64');
    total += content.length;
    if (total > EXTENSION_TEST_MAX_BYTES) {
      throw new ExtensionTestRefusal('bundle_too_large', `Extension bundle is over ${EXTENSION_TEST_MAX_BYTES} bytes`);
    }
    return { name: file.name, content };
  });
  if (!decoded.some((file) => file.name === 'manifest.json')) {
    throw new ExtensionTestRefusal('manifest_missing', 'Extension bundle needs manifest.json');
  }
  return decoded;
}
