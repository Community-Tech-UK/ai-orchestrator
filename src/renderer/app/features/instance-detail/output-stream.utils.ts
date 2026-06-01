/**
 * Pure stateless helper functions for the OutputStreamComponent.
 * None of these touch component state or Angular signals.
 */

import type { LinkedFileTarget } from './output-stream.types';

export interface BuildLinkedFileTargetOptions {
  workingDirectory?: string | null;
  isRemote?: boolean;
}

export function fileUrlToPath(path: string): string {
  if (!path.startsWith('file://')) {
    return path;
  }

  try {
    const url = new URL(path);
    if (url.protocol !== 'file:') {
      return path;
    }
    return decodeURIComponent(url.pathname);
  } catch {
    return path;
  }
}

export function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith('/')
    || path.startsWith('\\\\')
    || path.startsWith('//')
    || /^[A-Za-z]:[\\/]/.test(path);
}

export function pathSeparatorFor(path: string): '/' | '\\' {
  return /^[A-Za-z]:[\\/]/.test(path) || (path.includes('\\') && !path.includes('/'))
    ? '\\'
    : '/';
}

export function normalizePathLike(path: string, separator: '/' | '\\'): string {
  const driveMatch = /^([A-Za-z]:)[\\/](.*)$/.exec(path);
  let prefix = '';
  let rest = path;
  const absolute = isAbsoluteFilePath(path);

  if (driveMatch) {
    prefix = `${driveMatch[1]}${separator}`;
    rest = driveMatch[2];
  } else if (path.startsWith('\\\\') || path.startsWith('//')) {
    prefix = `${separator}${separator}`;
    rest = path.replace(/^[\\/]+/, '');
  } else if (path.startsWith('/')) {
    prefix = separator;
    rest = path.replace(/^[\\/]+/, '');
  }

  const segments: string[] = [];
  for (const segment of rest.split(/[\\/]+/)) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
      } else if (!absolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  return `${prefix}${segments.join(separator)}`;
}

export function joinAndNormalizePath(base: string, relative: string): string {
  const separator = pathSeparatorFor(base);
  const joined = `${base.replace(/[\\/]+$/, '')}${separator}${relative}`;
  return normalizePathLike(joined, separator);
}

export function resolvePathAgainstWorkingDirectory(path: string, workingDirectory?: string | null): string {
  if (!path || isAbsoluteFilePath(path)) {
    return path;
  }

  const base = workingDirectory?.trim();
  if (!base) {
    return path;
  }

  return joinAndNormalizePath(base, path);
}

export function canUseLocalFileActions(
  path: string,
  workingDirectory?: string | null,
  isRemote = false,
): boolean {
  if (isRemote) {
    return false;
  }

  return isAbsoluteFilePath(path) || Boolean(workingDirectory?.trim());
}

export function buildLinkedFileTarget(
  rawPath: string,
  options: BuildLinkedFileTargetOptions = {},
): LinkedFileTarget {
  const path = fileUrlToPath(rawPath.trim());
  const resolvedPath = resolvePathAgainstWorkingDirectory(path, options.workingDirectory);

  return {
    rawPath: path,
    resolvedPath,
    displayPath: path,
    canUseLocalFileActions: canUseLocalFileActions(
      path,
      options.workingDirectory,
      options.isRemote ?? false,
    ),
  };
}

export function getSystemFileManagerLabel(): string {
  if (navigator.userAgent.includes('Windows')) {
    return 'Explorer';
  }
  if (navigator.userAgent.includes('Linux')) {
    return 'Files';
  }
  return 'Finder';
}
