import path from 'node:path';

const RESTRICTED_PATTERNS = [
  /^\.env(\..+)?$/,          // .env, .env.local, .env.production, etc.
  /^\.ssh$/,                 // .ssh directory
  /^id_(rsa|ed25519|ecdsa|dsa)$/,  // private key files
  /^\.npmrc$/,               // npm credentials
  /^\.netrc$/,               // netrc credentials
  /^\.pypirc$/,              // PyPI credentials
  /^credentials\.json$/,     // Google/other credentials
  /^\.aws$/,                 // AWS config directory
  /^\.kube$/,                // Kubernetes config directory
  /^\.gnupg$/,               // GnuPG directory
  /^token\.json$/,           // OAuth tokens
  /^secrets?$/,              // secrets or secret files/dirs
  /^secrets?\./,             // secrets.* files
  /\.pem$/,                  // PEM certificate/key files
  /\.key$/,                  // .key files
];

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
]);

export class SecurityFilter {
  static isRestricted(name: string): boolean {
    return RESTRICTED_PATTERNS.some(pattern => pattern.test(name));
  }

  static isWithinRoot(targetPath: string, roots: string[]): boolean {
    // Detect Windows-style paths (e.g. C:\...) and handle with win32 module
    const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[/\\]/.test(p) || p.includes('\\');

    if (isWindowsPath(targetPath) || roots.some(isWindowsPath)) {
      // Use win32 path logic: normalize by replacing all forward slashes with backslashes
      const normalize = (p: string): string =>
        path.win32.resolve(p.replace(/\//g, '\\'));
      const resolvedTarget = normalize(targetPath);
      return roots.some(root => {
        const resolvedRoot = normalize(root);
        return (
          resolvedTarget === resolvedRoot ||
          resolvedTarget.startsWith(resolvedRoot + '\\')
        );
      });
    }

    const resolved = path.resolve(targetPath);
    return roots.some(root => {
      const resolvedRoot = path.resolve(root);
      return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    });
  }

  static shouldSkipDirectory(name: string): boolean {
    return SKIP_DIRECTORIES.has(name);
  }
}
