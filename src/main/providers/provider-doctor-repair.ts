import {
  isInstallerOwnedPath,
  knownInstallVersions,
  type CliShadowReport,
} from '../cli/cli-install-mirrors';
import { CLI_REGISTRY, type CliRegistryEntry } from '../cli/cli-registry';
import type { ProviderProbeErrorKind, RepairAction } from '../../shared/types/provider-doctor.types';
import {
  buildClaudeProfileLoginCommand,
  lookupClaudeLoginEmail,
} from './provider-login-launcher';

interface ProbeForRepair {
  name: string;
  status: string;
  message: string;
  metadata?: Record<string, unknown>;
  errorKind?: ProviderProbeErrorKind;
}

interface DiagnosisForRepair {
  provider: string;
  probes: ProbeForRepair[];
}

/**
  * Install command previews — no secrets, generic paths only. Shared with
  * `ProviderDoctor.generateRecommendations`, so a provider has one canonical
  * install instruction across repair actions and recommendations.
  */
export const INSTALL_COMMANDS: Record<string, string> = {
  'claude-cli': 'npm install -g @anthropic-ai/claude-code',
  'codex-cli': 'npm install -g @openai/codex',
  'gemini-cli': 'npm install -g @google/gemini-cli',
  'antigravity': 'Install Antigravity from antigravity.google, then run `agy` once to sign in',
  'copilot': 'gh extension install github/gh-copilot  # or: npm install -g @github/copilot',
  'cursor': 'Install Cursor from https://cursor.sh and add cursor-agent to PATH',
  // Its postinstall also refreshes the ~/.grok/bin copy, which is why a grok
  // version conflict is fixed by reinstalling rather than deleting a copy.
  'grok': 'npm install -g @xai-official/grok',
  'opencode': 'npm install -g opencode-ai  # or: curl -fsSL https://opencode.ai/install | bash',
  'anthropic-api': 'npm install -g @anthropic-ai/claude-code',
};

const LOGIN_COMMANDS: Record<string, string> = {
  'claude-cli': 'claude auth login',
  'codex-cli': 'codex login',
  'gemini-cli': 'gemini  # follow the interactive auth prompts',
  'opencode': 'opencode auth login',
  'anthropic-api': 'export ANTHROPIC_API_KEY=<your-key>',
};

/**
 * Maps a failed ProbeResult to a typed ProviderProbeErrorKind.
 * Only call this when probe.status === 'fail'.
 */
export function classifyProbeFailure(probe: ProbeForRepair): ProviderProbeErrorKind {
  const msg = probe.message.toLowerCase();

  switch (probe.name) {
    case 'cli_installed':
      return 'cli_not_found';

    case 'cli_shadow_check': {
      // Fallback for a probe that arrived without its own errorKind. A report
      // listing copies with differing readable versions is a version mismatch;
      // anything less specific stays the generic shadow-install kind.
      const report = probe.metadata?.['report'] as CliShadowReport | undefined;
      if (report && report.installs.length >= 2) {
        return knownInstallVersions(report.installs).length > 1
          ? 'cli_version_mismatch'
          : 'cli_shadow_install';
      }
      return 'cli_shadow_install';
    }

    case 'authenticated':
      if (msg.includes('expired') || msg.includes('invalid') || msg.includes('revoked')) {
        return 'auth_expired';
      }
      return 'auth_missing';

    case 'reachable':
      return 'endpoint_unreachable';

    default:
      return 'unknown';
  }
}

/**
 * Derives structured RepairActions from failed probes in a DiagnosisResult.
 * Commands are static install/login templates and never contain secrets.
 */
