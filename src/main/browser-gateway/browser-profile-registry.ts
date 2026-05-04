import * as path from 'path';
import { app } from 'electron';
import type {
  BrowserCreateProfileRequest,
  BrowserProfile,
} from '@contracts/types/browser';
import { generateId } from '../../shared/utils/id-generator';
import {
  BrowserProfileStore,
  getBrowserProfileStore,
} from './browser-profile-store';

export interface BrowserProfileRegistryOptions {
  store?: Pick<BrowserProfileStore, 'listProfiles' | 'createProfile'>;
  userDataPath?: string;
}

export class BrowserProfileRegistry {
  private static instance: BrowserProfileRegistry | null = null;
  private readonly store: Pick<BrowserProfileStore, 'listProfiles' | 'createProfile'>;
  private readonly profileRoot: string;

  constructor(options: BrowserProfileRegistryOptions = {}) {
    this.store = options.store ?? getBrowserProfileStore();
    const userDataPath = options.userDataPath ?? app.getPath('userData');
    this.profileRoot = path.resolve(userDataPath, 'browser-profiles');
  }

  static getInstance(): BrowserProfileRegistry {
    if (!this.instance) {
      this.instance = new BrowserProfileRegistry();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  createProfile(input: BrowserCreateProfileRequest): BrowserProfile {
    const label = input.label.trim();
    if (!label) {
      throw new Error('Browser profile label is required');
    }

    const duplicate = this.store
      .listProfiles()
      .some((profile) => profile.label.trim().toLowerCase() === label.toLowerCase());
    if (duplicate) {
      throw new Error(`Browser profile label '${label}' already exists`);
    }

    const id = generateId();
    return this.store.createProfile({
      id,
      ...input,
      label,
      userDataDir: this.resolveProfileDir(id),
    });
  }

  resolveProfileDir(profileId: string): string {
    const resolved = path.resolve(this.profileRoot, profileId);
    const relative = path.relative(this.profileRoot, resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Browser profile directory is outside managed browser profile root');
    }
    return resolved;
  }

  getProfileRoot(): string {
    return this.profileRoot;
  }
}

export function getBrowserProfileRegistry(): BrowserProfileRegistry {
  return BrowserProfileRegistry.getInstance();
}
