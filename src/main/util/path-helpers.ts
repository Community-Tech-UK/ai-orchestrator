import * as path from 'node:path';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pathCompareKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isInsideOrEqual(parent: string, child: string): boolean {
  const parentKey = pathCompareKey(parent);
  const childKey = pathCompareKey(child);
  const relative = path.relative(parentKey, childKey);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
