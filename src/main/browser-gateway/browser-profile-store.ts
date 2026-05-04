import type {
  BrowserAllowedOrigin,
  BrowserCreateProfileRequest,
  BrowserProfile,
  BrowserUpdateProfileRequest,
} from '@contracts/types/browser';
import { BrowserAllowedOriginSchema } from '@contracts/schemas/browser';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import { generateId } from '../../shared/utils/id-generator';

const logger = getLogger('BrowserProfileStore');

interface BrowserProfileRow {
  id: string;
  label: string;
  mode: BrowserProfile['mode'];
  browser: BrowserProfile['browser'];
  user_data_dir: string | null;
  allowed_origins_json: string;
  default_url: string | null;
  status: BrowserProfile['status'];
  debug_port: number | null;
  debug_endpoint: string | null;
  process_id: number | null;
  created_at: number;
  updated_at: number;
  last_launched_at: number | null;
  last_used_at: number | null;
  last_login_check_at: number | null;
}

export type BrowserRuntimeStatePatch = Partial<
  Pick<
    BrowserProfile,
    | 'status'
    | 'debugPort'
    | 'debugEndpoint'
    | 'processId'
    | 'lastLaunchedAt'
    | 'lastUsedAt'
    | 'lastLoginCheckAt'
  >
>;

export interface BrowserProfileCreateInput extends BrowserCreateProfileRequest {
  id?: string;
  userDataDir?: string;
}

export class BrowserProfileStore {
  constructor(private readonly db: SqliteDriver = getRLMDatabase().getRawDb()) {}

  listProfiles(): BrowserProfile[] {
    return this.db
      .prepare(
        `
        SELECT *
        FROM browser_profiles
        ORDER BY updated_at DESC, label ASC
      `,
      )
      .all<BrowserProfileRow>()
      .map((row) => this.map(row));
  }

  getProfile(id: string): BrowserProfile | null {
    const row = this.db
      .prepare(`SELECT * FROM browser_profiles WHERE id = ?`)
      .get<BrowserProfileRow>(id);
    return row ? this.map(row) : null;
  }

  createProfile(input: BrowserProfileCreateInput): BrowserProfile {
    const id = input.id ?? generateId();
    const now = Date.now();
    this.db
      .prepare(
        `
        INSERT INTO browser_profiles
          (id, label, mode, browser, user_data_dir, allowed_origins_json,
           default_url, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?)
      `,
      )
      .run(
        id,
        input.label,
        input.mode,
        input.browser,
        input.userDataDir ?? null,
        JSON.stringify(input.allowedOrigins),
        input.defaultUrl ?? null,
        now,
        now,
      );

    const profile = this.getProfile(id);
    if (!profile) {
      throw new Error(`Browser profile ${id} was not created`);
    }
    return profile;
  }

  updateProfile(id: string, patch: BrowserUpdateProfileRequest): BrowserProfile {
    const existing = this.getProfile(id);
    if (!existing) {
      throw new Error(`Browser profile ${id} not found`);
    }

    const now = Date.now();
    const nextAllowedOrigins = patch.allowedOrigins ?? existing.allowedOrigins;
    const nextDefaultUrl =
      patch.defaultUrl === undefined ? existing.defaultUrl ?? null : patch.defaultUrl;

    this.db
      .prepare(
        `
        UPDATE browser_profiles
        SET label = ?,
            allowed_origins_json = ?,
            default_url = ?,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        patch.label ?? existing.label,
        JSON.stringify(nextAllowedOrigins),
        nextDefaultUrl,
        now,
        id,
      );

    const profile = this.getProfile(id);
    if (!profile) {
      throw new Error(`Browser profile ${id} disappeared during update`);
    }
    return profile;
  }

  deleteProfile(id: string): void {
    this.db.prepare(`DELETE FROM browser_profiles WHERE id = ?`).run(id);
  }

  setRuntimeState(id: string, patch: BrowserRuntimeStatePatch): BrowserProfile {
    const existing = this.getProfile(id);
    if (!existing) {
      throw new Error(`Browser profile ${id} not found`);
    }

    const has = (key: keyof BrowserRuntimeStatePatch): boolean =>
      Object.prototype.hasOwnProperty.call(patch, key);
    const now = Date.now();

    this.db
      .prepare(
        `
        UPDATE browser_profiles
        SET status = ?,
            debug_port = ?,
            debug_endpoint = ?,
            process_id = ?,
            last_launched_at = ?,
            last_used_at = ?,
            last_login_check_at = ?,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        has('status') ? patch.status : existing.status,
        has('debugPort') ? patch.debugPort ?? null : existing.debugPort ?? null,
        has('debugEndpoint')
          ? patch.debugEndpoint ?? null
          : existing.debugEndpoint ?? null,
        has('processId') ? patch.processId ?? null : existing.processId ?? null,
        has('lastLaunchedAt')
          ? patch.lastLaunchedAt ?? null
          : existing.lastLaunchedAt ?? null,
        has('lastUsedAt') ? patch.lastUsedAt ?? null : existing.lastUsedAt ?? null,
        has('lastLoginCheckAt')
          ? patch.lastLoginCheckAt ?? null
          : existing.lastLoginCheckAt ?? null,
        now,
        id,
      );

    const profile = this.getProfile(id);
    if (!profile) {
      throw new Error(`Browser profile ${id} disappeared during runtime update`);
    }
    return profile;
  }

  private map(row: BrowserProfileRow): BrowserProfile {
    return {
      id: row.id,
      label: row.label,
      mode: row.mode,
      browser: row.browser,
      userDataDir: row.user_data_dir ?? undefined,
      allowedOrigins: this.parseAllowedOrigins(row),
      defaultUrl: row.default_url ?? undefined,
      status: row.status,
      debugPort: row.debug_port ?? undefined,
      debugEndpoint: row.debug_endpoint ?? undefined,
      processId: row.process_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastLaunchedAt: row.last_launched_at ?? undefined,
      lastUsedAt: row.last_used_at ?? undefined,
      lastLoginCheckAt: row.last_login_check_at ?? undefined,
    };
  }

  private parseAllowedOrigins(row: BrowserProfileRow): BrowserAllowedOrigin[] {
    try {
      const parsed = JSON.parse(row.allowed_origins_json) as unknown;
      const result = BrowserAllowedOriginSchema.array().safeParse(parsed);
      if (!result.success) {
        throw new Error(result.error.message);
      }
      return result.data;
    } catch (error) {
      logger.warn('Invalid browser profile allowed origins JSON', {
        profileId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}

let browserProfileStore: BrowserProfileStore | null = null;

export function getBrowserProfileStore(): BrowserProfileStore {
  if (!browserProfileStore) {
    browserProfileStore = new BrowserProfileStore();
  }
  return browserProfileStore;
}

export function _resetBrowserProfileStoreForTesting(): void {
  browserProfileStore = null;
}
