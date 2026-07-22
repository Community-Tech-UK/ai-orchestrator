import { app } from 'electron';
import type { BrowserGatewayRpcServerOptions } from './browser-gateway-rpc-server';
import {
  initializeBrowserGatewayService,
  type BrowserGatewayServiceOptions,
} from './browser-gateway-service';
import {
  initializeBrowserGatewayRpcServer,
} from './browser-gateway-rpc-server';
import { prepareBrowserExtensionNativeHostRuntime } from './browser-extension-native-runtime';
import { setBrowserGatewayMcpBridgeAvailabilityProvider } from './browser-health-service';
import { setBrowserLocalExtensionUserDataPathProvider } from './browser-local-extension-health';
import * as fs from 'node:fs';
import { CredentialVault } from './browser-credential-vault';
import { createBwRunner } from './browser-bw-runner';
import { SqliteVaultOriginBindingStore } from './browser-unattended-sqlite-stores';
import {
  getBrowserCampaignService,
  getBrowserCredentialAuthorizationService,
  maybeAutoUnlockBrowserCredentialVault,
  watchVaultAutoUnlockSetting,
} from './browser-unattended-services';
import {
  initializeBrowserCampaignRuntime,
  stopBrowserCampaignRuntime,
} from './browser-campaign-runtime';
import { getBrowserGrantStore } from './browser-grant-store';
import {
  applyBrowserAutonomyConfigFromDisk,
  initializeStandingCampaignRenewal,
  stopStandingCampaignRenewal,
} from './browser-autonomy-config';
import { registerCleanup } from '../util/cleanup-registry';
import { BrowserEmailCodeReader } from './browser-email-code-reader';
import { ImapMcpMailboxReader, type ImapMcpServerCommand } from './browser-imap-mailbox-reader';
import { MCP_CONFIG_PATH } from '../instance/lifecycle/spawn-config-builder';
import { getBrowserCredentialSession } from './browser-credential-session';
import { deriveManagedDebugPort } from './chrome-devtools-attach';
import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import { resolveAioMcpCliPath } from '../util/aio-mcp-cli-path';

const logger = getLogger('BrowserGatewayRuntime');

export * from './browser-anti-throttle';
export * from './browser-audit-store';
export * from './browser-action-classifier';
export * from './browser-auto-approve';
export * from './browser-approval-store';
export * from './chrome-devtools-attach';
export * from './chrome-devtools-mcp-config';
export * from './browser-gateway-service';
export * from './browser-gateway-rpc-client';
export * from './browser-gateway-rpc-server';
export * from './browser-extension-tab-store';
export * from './browser-extension-command-store';
export * from './browser-extension-native-host';
export * from './browser-extension-native-runtime';
export * from './browser-grant-policy';
export * from './browser-grant-store';
export * from './browser-health-service';
export * from './browser-mcp-config';
export * from './browser-mcp-deferral';
export * from './browser-mcp-tools';
export * from './browser-origin-policy';
export * from './browser-process-launcher';
export * from './browser-profile-registry';
export * from './browser-profile-store';
export * from './browser-redaction';
export * from './browser-safe-dto';
export * from './browser-target-registry';
export * from './browser-types';
export * from './browser-autonomy-config';
export * from './browser-campaign-runtime';
export * from './browser-imap-mailbox-reader';
export * from './browser-session-relogin';
export * from './browser-unattended-services';
export * from './browser-upload-policy';
export * from './puppeteer-browser-driver';

export interface BrowserGatewayRuntimeOptions extends BrowserGatewayRpcServerOptions {
  autoApproveRequests?: BrowserGatewayServiceOptions['autoApproveRequests'];
}

/**
 * Construct the credential vault + authorization services backed by SQLite +
 * Bitwarden. Best-effort: if the RLM database is not ready this returns empty
 * options and browser.fill_credential simply reports itself unavailable rather
 * than crashing gateway startup. Secrets never touch these objects — the vault
 * resolves them from Bitwarden in-process at fill time using the in-memory
 * BW_SESSION (unset until James unlocks).
 */
function buildCredentialServices(): Pick<
  BrowserGatewayServiceOptions,
  'credentialVault' | 'credentialAuthorizations' | 'emailCodeReader'
