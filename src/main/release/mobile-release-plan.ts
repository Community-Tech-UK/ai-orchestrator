export type ReleasePlanKind = 'ios' | 'android' | 'new-app-setup';

export type ReleasePlanChannel =
  | 'local-command'
  | 'app-store-connect-api'
  | 'play-developer-api'
  | 'browser'
  | 'manual-approval';

export interface ReleaseCommand {
  cwd?: string;
  argv: string[];
}

export interface MobileReleaseStep {
  id: string;
  title: string;
  channel: ReleasePlanChannel;
  description: string;
  verifies: string[];
  command?: ReleaseCommand;
  commands?: ReleaseCommand[];
  apiAction?: string;
  browserSkill?: 'new-app-setup';
  browserTool?: string;
  checkpoint?: boolean;
  requiredApproval?: string;
}

export interface MobileReleasePlan {
  kind: ReleasePlanKind;
  summary: string;
  blockers: string[];
  steps: MobileReleaseStep[];
}

export interface StoreAssetManifestInput {
  outputDir?: string;
  appIcon512Path?: string;
  featureGraphic1024x500Path?: string;
  phoneScreenshotPaths?: string[];
  sevenInchTabletScreenshotPaths?: string[];
  tenInchTabletScreenshotPaths?: string[];
  iphoneScreenshotPaths?: string[];
  ipadScreenshotPaths?: string[];
}

export type IosReleaseDestination =
  | 'testflight-internal'
  | 'testflight-external'
  | 'app-store-submit';

export interface IosReleasePlanInput {
  appPath: string;
  bundleId: string;
  archivePath: string;
  exportPath: string;
  exportOptionsPlist: string;
  ipaPath: string;
  buildNumber: string;
  destination: IosReleaseDestination;
  ascCredentials: {
    keyId?: string;
    issuerId?: string;
    privateKeyPath?: string;
  };
  scheme?: string;
  configuration?: string;
  marketingVersion?: string;
  testFlightGroup?: string;
  compliance?: {
    usesNonExemptEncryption?: boolean;
  };
  allowSubmitForReview?: boolean;
  storeAssets?: StoreAssetManifestInput;
  verificationCommands?: string[][];
}

export type AndroidDestinationTrack =
  | 'internal'
  | 'alpha'
  | 'beta'
  | 'production';

export interface AndroidReleasePlanInput {
  appPath: string;
  packageName: string;
  versionCode: number;
  versionName?: string;
  destinationTrack: AndroidDestinationTrack;
  aabPath: string;
  gradleExecutable?: string;
  playServiceAccountJsonPath?: string;
  keystorePropertiesPath?: string;
  rolloutPercent?: number;
  consoleDeclarationsRequired?: boolean;
  storeAssets?: StoreAssetManifestInput;
  verificationCommands?: string[][];
}

export interface NewAppSetupPlanInput {
  appSlug: string;
  playPackageName?: string;
  ascBundleId?: string;
  includePlay: boolean;
  includeAsc: boolean;
}

