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
});
