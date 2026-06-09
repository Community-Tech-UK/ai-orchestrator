/**
 * Pure builder for the automation-profile login command (Tier 3). Shared so the
 * renderer can display exactly what "Run on node" would execute, and the main
 * process can run it via the terminal RPC. No Node/Electron deps.
 */
import type { NodePlatform } from '../types/worker-node.types';

/** Standard Chrome locations per platform (mirrors capability detection). */
export const DEFAULT_CHROME_PATH: Record<NodePlatform, string> = {
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: 'google-chrome',
};

// Reject anything that could break out of the quoted shell argument. The profile
// dir / URL feed a shell command, so we refuse shell metacharacters rather than
// attempt to escape every shell's rules.
const SHELL_UNSAFE = /['"`$;\n\r&|<>()]/;

export function assertSafeLoginArg(value: string, label: string): void {
  if (SHELL_UNSAFE.test(value)) {
    throw new Error(`${label} contains characters that aren't allowed in a launch command`);
  }
}

/** Validate the target URL is a plain http(s) URL (no shell metacharacters). */
export function normalizeLoginUrl(url: string | undefined): string {
  const candidate = (url ?? 'about:blank').trim();
  if (candidate === 'about:blank') {
    return candidate;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Login URL must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Login URL must use http or https');
  }
  assertSafeLoginArg(parsed.href, 'Login URL');
  return parsed.href;
}

export interface BrowserLoginCommand {
  shell: string;
  command: string;
}

/**
 * Build a platform-appropriate, ready-to-run command that launches Chrome
 * headful against the automation profile.
 */
export function buildBrowserLoginCommand(
  platform: NodePlatform,
  profileDir: string,
  url: string,
  chromePath?: string,
): BrowserLoginCommand {
  assertSafeLoginArg(profileDir, 'Profile directory');
  const safeUrl = normalizeLoginUrl(url);
  const chrome = chromePath?.trim() || DEFAULT_CHROME_PATH[platform];
  if (chromePath) {
    assertSafeLoginArg(chrome, 'Chrome path');
  }

  if (platform === 'win32') {
    return {
      shell: 'powershell.exe',
      command:
        `Start-Process -FilePath '${chrome}' -ArgumentList ` +
        `'--user-data-dir=${profileDir}','--no-first-run','${safeUrl}'`,
    };
  }
  return {
    shell: platform === 'darwin' ? '/bin/zsh' : '/bin/sh',
    command: `"${chrome}" --user-data-dir="${profileDir}" --no-first-run "${safeUrl}" &`,
  };
}
