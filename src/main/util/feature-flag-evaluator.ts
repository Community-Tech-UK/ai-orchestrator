import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ORCHESTRATION_FEATURES, type FeatureFlag } from '../../shared/constants/feature-flags';
import { getLogger } from '../logging/logger';

const logger = getLogger('FeatureFlagEvaluator');

type FlagValue = boolean | { enabled: boolean; rolloutPercent: number };

function resolveUserDataPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    return app.getPath('userData');
  } catch {
    return os.tmpdir();
  }
}

export class FeatureFlagEvaluator {
  private static instance: FeatureFlagEvaluator | null = null;
  private flags = new Map<string, FlagValue>();
  private persistPath: string;

  private constructor() {
    this.persistPath = path.join(resolveUserDataPath(), 'feature-flags.json');
    this.load();
  }

  static getInstance(): FeatureFlagEvaluator {
    if (!this.instance) this.instance = new FeatureFlagEvaluator();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  isEnabled(flag: string, seed?: string): boolean {
    // 1. Check runtime overrides
    const override = this.flags.get(flag);
    if (override !== undefined) {
      if (typeof override === 'boolean') return override;
      if (!override.enabled) return false;
      if (override.rolloutPercent >= 100) return true;
      if (override.rolloutPercent <= 0) return false;
      const hash = createHash('sha256').update(`${flag}:${seed ?? 'default'}`).digest();
      const bucket = hash.readUInt16BE(0) % 100;
      return bucket < override.rolloutPercent;
    }

    // 2. Check env var
    const envKey = `ORCH_FEATURE_${flag.replace(/\./g, '_').toUpperCase()}`;
    const envVal = process.env[envKey];
    if (envVal === 'true') return true;
    if (envVal === 'false') return false;

    // 3. Check compile-time constants
    if (flag in ORCHESTRATION_FEATURES) {
      return ORCHESTRATION_FEATURES[flag as FeatureFlag];
    }

    return false;
  }

  setFlag(flag: string, value: FlagValue): void {
    this.flags.set(flag, value);
  }

  removeFlag(flag: string): void {
    this.flags.delete(flag);
  }

  getAllFlags(): Record<string, FlagValue> {
    return Object.fromEntries(this.flags);
  }

  save(): void {
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify(Object.fromEntries(this.flags), null, 2));
    } catch (err) {
      logger.warn(`Failed to save feature flags: ${err}`);
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
        for (const [k, v] of Object.entries(data)) {
          this.flags.set(k, v as FlagValue);
        }
      }
    } catch {
      // Start fresh
    }
  }
}
