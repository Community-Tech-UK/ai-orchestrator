/** User-initiated Xiaomi login. Only the encrypted session survives the window. */
import type { BrowserWindow, BrowserWindowConstructorOptions, Session, WebContents } from 'electron';
import { MAX_PROFILES_PER_PROVIDER, PROVIDER_ACCOUNT_PROFILE_ID_PATTERN } from '../../../../shared/types/provider-account.types';
import { getLogger } from '../../../logging/logger';
import { getMimoSavedSessionStore, type MimoSavedCookie, type MimoSavedSessionStore } from './mimo-saved-session-store';

const logger = getLogger('MimoUsageLogin');
const LOGIN_URL = 'https://platform.xiaomimimo.com/console/plan-manage';
const CONSOLE_NAMES = ['api-platform_serviceToken', 'api-platform_slh', 'api-platform_ph'];
const SSO_NAMES = ['passToken', 'cUserId', 'userId', 'deviceId', 'pass_ua'];

interface LoginRuntime {
  createSession(partition: string): Session;
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  showSaveFailure?(window: BrowserWindow): void;
}

interface LoginEntry {
  window: BrowserWindow;
  contents: WebContents;
  session: Session;
  generation: number;
  active: boolean;
  capturing: boolean;
  captureAgain: boolean;
  pending: Promise<void> | null;
  failureShown: boolean;
  cookieChanged: () => void;
  slot: LoginSlot;
}

interface LoginSlot {
  session: Session;
  owner: object | null;
  cleanup: Promise<boolean>;
  blocked: boolean;
}

interface LoginRequest {
  cancelled: boolean;
  generation: number;
  promise?: Promise<void>;
}

export interface MimoUsageLoginOptions {
  store?: Pick<MimoSavedSessionStore, 'save' | 'remove' | 'generation' | 'assertEncryptionAvailable'>;
  runtime?: () => LoginRuntime;
  onChanged?: (profileId: string) => void;
}

/** Exact origins only; URL credentials, nonstandard ports and custom schemes are refused. */
export function isMimoLoginNavigation(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['platform.xiaomimimo.com', 'account.xiaomi.com'].includes(url.hostname);
  } catch {
    return false;
  }
}

function wantedCookie(cookie: Electron.Cookie): cookie is Electron.Cookie & { domain: string } {
  if (typeof cookie.domain !== 'string') return false;
  const domain = cookie.domain.replace(/^\./, '');
  return (domain === 'platform.xiaomimimo.com' && CONSOLE_NAMES.includes(cookie.name))
    || (domain === 'xiaomimimo.com' && cookie.name === 'userId')
    || (domain === 'account.xiaomi.com' && SSO_NAMES.includes(cookie.name))
    || (domain === 'xiaomi.com' && cookie.name === 'cUserId');
}

function completeConsole(cookies: MimoSavedCookie[]): boolean {
  return CONSOLE_NAMES.every((name) => cookies.some((cookie) => cookie.name === name
    && cookie.domain.replace(/^\./, '') === 'platform.xiaomimimo.com' && cookie.value))
    && cookies.some((cookie) => cookie.name === 'userId'
      && cookie.domain.replace(/^\./, '') === 'xiaomimimo.com' && cookie.value);
}

export class MimoUsageLogin {
  private readonly entries = new Map<string, LoginEntry>();
  private readonly requests = new Map<string, LoginRequest>();
  private readonly slots: LoginSlot[] = [];
  private readonly store: Pick<MimoSavedSessionStore, 'save' | 'remove' | 'generation' | 'assertEncryptionAvailable'>;
  private readonly runtime: () => LoginRuntime;
  private readonly onChanged: (profileId: string) => void;

  constructor(options: MimoUsageLoginOptions = {}) {
    this.store = options.store ?? getMimoSavedSessionStore();
    this.runtime = options.runtime ?? defaultRuntime;
    this.onChanged = options.onChanged ?? notifyQuotaChanged;
  }

