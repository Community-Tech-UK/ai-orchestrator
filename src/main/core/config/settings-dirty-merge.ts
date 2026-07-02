/**
 * Field-level dirty tracking and merge helpers for lockfiled settings writes.
 *
 * Ported from pi's settings-manager `persistScopedSettings` idea: instead of
 * clobbering the whole settings file with the in-memory snapshot, a write
 * re-reads the file under the lock, then merges ONLY the dirty dot-paths of
 * the current write over the latest disk state. Concurrent changes made by
 * another process to unrelated fields (including sibling keys inside the same
 * nested object) are preserved.
 *
 * Conflict policy: when the disk value at a dirty path differs from both the
 * last-known (expected) value and the attempted value, another writer changed
 * the same field concurrently. The attempted value still wins — matching the
 * pre-existing last-write-wins behavior — but the conflict is surfaced to the
 * caller so it can be logged / emitted.
 */

export interface SettingsWriteContext {
  readonly dirtyPaths: readonly string[];
  readonly expectedVersion: number;
}

export interface SettingsConflict {
  readonly path: string;
  readonly diskValue: unknown;
  readonly attemptedValue: unknown;
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Objects with dotted keys are treated as leaves so generated dot-paths stay
 * unambiguous (e.g. a map keyed by model ids like "gpt-5.5" must never be
 * split on the dot).
 */
function hasDottedKeys(value: PlainObject): boolean {
  return Object.keys(value).some((key) => key.includes('.'));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aObj = a as PlainObject;
  const bObj = b as PlainObject;
  const aKeys = Object.keys(aObj);
  if (aKeys.length !== Object.keys(bObj).length) return false;
  return aKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(bObj, key) && deepEqual(aObj[key], bObj[key]),
  );
}

function diffPaths(prefix: string, attempted: unknown, expected: unknown): string[] {
  if (deepEqual(attempted, expected)) return [];
  if (
    !isPlainObject(attempted) || !isPlainObject(expected)
    || hasDottedKeys(attempted) || hasDottedKeys(expected)
  ) {
    return [prefix];
  }
  const keys = new Set([...Object.keys(attempted), ...Object.keys(expected)]);
  const paths: string[] = [];
  for (const key of keys) {
    paths.push(...diffPaths(`${prefix}.${key}`, attempted[key], expected[key]));
  }
  return paths;
}

/**
 * Compute the dirty dot-paths for one top-level settings key by diffing the
 * attempted value against the last-known (expected) value.
 *
 * - No expected baseline (first write, migrations): the whole key is dirty,
 *   i.e. a wholesale write — today's behavior.
 * - Value identical to the baseline: the whole key is still marked dirty so
 *   the write (and its clobber-the-disk semantics) is preserved for callers
 *   that intentionally re-set a value.
 * - Nested plain objects: only the changed subpaths are dirty; subpaths
 *   present in the baseline but missing from the attempted value are dirty
 *   deletions.
 */
export function computeDirtyPaths(
  key: string,
  attempted: unknown,
  expected: unknown,
  hasExpected: boolean,
): string[] {
  if (!hasExpected) return [key];
  const paths = diffPaths(key, attempted, expected);
  return paths.length > 0 ? paths : [key];
}

export function getAtPath(root: PlainObject, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function hasAtPath(root: PlainObject, path: string): boolean {
  const segments = path.split('.');
  let current: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(current)) return false;
    current = current[segment];
  }
  const last = segments[segments.length - 1];
  return isPlainObject(current) && Object.prototype.hasOwnProperty.call(current, last);
}

function setAtPath(root: PlainObject, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (isPlainObject(next)) {
      current = next;
    } else {
      const created: PlainObject = {};
      current[segment] = created;
      current = created;
    }
  }
  current[segments[segments.length - 1]] = value;
}

function deleteAtPath(root: PlainObject, path: string): void {
  const segments = path.split('.');
  let current: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(current)) return;
    current = current[segment];
  }
  if (isPlainObject(current)) {
    delete current[segments[segments.length - 1]];
  }
}

/**
 * Detect concurrent same-field writes: the disk value at a dirty path differs
 * from both the last-known value and the attempted value.
 */
export function detectConflicts(
  dirtyPaths: readonly string[],
  disk: PlainObject,
  expected: PlainObject,
  attempted: PlainObject,
): SettingsConflict[] {
  const conflicts: SettingsConflict[] = [];
  for (const path of dirtyPaths) {
    const diskValue = getAtPath(disk, path);
    const attemptedValue = getAtPath(attempted, path);
    if (!deepEqual(diskValue, getAtPath(expected, path)) && !deepEqual(diskValue, attemptedValue)) {
      conflicts.push({ path, diskValue, attemptedValue });
    }
  }
  return conflicts;
}

/**
 * Merge only the dirty paths from `attempted` over the latest `disk` snapshot,
 * preserving unrelated concurrent changes. Dirty paths absent from `attempted`
 * are deletions.
 */
export function mergeDirtyPaths(
  disk: PlainObject,
  attempted: PlainObject,
  dirtyPaths: readonly string[],
): PlainObject {
  const merged = structuredClone(disk);
  for (const path of dirtyPaths) {
    if (hasAtPath(attempted, path)) {
      setAtPath(merged, path, structuredClone(getAtPath(attempted, path)));
    } else {
      deleteAtPath(merged, path);
    }
  }
  return merged;
}
