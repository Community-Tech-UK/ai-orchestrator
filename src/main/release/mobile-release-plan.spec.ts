import { describe, expect, it } from 'vitest';
import {
  buildAndroidReleasePlan,
  buildIosReleasePlan,
  buildNewAppSetupPlan,
} from './mobile-release-plan';

describe('mobile release plans', () => {
  it('builds an API-first iOS TestFlight plan with no browser build upload step', () => {
    const plan = buildIosReleasePlan({
      appPath: '/work/apps/binsout',
      bundleId: 'com.example.binsout',
      archivePath: '/tmp/binsout.xcarchive',
      exportPath: '/tmp/binsout-export',
      exportOptionsPlist: '/tmp/ExportOptions.plist',
      ipaPath: '/tmp/binsout-export/App.ipa',
      buildNumber: '42',
      destination: 'testflight-internal',
      ascCredentials: {
        keyId: 'KEY123',
        issuerId: 'issuer-123',
        privateKeyPath: '/Users/james/.appstoreconnect/private_keys/AuthKey_KEY123.p8',
      },
      testFlightGroup: 'Internal Testers',
      compliance: { usesNonExemptEncryption: false },
      verificationCommands: [
        ['npm', 'run', 'test:quiet'],
        ['npm', 'run', 'build'],
      ],
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.steps.map((step) => step.id)).toEqual([
      'read-project-instructions',
      'bump-ios-build-number',
      'run-project-verification',
      'archive-ios-app',
      'export-ios-ipa',
      'upload-ios-ipa-altool',
      'poll-asc-build-processing',
      'set-asc-export-compliance',
      'attach-testflight-group',
      'verify-ios-smoke',
    ]);
    expect(plan.steps.find((step) => step.id === 'upload-ios-ipa-altool')).toMatchObject({
      channel: 'local-command',
      command: {
        argv: expect.arrayContaining(['xcrun', 'altool', '--upload-app']),
      },
    });
    expect(plan.steps.some((step) => step.channel === 'browser' && /upload/i.test(step.title)))
      .toBe(false);
    expect(plan.steps.filter((step) => step.channel === 'app-store-connect-api').map((step) => step.id))
      .toEqual([
        'poll-asc-build-processing',
        'set-asc-export-compliance',
        'attach-testflight-group',
      ]);
  });

  it('blocks iOS App Store submission until review submission is explicitly approved', () => {
    const plan = buildIosReleasePlan({
      appPath: '/work/apps/binsout',
      bundleId: 'com.example.binsout',
      archivePath: '/tmp/binsout.xcarchive',
      exportPath: '/tmp/binsout-export',
      exportOptionsPlist: '/tmp/ExportOptions.plist',
      ipaPath: '/tmp/binsout-export/App.ipa',
      buildNumber: '42',
      destination: 'app-store-submit',
      ascCredentials: {
        keyId: 'KEY123',
        issuerId: 'issuer-123',
        privateKeyPath: '/Users/james/.appstoreconnect/private_keys/AuthKey_KEY123.p8',
      },
      compliance: { usesNonExemptEncryption: false },
      allowSubmitForReview: false,
      storeAssets: {
        outputDir: '/tmp/store-assets',
        iphoneScreenshotPaths: ['/tmp/store-assets/ios/iphone-1.png'],
        ipadScreenshotPaths: ['/tmp/store-assets/ios/ipad-1.png'],
      },
    });

    expect(plan.blockers).toContain('app-store-submit-approval-required');
    expect(plan.steps.find((step) => step.id === 'submit-app-store-review')).toMatchObject({
      channel: 'manual-approval',
      requiredApproval: 'James must explicitly approve App Store review submission.',
    });
  });

  it('builds a Play API Android plan and routes console declarations to the browser setup plan', () => {
    const plan = buildAndroidReleasePlan({
      appPath: '/work/apps/binsout',
      packageName: 'com.example.binsout',
      versionCode: 42,
      versionName: '1.2.3',
      destinationTrack: 'internal',
      aabPath: '/work/apps/binsout/android/app/build/outputs/bundle/release/app-release.aab',
      gradleExecutable: './gradlew',
      playServiceAccountJsonPath: '/Users/james/work/creds/play-service-account.json',
      keystorePropertiesPath: 'keys/binsout-upload.keystore.properties',
      consoleDeclarationsRequired: true,
      verificationCommands: [['npm', 'run', 'test:quiet']],
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.steps.map((step) => step.id)).toEqual([
      'read-project-instructions',
      'bump-android-version',
      'verify-android-signing',
      'run-project-verification',
      'build-android-aab',
      'create-play-edit',
      'upload-play-aab',
      'update-play-track',
      'commit-play-edit',
      'browser-console-declarations',
      'capture-play-app-signing-sha',
      'verify-android-smoke',
    ]);
    expect(plan.steps.find((step) => step.id === 'build-android-aab')).toMatchObject({
      channel: 'local-command',
      command: { argv: ['./gradlew', 'bundleRelease'] },
    });
    expect(plan.steps.filter((step) => step.channel === 'play-developer-api').map((step) => step.id))
      .toEqual([
        'create-play-edit',
        'upload-play-aab',
        'update-play-track',
        'commit-play-edit',
      ]);
    expect(plan.steps.find((step) => step.id === 'browser-console-declarations')).toMatchObject({
      channel: 'browser',
      browserSkill: 'new-app-setup',
    });
    expect(plan.steps.some((step) => step.channel === 'browser' && /aab upload/i.test(step.title)))
      .toBe(false);
  });

  it('adds a Play store asset pipeline for production releases', () => {
    const plan = buildAndroidReleasePlan({
      appPath: '/work/apps/binsout',
      packageName: 'com.example.binsout',
      versionCode: 43,
      versionName: '1.2.4',
      destinationTrack: 'production',
      aabPath: '/work/apps/binsout/android/app/build/outputs/bundle/release/app-release.aab',
      playServiceAccountJsonPath: '/Users/james/work/creds/play-service-account.json',
      keystorePropertiesPath: 'keys/binsout-upload.keystore.properties',
      storeAssets: {
        outputDir: '/tmp/binsout-store-assets',
        appIcon512Path: '/tmp/binsout-store-assets/icon-512.png',
        featureGraphic1024x500Path: '/tmp/binsout-store-assets/feature-1024x500.png',
        phoneScreenshotPaths: [
          '/tmp/binsout-store-assets/phone-1.png',
          '/tmp/binsout-store-assets/phone-2.png',
        ],
        sevenInchTabletScreenshotPaths: ['/tmp/binsout-store-assets/tablet-7-1.png'],
        tenInchTabletScreenshotPaths: ['/tmp/binsout-store-assets/tablet-10-1.png'],
      },
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.steps.map((step) => step.id)).toEqual(expect.arrayContaining([
      'prepare-store-assets',
      'verify-store-assets',
      'upload-play-store-assets',
    ]));
    expect(plan.steps.find((step) => step.id === 'upload-play-store-assets')).toMatchObject({
      channel: 'play-developer-api',
      apiAction: 'play.edits.images.upload',
      verifies: expect.arrayContaining([
        'Play listing has app icon 512, feature graphic 1024x500, phone screenshots, and 7 inch/10 inch tablet screenshots.',
      ]),
    });
  });

  it('blocks public store submissions until required asset manifests are present', () => {
    const android = buildAndroidReleasePlan({
      appPath: '/work/apps/binsout',
      packageName: 'com.example.binsout',
      versionCode: 43,
      destinationTrack: 'production',
      aabPath: '/tmp/app-release.aab',
      playServiceAccountJsonPath: '/Users/james/work/creds/play-service-account.json',
      keystorePropertiesPath: 'keys/binsout-upload.keystore.properties',
    });
    const ios = buildIosReleasePlan({
      appPath: '/work/apps/binsout',
      bundleId: 'com.example.binsout',
      archivePath: '/tmp/binsout.xcarchive',
      exportPath: '/tmp/binsout-export',
      exportOptionsPlist: '/tmp/ExportOptions.plist',
      ipaPath: '/tmp/binsout-export/App.ipa',
      buildNumber: '43',
      destination: 'app-store-submit',
      ascCredentials: {
        keyId: 'KEY123',
        issuerId: 'issuer-123',
        privateKeyPath: '/Users/james/.appstoreconnect/private_keys/AuthKey_KEY123.p8',
      },
      compliance: { usesNonExemptEncryption: false },
      allowSubmitForReview: true,
    });

    expect(android.blockers).toEqual(expect.arrayContaining([
      'store-assets-output-dir-missing',
      'play-icon-512-missing',
      'play-feature-graphic-1024x500-missing',
      'play-phone-screenshots-missing',
      'play-7-inch-tablet-screenshots-missing',
      'play-10-inch-tablet-screenshots-missing',
    ]));
    expect(ios.blockers).toEqual(expect.arrayContaining([
      'store-assets-output-dir-missing',
      'ios-iphone-screenshots-missing',
      'ios-ipad-screenshots-missing',
    ]));
  });

  it('surfaces credential and signing blockers without embedding secret values', () => {
    const ios = buildIosReleasePlan({
      appPath: '/work/apps/binsout',
      bundleId: 'com.example.binsout',
      archivePath: '/tmp/binsout.xcarchive',
      exportPath: '/tmp/binsout-export',
      exportOptionsPlist: '/tmp/ExportOptions.plist',
      ipaPath: '/tmp/binsout-export/App.ipa',
      buildNumber: '42',
      destination: 'testflight-internal',
      ascCredentials: {},
      compliance: { usesNonExemptEncryption: false },
    });
    const android = buildAndroidReleasePlan({
      appPath: '/work/apps/binsout',
      packageName: 'com.example.binsout',
      versionCode: 42,
      destinationTrack: 'internal',
      aabPath: '/tmp/app-release.aab',
    });

    expect(ios.blockers).toEqual([
      'asc-api-key-id-missing',
      'asc-api-issuer-id-missing',
      'asc-private-key-path-missing',
      'testflight-group-missing',
    ]);
    expect(android.blockers).toEqual([
      'play-service-account-json-missing',
      'android-upload-keystore-properties-missing',
    ]);
    expect(JSON.stringify({ ios, android })).not.toContain('BEGIN PRIVATE KEY');
  });

  it('builds a checkpointed browser-only new-app setup plan for console gaps', () => {
    const plan = buildNewAppSetupPlan({
      appSlug: 'binsout',
      playPackageName: 'com.example.binsout',
      ascBundleId: 'com.example.binsout',
      includePlay: true,
      includeAsc: true,
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.steps[0]).toMatchObject({
      id: 'claim-browser-campaign-lease',
      channel: 'browser',
      browserTool: 'browser.claim_campaign_lease',
    });
    expect(plan.steps.map((step) => step.id)).toEqual(expect.arrayContaining([
      'play-create-app-record',
      'play-app-content-declarations',
      'play-content-rating',
      'play-data-safety-import',
      'asc-create-app-record',
      'asc-privacy-nutrition-labels',
      'surface-account-legal-prompts',
    ]));
    const browserMutationSteps = plan.steps.filter(
      (step) => step.channel === 'browser' && step.id !== 'claim-browser-campaign-lease',
    );
    expect(browserMutationSteps.every((step) => step.checkpoint === true)).toBe(true);
    expect(browserMutationSteps.every((step) => step.verifies.length > 0)).toBe(true);
    expect(plan.steps.find((step) => step.id === 'surface-account-legal-prompts')).toMatchObject({
      channel: 'manual-approval',
      requiredApproval: 'Stop for James on identity, agreements, tax, banking, payment, or legal prompts.',
    });
  });
});
