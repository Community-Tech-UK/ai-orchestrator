import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as barrel from '../index';

describe('schemas barrel (transitional - deleted in Task 16)', () => {
  it('re-exports at least one symbol from each domain file', () => {
    expect(barrel).toHaveProperty('SettingsGetPayloadSchema');
    expect(barrel).toHaveProperty('EditorOpenFilePayloadSchema');
    expect(barrel).toHaveProperty('BashValidatePayloadSchema');
    expect(barrel).toHaveProperty('SearchSemanticPayloadSchema');
    expect(barrel).toHaveProperty('LspPositionPayloadSchema');
    expect(barrel).toHaveProperty('KgAddFactPayloadSchema');
    expect(barrel).toHaveProperty('InstanceCreatePayloadSchema');
    expect(barrel).toHaveProperty('SnapshotTakePayloadSchema');
    expect(barrel).toHaveProperty('PluginManifestSchema');
  });

  it('workspace.schemas.ts source file no longer exists on disk', () => {
    const workspaceSchemasPath = join(__dirname, '..', 'workspace.schemas.ts');
    expect(existsSync(workspaceSchemasPath)).toBe(false);
  });
});
