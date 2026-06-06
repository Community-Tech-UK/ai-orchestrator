import type { CliShadowReport } from '../cli/cli-detection';
import type { ProviderProbeErrorKind, RepairAction } from '../../shared/types/provider-doctor.types';

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

/** Install command previews — no secrets, generic paths only. */
const INSTALL_COMMANDS: Record<string, string> = {
  'claude-cli': 'npm install -g @anthropic-ai/claude-code',
  'codex-cli': 'npm install -g @openai/codex',
  'gemini-cli': 'npm install -g @google/gemini-cli',
  'copilot': 'gh extension install github/gh-copilot  # or: npm install -g @github/copilot',
  'cursor': 'Install Cursor from https://cursor.sh and add cursor-agent to PATH',
  'anthropic-api': 'npm install -g @anthropic-ai/claude-code',
};

const LOGIN_COMMANDS: Record<string, string> = {
  'claude-cli': 'claude auth login',
  'codex-cli': 'codex login',
  'gemini-cli': 'gemini  # follow the interactive auth prompts',
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
      const report = probe.metadata?.['report'] as CliShadowReport | undefined;
      if (report && report.installs.length >= 2) {
        const versions = new Set(report.installs.map((i) => i.version));
        return versions.size > 1 ? 'cli_version_mismatch' : 'cli_shadow_install';
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
          description: `Install the ${provider} CLI so the binary is accessible on PATH.`,
          severity: 'critical',
        });
        break;
      }

      case 'cli_shadow_install': {
        const report = probe.metadata?.['report'] as CliShadowReport | undefined;
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
        actions.push({
          kind,
          command: `${installCmd}  # then remove older copies from PATH`,
          description: 'Multiple CLI installs with different versions — update to a single consistent version.',
          severity: 'warning',
        });
        break;
      }

      case 'auth_missing':
      case 'auth_expired': {
        const loginCmd = LOGIN_COMMANDS[provider] ?? '# re-run the provider login command';
        actions.push({
          kind,
          command: loginCmd,
          description: kind === 'auth_missing'
            ? `Authenticate the ${provider} CLI so it can communicate with the provider.`
            : `Credentials for ${provider} are expired or invalid — re-authenticate.`,
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