export function buildIosReleasePlan(input: IosReleasePlanInput): MobileReleasePlan {
  const blockers = [
    ...missingAscCredentialBlockers(input.ascCredentials),
    ...(isTestFlightDestination(input.destination) && !input.testFlightGroup
      ? ['testflight-group-missing']
      : []),
    ...(input.destination === 'app-store-submit' && !input.allowSubmitForReview
      ? ['app-store-submit-approval-required']
      : []),
    ...iosStoreAssetBlockers(input),
  ];
  const scheme = input.scheme ?? 'App';
  const configuration = input.configuration ?? 'Release';
  const steps: MobileReleaseStep[] = [
    {
      id: 'read-project-instructions',
      title: 'Read app release instructions',
      channel: 'local-command',
      description: 'Inspect repo instructions, app config, and release notes before editing.',
      verifies: ['Repo-specific release constraints are known before version/build changes.'],
    },
    {
      id: 'bump-ios-build-number',
      title: 'Bump iOS build number',
      channel: 'local-command',
      description: 'Set CURRENT_PROJECT_VERSION in every build configuration.',
      verifies: [`Bundle ${input.bundleId} uses build ${input.buildNumber}.`],
    },
    {
      id: 'run-project-verification',
      title: 'Run project verification gates',
      channel: 'local-command',
      description: 'Run repo tests/build gates before creating an archive.',
      commands: commandsFrom(input.appPath, input.verificationCommands),
      verifies: ['Project verification completes before archive/export.'],
    },
    {
      id: 'archive-ios-app',
      title: 'Archive iOS app',
      channel: 'local-command',
      description: 'Create an App Store Connect archive with xcodebuild.',
      command: {
        cwd: input.appPath,
        argv: [
          'xcodebuild',
          '-project',
          'ios/App/App.xcodeproj',
          '-scheme',
          scheme,
          '-configuration',
          configuration,
          '-archivePath',
          input.archivePath,
          'archive',
        ],
      },
      verifies: [`Archive exists at ${input.archivePath}.`],
    },
    {
      id: 'export-ios-ipa',
      title: 'Export iOS IPA',
      channel: 'local-command',
      description: 'Export the archive with an app-store-connect ExportOptions plist.',
      command: {
        cwd: input.appPath,
        argv: [
          'xcodebuild',
          '-exportArchive',
          '-archivePath',
          input.archivePath,
          '-exportPath',
          input.exportPath,
          '-exportOptionsPlist',
          input.exportOptionsPlist,
        ],
      },
      verifies: [`IPA exists at ${input.ipaPath}.`],
    },
    {
      id: 'upload-ios-ipa-altool',
      title: 'Upload iOS IPA with altool',
      channel: 'local-command',
      description: 'Upload the IPA through the supported CLI/API path, not browser file upload.',
      command: {
        cwd: input.appPath,
        argv: [
          'xcrun',
          'altool',
          '--upload-app',
          '--type',
          'ios',
          '--file',
          input.ipaPath,
          '--apiKey',
          input.ascCredentials.keyId ?? '<ASC_API_KEY_ID>',
          '--apiIssuer',
          input.ascCredentials.issuerId ?? '<ASC_API_ISSUER_ID>',
        ],
      },
      verifies: ['Upload returns a provider request id or accepted upload response.'],
    },
    {
      id: 'poll-asc-build-processing',
      title: 'Poll ASC build processing',
      channel: 'app-store-connect-api',
      description: 'Wait until App Store Connect processing completes for the uploaded build.',
      apiAction: 'app-store-connect.builds.poll-processing',
      verifies: ['Latest ASC build for this bundle/build number is processed.'],
    },
    {
      id: 'set-asc-export-compliance',
      title: 'Set ASC export compliance',
      channel: 'app-store-connect-api',
      description: 'Set export compliance for the processed build through ASC API.',
      apiAction: 'app-store-connect.builds.set-export-compliance',
      verifies: [
        input.compliance?.usesNonExemptEncryption === false
          ? 'ASC records non-exempt encryption as false or Info.plist carries the durable answer.'
        : 'ASC export compliance answer is present for the processed build.',
      ],
    },
    ...iosStoreAssetSteps(input),
    ...iosDestinationSteps(input),
    {
      id: 'verify-ios-smoke',
      title: 'Verify iOS smoke behavior',
      channel: 'local-command',
      description: 'Install or launch the released build where available and smoke-test core flows.',
      verifies: ['Launch, home screen, sign-in, push registration, and deep links are checked.'],
    },
  ];
  return {
    kind: 'ios',
    summary: `iOS ${input.destination} release plan for ${input.bundleId}`,
    blockers,
    steps,
  };
}