export function buildRepairActions(diagnosis: DiagnosisForRepair): RepairAction[] {
  const actions: RepairAction[] = [];

  for (const probe of diagnosis.probes) {
    if (probe.status !== 'fail') continue;

    const kind = probe.errorKind ?? classifyProbeFailure(probe);
    const provider = diagnosis.provider;

    switch (kind) {
      case 'cli_not_found': {
        const cmd = INSTALL_COMMANDS[provider] ?? 'Check provider documentation to install the CLI';
        actions.push({
          kind,
          command: cmd,
          // Not having a provider CLI is an optional, non-blocking state — the
          // user may have no subscription for it. Surface it as informational
          // guidance, not a critical fault that demands resolution.
          description: `Optional — install the ${provider} CLI only if you want to use this provider. The orchestrator runs fine without it.`,
          severity: 'info',
        });
        break;
      }

      case 'cli_shadow_install': {
        const report = probe.metadata?.['report'] as CliShadowReport | undefined;
        if (installerMaintainsExtraCopies(provider)) {
          // Reached only via the report-less fallback (the probe classifies a
          // real report as a version mismatch). Removal is still the wrong
          // advice for a CLI that reinstalls its own extra copy.
          actions.push({
            kind,
            command: INSTALL_COMMANDS[provider] ?? '# reinstall the CLI',
            description: 'Several copies of this CLI are on PATH. Reinstall it — its installer maintains the extra copy, so deleting one just gets it recreated.',
            severity: 'warning',
          });
          break;
        }
        if (report && report.installs.length >= 2) {
          const hint = report.installs
            .slice(1)
            .map((i) => inferUninstallHint(i.path) ?? `# remove manually: ${i.path}`)
            .join('\n');
          actions.push({
            kind,
            command: hint,
            description: 'Remove stale shadow CLI installs so only the active copy remains.',
            severity: 'warning',
          });
        } else {
          actions.push({
            kind,
            command: '# Locate and remove the duplicate CLI binary',
            description: 'Multiple CLI installs detected — remove extras to avoid version conflicts.',
            severity: 'warning',
          });
        }
        break;
      }

      case 'cli_version_mismatch': {
        const installCmd = INSTALL_COMMANDS[provider] ?? '# reinstall the CLI';
        // Deleting a copy is the wrong advice for one the CLI's own installer
        // maintains (grok's postinstall rewrites ~/.grok/bin): reinstalling
        // refreshes it, and deleting it just gets it recreated. But only
        // those copies — a stale grok under another node version or Homebrew
        // is untouched by the reinstall and still has to be removed.
        const report = probe.metadata?.['report'] as CliShadowReport | undefined;
        const stale = report?.installs.slice(1) ?? [];
        const allInstallerOwned = stale.length > 0
          && stale.every((install) => isInstallerOwnedCopy(provider, install.path));
        const suffix = allInstallerOwned
          ? '  # refreshes every copy the installer owns'
          : '  # then remove older copies from PATH';
        actions.push({
          kind,
          command: `${installCmd}${suffix}`,
          description: 'Multiple CLI installs with different versions — update to a single consistent version.',
          severity: 'warning',
        });
        break;
      }

      case 'auth_missing':
      case 'auth_expired': {
        const claudeLogin = provider === 'claude-cli'
          ? buildClaudeProfileLoginCommand('legacy', process.platform, 'shared-store', lookupClaudeLoginEmail('legacy'))
          : null;
        const loginCmd = claudeLogin?.command
          ?? LOGIN_COMMANDS[provider]
          ?? '# re-run the provider login command';
        actions.push({
          kind,
          command: loginCmd,
          description: claudeLogin?.hint
            ?? (kind === 'auth_missing'
              ? `Authenticate the ${provider} CLI so it can communicate with the provider.`
              : `Credentials for ${provider} are expired or invalid — re-authenticate.`),
          severity: 'critical',
        });
        break;
      }

      case 'endpoint_unreachable': {
        actions.push({
          kind,
          command: 'curl -s -o /dev/null -w "%{http_code}" https://api.anthropic.com/',
          description: 'Verify network connectivity to the provider API endpoint and check proxy settings.',
          severity: 'warning',
        });
        break;
      }

      default: {
        actions.push({
          kind: 'unknown',
          command: `# Probe "${probe.name}" failed: ${probe.message}`,
          description: `Investigate the "${probe.name}" probe failure for ${provider}.`,
          severity: 'info',
        });
      }
    }
  }

  return actions;
}

