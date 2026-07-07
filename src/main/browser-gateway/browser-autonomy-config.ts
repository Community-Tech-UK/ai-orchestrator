import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { BrowserCreateProfileRequest } from '@contracts/types/browser';
import { getBrowserProfileStore } from './browser-profile-store';
import { getBrowserProfileRegistry } from './browser-profile-registry';
import {
  getBrowserCampaignService,
  getBrowserCredentialAuthorizationService,
} from './browser-unattended-services';
import { getLogger } from '../logging/logger';

/**
 * Operator-owned "full autonomy" bootstrap. A single JSON file the local
 * operator controls declares everything an unattended run needs — the
 * master-password source, the managed profiles, the standing credential
 * authorizations, and any standing campaigns — so the whole pipeline comes up
 * hands-free at app start with no UI clicks and no per-session approvals.
 *
 * WHY A FILE, NOT A TOOL: credential authorizations grant the agent the right
 * to log in / register with real secrets. Those must originate from the human
 * operator, never from an agent tool-call (this tree runs many autonomous
 * agents). A file on the operator's disk is exactly that trust source — an
 * agent has no MCP surface to write it. Everything here is idempotent, so it
 * re-applies safely on every boot.
 *
 * Location: AIO_BROWSER_AUTONOMY_CONFIG env var, else
 * ~/.config/ai-orchestrator/browser-autonomy.json. Absent file = no-op (the
 * vault stays locked and nothing is provisioned, exactly as before).
 */

const logger = getLogger('BrowserAutonomyConfig');

const OriginSchema = z
  .object({
    scheme: z.enum(['https', 'http']),
    hostPattern: z.string().min(1).max(500),
    port: z.number().int().positive().optional(),
    includeSubdomains: z.boolean().default(false),
  })
  .strict();

const ProfileSchema = z
  .object({
    id: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    mode: z.enum(['session', 'isolated']).default('isolated'),
    browser: z.literal('chrome').default('chrome'),
    allowedOrigins: z.array(OriginSchema).min(1).max(50),
    defaultUrl: z.string().url().max(2000).optional(),
  })
  .strict();