> {
  try {
    const credentialVault = new CredentialVault({
      runner: createBwRunner(),
      bindings: new SqliteVaultOriginBindingStore(),
      getSession: () => getBrowserCredentialSession().getToken(),
    });
    // Shared singleton: the same instance the renderer IPC dialogs write to,
    // so a newly approved authorization is immediately honoured at fill time.
    const credentialAuthorizations = getBrowserCredentialAuthorizationService();
    return { credentialVault, credentialAuthorizations, ...buildEmailCodeReader() };
  } catch (error) {
    logger.warn('Credential vault services unavailable; browser.fill_credential disabled', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * Build the agent-mailbox one-time-code reader over the imap MCP server from
 * config/mcp-servers.json. Best-effort: when the server is not configured,
 * email_code fills simply report themselves unavailable. The IMAP credentials
 * live entirely inside the imap server's own config — never here.
 */
function buildEmailCodeReader(): Pick<BrowserGatewayServiceOptions, 'emailCodeReader'> {
  try {
    const raw = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8')) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    const imap = raw.mcpServers?.['imap'];
    if (!imap?.command) {
      logger.info('No imap MCP server configured; email_code fills unavailable');
      return {};
    }
    const server: ImapMcpServerCommand = { command: imap.command, args: imap.args ?? [] };
    // The agent shared mailbox. The imap server's own default is its FIRST
    // configured account, which is not necessarily this one — be explicit.
    const account =
      process.env['AIO_BROWSER_EMAIL_ACCOUNT']?.trim() || 'james@communitytech.co.uk';
    const emailCodeReader = new BrowserEmailCodeReader({
      reader: new ImapMcpMailboxReader({ server, account }),
    });
    return { emailCodeReader };
  } catch (error) {
    logger.warn('Failed to configure email-code reader; email_code fills unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export async function initializeBrowserGatewayRuntime(
  options: BrowserGatewayRuntimeOptions = {},
): Promise<void> {
  // Point the local-extension probe at the same user-data path the native-host
  // installer writes to, so health, freshness prechecks and list_targets all
  // inspect the files this install actually owns.
  setBrowserLocalExtensionUserDataPathProvider(
    () => options.userDataPath ?? app.getPath('userData'),
  );
  const credentials = buildCredentialServices();
  // Operator-owned full-autonomy bootstrap: provision managed profiles,
  // standing credential authorizations, and campaigns from the config file,
  // and point the auto-unlock env var at the configured master-password file.
  // Runs BEFORE auto-unlock so the config's password path is honoured.
  applyBrowserAutonomyConfigFromDisk();
  // Hands-free unlock: if the operator opted into browserVaultAutoUnlock and a
  // master-password file is configured, unlock the vault at startup so
  // unattended runs never need the UI. Non-blocking; failures leave it locked.
  // The watcher also unlocks immediately if the flag/path is set post-startup.
  void maybeAutoUnlockBrowserCredentialVault();
  watchVaultAutoUnlockSetting();
  // Campaign runtime: budget enforcement for mutations under campaign leases,
  // the ~60min lease renewer, and lease revocation on any campaign stop.
  try {
    initializeBrowserCampaignRuntime({
      campaigns: getBrowserCampaignService(),
      grantStore: getBrowserGrantStore(),
    });
    registerCleanup(() => stopBrowserCampaignRuntime());
  } catch (error) {
    logger.warn('Browser campaign runtime unavailable (campaign leases disabled)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // Standing campaign renewal: re-establish a config-declared standing campaign
  // once its 14h cap expires, so unattended runs continue without a restart.
  // No-op unless the operator's autonomy config declares campaigns.
  try {
    initializeStandingCampaignRenewal();
    registerCleanup(() => stopStandingCampaignRenewal());
  } catch (error) {
    logger.warn('Standing campaign renewal unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const service = initializeBrowserGatewayService({
    autoApproveRequests: options.autoApproveRequests,
    ...credentials,
    // Operator opt-in for autonomous credential fills on the user's shared
    // existing tabs. Global flag today (the standing authorization supplies the
    // per-node/origin scoping); the signature is per-profile for a future
    // per-profile allowlist. Fails closed to managed-only if settings error.
    allowSharedTabCredentialFill: (_profileId) => {
      try {
        return getSettingsManager().getAll().browserAllowSharedTabCredentialFill === true;
      } catch (error) {
        logger.warn('Failed to read browserAllowSharedTabCredentialFill; shared-tab fills stay off', {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    // Pin the managed profile's CDP port to the derived value when it is the
    // designated chrome-devtools attach profile, so the agent's spawn-time
    // `--browserUrl` matches the live port. Otherwise use a random free port.
    resolvePreferredDebugPort: (profileId) => {
      try {
        const settings = getSettingsManager().getAll();
        if (
          settings.chromeDevtoolsAttachEnabled
          && settings.chromeDevtoolsAttachProfileId?.trim() === profileId
        ) {
          return deriveManagedDebugPort(profileId);
        }
      } catch (error) {
        logger.warn('Failed to resolve chrome-devtools attach debug port; using a random port', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return undefined;
    },
  });
  const server = await initializeBrowserGatewayRpcServer({
    ...options,
    service: options.service ?? service,
  });
  setBrowserGatewayMcpBridgeAvailabilityProvider(() => Boolean(server.getSocketPath()));
  const socketPath = server.getSocketPath();
  if (socketPath) {
    const aioMcpCliPath = resolveAioMcpCliPath();
    if (!aioMcpCliPath) {
      // Without the SEA we have nothing to point Chrome's native-messaging
      // host registration at. The MCP bridge for the in-app browser
      // extension stays unregistered — degraded but non-fatal.
      logger.warn(
        'aio-mcp SEA binary not found — Chrome native-messaging host wrapper not installed',
      );
    } else {
      prepareBrowserExtensionNativeHostRuntime({
        userDataPath: options.userDataPath ?? app.getPath('userData'),
        socketPath,
        extensionToken: server.getExtensionToken(),
        hostCommand: {
          exe: aioMcpCliPath,
          args: ['native-host'],
        },
      });
    }
  }
}