export function buildAndroidReleasePlan(input: AndroidReleasePlanInput): MobileReleasePlan {
  const blockers = [
    ...(input.playServiceAccountJsonPath ? [] : ['play-service-account-json-missing']),
    ...(input.keystorePropertiesPath ? [] : ['android-upload-keystore-properties-missing']),
    ...androidStoreAssetBlockers(input),
  ];
  const gradle = input.gradleExecutable ?? './gradlew';
  const steps: MobileReleaseStep[] = [
    {
      id: 'read-project-instructions',
      title: 'Read app release instructions',
      channel: 'local-command',
      description: 'Inspect repo instructions, app config, signing, and release notes before editing.',
      verifies: ['Repo-specific release constraints are known before version changes.'],
    },
    {
      id: 'bump-android-version',
      title: 'Bump Android version',
      channel: 'local-command',
      description: 'Set a strictly increasing versionCode and requested versionName.',
      verifies: [
        `Package ${input.packageName} uses versionCode ${input.versionCode}.`,
        ...(input.versionName ? [`versionName is ${input.versionName}.`] : []),
      ],
    },
    {
      id: 'verify-android-signing',
      title: 'Verify Android signing inputs',
      channel: 'local-command',
      description: 'Confirm upload keystore properties and Android SDK configuration before building.',
      verifies: [
        input.keystorePropertiesPath
          ? `Upload keystore properties file is ${input.keystorePropertiesPath}.`
          : 'Upload keystore properties file is provided.',
      ],
    },
    {
      id: 'run-project-verification',
      title: 'Run project verification gates',
      channel: 'local-command',
      description: 'Run repo tests/build gates before packaging the AAB.',
      commands: commandsFrom(input.appPath, input.verificationCommands),
      verifies: ['Project verification completes before bundleRelease.'],
    },
    {
      id: 'build-android-aab',
      title: 'Build signed Android AAB',
      channel: 'local-command',
      description: 'Build the release app bundle with Gradle.',
      command: { cwd: input.appPath, argv: [gradle, 'bundleRelease'] },
      verifies: [`AAB exists at ${input.aabPath}.`],
    },
    {
      id: 'create-play-edit',
      title: 'Create Play edit',
      channel: 'play-developer-api',
      description: 'Open a Play Developer Publishing API edit.',
      apiAction: 'play.edits.insert',
      verifies: ['A Play edit id is available for the release transaction.'],
    },
    {
      id: 'upload-play-aab',
      title: 'Upload AAB through Play API',
      channel: 'play-developer-api',
      description: 'Upload the signed AAB to the active Play edit.',
      apiAction: 'play.edits.bundles.upload',
      verifies: ['Play API returns the uploaded bundle version code.'],
    },
    ...androidStoreAssetSteps(input),
    {
      id: 'update-play-track',
      title: 'Update Play release track',
      channel: 'play-developer-api',
      description: 'Assign the uploaded bundle to the requested track and rollout state.',
      apiAction: 'play.edits.tracks.update',
      verifies: [
        `${input.destinationTrack} track references versionCode ${input.versionCode}.`,
        ...(input.rolloutPercent !== undefined ? [`Rollout percent is ${input.rolloutPercent}.`] : []),
      ],
    },
    {
      id: 'commit-play-edit',
      title: 'Commit Play edit',
      channel: 'play-developer-api',
      description: 'Commit the edit only after upload and track state verify.',
      apiAction: 'play.edits.commit',
      verifies: ['Committed Play edit is visible from a fresh API read.'],
    },
    ...androidConsoleDeclarationSteps(input),
    {
      id: 'capture-play-app-signing-sha',
      title: 'Capture Play App Signing SHA-256',
      channel: 'browser',
      description: 'Read Play App Signing SHA-256 for assetlinks.json after first upload.',
      browserSkill: 'new-app-setup',
      checkpoint: true,
      verifies: ['Play App Signing SHA-256 is recorded alongside upload/debug SHA values.'],
    },
    {
      id: 'verify-android-smoke',
      title: 'Verify Android smoke behavior',
      channel: 'local-command',
      description: 'Install or launch the released build where available and smoke-test core flows.',
      verifies: ['Launch, home screen, sign-in, push registration, and deep links are checked.'],
    },
  ];
  return {
    kind: 'android',
    summary: `Android ${input.destinationTrack} release plan for ${input.packageName}`,
    blockers,
    steps,
  };
}