/**
 * True when this provider's CLI installer keeps a second copy of itself on
 * PATH (see `CliRegistryEntry.installerMirrorDirs`). Doctor providers use the
 * `-cli` suffixed ids, so strip it before looking the CLI up.
 */
export function installerMaintainsExtraCopies(provider: string): boolean {
  return Boolean(registryEntryForProvider(provider)?.installerMirrorDirs?.length);
}

/**
 * Whether this particular copy is one the provider's CLI installer maintains
 * itself — the copies a reinstall refreshes and a user must not delete. Any
 * other stale copy (another node version's global bin, Homebrew) is a real
 * leftover that only removal fixes.
 */
export function isInstallerOwnedCopy(provider: string, installPath: string): boolean {
  const entry = registryEntryForProvider(provider);
  return entry ? isInstallerOwnedPath(entry, installPath) : false;
}

/** Doctor providers use `-cli` suffixed ids; the registry is keyed by CLI type. */
function registryEntryForProvider(provider: string): CliRegistryEntry | undefined {
  const registry: Record<string, CliRegistryEntry | undefined> = CLI_REGISTRY;
  return registry[provider] ?? registry[provider.replace(/-cli$/, '')];
}

/**
 * Classifies an auth failure message into expired vs missing.
 * Used internally in the authenticated probe handlers.
 */
export function classifyAuthKind(message: string): ProviderProbeErrorKind {
  const lower = message.toLowerCase();
  if (lower.includes('expired') || lower.includes('invalid') || lower.includes('revoked')) {
    return 'auth_expired';
  }
  return 'auth_missing';
}

/**
 * The recommendation for a shadow report, decided per stale copy. A copy the
 * CLI's own installer maintains (grok's ~/.grok/bin) is refreshed by
 * reinstalling and must not be deleted — the installer recreates it. Any
 * other stale copy (another node version's global bin, Homebrew) is a leftover
 * that only removal fixes, so it keeps its uninstall hint. CLI Health shows
 * recommendations only, so this string is all the guidance it gives.
 */
export function buildShadowRecommendation(provider: string, report: CliShadowReport): string {
  const stale = report.installs.slice(1);
  const owned = stale.filter((install) => isInstallerOwnedCopy(provider, install.path));
  const leftovers = stale.filter((install) => !owned.includes(install));
  const parts = [
    `Shadow install detected. Active: ${report.activePath} (v${report.activeVersion ?? '?'}).`,
  ];
  if (leftovers.length > 0) {
    const lines = leftovers.map((install) => {
      const uninstallHint = inferUninstallHint(install.path);
      return `- ${install.path} (v${install.version ?? '?'})`
        + `${uninstallHint ? ` — uninstall: ${uninstallHint}` : ''}`;
    });
    parts.push(`Remove the stale copies so the active install is the only one:\n${lines.join('\n')}`);
  }
  if (owned.length > 0) {
    const lines = owned.map((install) => `- ${install.path} (v${install.version ?? '?'})`);
    parts.push(
      `Reinstall ${provider} to refresh the copies its installer maintains — do not delete`
      + ` these by hand, the installer recreates them:\n${lines.join('\n')}`,
    );
  }
  return parts.join(' ');
}

/**
 * Best-effort hint on how to remove a stale CLI copy based on its install path.
 */
export function inferUninstallHint(installPath: string): string | null {
  if (installPath.startsWith('/opt/homebrew/')) {
    const binName = installPath.split('/').pop();
    return `/opt/homebrew/bin/npm uninstall -g <package>  # ${binName} under Homebrew's node`;
  }
  if (installPath.startsWith('/usr/local/')) {
    const binName = installPath.split('/').pop();
    return `/usr/local/bin/npm uninstall -g <package>  # ${binName} under system npm`;
  }
  if (installPath.includes('/.nvm/versions/node/')) {
    return 'nvm install handled — keep this one if it is the newest';
  }
  return null;
}
