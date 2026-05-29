/**
 * Pure stateless helper functions for the OutputStreamComponent.
 * None of these touch component state or Angular signals.
 */

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

export function getSystemFileManagerLabel(): string {
  if (navigator.userAgent.includes('Windows')) {
    return 'Explorer';
  }
  if (navigator.userAgent.includes('Linux')) {
    return 'Files';
  }
  return 'Finder';
}
