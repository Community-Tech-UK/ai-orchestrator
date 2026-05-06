import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PluginManifestSchema, type ValidatedPluginManifest } from '@contracts/schemas/plugin';
import { PluginDependencyResolver } from './plugin-dependency-resolver';

export type PluginValidationResult =
  | { ok: true; manifest: ValidatedPluginManifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

export interface PluginValidationOptions {
  expectedChecksum?: string;
  checksumPath?: string;
}

export class PluginValidator {
  constructor(private readonly dependencies: PluginDependencyResolver) {}

  async validate(stagedPath: string, options: PluginValidationOptions = {}): Promise<PluginValidationResult> {
    const warnings: string[] = [];
    const errors: string[] = [];
    const manifestPath = path.join(stagedPath, '.codex-plugin', 'plugin.json');

    if (options.expectedChecksum && options.checksumPath) {
      const checksumError = await this.validateChecksum(options.checksumPath, options.expectedChecksum);
      if (checksumError) {
        errors.push(checksumError);
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        errors: [...errors, `Missing or unreadable .codex-plugin/plugin.json: ${reason}`],
        warnings,
      };
    }

    const manifestResult = PluginManifestSchema.safeParse(parsed);
    if (!manifestResult.success) {
      errors.push(...manifestResult.error.issues.map((issue) => {
        const field = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${field}${issue.message}`;
      }));
    }

    if (errors.length > 0 || !manifestResult.success) {
      return { ok: false, errors, warnings };
    }

    const dependencyResult = await this.dependencies.check(manifestResult.data);
    warnings.push(...dependencyResult.warnings);
    errors.push(...dependencyResult.errors);

    if (errors.length > 0) {
      return { ok: false, errors, warnings };
    }

    return {
      ok: true,
      manifest: manifestResult.data,
      warnings,
    };
  }

  private async validateChecksum(filePath: string, expectedChecksum: string): Promise<string | null> {
    const [algorithm, expectedRaw] = expectedChecksum.includes(':')
      ? expectedChecksum.split(':', 2)
      : ['sha256', expectedChecksum];
    const expected = expectedRaw?.toLowerCase();
    if (algorithm !== 'sha256' || !expected) {
      return `Unsupported checksum format: ${expectedChecksum}`;
    }

    const bytes = await fs.readFile(filePath);
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    return actual === expected
      ? null
      : `Plugin checksum mismatch: expected ${expected}, got ${actual}`;
  }
}