  async connect(profile: { id: string; label: string }): Promise<void> {
    if (!PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(profile.id)) throw new Error('Invalid MiMo account.');
    this.store.assertEncryptionAvailable();
    const pending = this.requests.get(profile.id);
    if (pending) return pending.promise;
    const existing = this.entries.get(profile.id);
    if (existing && !existing.window.isDestroyed()) {
      existing.window.focus();
      return;
    }
    if (existing) this.dispose(profile.id, existing);
    const request: LoginRequest = { cancelled: false, generation: this.store.generation(profile.id) };
    this.requests.set(profile.id, request);
    request.promise = this.open(profile, request).finally(() => {
      if (this.requests.get(profile.id) === request) this.requests.delete(profile.id);
    });
    return request.promise;
  }

  private async open(profile: { id: string; label: string }, request: LoginRequest): Promise<void> {
    const runtime = this.runtime();
    const slot = this.reserve(runtime, request);
    // Electron retains native partitions until exit. Reuse a bounded pool only
    // after cleanup, with exclusive ownership throughout preparation and login.
    const cleared = await slot.cleanup;
    if (!cleared) slot.blocked = true;
    if (!cleared || request.cancelled || this.store.generation(profile.id) !== request.generation) {
      slot.owner = null;
      throw new Error('The MiMo sign-in session is unavailable. Close other sign-in windows and try again.');
    }
    const { session } = slot;
    let window: BrowserWindow;
    try {
      window = runtime.createWindow({
        width: 900, height: 760, title: `Connect MiMo usage: ${profile.label}`,
        autoHideMenuBar: true,
        webPreferences: { session, nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false },
      });
    } catch {
      slot.owner = null;
      throw new Error('The MiMo sign-in window could not be opened.');
    }
    const entry: LoginEntry = {
      window, contents: window.webContents, session, generation: this.store.generation(profile.id), active: true,
      capturing: false, captureAgain: false, pending: null, failureShown: false,
      cookieChanged: () => { void this.capture(profile.id, entry); },
      slot,
    };
    this.entries.set(profile.id, entry);
    const guardNavigation = (event: Electron.Event, url: string): void => {
      if (!isMimoLoginNavigation(url)) event.preventDefault();
    };
    entry.contents.on('will-navigate', guardNavigation);
    entry.contents.on('will-redirect', guardNavigation);
    entry.contents.on('will-attach-webview', (event) => event.preventDefault());
    entry.contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.on('page-title-updated', (event) => event.preventDefault());
    session.cookies.on('changed', entry.cookieChanged);
    entry.contents.on('did-finish-load', entry.cookieChanged);
    window.on('closed', () => {
      // Last capture handles a user closing immediately after sign-in.
      void this.capture(profile.id, entry).finally(() => this.dispose(profile.id, entry));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        window.loadURL(LOGIN_URL),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('MiMo login timeout')), 20_000);
        }),
      ]);
    } catch {
      this.dispose(profile.id, entry);
      throw new Error('The MiMo sign-in page could not be opened. Try Connect usage again.');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async disconnect(profileId: string): Promise<void> {
    if (!PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(profileId)) throw new Error('Invalid MiMo account.');
    const entry = this.entries.get(profileId);
    const request = this.requests.get(profileId);
    if (request) {
      request.cancelled = true;
      this.requests.delete(profileId);
    }
    // Invalidate before closing: a pending cookies.get must never restore a removed login.
    if (entry) {
      this.dispose(profileId, entry);
    }
    this.store.remove(profileId);
    this.onChanged(profileId);
    if (entry) await entry.slot.cleanup;
  }

  private capture(profileId: string, entry: LoginEntry): Promise<void> {
    if (!this.isCurrent(profileId, entry)) return Promise.resolve();
    if (entry.capturing) { entry.captureAgain = true; return entry.pending ?? Promise.resolve(); }
    entry.pending = this.captureCookies(profileId, entry);
    return entry.pending;
  }

  private async captureCookies(profileId: string, entry: LoginEntry): Promise<void> {
    entry.capturing = true;
    try {
      do {
        entry.captureAgain = false;
        const cookies = (await entry.session.cookies.get({})).filter(wantedCookie).map((cookie) => ({
          ...cookie,
          domain: cookie.domain.replace(/^\./, '') === 'account.xiaomi.com'
            ? 'account.xiaomi.com' : `.${cookie.domain.replace(/^\./, '')}`,
          value: cookie.value.replace(/^"+|"+$/g, ''),
        }));
        if (!this.isCurrent(profileId, entry)) return;
        if (!completeConsole(cookies)) continue;
        this.store.save(profileId, cookies);
        this.dispose(profileId, entry);
        this.onChanged(profileId);
      } while (entry.active && entry.captureAgain);
    } catch {
      // No response bodies, cookies, URLs or underlying encryption errors enter logs.
      logger.warn('MiMo usage login could not be saved; reconnect usage to retry.');
      if (!entry.failureShown && !entry.window.isDestroyed()) {
        entry.failureShown = true;
        this.runtime().showSaveFailure?.(entry.window);
      }
    } finally {
      entry.capturing = false;
      entry.pending = null;
    }
  }

  private isCurrent(profileId: string, entry: LoginEntry): boolean {
    return entry.active && this.entries.get(profileId) === entry
      && this.store.generation(profileId) === entry.generation;
  }

  private dispose(profileId: string, entry: LoginEntry): void {
    if (!entry.active) return;
    entry.active = false;
    entry.session.cookies.removeListener('changed', entry.cookieChanged);
    if (this.entries.get(profileId) === entry) this.entries.delete(profileId);
    // BrowserWindow native getters throw after a human close. The retained
    // WebContents JS emitter still supports detaching this listener.
    entry.contents.removeListener('did-finish-load', entry.cookieChanged);
    // An untrusted beforeunload handler must not keep using a released session.
    if (!entry.window.isDestroyed()) entry.window.destroy();
    entry.slot.cleanup = this.clearSession(entry.session);
    entry.slot.owner = null;
  }

  private reserve(runtime: LoginRuntime, owner: object): LoginSlot {
    let slot = this.slots.find((candidate) => candidate.owner === null && !candidate.blocked);
    if (!slot) {
      if (this.slots.length >= MAX_PROFILES_PER_PROVIDER) {
        throw new Error('Close another MiMo sign-in window before connecting usage.');
      }
      const session = runtime.createSession(`mimo-usage-slot-${this.slots.length}`);
      // One permanent denial handler per bounded session, never per account.
      session.setPermissionCheckHandler(() => false);
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      session.on('will-download', (event) => event.preventDefault());
      slot = { session, owner: null, blocked: false, cleanup: this.clearSession(session) };
      this.slots.push(slot);
    }
    slot.owner = owner;
    return slot;
  }

  private async clearSession(session: Session): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await session.closeAllConnections();
          await Promise.all([session.clearStorageData(), session.clearAuthCache()]);
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('MiMo cleanup timeout')), 20_000);
        }),
      ]);
      return true;
    } catch {
      logger.warn('MiMo temporary login cleanup failed.');
      // Keep the rejected result on this slot: never reopen uncleared storage.
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function defaultRuntime(): LoginRuntime {
  // Lazy access keeps quota module imports usable outside Electron's main process.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron');
  return {
    createSession: (partition) => electron.session.fromPartition(partition, { cache: false }),
    createWindow: (options) => new electron.BrowserWindow(options),
    showSaveFailure: (window) => {
      void electron.dialog.showMessageBox(window, {
        type: 'error', title: 'MiMo usage login was not saved',
        message: 'The app could not securely save this login. Close the sign-in window and try Connect usage again.',
      }).catch(() => logger.warn('MiMo usage login error could not be displayed.'));
    },
  };
}

function notifyQuotaChanged(profileId: string): void {
  void import('./index').then(({ registerDefaultQuotaProbes }) => {
    registerDefaultQuotaProbes();
    return import('../provider-quota-service');
  }).then(({ getProviderQuotaService }) => getProviderQuotaService().refresh('opencode', profileId, { force: true }))
    .catch(() => logger.warn('MiMo usage refresh failed after changing its saved login.'));
}

let instance: MimoUsageLogin | null = null;
export function getMimoUsageLogin(): MimoUsageLogin { return instance ??= new MimoUsageLogin(); }