const AuthorizationSchema = z
  .object({
    profileId: z.string().min(1).max(200),
    allowedOrigins: z
      .array(
        z
          .object({
            scheme: z.enum(['https', 'http']),
            hostPattern: z.string().min(1).max(500),
            includeSubdomains: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    purposes: z.array(z.enum(['login', 'register', 'totp', 'email_code'])).min(1),
    vaultFolder: z.string().min(1).max(200).default('AIO-Agent'),
    expiresInDays: z.number().int().min(1).max(365).default(90),
    note: z.string().min(1).max(1000).optional(),
  })
  .strict();

const CampaignSchema = z
  .object({
    label: z.string().min(1).max(200),
    profileId: z.string().min(1).max(200),
    allowedOrigins: z.array(z.string().min(1).max(500)).min(1).max(50),
    allowedActionClasses: z.array(z.string().min(1).max(50)).min(1).max(10),
    budget: z
      .object({
        maxActions: z.number().int().min(1).max(100_000),
        maxSubmits: z.number().int().min(0).max(10_000),
        maxNewAccounts: z.number().int().min(0).max(100),
        maxUploads: z.number().int().min(0).max(1_000),
        maxDurationHours: z.number().min(0.5).max(14),
      })
      .strict(),
  })
  .strict();

export const BrowserAutonomyConfigSchema = z
  .object({
    /** Path to the Bitwarden master-password file. Enables hands-free unlock. */
    masterPasswordFile: z.string().min(1).max(2000).optional(),
    profiles: z.array(ProfileSchema).max(50).default([]),
    credentialAuthorizations: z.array(AuthorizationSchema).max(100).default([]),
    campaigns: z.array(CampaignSchema).max(50).default([]),
  })
  .strict();

export type BrowserAutonomyConfig = z.infer<typeof BrowserAutonomyConfigSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveAutonomyConfigPath(): string {
  const override = process.env['AIO_BROWSER_AUTONOMY_CONFIG']?.trim();
  return override || path.join(os.homedir(), '.config', 'ai-orchestrator', 'browser-autonomy.json');
}

/** Read + validate the config file. Returns null when absent or invalid. */
export function loadBrowserAutonomyConfig(
  configPath = resolveAutonomyConfigPath(),
): BrowserAutonomyConfig | null {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return null; // Absent file is the normal "no autonomy configured" case.
  }
  try {
    return BrowserAutonomyConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    logger.error('Browser autonomy config is invalid; ignoring it', undefined, {
      configPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Stable, content-derived id so re-applying the same authorization is a no-op. */
function authorizationId(auth: BrowserAutonomyConfig['credentialAuthorizations'][number]): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        profileId: auth.profileId,
        allowedOrigins: auth.allowedOrigins,
        purposes: [...auth.purposes].sort(),
        vaultFolder: auth.vaultFolder,
      }),
    )
    .digest('hex')
    .slice(0, 32);
  return `authcfg-${digest}`;
}

/** Create one campaign from a config entry (hours -> ms). Shared by the boot
 * apply and the expiry-renewal path so their create shape can never drift. */
function createCampaignFromConfig(
  campaigns: ApplyAutonomyConfigDeps['campaigns'],
  campaign: BrowserAutonomyConfig['campaigns'][number],
): void {
  campaigns.create({
    label: campaign.label,
    profileId: campaign.profileId,
    allowedOrigins: campaign.allowedOrigins,
    allowedActionClasses: campaign.allowedActionClasses,
    budget: {
      maxActions: campaign.budget.maxActions,
      maxSubmits: campaign.budget.maxSubmits,
      maxNewAccounts: campaign.budget.maxNewAccounts,
      maxUploads: campaign.budget.maxUploads,
      maxDurationMs: Math.round(campaign.budget.maxDurationHours * 60 * 60 * 1000),
    },
  });
}

export interface ApplyAutonomyConfigDeps {
  profileStore: Pick<
    ReturnType<typeof getBrowserProfileStore>,
    'getProfile' | 'createProfile'
  >;
  resolveProfileDir: (profileId: string) => string;
  authorizations: Pick<
    ReturnType<typeof getBrowserCredentialAuthorizationService>,
    'list' | 'create'
  >;
  campaigns: Pick<
    ReturnType<typeof getBrowserCampaignService>,
    'list' | 'create'
  >;
  now?: () => number;
}

export interface ApplyAutonomyConfigResult {
  profilesCreated: number;
  authorizationsCreated: number;
  campaignsCreated: number;
}

/**
 * Idempotently provision profiles, standing authorizations, and campaigns from
 * a parsed config. Safe to call on every boot: existing profiles (by id),
 * authorizations (by content hash), and active campaigns (by label) are left
 * untouched. Never unlocks the vault itself — that stays with the auto-unlock
 * path (the config only points the env var at the password file).
 */
export function applyBrowserAutonomyConfig(
  config: BrowserAutonomyConfig,
  deps: ApplyAutonomyConfigDeps,
): ApplyAutonomyConfigResult {
  const now = deps.now ?? (() => Date.now());
  const result: ApplyAutonomyConfigResult = {
    profilesCreated: 0,
    authorizationsCreated: 0,
    campaignsCreated: 0,
  };

  for (const profile of config.profiles) {
    if (deps.profileStore.getProfile(profile.id)) {
      continue;
    }
    const createInput: BrowserCreateProfileRequest & { id: string; userDataDir: string } = {
      id: profile.id,
      label: profile.label,
      mode: profile.mode,
      browser: profile.browser,
      allowedOrigins: profile.allowedOrigins,
      ...(profile.defaultUrl ? { defaultUrl: profile.defaultUrl } : {}),
      userDataDir: deps.resolveProfileDir(profile.id),
    };
    deps.profileStore.createProfile(createInput);
    result.profilesCreated += 1;
  }

  for (const auth of config.credentialAuthorizations) {
    const id = authorizationId(auth);
    const existing = deps.authorizations
      .list(auth.profileId)
      .find((record) => record.id === id && !record.revokedAt && record.expiresAt > now());
    if (existing) {
      continue;
    }
    deps.authorizations.create(
      {
        profileId: auth.profileId,
        allowedOrigins: auth.allowedOrigins,
        purposes: auth.purposes,
        vaultFolder: auth.vaultFolder,
        expiresAt: now() + auth.expiresInDays * DAY_MS,
        ...(auth.note ? { note: auth.note } : {}),
      },
      id,
    );
    result.authorizationsCreated += 1;
  }

  for (const campaign of config.campaigns) {
    const liveDuplicate = deps.campaigns
      .list()
      .some(
        (existing) =>
          existing.label === campaign.label &&
          (existing.status === 'active' || existing.status === 'paused'),
      );
    if (liveDuplicate) {
      continue;
    }
    createCampaignFromConfig(deps.campaigns, campaign);
    result.campaignsCreated += 1;
  }

  return result;
}

/**
 * Boot-time entry point: load the config from disk and apply it. Points the
 * auto-unlock env var at the configured master-password file (so the existing
 * auto-unlock path unlocks the vault) and provisions profiles/authorizations/
 * campaigns. Best-effort: never throws into gateway startup.
 */
/** The app-root singletons wired into the idempotent apply. */
function defaultAutonomyDeps(): ApplyAutonomyConfigDeps {
  const registry = getBrowserProfileRegistry();
  return {
    profileStore: getBrowserProfileStore(),
    resolveProfileDir: (profileId) => registry.resolveProfileDir(profileId),
    authorizations: getBrowserCredentialAuthorizationService(),
    campaigns: getBrowserCampaignService(),
  };
}

export function applyBrowserAutonomyConfigFromDisk(): void {
  const config = loadBrowserAutonomyConfig();
  if (!config) {
    return;
  }
  if (config.masterPasswordFile && !process.env['AIO_BW_MASTER_PASSWORD_FILE']?.trim()) {
    // Operator-owned config → hands-free unlock via the existing auto-unlock
    // path. The path only; the password itself is read at unlock time.
    process.env['AIO_BW_MASTER_PASSWORD_FILE'] = config.masterPasswordFile;
  }
  try {
    const applied = applyBrowserAutonomyConfig(config, defaultAutonomyDeps());
    logger.info('Applied browser autonomy config', { ...applied });
  } catch (error) {
    logger.error('Failed to apply browser autonomy config', undefined, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Re-establish a standing campaign after its 14h cap expires, WITHOUT a restart,
 * so an unattended run keeps going overnight and beyond. Only a purely-expired
 * history rolls over: a campaign the operator killed (or that is still active/
 * paused/completed) is left untouched, so the in-app kill switch is never
 * defeated here. Absent config / no campaigns = no-op. Returns the count
 * re-created. Idempotent and safe to call on a timer.
 */
export function reestablishExpiredStandingCampaigns(
  deps: ApplyAutonomyConfigDeps = defaultAutonomyDeps(),
  config = loadBrowserAutonomyConfig(),
): number {
  if (!config || config.campaigns.length === 0) {
    return 0;
  }
  const existing = deps.campaigns.list();
  let created = 0;
  for (const campaign of config.campaigns) {
    const sameLabel = existing.filter((c) => c.label === campaign.label);
    if (sameLabel.length === 0) {
      continue; // Never provisioned yet — the boot-time apply owns the first create.
    }
    const blocking = sameLabel.some(
      (c) =>
        c.status === 'active' ||
        c.status === 'paused' ||
        c.status === 'killed' ||
        c.status === 'completed',
    );
    if (blocking) {
      continue;
    }
    if (sameLabel.some((c) => c.status === 'expired')) {
      createCampaignFromConfig(deps.campaigns, campaign);
      created += 1;
    }
  }
  return created;
}

let standingRenewalTimer: NodeJS.Timeout | null = null;

/**
 * Poll for expired standing campaigns and re-establish them (default every
 * 10 min). The cap on each campaign is still 14h; this just rolls a fresh one
 * once the prior window closes. `.unref()` so it never holds the process open.
 */
export function initializeStandingCampaignRenewal(intervalMs = 10 * 60 * 1000): void {
  if (standingRenewalTimer) {
    clearInterval(standingRenewalTimer);
  }
  standingRenewalTimer = setInterval(() => {
    try {
      const created = reestablishExpiredStandingCampaigns();
      if (created > 0) {
        logger.info('Re-established expired standing campaign(s)', { created });
      }
    } catch (error) {
      logger.warn('Standing campaign renewal tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, intervalMs);
  standingRenewalTimer.unref?.();
}

export function stopStandingCampaignRenewal(): void {
  if (standingRenewalTimer) {
    clearInterval(standingRenewalTimer);
    standingRenewalTimer = null;
  }
}
