/**
 * Provider CLI sign-in launcher.
 *
 * Provider logins are interactive (device codes, browser round-trips, TTY
 * prompts), so the app cannot complete them headlessly. What it *can* do is
 * stop making the user find a terminal and remember the command: this module
 * opens the platform terminal already running the right login command.
 *
 * Security: the renderer only ever sends a provider id. Every command run here
 * comes from the fixed table below — no caller-supplied string reaches a shell.
 */

import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getLogger } from '../logging/logger';
import {
  assertSafeCopilotProfileId,
  resolveCopilotProfileHome,
} from '../cli/adapters/copilot/copilot-account-home-resolver';
import { COPILOT_LEGACY_PROFILE_ID } from '../../shared/types/copilot-account.types';
import { emitCopilotAccountEvent } from './copilot/copilot-account-events';
import {
  assertSafeAccountProfileId,
  resolveAccountProfileHome,
} from '../cli/adapters/account-pool/provider-account-home-resolver';
import type { PooledProvider } from '../../shared/types/provider-account.types';
import { getProviderAccountStore } from './account-pool/provider-account-store';
import { seedClaudeProfileHome } from './account-pool/claude-profile-seed';
import { codexProfileHasAuth, seedCodexProfileHome } from './account-pool/codex-profile-seed';
import { emitProviderAccountEvent } from './account-pool/provider-account-events';

const logger = getLogger('ProviderLoginLauncher');

export interface ProviderLoginCommand {
  /** Canonical provider id used by the Doctor UI. */
  provider: string;
  /** Shell-safe command line, e.g. `claude auth login`. */
  command: string;
  /** Extra guidance shown next to the launch button. */
  hint?: string;
}

/**
 * Fixed login commands, verified against each CLI's `--help` output.
 *
 * Keys cover both the short provider ids used by the Doctor report
 * (`claude`) and the ProviderDoctor probe keys (`claude-cli`) so either
 * spelling resolves.
 */
const LOGIN_COMMANDS: Record<string, ProviderLoginCommand> = {
  claude: { provider: 'claude', command: 'claude auth login' },
  codex: { provider: 'codex', command: 'codex login' },
  copilot: { provider: 'copilot', command: 'copilot login' },
  cursor: { provider: 'cursor', command: 'cursor-agent login' },
  opencode: {
    provider: 'opencode',
    command: 'opencode auth login',
    hint: 'Pick the backend to connect. For a MiMo Token Plan, choose the Xiaomi Token Plan region that matches the base URL in the MiMo console (Europe is token-plan-ams), then paste the key. OpenCode stores it; Harness never sees it.',
  },
  antigravity: {
    provider: 'antigravity',
    command: 'agy',
    hint: 'Antigravity has no login subcommand — sign in through the prompts on first run, then quit the CLI.',
  },
  gemini: {
    provider: 'gemini',
    command: 'gemini',
    hint: 'Gemini CLI has no login subcommand — pick an auth method in the interactive prompts.',
  },
};

const PROVIDER_ALIASES: Record<string, string> = {
  'claude-cli': 'claude',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
};

/** Only ever letters, digits, spaces and `-_.` — asserted before shell embedding. */
const SAFE_COMMAND = /^[A-Za-z0-9 ._-]+$/;
/**
 * Email pinned onto `claude auth login --email`. The login page otherwise
 * follows whichever Claude account the browser is already signed into.
 * Reject anything this regex does not match rather than quoting it cleverly.
 */
const CLAUDE_LOGIN_EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Exact lowercase hostname. Mirrors `CopilotHostSchema` in the contracts
 * package; duplicated as a plain regex here so the launcher validates even when
 * called from a path that skipped IPC schema validation.
 */
const SAFE_HOST = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

/**
 * Characters that make a derived path unsafe to embed in ANY of the three
 * terminal wrappers (POSIX shell, cmd.exe, AppleScript). The Copilot profile
 * home is `<userData>/copilot-cli-profiles/<safe-slug>`, so hitting this means
 * the user's own userData path contains a quote or shell metacharacter —
 * pathological, and better refused loudly than escaped cleverly.
 */