export function buildNewAppSetupPlan(input: NewAppSetupPlanInput): MobileReleasePlan {
  const blockers = !input.includePlay && !input.includeAsc
    ? ['no-console-platform-selected']
    : [];
  const steps: MobileReleaseStep[] = [
    {
      id: 'claim-browser-campaign-lease',
      title: 'Claim browser campaign lease',
      channel: 'browser',
      description: 'Use the approved campaign envelope before unattended console mutations.',
      browserTool: 'browser.claim_campaign_lease',
      verifies: ['Lease is active, origin-scoped, and in budget before console work starts.'],
    },
    ...playSetupSteps(input),
    ...ascSetupSteps(input),
    {
      id: 'surface-account-legal-prompts',
      title: 'Surface account and legal prompts',
      channel: 'manual-approval',
      description: 'Escalate prompts that require the account holder or legal judgement.',
      requiredApproval: 'Stop for James on identity, agreements, tax, banking, payment, or legal prompts.',
      verifies: ['No account-holder, payment, identity, tax, banking, or legal prompt was auto-answered.'],
    },
  ];
  return {
    kind: 'new-app-setup',
    summary: `Checkpointed console setup plan for ${input.appSlug}`,
    blockers,
    steps,
  };
}

function iosDestinationSteps(input: IosReleasePlanInput): MobileReleaseStep[] {
  if (isTestFlightDestination(input.destination)) {
    return [
      {
        id: 'attach-testflight-group',
        title: 'Attach build to TestFlight group',
        channel: 'app-store-connect-api',
        description: 'Explicitly attach the processed build to the requested TestFlight group.',
        apiAction: 'app-store-connect.beta-groups.attach-build',
        verifies: [`TestFlight group ${input.testFlightGroup ?? '<GROUP>'} includes the new build.`],
      },
    ];
  }
  return [
    {
      id: 'submit-app-store-review',
      title: 'Submit for App Store review',
      channel: input.allowSubmitForReview ? 'app-store-connect-api' : 'manual-approval',
      description: 'Submit only after metadata, screenshots, compliance, and review answers verify.',
      apiAction: input.allowSubmitForReview ? 'app-store-connect.app-store-versions.submit' : undefined,
      requiredApproval: input.allowSubmitForReview
        ? undefined
        : 'James must explicitly approve App Store review submission.',
      verifies: ['Review submission status is visible from a fresh ASC read.'],
    },
  ];
}

function androidConsoleDeclarationSteps(input: AndroidReleasePlanInput): MobileReleaseStep[] {
  if (!input.consoleDeclarationsRequired) {
    return [];
  }
  return [
    {
      id: 'browser-console-declarations',
      title: 'Complete browser-only console declarations',
      channel: 'browser',
      description: 'Use the checkpointed new-app setup flow for Play declarations without public API coverage.',
      browserSkill: 'new-app-setup',
      checkpoint: true,
      verifies: ['Content rating, Data safety, app access, and policy declarations show saved summaries.'],
    },
  ];
}

function iosStoreAssetBlockers(input: IosReleasePlanInput): string[] {
  if (!iosStoreAssetsRequired(input)) {
    return [];
  }
  return [
    ...storeAssetOutputBlockers(input.storeAssets),
    ...(nonEmpty(input.storeAssets?.iphoneScreenshotPaths)
      ? []
      : ['ios-iphone-screenshots-missing']),
    ...(nonEmpty(input.storeAssets?.ipadScreenshotPaths)
      ? []
      : ['ios-ipad-screenshots-missing']),
  ];
}

