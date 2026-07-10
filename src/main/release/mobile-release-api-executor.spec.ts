import { describe, expect, it, vi } from 'vitest';
import { buildAndroidReleasePlan, buildIosReleasePlan } from './mobile-release-plan';
import {
  executeAndroidPlayApiRelease,
  executeIosAscApiRelease,
  type AscReleaseApiClient,
  type PlayReleaseApiClient,
} from './mobile-release-api-executor';

describe('mobile release API executors', () => {
  it('executes Play API release steps from the Android release plan in order', async () => {
    const plan = buildAndroidReleasePlan({
      appPath: '/repo/app',
      packageName: 'com.example.app',
      versionCode: 42,
      destinationTrack: 'internal',
      aabPath: '/repo/app/build/app-release.aab',
      playServiceAccountJsonPath: '/creds/play.json',
      keystorePropertiesPath: 'keys/app-upload.keystore.properties',
    });
    const calls: string[] = [];
    const client: PlayReleaseApiClient = {
      createEdit: vi.fn(async (packageName) => {
        calls.push(`create:${packageName}`);
        return { id: 'edit-1' };
      }),
      uploadBundle: vi.fn(async ({ packageName, editId, aab }) => {
        calls.push(`upload:${packageName}:${editId}:${Buffer.from(aab as Uint8Array).toString('utf8')}`);
        return { versionCode: 42, sha256: 'sha256' };
      }),
      uploadImage: vi.fn(async () => ({ ok: true })),
      updateTrack: vi.fn(async ({ packageName, editId, track, releases }) => {
        calls.push(`track:${packageName}:${editId}:${track}:${releases[0]['versionCodes']}`);
        return { track, releases };
      }),
      commitEdit: vi.fn(async ({ packageName, editId, changesInReviewBehavior }) => {
        calls.push(`commit:${packageName}:${editId}:${changesInReviewBehavior}`);
        return { id: editId };
      }),
    };

    const result = await executeAndroidPlayApiRelease({
      plan,
      client,
      packageName: 'com.example.app',
      expectedVersionCode: 42,
      track: 'internal',
      aabPath: '/repo/app/build/app-release.aab',
      readFile: async () => Buffer.from('aab'),
    });

    expect(result).toEqual({
      editId: 'edit-1',
      uploadedVersionCode: 42,
      committed: true,
      executedStepIds: [
        'create-play-edit',
        'upload-play-aab',
        'update-play-track',
        'commit-play-edit',
      ],
    });
    expect(calls).toEqual([
      'create:com.example.app',
      'upload:com.example.app:edit-1:aab',
      'track:com.example.app:edit-1:internal:42',
      'commit:com.example.app:edit-1:ERROR_IF_IN_REVIEW',
    ]);
  });

  it('refuses to update or commit a Play edit when the uploaded version code is missing or wrong', async () => {
    const plan = buildAndroidReleasePlan({
      appPath: '/repo/app',
      packageName: 'com.example.app',
      versionCode: 42,
      destinationTrack: 'internal',
      aabPath: '/repo/app/build/app-release.aab',
      playServiceAccountJsonPath: '/creds/play.json',
      keystorePropertiesPath: 'keys/app-upload.keystore.properties',
    });
    const updateTrack = vi.fn();
    const commitEdit = vi.fn();

    for (const uploadResult of [{}, { versionCode: 41 }]) {
      await expect(executeAndroidPlayApiRelease({
        plan,
        client: {
          createEdit: vi.fn(async () => ({ id: 'edit-1' })),
          uploadBundle: vi.fn(async () => uploadResult),
          updateTrack,
          commitEdit,
        },
        packageName: 'com.example.app',
        expectedVersionCode: 42,
        track: 'internal',
        aabPath: '/repo/app/build/app-release.aab',
        readFile: async () => Buffer.from('aab'),
      })).rejects.toThrow(/play_uploaded_version_code_(missing|mismatch)/);
    }
    expect(updateTrack).not.toHaveBeenCalled();
    expect(commitEdit).not.toHaveBeenCalled();
  });

  it('prepares, verifies, hashes, and uploads Play store assets before commit', async () => {
    const assets = {
      outputDir: '/store-assets',
      appIcon512Path: '/store-assets/icon.png',
      featureGraphic1024x500Path: '/store-assets/feature.png',
      phoneScreenshotPaths: ['/store-assets/phone-1.png', '/store-assets/phone-2.png'],
      sevenInchTabletScreenshotPaths: ['/store-assets/tablet-7.png'],
      tenInchTabletScreenshotPaths: ['/store-assets/tablet-10.png'],
    };
    const plan = buildAndroidReleasePlan({
      appPath: '/repo/app',
      packageName: 'com.example.app',
      versionCode: 42,
      destinationTrack: 'production',
      aabPath: '/repo/app/build/app-release.aab',
      playServiceAccountJsonPath: '/creds/play.json',
      keystorePropertiesPath: 'keys/app-upload.keystore.properties',
      storeAssets: assets,
    });
    const uploadImage = vi.fn(async ({ imageType }) => ({ imageType }));
    const client: PlayReleaseApiClient = {
      createEdit: vi.fn(async () => ({ id: 'edit-1' })),
      uploadBundle: vi.fn(async () => ({ versionCode: 42 })),
      uploadImage,
      updateTrack: vi.fn(async () => ({})),
      commitEdit: vi.fn(async () => ({})),
    };
    const files = new Map<string, Buffer>([
      [assets.appIcon512Path, png(512, 512)],
      [assets.featureGraphic1024x500Path, png(1024, 500)],
      [assets.phoneScreenshotPaths[0], png(1080, 1920)],
      [assets.phoneScreenshotPaths[1], png(1080, 1920)],
      [assets.sevenInchTabletScreenshotPaths[0], png(1200, 1920)],
      [assets.tenInchTabletScreenshotPaths[0], png(1600, 2560)],
      ['/repo/app/build/app-release.aab', Buffer.from('aab')],
    ]);

    const result = await executeAndroidPlayApiRelease({
      plan,
      client,
      packageName: 'com.example.app',
      expectedVersionCode: 42,
      track: 'production',
      aabPath: '/repo/app/build/app-release.aab',
      storeAssets: assets,
      readFile: async (filePath) => files.get(filePath) ?? Buffer.from('missing'),
    });

    expect(result.executedStepIds).toEqual([
      'create-play-edit',
      'upload-play-aab',
      'prepare-store-assets',
      'verify-store-assets',
      'upload-play-store-assets',
      'update-play-track',
      'commit-play-edit',
    ]);
    expect(result.storeAssets?.verifiedAssets).toHaveLength(6);
    expect(result.storeAssets?.verifiedAssets[0]).toMatchObject({
      kind: 'play-icon',
      width: 512,
      height: 512,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(uploadImage).toHaveBeenCalledTimes(6);
    expect(uploadImage).toHaveBeenCalledWith(expect.objectContaining({
      imageType: 'icon',
      language: 'en-US',
    }));
  });

  it('rejects Play store assets with the wrong dimensions', async () => {
    const assets = {
      outputDir: '/store-assets',
      appIcon512Path: '/store-assets/icon.png',
      featureGraphic1024x500Path: '/store-assets/feature.png',
      phoneScreenshotPaths: ['/store-assets/phone-1.png', '/store-assets/phone-2.png'],
      sevenInchTabletScreenshotPaths: ['/store-assets/tablet-7.png'],
      tenInchTabletScreenshotPaths: ['/store-assets/tablet-10.png'],
    };
    const plan = buildAndroidReleasePlan({
      appPath: '/repo/app',
      packageName: 'com.example.app',
      versionCode: 42,
      destinationTrack: 'production',
      aabPath: '/repo/app/build/app-release.aab',
      playServiceAccountJsonPath: '/creds/play.json',
      keystorePropertiesPath: 'keys/app-upload.keystore.properties',
      storeAssets: assets,
    });

    await expect(executeAndroidPlayApiRelease({
      plan,
      client: {
        createEdit: vi.fn(async () => ({ id: 'edit-1' })),
        uploadBundle: vi.fn(async () => ({ versionCode: 42 })),
        uploadImage: vi.fn(async () => ({})),
        updateTrack: vi.fn(async () => ({})),
        commitEdit: vi.fn(async () => ({})),
      },
      packageName: 'com.example.app',
      expectedVersionCode: 42,
      track: 'production',
      aabPath: '/repo/app/build/app-release.aab',
      storeAssets: assets,
      readFile: async (filePath) => filePath.endsWith('icon.png') ? png(256, 256) : png(1024, 500),
    })).rejects.toThrow('store_asset_dimension_mismatch:play-icon');
  });

  it('rejects Play screenshots outside store dimension limits', async () => {
    const assets = {
      outputDir: '/store-assets',
      appIcon512Path: '/store-assets/icon.png',
      featureGraphic1024x500Path: '/store-assets/feature.png',
      phoneScreenshotPaths: ['/store-assets/phone-1.png', '/store-assets/phone-2.png'],
      sevenInchTabletScreenshotPaths: ['/store-assets/tablet-7.png'],
      tenInchTabletScreenshotPaths: ['/store-assets/tablet-10.png'],
    };
    const plan = buildAndroidReleasePlan({
      appPath: '/repo/app',
      packageName: 'com.example.app',
      versionCode: 42,
      destinationTrack: 'production',
      aabPath: '/repo/app/build/app-release.aab',
      playServiceAccountJsonPath: '/creds/play.json',
      keystorePropertiesPath: 'keys/app-upload.keystore.properties',
      storeAssets: assets,
    });
    const files = new Map<string, Buffer>([
      [assets.appIcon512Path, png(512, 512)],
      [assets.featureGraphic1024x500Path, png(1024, 500)],
      [assets.phoneScreenshotPaths[0], png(200, 1920)],
      [assets.phoneScreenshotPaths[1], png(1080, 1920)],
      [assets.sevenInchTabletScreenshotPaths[0], png(1200, 1920)],
      [assets.tenInchTabletScreenshotPaths[0], png(1600, 2560)],
      ['/repo/app/build/app-release.aab', Buffer.from('aab')],
    ]);

    await expect(executeAndroidPlayApiRelease({
      plan,
      client: {
        createEdit: vi.fn(async () => ({ id: 'edit-1' })),
        uploadBundle: vi.fn(async () => ({ versionCode: 42 })),
        uploadImage: vi.fn(async () => ({})),
        updateTrack: vi.fn(async () => ({})),
        commitEdit: vi.fn(async () => ({})),
      },
      packageName: 'com.example.app',
      expectedVersionCode: 42,
      track: 'production',
      aabPath: '/repo/app/build/app-release.aab',
      storeAssets: assets,
      readFile: async (filePath) => files.get(filePath) ?? Buffer.from('missing'),
    })).rejects.toThrow('store_asset_dimension_mismatch:play-phone-screenshot');
  });

  it('refuses to execute Play APIs when the plan still has blockers', async () => {
    const plan = buildAndroidReleasePlan({
      appPath: '/repo/app',
      packageName: 'com.example.app',
      versionCode: 42,
      destinationTrack: 'internal',
      aabPath: '/repo/app/build/app-release.aab',
    });

    await expect(executeAndroidPlayApiRelease({
      plan,
      client: {} as PlayReleaseApiClient,
      packageName: 'com.example.app',
      expectedVersionCode: 42,
      track: 'internal',
      aabPath: '/repo/app/build/app-release.aab',
      readFile: async () => Buffer.from('aab'),
    })).rejects.toThrow(/release_plan_blocked:play-service-account-json-missing,android-upload-keystore-properties-missing/);
  });

  it('executes ASC API finalization steps from the iOS release plan in order', async () => {
    const plan = buildIosReleasePlan({
      appPath: '/repo/app',
      bundleId: 'com.example.app',
      archivePath: '/tmp/app.xcarchive',
      exportPath: '/tmp/export',
      exportOptionsPlist: '/tmp/ExportOptions.plist',
      ipaPath: '/tmp/export/App.ipa',
      buildNumber: '42',
      destination: 'testflight-internal',
      ascCredentials: {
        keyId: 'KEY123',
        issuerId: 'issuer',
        privateKeyPath: '/creds/AuthKey_KEY123.p8',
      },
      testFlightGroup: 'Internal',
      compliance: { usesNonExemptEncryption: false },
    });
    const calls: string[] = [];
    const client: AscReleaseApiClient = {
      request: vi.fn(async (path, options) => {
        calls.push(`${options?.method ?? 'GET'}:${path}:${JSON.stringify(options?.body ?? null)}`);
        if (path === '/v1/builds/build-1') {
          return { data: { id: 'build-1', attributes: { processingState: 'VALID' } } };
        }
        return {};
      }),
    };

    const result = await executeIosAscApiRelease({
      plan,
      client,
      buildId: 'build-1',
      betaGroupId: 'group-1',
      usesNonExemptEncryption: false,
    });

    expect(result).toEqual({
      buildId: 'build-1',
      processingState: 'VALID',
      betaGroupAttached: true,
      submittedForReview: false,
      executedStepIds: [
        'poll-asc-build-processing',
        'set-asc-export-compliance',
        'attach-testflight-group',
      ],
    });
    expect(calls).toEqual([
      'GET:/v1/builds/build-1:null',
      'PATCH:/v1/builds/build-1:{"data":{"id":"build-1","type":"builds","attributes":{"usesNonExemptEncryption":false}}}',
      'POST:/v1/betaGroups/group-1/relationships/builds:{"data":[{"id":"build-1","type":"builds"}]}',
    ]);
  });

  it('keeps App Store review submission behind explicit approval', async () => {
    const plan = buildIosReleasePlan({
      appPath: '/repo/app',
      bundleId: 'com.example.app',
      archivePath: '/tmp/app.xcarchive',
      exportPath: '/tmp/export',
      exportOptionsPlist: '/tmp/ExportOptions.plist',
      ipaPath: '/tmp/export/App.ipa',
      buildNumber: '42',
      destination: 'app-store-submit',
      ascCredentials: {
        keyId: 'KEY123',
        issuerId: 'issuer',
        privateKeyPath: '/creds/AuthKey_KEY123.p8',
      },
      compliance: { usesNonExemptEncryption: false },
      allowSubmitForReview: false,
    });

    await expect(executeIosAscApiRelease({
      plan,
      client: {} as AscReleaseApiClient,
      buildId: 'build-1',
      usesNonExemptEncryption: false,
      appStoreVersionId: 'version-1',
    })).rejects.toThrow(/release_plan_blocked:app-store-submit-approval-required/);
  });

  it('uploads and verifies ASC screenshot sets before submitting the App Store version', async () => {
    const assets = {
      outputDir: '/store-assets',
      appStoreVersionLocalizationId: 'localization-1',
      iphoneScreenshotPaths: ['/store-assets/iphone-1.png'],
      iphoneScreenshotDisplayType: 'APP_IPHONE_67',
      ipadScreenshotPaths: ['/store-assets/ipad-1.png'],
      ipadScreenshotDisplayType: 'APP_IPAD_PRO_3GEN_129',
    };
    const plan = buildIosReleasePlan({
      appPath: '/repo/app',
      bundleId: 'com.example.app',
      archivePath: '/tmp/app.xcarchive',
      exportPath: '/tmp/export',
      exportOptionsPlist: '/tmp/ExportOptions.plist',
      ipaPath: '/tmp/export/App.ipa',
      buildNumber: '42',
      destination: 'app-store-submit',
      ascCredentials: {
        keyId: 'KEY123',
        issuerId: 'issuer',
        privateKeyPath: '/creds/AuthKey_KEY123.p8',
      },
      compliance: { usesNonExemptEncryption: false },
      allowSubmitForReview: true,
      storeAssets: assets,
    });
    const calls: string[] = [];
    const request = vi.fn(async (
      requestPath: string,
      options?: { method?: string; body?: unknown },
    ) => {
      const method = options?.method ?? 'GET';
      calls.push(`${method}:${requestPath}`);
      if (requestPath === '/v1/builds/build-1') {
        return { data: { id: 'build-1', attributes: { processingState: 'VALID' } } };
      }
      if (requestPath === '/v1/appStoreVersionLocalizations/localization-1/appScreenshotSets') {
        return {
          data: [{
            id: 'iphone-set',
            type: 'appScreenshotSets',
            attributes: { screenshotDisplayType: 'APP_IPHONE_67' },
          }],
        };
      }
      if (requestPath === '/v1/appScreenshotSets') {
        expect(options?.body).toEqual({
          data: {
            type: 'appScreenshotSets',
            attributes: { screenshotDisplayType: 'APP_IPAD_PRO_3GEN_129' },
            relationships: {
              appStoreVersionLocalization: {
                data: {
                  id: 'localization-1',
                  type: 'appStoreVersionLocalizations',
                },
              },
            },
          },
        });
        return { data: { id: 'ipad-set', type: 'appScreenshotSets' } };
      }
      if (requestPath === '/v1/appScreenshots' && method === 'POST') {
        const body = options?.body as {
          data: {
            attributes: { fileName: string; fileSize: number };
            relationships: { appScreenshotSet: { data: { id: string; type: string } } };
          };
        };
        const iphone = body.data.attributes.fileName.includes('iphone');
        expect(body.data.relationships.appScreenshotSet.data).toEqual({
          id: iphone ? 'iphone-set' : 'ipad-set',
          type: 'appScreenshotSets',
        });
        return {
          data: {
            id: iphone ? 'iphone-screenshot' : 'ipad-screenshot',
            type: 'appScreenshots',
            attributes: {
              uploadOperations: iphone
                ? [
                  {
                    method: 'PUT',
                    url: 'https://upload.example.test/iphone?Signature=first',
                    offset: 0,
                    length: 12,
                    requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
                  },
                  {
                    method: 'PUT',
                    url: 'https://upload.example.test/iphone?Signature=second',
                    offset: 12,
                    length: 12,
                    requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
                  },
                ]
                : [{
                  method: 'PUT',
                  url: 'https://upload.example.test/ipad?Signature=only',
                  offset: 0,
                  length: 24,
                  requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
                }],
            },
          },
        };
      }
      if (requestPath.startsWith('/v1/appScreenshots/') && method === 'PATCH') {
        expect(options?.body).toMatchObject({
          data: {
            type: 'appScreenshots',
            attributes: {
              uploaded: true,
              sourceFileChecksum: expect.stringMatching(/^[a-f0-9]{32}$/),
            },
          },
        });
        return { data: { id: requestPath.split('/').pop() } };
      }
      if (requestPath.startsWith('/v1/appScreenshots/') && method === 'GET') {
        return {
          data: {
            id: requestPath.split('/').pop(),
            attributes: { assetDeliveryState: { state: 'COMPLETE', errors: [] } },
          },
        };
      }
      return {};
    });
    const uploadAssetPart = vi.fn(async ({ method, url, headers, body }) => {
      calls.push(`${method}:${url}`);
      expect(headers).toEqual({ 'Content-Type': 'image/png' });
      expect(body).toHaveLength(url.includes('ipad') ? 24 : 12);
    });

    const result = await executeIosAscApiRelease({
      plan,
      client: { request, uploadAssetPart },
      buildId: 'build-1',
      appStoreVersionId: 'version-1',
      usesNonExemptEncryption: false,
      storeAssets: assets,
      readFile: async (filePath) => filePath.includes('ipad') ? png(2048, 2732) : png(1290, 2796),
    });

    expect(result.executedStepIds).toEqual([
      'poll-asc-build-processing',
      'set-asc-export-compliance',
      'prepare-store-assets',
      'verify-store-assets',
      'upload-asc-store-assets',
      'submit-app-store-review',
    ]);
    expect(result.storeAssets?.verifiedAssets).toHaveLength(2);
    expect(result.storeAssets?.uploadedAssets).toHaveLength(2);
    expect(uploadAssetPart).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([
      'GET:/v1/builds/build-1',
      'PATCH:/v1/builds/build-1',
      'GET:/v1/appStoreVersionLocalizations/localization-1/appScreenshotSets',
      'POST:/v1/appScreenshotSets',
      'POST:/v1/appScreenshots',
      'PUT:https://upload.example.test/iphone?Signature=first',
      'PUT:https://upload.example.test/iphone?Signature=second',
      'PATCH:/v1/appScreenshots/iphone-screenshot',
      'GET:/v1/appScreenshots/iphone-screenshot',
      'POST:/v1/appScreenshots',
      'PUT:https://upload.example.test/ipad?Signature=only',
      'PATCH:/v1/appScreenshots/ipad-screenshot',
      'GET:/v1/appScreenshots/ipad-screenshot',
      'POST:/v1/appStoreVersionSubmissions',
    ]);
  });

});

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