const UNSAFE_PATH_CHARS = /["'`$;&|<>\n\r\0]/;
/** Backslash is a path separator on Windows, but an escape everywhere else. */
const POSIX_UNSAFE_PATH_CHARS = /\\/;
/** `cmd.exe` expands `%VAR%` INSIDE the double quotes of `set "K=V"`, so a
 *  percent cannot be made inert by quoting the way the others can. */
const WIN32_UNSAFE_PATH_CHARS = /%/;

/**
 * The ONE audited quoting helper (spec §17). Every platform's terminal wrapper
 * gets its path through here; nothing else interpolates a path into a command.
 */
export function quotePathForTerminal(value: string, platform: NodeJS.Platform): string {
  if (
    UNSAFE_PATH_CHARS.test(value)
    || (platform !== 'win32' && POSIX_UNSAFE_PATH_CHARS.test(value))
    || (platform === 'win32' && WIN32_UNSAFE_PATH_CHARS.test(value))
  ) {
    throw new Error(
      'Refusing to build a sign-in command: the profile directory contains a character that cannot be safely quoted.',
    );
  }
  // Post-validation the value has no quote of either kind, so a single pair of
  // quotes is sufficient and unambiguous on every platform. Quoting is still
  // required: the macOS userData path contains a space.
  return platform === 'win32' ? `"${value}"` : `'${value}'`;
}

export interface CopilotProfileLoginRequest {
  /** Validated safe slug. Never a path. */
  profileId: string;
  /** Normalized lowercase hostname. Defaults to the CLI's own default. */
  host?: string;
  /** True for the migration-created profile bound to the pre-existing home. */
  isLegacy?: boolean;
}

/**
 * Build `COPILOT_HOME=<derived home> copilot login [--host <host>]` for one
 * account profile.
 *
 * The renderer supplies a profile ID and (optionally) a host — never a command,
 * a path, or an environment map. The home is derived in main from the validated
 * ID, so no caller-controlled fragment reaches a shell.
 */
export function buildCopilotProfileLoginCommand(
  request: CopilotProfileLoginRequest,
  platform: NodeJS.Platform = process.platform,
): ProviderLoginCommand {
  assertSafeCopilotProfileId(request.profileId);
  const host = request.host?.trim();
  if (host !== undefined && host !== '' && !SAFE_HOST.test(host)) {
    throw new Error('Refusing to build a sign-in command: the Copilot host is not a valid hostname.');
  }
  const home = resolveCopilotProfileHome(request.profileId, {
    isLegacy: request.isLegacy || request.profileId === COPILOT_LEGACY_PROFILE_ID,
  });
  const quotedHome = quotePathForTerminal(home, platform);
  const hostArgs = host ? ` --host ${host}` : '';
  // cmd.exe's `set "VAR=value"` form must wrap the WHOLE assignment, so the
  // validated raw path goes inside those quotes rather than being quoted again.
  // `quotePathForTerminal` still runs above on both platforms — it is the
  // validation gate as well as the quoter.
  const command = platform === 'win32'
    ? `set "COPILOT_HOME=${home}" && copilot login${hostArgs}`
    : `COPILOT_HOME=${quotedHome} copilot login${hostArgs}`;
  return {
    provider: 'copilot',
    command,
    hint: 'Complete the GitHub sign-in in your browser. Harness never sees the token.',
  };
}

export interface AccountProfileLoginRequest {
  provider: PooledProvider;
  /** Validated safe slug. Never a path. */
  profileId: string;
}

function assertEmbeddablePath(home: string, platform: NodeJS.Platform): string {
  // Validation gate and quoter in one: refuses anything the terminal wrappers
  // cannot carry safely (spec §13).
  return quotePathForTerminal(home, platform);
}

/**
 * `claude auth login --email` fragment, or '' when the address is missing or
 * not safe to embed. Callers quote the address; this function is the only
 * place an email enters a sign-in command.
 */
export function claudeLoginEmailFlag(email: string | undefined, platform: NodeJS.Platform): string {
  const trimmed = email?.trim() ?? '';
  if (!CLAUDE_LOGIN_EMAIL.test(trimmed)) return '';
  const quoted = platform === 'win32' ? `"${trimmed}"` : `'${trimmed}'`;
  return ` --email ${quoted}`;
}

function claudeLoginHint(email: string | undefined): string {
  const trimmed = email?.trim() ?? '';
  if (CLAUDE_LOGIN_EMAIL.test(trimmed)) {
    return `Sign in as ${trimmed}. If the browser is already signed into a different Claude account, switch to this one before approving. Harness never sees the token.`;
  }
  return 'Sign in with the Claude account this profile is for. Harness never sees the token.';
}

/** `oauthAccount.emailAddress` from a Claude config file, when it is a string. */
export function readClaudeOauthEmail(claudeJsonPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const account = (parsed as { oauthAccount?: { emailAddress?: unknown } }).oauthAccount;
    const email = account?.emailAddress;
    return typeof email === 'string' && email.trim() ? email.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The email a Claude sign-in must target. The pool's verified identity wins.
 * The legacy CLI home falls back to `~/.claude.json`, which is the account
 * that home already belongs to.
 */
export function lookupClaudeLoginEmail(profileId: string): string | undefined {
  try {
    const expected = getProviderAccountStore()
      .listProfiles('claude')
      .find((entry) => entry.id === profileId)
      ?.expectedIdentity
      ?.trim();
    if (expected) return expected;
  } catch {
    // Store unavailable during tests or early startup.
  }
  if (profileId !== 'legacy') return undefined;
  return readClaudeOauthEmail(join(homedir(), '.claude.json'));
}

/**
 * `CLAUDE_CONFIG_DIR=<derived home> claude auth login` for one Claude account
 * profile, after seeding the home. The legacy profile signs in to `~/.claude`
 * with `CLAUDE_CONFIG_DIR` cleared, so a shell that has the variable set cannot
 * write the login into a pooled profile. `--email` pins the browser login to
 * that home's account when we know it.
 */
export function buildClaudeProfileLoginCommand(
  profileId: string,
  platform: NodeJS.Platform = process.platform,
  continuation: 'shared-store' | 'replay' = 'shared-store',
  email?: string,
): ProviderLoginCommand {
  assertSafeAccountProfileId(profileId);
  const resolved = resolveAccountProfileHome({ provider: 'claude', profileId });
  const emailFlag = claudeLoginEmailFlag(email, platform);
  if (resolved.kind === 'legacy') {
    const command = platform === 'win32'
      ? `set "CLAUDE_CONFIG_DIR=" & claude auth login${emailFlag}`
      : `env -u CLAUDE_CONFIG_DIR claude auth login${emailFlag}`;
    return { provider: 'claude', command, hint: claudeLoginHint(email) };
  }
  const quoted = assertEmbeddablePath(resolved.home, platform);
  seedClaudeProfileHome(resolved.home, { continuation });
  const command = platform === 'win32'
    ? `set "CLAUDE_CONFIG_DIR=${resolved.home}" && claude auth login${emailFlag}`
    : `CLAUDE_CONFIG_DIR=${quoted} claude auth login${emailFlag}`;
  return {
    provider: 'claude',
    command,
    hint: claudeLoginHint(email),
  };
}

/**
 * `CODEX_HOME=<derived home> codex login --device-auth` for one Codex account
 * profile. Refused when the home already holds a sign-in: `codex login` revokes
 * whatever tokens are already there (spec invariant 11). `--device-auth` keeps
 * two logins from fighting over the loopback callback port.
 */
export function buildCodexProfileLoginCommand(
  profileId: string,
  platform: NodeJS.Platform = process.platform,
): ProviderLoginCommand {
  assertSafeAccountProfileId(profileId);
  const resolved = resolveAccountProfileHome({ provider: 'codex', profileId });
  if (resolved.kind === 'legacy') {
    return { provider: 'codex', command: 'codex login' };
  }
  if (codexProfileHasAuth(resolved.home)) {
    throw new Error(
      'This Codex account is already signed in. Signing in again would revoke its current sign-in; '
      + 'to use a different ChatGPT account, remove this account and add it again.',
    );
  }
  const quoted = assertEmbeddablePath(resolved.home, platform);
  seedCodexProfileHome(resolved.home);
  const command = platform === 'win32'
    ? `set "CODEX_HOME=${resolved.home}" && codex login --device-auth`
    : `CODEX_HOME=${quoted} codex login --device-auth`;
  return {
    provider: 'codex',
    command,
    hint: 'Enter the device code shown in the terminal at chatgpt.com, signed in as the account this profile is for.',
  };
}

export function buildAccountProfileLoginCommand(
  request: AccountProfileLoginRequest,
  platform: NodeJS.Platform = process.platform,
): ProviderLoginCommand {
  if (request.provider === 'claude') {
    let continuation: 'shared-store' | 'replay' = 'shared-store';
    try {
      continuation = getProviderAccountStore().getPoolPolicy('claude').continuation;
    } catch {
      continuation = 'shared-store';
    }
    return buildClaudeProfileLoginCommand(
      request.profileId,
      platform,
      continuation,
      lookupClaudeLoginEmail(request.profileId),
    );
  }
  return buildCodexProfileLoginCommand(request.profileId, platform);
}

/**
 * Seeds the profile home and copies the sign-in command. The command embeds the
 * derived home, so it must never cross IPC; the caller supplies the clipboard
 * write (main's `clipboard.writeText`).
 */
export function copyAccountProfileLoginCommand(
  request: AccountProfileLoginRequest,
  writeText: (text: string) => void,
): { hint?: string } {
  const login = buildAccountProfileLoginCommand(request);
  writeText(login.command);
  emitProviderAccountEvent({
    event: 'account_login_command_copied',
    provider: request.provider,
    profileId: request.profileId,
  });
  return login.hint ? { hint: login.hint } : {};
}

export function getProviderLoginCommand(provider: string): ProviderLoginCommand | null {
  const key = PROVIDER_ALIASES[provider] ?? provider;
  return LOGIN_COMMANDS[key] ?? null;
}

/** One candidate way to open a terminal running the login command. */
export interface TerminalLaunchCandidate {
  /**
   * `osascript` waits for the helper to exit and treats a non-zero code as a
   * failure; `spawn` detaches and only reports whether the process started.
   */
  mode: 'osascript' | 'spawn';
  file: string;
  args: string[];
  /** Human-readable terminal name for the UI. */
  terminal: string;
}

/**
 * Builds the ordered terminal-launch candidates for a platform. Pure, so the
 * command wiring is testable without ever spawning a process.
 */
export function buildTerminalLaunchCandidates(
  command: string,
  platform: NodeJS.Platform,
): TerminalLaunchCandidate[] {
  if (platform === 'darwin') {
    return [
      {
        mode: 'osascript',
        file: '/usr/bin/osascript',
        args: [
          '-e',
          `tell application "Terminal" to do script "${command}"`,
          '-e',
          'tell application "Terminal" to activate',
        ],
        terminal: 'Terminal',
      },
    ];
  }

  if (platform === 'win32') {
    return [
      {
        mode: 'spawn',
        file: 'cmd.exe',
        args: ['/c', 'start', '""', 'cmd.exe', '/k', command],
        terminal: 'Command Prompt',
      },
    ];
  }

  const keepOpen = `${command}; exec $SHELL`;
  return [
    { mode: 'spawn', file: 'x-terminal-emulator', args: ['-e', command], terminal: 'x-terminal-emulator' },
    { mode: 'spawn', file: 'gnome-terminal', args: ['--', 'sh', '-c', keepOpen], terminal: 'GNOME Terminal' },
    { mode: 'spawn', file: 'konsole', args: ['-e', command], terminal: 'Konsole' },
    { mode: 'spawn', file: 'xfce4-terminal', args: ['-e', command], terminal: 'Xfce Terminal' },
    { mode: 'spawn', file: 'alacritty', args: ['-e', 'sh', '-c', keepOpen], terminal: 'Alacritty' },
    { mode: 'spawn', file: 'kitty', args: ['sh', '-c', keepOpen], terminal: 'kitty' },
    { mode: 'spawn', file: 'xterm', args: ['-e', keepOpen], terminal: 'xterm' },
  ];
}

export interface ProviderLoginLaunchResult {
  provider: string;
  command: string;
  /** Which terminal application was opened. */
  terminal: string;
  hint?: string;
}

/**
 * Opens a terminal window running the provider's login command.
 * Throws when the provider has no known login command or no terminal could be
 * launched — the caller surfaces the message to the user.
 */
export async function launchProviderLogin(
  provider: string,
  copilotProfile?: CopilotProfileLoginRequest,
  accountProfile?: AccountProfileLoginRequest,
): Promise<ProviderLoginLaunchResult> {
  // A Copilot or Claude/Codex account-profile sign-in is built here rather than
  // looked up, because it has to carry that profile's derived home. Everything
  // caller-supplied (the profile ID, the host) is validated before it becomes a command.
  const canonical = PROVIDER_ALIASES[provider] ?? provider;
  // Doctor "Sign in" for Claude is the legacy CLI home, not whichever account
  // the browser session happens to be. Build that command here so it clears
  // CLAUDE_CONFIG_DIR and pins --email; the fixed table cannot carry either.
  const legacyClaude = !copilotProfile && !accountProfile && canonical === 'claude';
  const login = copilotProfile
    ? buildCopilotProfileLoginCommand(copilotProfile)
    : accountProfile
      ? buildAccountProfileLoginCommand(accountProfile)
      : legacyClaude
        ? buildClaudeProfileLoginCommand('legacy', process.platform, 'shared-store', lookupClaudeLoginEmail('legacy'))
        : getProviderLoginCommand(provider);
  if (!login) {
    throw new Error(`No known sign-in command for provider "${provider}".`);
  }
  // The Copilot profile command legitimately carries quotes and `=` from the
  // audited quoting helper, so it is exempt from the fixed-table character
  // allowlist — its own inputs were validated above.
  if (!copilotProfile && !accountProfile && !legacyClaude && !SAFE_COMMAND.test(login.command)) {
    // Unreachable with the table above; guards future edits from smuggling
    // shell metacharacters into the AppleScript/cmd wrappers.
    throw new Error(`Refusing to run an unsafe login command for "${provider}".`);
  }

  const candidates = buildTerminalLaunchCandidates(login.command, process.platform);
  const errors: string[] = [];
  for (const candidate of candidates) {
    const attempt = candidate.mode === 'osascript'
      ? await runAndWait(candidate.file, candidate.args)
      : await trySpawn(candidate.file, candidate.args);
    if (attempt.success) {
      logger.info('Launched provider sign-in in a terminal', {
        provider: login.provider,
        terminal: candidate.terminal,
        ...(copilotProfile ? { profileId: copilotProfile.profileId } : {}),
        ...(accountProfile ? { profileId: accountProfile.profileId } : {}),
      });
      if (accountProfile) {
        emitProviderAccountEvent({
          event: 'account_login_launched',
          provider: accountProfile.provider,
          profileId: accountProfile.profileId,
        });
      }
      if (copilotProfile) {
        emitCopilotAccountEvent({
          event: 'copilot_account_login_launched',
          profileId: copilotProfile.profileId,
        });
      }
      return {
        provider: login.provider,
        command: login.command,
        terminal: candidate.terminal,
        ...(login.hint ? { hint: login.hint } : {}),
      };
    }
    errors.push(`${candidate.file}: ${attempt.message}`);
  }

  throw new Error(`Failed to open a terminal for sign-in. Tried: ${errors.join('; ')}`);
}

type LaunchAttempt = { success: true } | { success: false; message: string };

function runAndWait(file: string, args: string[]): Promise<LaunchAttempt> {
  return new Promise((resolve) => {
    execFile(file, args, (error, _stdout, stderr) => {
      if (error) {
        resolve({ success: false, message: stderr.trim() || error.message });
        return;
      }
      resolve({ success: true });
    });
  });
}

function trySpawn(cmd: string, args: string[]): Promise<LaunchAttempt> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      let settled = false;
      proc.once('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ success: false, message: err.message });
      });
      proc.once('spawn', () => {
        if (settled) return;
        settled = true;
        proc.unref();
        resolve({ success: true });
      });
    } catch (error) {
      resolve({ success: false, message: (error as Error).message });
    }
  });
}