function androidStoreAssetBlockers(input: AndroidReleasePlanInput): string[] {
  if (!androidStoreAssetsRequired(input)) {
    return [];
  }
  return [
    ...storeAssetOutputBlockers(input.storeAssets),
    ...(input.storeAssets?.appIcon512Path ? [] : ['play-icon-512-missing']),
    ...(input.storeAssets?.featureGraphic1024x500Path
      ? []
      : ['play-feature-graphic-1024x500-missing']),
    ...(minimumCount(input.storeAssets?.phoneScreenshotPaths, 2)
      ? []
      : ['play-phone-screenshots-missing']),
    ...(nonEmpty(input.storeAssets?.sevenInchTabletScreenshotPaths)
      ? []
      : ['play-7-inch-tablet-screenshots-missing']),
    ...(nonEmpty(input.storeAssets?.tenInchTabletScreenshotPaths)
      ? []
      : ['play-10-inch-tablet-screenshots-missing']),
  ];
}

function iosStoreAssetSteps(input: IosReleasePlanInput): MobileReleaseStep[] {
  if (!iosStoreAssetsRequired(input)) {
    return [];
  }
  return [
    prepareStoreAssetsStep(input.storeAssets, 'iOS App Store screenshots'),
    verifyStoreAssetsStep(input.storeAssets, 'iPhone and iPad screenshot dimensions and hashes'),
    {
      id: 'upload-asc-store-assets',
      title: 'Upload ASC store assets',
      channel: 'app-store-connect-api',
      description: 'Upload verified iPhone/iPad screenshots and metadata assets through App Store Connect APIs where available.',
      apiAction: 'app-store-connect.screenshots.upload',
      verifies: ['ASC app version has the verified iPhone and iPad screenshot sets attached.'],
    },
  ];
}

function androidStoreAssetSteps(input: AndroidReleasePlanInput): MobileReleaseStep[] {
  if (!androidStoreAssetsRequired(input)) {
    return [];
  }
  return [
    prepareStoreAssetsStep(input.storeAssets, 'Google Play icon, feature graphic, phone, and tablet screenshots'),
    verifyStoreAssetsStep(input.storeAssets, 'Play image dimensions and hashes'),
    {
      id: 'upload-play-store-assets',
      title: 'Upload Play store assets',
      channel: 'play-developer-api',
      description: 'Upload listing images and release assets to the active Play edit before commit.',
      apiAction: 'play.edits.images.upload',
      verifies: [
        'Play listing has app icon 512, feature graphic 1024x500, phone screenshots, and 7 inch/10 inch tablet screenshots.',
      ],
    },
  ];
}

function prepareStoreAssetsStep(
  assets: StoreAssetManifestInput | undefined,
  platformSummary: string,
): MobileReleaseStep {
  return {
    id: 'prepare-store-assets',
    title: 'Prepare store asset bundle',
    channel: 'local-command',
    description: `Generate, resize, or copy ${platformSummary} into ${assets?.outputDir ?? '<store-assets-outputDir>'}.`,
    verifies: ['Required store asset files exist in the staged output directory.'],
  };
}

function verifyStoreAssetsStep(
  assets: StoreAssetManifestInput | undefined,
  verificationSummary: string,
): MobileReleaseStep {
  return {
    id: 'verify-store-assets',
    title: 'Verify store asset manifest',
    channel: 'local-command',
    description: `Check ${verificationSummary} before any store upload.`,
    verifies: [
      `Manifest paths are staged under ${assets?.outputDir ?? '<store-assets-outputDir>'}.`,
      'Image dimensions, file counts, and SHA-256 hashes are recorded before upload.',
    ],
  };
}

function storeAssetOutputBlockers(assets: StoreAssetManifestInput | undefined): string[] {
  return assets?.outputDir ? [] : ['store-assets-output-dir-missing'];
}

function iosStoreAssetsRequired(input: IosReleasePlanInput): boolean {
  return input.destination === 'app-store-submit' || hasAnyStoreAsset(input.storeAssets);
}

