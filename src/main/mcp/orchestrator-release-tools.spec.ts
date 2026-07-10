import { describe, expect, it, vi } from 'vitest';
import {
  BuildIosReleasePlanArgsSchema,
  createReleaseToolDefinitions,
  STORE_ASSETS_INPUT_SCHEMA,
} from './orchestrator-release-tools';

describe('orchestrator release MCP tools', () => {
  it('accepts ASC localization and screenshot display mappings in release tool schemas', () => {
    const storeAssets = {
      outputDir: '/store-assets',
      appStoreVersionLocalizationId: 'localization-1',
      iphoneScreenshotPaths: ['/store-assets/iphone.png'],
      iphoneScreenshotDisplayType: 'APP_IPHONE_67',
      ipadScreenshotPaths: ['/store-assets/ipad.png'],
      ipadScreenshotDisplayType: 'APP_IPAD_PRO_3GEN_129',
    };

    expect(BuildIosReleasePlanArgsSchema.safeParse({
      appPath: '/repo/app',
      bundleId: 'com.example.app',
      archivePath: '/tmp/app.xcarchive',
      exportPath: '/tmp/export',
      exportOptionsPlist: '/tmp/ExportOptions.plist',
      ipaPath: '/tmp/export/App.ipa',
      buildNumber: '42',
      destination: 'app-store-submit',
      storeAssets,
    }).success).toBe(true);
    expect(STORE_ASSETS_INPUT_SCHEMA.properties).toMatchObject({
      appStoreVersionLocalizationId: { type: 'string' },
      iphoneScreenshotDisplayType: { type: 'string' },
      ipadScreenshotDisplayType: { type: 'string' },
    });
  });

  it('builds an operational readiness report for the remaining live rollout gates', async () => {
    const tools = createReleaseToolDefinitions();
    const tool = tools.find((candidate) => candidate.name === 'build_release_operational_readiness_report');

    const result = await tool!.handler({
      expectedWorkerVersion: '2026.07.07',
      expectedExtensionVersion: '0.2.1',
      remoteNodes: [],
    });

    expect(result).toMatchObject({
      ready: false,
      blockers: expect.arrayContaining([
        'worker-redeploy-missing',
        'native-host-recovery-drill-missing',
        'testflight-internal-release-missing',
        'play-internal-release-missing',
      ]),
    });
  });

  it('accepts list_remote_nodes-shaped rollout evidence in the readiness report tool', async () => {
    const tools = createReleaseToolDefinitions();
    const tool = tools.find((candidate) => candidate.name === 'build_release_operational_readiness_report');

    const result = await tool!.handler({
      expectedWorkerVersion: '0.1.0',
      expectedExtensionVersion: '0.2.1',
      harnessRestartedAt: 1_700_000_000_000,
      remoteNodes: [
        {
          name: 'windows-pc',
          connected: true,
          hasBrowserMcp: true,
          workerAgent: {
            version: '0.1.0',
            startedAt: 1_700_000_000_000,
          },
          extensionRelay: {
            enabled: true,
            running: true,
            extensionVersion: '0.2.1',
            extensionReloadedAt: 1_700_000_010_000,
            lastExtensionContactAt: 1_700_000_020_000,
          },
        },
      ],
      browserHealth: {
        checkedAt: 1_700_000_030_000,
        ok: true,
      },
      nativeHostRecoveryDrill: {
        ranAt: 1_700_000_040_000,
        passed: true,
      },
      testflightInternalRelease: {
        releasedAt: 1_700_000_050_000,
        bundleId: 'com.example.app',
        buildNumber: '42',
        betaGroupAttached: true,
        smokePassed: true,
      },
      playInternalRelease: {
        releasedAt: 1_700_000_060_000,
        packageName: 'com.example.app',
        versionCode: 42,
        track: 'internal',
        committed: true,
        smokePassed: true,
      },
    });

    expect(result).toMatchObject({
      ready: true,
      blockers: [],
    });
  });

  it('builds an Android release plan from tool inputs', async () => {
    const tools = createReleaseToolDefinitions();
    const tool = tools.find((candidate) => candidate.name === 'build_android_release_plan');

    const result = await tool!.handler({
      appPath: '/repo/app',
      packageName: 'com.example.app',
      versionCode: 42,
      destinationTrack: 'internal',
      aabPath: '/repo/app/build/app-release.aab',
      playServiceAccountJsonPath: '/creds/play.json',
      keystorePropertiesPath: 'keys/app-upload.keystore.properties',
    });

    expect(result).toMatchObject({
      kind: 'android',
      blockers: [],
    });
    expect(JSON.stringify(result)).toContain('create-play-edit');
    expect(JSON.stringify(result)).toContain('upload-play-aab');
  });

  it('generates an import-ready Play Data safety CSV', async () => {
    const tool = createReleaseToolDefinitions().find(
      (candidate) => candidate.name === 'generate_play_data_safety_csv',
    );

    const result = await tool!.handler({
      rows: [{
        questionId: 'PSL_DATA_TYPES_PERSONAL',
        responseId: 'PSL_NAME',
        responseValue: true,
        answerRequirement: 'MULTIPLE_CHOICE',
        questionLabel: 'Personal info Name',
      }],
    });

    expect(result).toEqual({
      csv: expect.stringContaining(
        'PSL_DATA_TYPES_PERSONAL,PSL_NAME,TRUE,MULTIPLE_CHOICE,Personal info Name',
      ),
      rowCount: 1,
    });
  });

  it('executes an Android Play API release without returning service-account secrets', async () => {
    const createPlayClient = vi.fn(() => ({
      createEdit: vi.fn(async () => ({ id: 'edit-1' })),
      uploadBundle: vi.fn(async () => ({ versionCode: 42 })),
      updateTrack: vi.fn(async () => ({ track: 'internal' })),
      commitEdit: vi.fn(async () => ({ id: 'edit-1' })),
    }));
    const tools = createReleaseToolDefinitions({
      readTextFile: async () => JSON.stringify({
        client_email: 'release-bot@example.iam.gserviceaccount.com',
        private_key_id: 'kid-1',
        private_key: 'PRIVATE_KEY_SHOULD_NOT_BE_RETURNED',
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
      readBinaryFile: async () => Buffer.from('aab-bytes'),
      createPlayClient,
    });
    const tool = tools.find((candidate) => candidate.name === 'execute_android_play_release');

    const result = await tool!.handler({
      appPath: '/repo/app',
      packageName: 'com.example.app',
      versionCode: 42,
      destinationTrack: 'internal',
      track: 'internal',
      aabPath: '/repo/app/build/app-release.aab',
      playServiceAccountJsonPath: '/creds/play.json',
      keystorePropertiesPath: 'keys/app-upload.keystore.properties',
    });

    expect(createPlayClient).toHaveBeenCalledWith({
      clientEmail: 'release-bot@example.iam.gserviceaccount.com',
      privateKeyId: 'kid-1',
      privateKey: 'PRIVATE_KEY_SHOULD_NOT_BE_RETURNED',
      tokenUri: 'https://oauth2.googleapis.com/token',
    });
    expect(result).toMatchObject({
      release: {
        editId: 'edit-1',
        uploadedVersionCode: 42,
        committed: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_KEY_SHOULD_NOT_BE_RETURNED');
  });

  it('executes ASC finalization from an iOS release plan without returning the private key', async () => {
    const requests: string[] = [];
    const createAscClient = vi.fn(() => ({
      request: vi.fn(async (path: string, options?: { method?: string }) => {
        requests.push(`${options?.method ?? 'GET'} ${path}`);
        if (path === '/v1/builds/build-1') {
          return { data: { attributes: { processingState: 'VALID' } } };
        }
        return {};
      }),
    }));
    const tools = createReleaseToolDefinitions({
      readTextFile: async () => 'ASC_PRIVATE_KEY_SHOULD_NOT_BE_RETURNED',
      createAscClient,
    });
    const tool = tools.find((candidate) => candidate.name === 'execute_ios_asc_finalization');

    const result = await tool!.handler({
      appPath: '/repo/app',
      bundleId: 'com.example.app',
      archivePath: '/tmp/app.xcarchive',
      exportPath: '/tmp/export',
      exportOptionsPlist: '/tmp/ExportOptions.plist',
      ipaPath: '/tmp/export/App.ipa',
      buildNumber: '42',
      destination: 'testflight-internal',
      ascKeyId: 'KEY123',
      ascIssuerId: 'issuer-1',
      ascPrivateKeyPath: '/creds/AuthKey_KEY123.p8',
      testFlightGroup: 'Internal',
      buildId: 'build-1',
      betaGroupId: 'group-1',
      usesNonExemptEncryption: false,
    });

    expect(createAscClient).toHaveBeenCalledWith({
      keyId: 'KEY123',
      issuerId: 'issuer-1',
      privateKey: 'ASC_PRIVATE_KEY_SHOULD_NOT_BE_RETURNED',
    });
    expect(requests).toEqual([
      'GET /v1/builds/build-1',
      'PATCH /v1/builds/build-1',
      'POST /v1/betaGroups/group-1/relationships/builds',
    ]);
    expect(result).toMatchObject({
      release: {
        buildId: 'build-1',
        processingState: 'VALID',
        betaGroupAttached: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain('ASC_PRIVATE_KEY_SHOULD_NOT_BE_RETURNED');
  });
});