function androidStoreAssetsRequired(input: AndroidReleasePlanInput): boolean {
  return input.destinationTrack === 'production' || hasAnyStoreAsset(input.storeAssets);
}

function hasAnyStoreAsset(assets: StoreAssetManifestInput | undefined): boolean {
  return Boolean(
    assets?.outputDir ||
      assets?.appIcon512Path ||
      assets?.featureGraphic1024x500Path ||
      nonEmpty(assets?.phoneScreenshotPaths) ||
      nonEmpty(assets?.sevenInchTabletScreenshotPaths) ||
      nonEmpty(assets?.tenInchTabletScreenshotPaths) ||
      nonEmpty(assets?.iphoneScreenshotPaths) ||
      nonEmpty(assets?.ipadScreenshotPaths),
  );
}

function nonEmpty(values: string[] | undefined): boolean {
  return (values?.length ?? 0) > 0;
}

function minimumCount(values: string[] | undefined, count: number): boolean {
  return (values?.length ?? 0) >= count;
}

function playSetupSteps(input: NewAppSetupPlanInput): MobileReleaseStep[] {
  if (!input.includePlay) {
    return [];
  }
  return [
    browserCheckpointStep(
      'play-create-app-record',
      'Create Play app record',
      `Create ${input.playPackageName ?? input.appSlug} in Play Console; there is no public create-app API.`,
      'Play Console shows the selected package and draft app record.',
    ),
    browserCheckpointStep(
      'play-app-content-declarations',
      'Complete Play app content declarations',
      'Complete target audience, ads, app access, news, financial, health, government, advertising ID, and sensitive-permission declarations.',
      'Every app content section shows a saved or completed summary.',
    ),
    browserCheckpointStep(
      'play-content-rating',
      'Complete Play content rating',
      'Answer the IARC questionnaire and save the rating summary.',
      'Content rating page shows the saved rating summary.',
    ),
    browserCheckpointStep(
      'play-data-safety-import',
      'Import Play Data safety CSV',
      'Generate the CSV offline, import it through the console UI, and verify each saved summary page.',
      'Data safety summary matches the imported CSV answers after reload.',
    ),
  ];
}

function ascSetupSteps(input: NewAppSetupPlanInput): MobileReleaseStep[] {
  if (!input.includeAsc) {
    return [];
  }
  return [
    browserCheckpointStep(
      'asc-create-app-record',
      'Create ASC app record',
      `Create ${input.ascBundleId ?? input.appSlug} through the logged-in App Store Connect browser session when API/private automation is unsuitable.`,
      'App Store Connect shows the selected bundle id and app record.',
    ),
    browserCheckpointStep(
      'asc-privacy-nutrition-labels',
      'Complete ASC privacy nutrition labels',
      'Fill privacy nutrition labels with read-back verification for every data category.',
      'Privacy labels show saved answers after reload.',
    ),
  ];
}

function browserCheckpointStep(
  id: string,
  title: string,
  description: string,
  verification: string,
): MobileReleaseStep {
  return {
    id,
    title,
    channel: 'browser',
    description,
    browserSkill: 'new-app-setup',
    checkpoint: true,
    verifies: [verification],
  };
}

function commandsFrom(cwd: string, commands: string[][] | undefined): ReleaseCommand[] | undefined {
  return commands?.map((argv) => ({ cwd, argv }));
}

function isTestFlightDestination(destination: IosReleaseDestination): boolean {
  return destination === 'testflight-internal' || destination === 'testflight-external';
}

function missingAscCredentialBlockers(
  credentials: IosReleasePlanInput['ascCredentials'],
): string[] {
  return [
    ...(credentials.keyId ? [] : ['asc-api-key-id-missing']),
    ...(credentials.issuerId ? [] : ['asc-api-issuer-id-missing']),
    ...(credentials.privateKeyPath ? [] : ['asc-private-key-path-missing']),
  ];
}
