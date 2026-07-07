import * as fs from 'node:fs/promises';
import { z } from 'zod';
import type { McpServerToolDefinition } from './mcp-server-tools';
import {
  buildAndroidReleasePlan,
  buildIosReleasePlan,
  buildNewAppSetupPlan,
  type AndroidReleasePlanInput,
  type IosReleasePlanInput,
  type NewAppSetupPlanInput,
} from '../release/mobile-release-plan';
import {
  executeAndroidPlayApiRelease,
  executeIosAscApiRelease,
  type AscReleaseApiClient,
  type PlayReleaseApiClient,
} from '../release/mobile-release-api-executor';
import {
  GoogleServiceAccountTokenProvider,
  PlayDeveloperClient,
  type GoogleServiceAccountCredentials,
} from '../release/play-developer-client';
import { AppStoreConnectClient } from '../release/app-store-connect-client';
import {
  buildReleaseOperationalReadinessReport,
  remoteNodesToReleaseReadinessEvidence,
} from '../release/mobile-release-readiness';

const nonEmpty = z.string().min(1);
const commandListSchema = z.array(z.array(nonEmpty));
const androidTrackSchema = z.enum(['internal', 'alpha', 'beta', 'production']);
const iosDestinationSchema = z.enum(['testflight-internal', 'testflight-external', 'app-store-submit']);
const releaseRecordSchema = z.record(z.string(), z.unknown());
const storeAssetsSchema = z.object({
  outputDir: nonEmpty.optional(),
  appIcon512Path: nonEmpty.optional(),
  featureGraphic1024x500Path: nonEmpty.optional(),
  phoneScreenshotPaths: z.array(nonEmpty).optional(),
  sevenInchTabletScreenshotPaths: z.array(nonEmpty).optional(),
  tenInchTabletScreenshotPaths: z.array(nonEmpty).optional(),
  iphoneScreenshotPaths: z.array(nonEmpty).optional(),
  ipadScreenshotPaths: z.array(nonEmpty).optional(),
}).strict();
const readinessWorkerAgentSchema = z.object({
  version: nonEmpty,
  startedAt: z.number().int().nonnegative(),
}).strict();
const readinessExtensionRelaySchema = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  extensionVersion: nonEmpty.optional(),
  extensionReloadedAt: z.number().int().nonnegative().optional(),
  lastExtensionContactAt: z.number().int().nonnegative().optional(),
}).passthrough();
const readinessNodeSchema = z.object({
  id: nonEmpty.optional(),
  name: nonEmpty,
  status: z.enum(['connecting', 'connected', 'degraded', 'disconnected']).optional(),
  connected: z.boolean(),
  hasBrowserMcp: z.boolean(),
  workerVersion: nonEmpty.optional(),
  workerDeployedAt: z.number().int().nonnegative().optional(),
  workerAgent: readinessWorkerAgentSchema.optional(),
  extensionVersion: nonEmpty.optional(),
  extensionReloadedAt: z.number().int().nonnegative().optional(),
  extensionRelay: readinessExtensionRelaySchema.optional(),
}).passthrough();
const browserHealthSchema = z.object({
  checkedAt: z.number().int().nonnegative().optional(),
  ok: z.boolean(),
  summary: nonEmpty.optional(),
}).strict();
const nativeHostRecoveryDrillSchema = z.object({
  ranAt: z.number().int().nonnegative().optional(),
  passed: z.boolean(),
  nodeName: nonEmpty.optional(),
  summary: nonEmpty.optional(),
}).strict();
const testflightInternalReleaseSchema = z.object({
  releasedAt: z.number().int().nonnegative().optional(),
  bundleId: nonEmpty,
  buildNumber: nonEmpty,
  betaGroupAttached: z.boolean(),
  smokePassed: z.boolean(),
}).strict();
const playInternalReleaseSchema = z.object({
  releasedAt: z.number().int().nonnegative().optional(),
  packageName: nonEmpty,
  versionCode: z.number().int().positive(),
  track: nonEmpty,
  committed: z.boolean(),
  smokePassed: z.boolean(),
}).strict();

export const BuildReleaseOperationalReadinessReportArgsSchema = z.object({
  expectedWorkerVersion: nonEmpty.optional(),
  expectedExtensionVersion: nonEmpty.optional(),
  harnessRestartedAt: z.number().int().nonnegative().optional(),
  remoteNodes: z.array(readinessNodeSchema),
  browserHealth: browserHealthSchema.optional(),
  nativeHostRecoveryDrill: nativeHostRecoveryDrillSchema.optional(),
  testflightInternalRelease: testflightInternalReleaseSchema.optional(),
  playInternalRelease: playInternalReleaseSchema.optional(),
}).strict();

export const BuildAndroidReleasePlanArgsSchema = z.object({
  appPath: nonEmpty,
  packageName: nonEmpty,
  versionCode: z.number().int().positive(),
  versionName: nonEmpty.optional(),
  destinationTrack: androidTrackSchema,
  aabPath: nonEmpty,
  gradleExecutable: nonEmpty.optional(),
  playServiceAccountJsonPath: nonEmpty.optional(),
  keystorePropertiesPath: nonEmpty.optional(),
  rolloutPercent: z.number().min(0).max(1).optional(),
  consoleDeclarationsRequired: z.boolean().optional(),
  storeAssets: storeAssetsSchema.optional(),
  verificationCommands: commandListSchema.optional(),
}).strict();

export const ExecuteAndroidPlayReleaseArgsSchema = BuildAndroidReleasePlanArgsSchema.extend({
  playServiceAccountJsonPath: nonEmpty,
  keystorePropertiesPath: nonEmpty,
  track: androidTrackSchema.optional(),
  releases: z.array(releaseRecordSchema).optional(),
  changesInReviewBehavior: z.enum(['CANCEL_IN_REVIEW_AND_SUBMIT', 'ERROR_IF_IN_REVIEW']).optional(),
}).strict();

export const BuildIosReleasePlanArgsSchema = z.object({
  appPath: nonEmpty,
  bundleId: nonEmpty,
  archivePath: nonEmpty,
  exportPath: nonEmpty,
  exportOptionsPlist: nonEmpty,
  ipaPath: nonEmpty,
  buildNumber: nonEmpty,
  destination: iosDestinationSchema,
  ascKeyId: nonEmpty.optional(),
  ascIssuerId: nonEmpty.optional(),
  ascPrivateKeyPath: nonEmpty.optional(),
  scheme: nonEmpty.optional(),
  configuration: nonEmpty.optional(),
  marketingVersion: nonEmpty.optional(),
  testFlightGroup: nonEmpty.optional(),
  usesNonExemptEncryption: z.boolean().optional(),
  allowSubmitForReview: z.boolean().optional(),
  storeAssets: storeAssetsSchema.optional(),
  verificationCommands: commandListSchema.optional(),
}).strict();

export const ExecuteIosAscFinalizationArgsSchema = BuildIosReleasePlanArgsSchema.extend({
  ascKeyId: nonEmpty,
  ascIssuerId: nonEmpty,
  ascPrivateKeyPath: nonEmpty,
  buildId: nonEmpty,
  betaGroupId: nonEmpty.optional(),
  appStoreVersionId: nonEmpty.optional(),
  usesNonExemptEncryption: z.boolean(),
}).strict();

export const BuildNewAppSetupPlanArgsSchema = z.object({
  appSlug: nonEmpty,
  playPackageName: nonEmpty.optional(),
  ascBundleId: nonEmpty.optional(),
  includePlay: z.boolean(),
  includeAsc: z.boolean(),
}).strict();

export interface ReleaseToolDependencies {
  readTextFile?: (path: string) => Promise<string>;
  readBinaryFile?: (path: string) => Promise<Uint8Array>;
  createPlayClient?: (serviceAccount: GoogleServiceAccountCredentials) => PlayReleaseApiClient;
  createAscClient?: (credentials: { keyId: string; issuerId: string; privateKey: string }) => AscReleaseApiClient;
}

export function createReleaseToolDefinitions(
  dependencies: ReleaseToolDependencies = {},
): McpServerToolDefinition[] {
  const readTextFile = dependencies.readTextFile ?? ((filePath) => fs.readFile(filePath, 'utf8'));
  const readBinaryFile = dependencies.readBinaryFile ?? ((filePath) => fs.readFile(filePath));
  const createPlayClient = dependencies.createPlayClient ?? createDefaultPlayClient;
  const createAscClient = dependencies.createAscClient ?? ((credentials) => new AppStoreConnectClient(credentials));

  return [
    {
      name: 'build_release_operational_readiness_report',
      ...RELEASE_TOOL_SPECS.build_release_operational_readiness_report,
      handler: async (args) => {
        const parsed = BuildReleaseOperationalReadinessReportArgsSchema.parse(args);
        return buildReleaseOperationalReadinessReport({
          ...parsed,
          remoteNodes: remoteNodesToReleaseReadinessEvidence(parsed.remoteNodes),
        });
      },
    },
    {
      name: 'build_ios_release_plan',
      ...RELEASE_TOOL_SPECS.build_ios_release_plan,
      handler: async (args) => buildIosReleasePlan(toIosPlanInput(BuildIosReleasePlanArgsSchema.parse(args))),
    },
    {
      name: 'build_android_release_plan',
      ...RELEASE_TOOL_SPECS.build_android_release_plan,
      handler: async (args) => buildAndroidReleasePlan(toAndroidPlanInput(BuildAndroidReleasePlanArgsSchema.parse(args))),
    },
    {
      name: 'build_new_app_setup_plan',
      ...RELEASE_TOOL_SPECS.build_new_app_setup_plan,
      handler: async (args) => buildNewAppSetupPlan(BuildNewAppSetupPlanArgsSchema.parse(args) as NewAppSetupPlanInput),
    },
    {
      name: 'execute_android_play_release',
      ...RELEASE_TOOL_SPECS.execute_android_play_release,
      handler: async (args) => {
        const parsed = ExecuteAndroidPlayReleaseArgsSchema.parse(args);
        const plan = buildAndroidReleasePlan(toAndroidPlanInput(parsed));
        const serviceAccount = await readGoogleServiceAccount(readTextFile, parsed.playServiceAccountJsonPath);
        const release = await executeAndroidPlayApiRelease({
          plan,
          client: createPlayClient(serviceAccount),
          packageName: parsed.packageName,
          track: parsed.track ?? parsed.destinationTrack,
          aabPath: parsed.aabPath,
          readFile: readBinaryFile,
          releases: parsed.releases,
          changesInReviewBehavior: parsed.changesInReviewBehavior,
        });
        return { plan, release };
      },
    },
    {
      name: 'execute_ios_asc_finalization',
      ...RELEASE_TOOL_SPECS.execute_ios_asc_finalization,
      handler: async (args) => {
        const parsed = ExecuteIosAscFinalizationArgsSchema.parse(args);
        const plan = buildIosReleasePlan(toIosPlanInput(parsed));
        const privateKey = await readTextFile(parsed.ascPrivateKeyPath);
        const release = await executeIosAscApiRelease({
          plan,
          client: createAscClient({
            keyId: parsed.ascKeyId,
            issuerId: parsed.ascIssuerId,
            privateKey,
          }),
          buildId: parsed.buildId,
          betaGroupId: parsed.betaGroupId,
          appStoreVersionId: parsed.appStoreVersionId,
          usesNonExemptEncryption: parsed.usesNonExemptEncryption,
        });
        return { plan, release };
      },
    },
  ];
}

function toAndroidPlanInput(
  parsed: z.infer<typeof BuildAndroidReleasePlanArgsSchema>,
): AndroidReleasePlanInput {
  return {
    appPath: parsed.appPath,
    packageName: parsed.packageName,
    versionCode: parsed.versionCode,
    versionName: parsed.versionName,
    destinationTrack: parsed.destinationTrack,
    aabPath: parsed.aabPath,
    gradleExecutable: parsed.gradleExecutable,
    playServiceAccountJsonPath: parsed.playServiceAccountJsonPath,
    keystorePropertiesPath: parsed.keystorePropertiesPath,
    rolloutPercent: parsed.rolloutPercent,
    consoleDeclarationsRequired: parsed.consoleDeclarationsRequired,
    storeAssets: parsed.storeAssets,
    verificationCommands: parsed.verificationCommands,
  };
}

function toIosPlanInput(parsed: z.infer<typeof BuildIosReleasePlanArgsSchema>): IosReleasePlanInput {
  return {
    appPath: parsed.appPath,
    bundleId: parsed.bundleId,
    archivePath: parsed.archivePath,
    exportPath: parsed.exportPath,
    exportOptionsPlist: parsed.exportOptionsPlist,
    ipaPath: parsed.ipaPath,
    buildNumber: parsed.buildNumber,
    destination: parsed.destination,
    ascCredentials: {
      keyId: parsed.ascKeyId,
      issuerId: parsed.ascIssuerId,
      privateKeyPath: parsed.ascPrivateKeyPath,
    },
    scheme: parsed.scheme,
    configuration: parsed.configuration,
    marketingVersion: parsed.marketingVersion,
    testFlightGroup: parsed.testFlightGroup,
    compliance: {
      usesNonExemptEncryption: parsed.usesNonExemptEncryption,
    },
    allowSubmitForReview: parsed.allowSubmitForReview,
    storeAssets: parsed.storeAssets,
    verificationCommands: parsed.verificationCommands,
  };
}

function createDefaultPlayClient(serviceAccount: GoogleServiceAccountCredentials): PlayReleaseApiClient {
  return new PlayDeveloperClient({
    tokenProvider: new GoogleServiceAccountTokenProvider({ serviceAccount }),
  });
}

async function readGoogleServiceAccount(
  readTextFile: (path: string) => Promise<string>,
  filePath: string,
): Promise<GoogleServiceAccountCredentials> {
  const raw = JSON.parse(await readTextFile(filePath)) as Record<string, unknown>;
  return {
    clientEmail: requiredString(raw, 'client_email', 'clientEmail'),
    privateKeyId: requiredString(raw, 'private_key_id', 'privateKeyId'),
    privateKey: requiredString(raw, 'private_key', 'privateKey'),
    tokenUri: optionalString(raw, 'token_uri', 'tokenUri'),
  };
}

function requiredString(record: Record<string, unknown>, snakeKey: string, camelKey: string): string {
  const value = record[snakeKey] ?? record[camelKey];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`release_credentials_missing:${snakeKey}`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): string | undefined {
  const value = record[snakeKey] ?? record[camelKey];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const STORE_ASSETS_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    outputDir: { type: 'string' },
    appIcon512Path: { type: 'string' },
    featureGraphic1024x500Path: { type: 'string' },
    phoneScreenshotPaths: { type: 'array', items: { type: 'string' } },
    sevenInchTabletScreenshotPaths: { type: 'array', items: { type: 'string' } },
    tenInchTabletScreenshotPaths: { type: 'array', items: { type: 'string' } },
    iphoneScreenshotPaths: { type: 'array', items: { type: 'string' } },
    ipadScreenshotPaths: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

const READINESS_NODE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    status: {
      type: 'string',
      enum: ['connecting', 'connected', 'degraded', 'disconnected'],
    },
    connected: { type: 'boolean' },
    hasBrowserMcp: { type: 'boolean' },
    workerVersion: { type: 'string' },
    workerDeployedAt: { type: 'integer', minimum: 0 },
    workerAgent: {
      type: 'object',
      properties: {
        version: { type: 'string' },
        startedAt: { type: 'integer', minimum: 0 },
      },
      required: ['version', 'startedAt'],
      additionalProperties: false,
    },
    extensionVersion: { type: 'string' },
    extensionReloadedAt: { type: 'integer', minimum: 0 },
    extensionRelay: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        running: { type: 'boolean' },
        extensionVersion: { type: 'string' },
        extensionReloadedAt: { type: 'integer', minimum: 0 },
        lastExtensionContactAt: { type: 'integer', minimum: 0 },
      },
      required: ['enabled', 'running'],
      additionalProperties: true,
    },
  },
  required: ['name', 'connected', 'hasBrowserMcp'],
  additionalProperties: true,
};

export const RELEASE_OPERATIONAL_READINESS_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    expectedWorkerVersion: { type: 'string' },
    expectedExtensionVersion: { type: 'string' },
    harnessRestartedAt: { type: 'integer', minimum: 0 },
    remoteNodes: { type: 'array', items: READINESS_NODE_INPUT_SCHEMA },
    browserHealth: {
      type: 'object',
      properties: {
        checkedAt: { type: 'integer', minimum: 0 },
        ok: { type: 'boolean' },
        summary: { type: 'string' },
      },
      required: ['ok'],
      additionalProperties: false,
    },
    nativeHostRecoveryDrill: {
      type: 'object',
      properties: {
        ranAt: { type: 'integer', minimum: 0 },
        passed: { type: 'boolean' },
        nodeName: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['passed'],
      additionalProperties: false,
    },
    testflightInternalRelease: {
      type: 'object',
      properties: {
        releasedAt: { type: 'integer', minimum: 0 },
        bundleId: { type: 'string' },
        buildNumber: { type: 'string' },
        betaGroupAttached: { type: 'boolean' },
        smokePassed: { type: 'boolean' },
      },
      required: ['bundleId', 'buildNumber', 'betaGroupAttached', 'smokePassed'],
      additionalProperties: false,
    },
    playInternalRelease: {
      type: 'object',
      properties: {
        releasedAt: { type: 'integer', minimum: 0 },
        packageName: { type: 'string' },
        versionCode: { type: 'integer', minimum: 1 },
        track: { type: 'string' },
        committed: { type: 'boolean' },
        smokePassed: { type: 'boolean' },
      },
      required: ['packageName', 'versionCode', 'track', 'committed', 'smokePassed'],
      additionalProperties: false,
    },
  },
  required: ['remoteNodes'],
  additionalProperties: false,
};

export const ANDROID_PLAN_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    appPath: { type: 'string' },
    packageName: { type: 'string' },
    versionCode: { type: 'integer', minimum: 1 },
    versionName: { type: 'string' },
    destinationTrack: { type: 'string', enum: ['internal', 'alpha', 'beta', 'production'] },
    aabPath: { type: 'string' },
    gradleExecutable: { type: 'string' },
    playServiceAccountJsonPath: { type: 'string' },
    keystorePropertiesPath: { type: 'string' },
    rolloutPercent: { type: 'number', minimum: 0, maximum: 1 },
    consoleDeclarationsRequired: { type: 'boolean' },
    storeAssets: STORE_ASSETS_INPUT_SCHEMA,
    verificationCommands: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
  },
  required: ['appPath', 'packageName', 'versionCode', 'destinationTrack', 'aabPath'],
  additionalProperties: false,
};

export const ANDROID_EXECUTE_INPUT_SCHEMA = {
  ...ANDROID_PLAN_INPUT_SCHEMA,
  properties: {
    ...ANDROID_PLAN_INPUT_SCHEMA.properties,
    track: { type: 'string', enum: ['internal', 'alpha', 'beta', 'production'] },
    releases: { type: 'array', items: { type: 'object', additionalProperties: true } },
    changesInReviewBehavior: { type: 'string', enum: ['CANCEL_IN_REVIEW_AND_SUBMIT', 'ERROR_IF_IN_REVIEW'] },
  },
  required: [...ANDROID_PLAN_INPUT_SCHEMA.required, 'playServiceAccountJsonPath', 'keystorePropertiesPath'],
};

export const IOS_PLAN_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    appPath: { type: 'string' },
    bundleId: { type: 'string' },
    archivePath: { type: 'string' },
    exportPath: { type: 'string' },
    exportOptionsPlist: { type: 'string' },
    ipaPath: { type: 'string' },
    buildNumber: { type: 'string' },
    destination: { type: 'string', enum: ['testflight-internal', 'testflight-external', 'app-store-submit'] },
    ascKeyId: { type: 'string' },
    ascIssuerId: { type: 'string' },
    ascPrivateKeyPath: { type: 'string' },
    scheme: { type: 'string' },
    configuration: { type: 'string' },
    marketingVersion: { type: 'string' },
    testFlightGroup: { type: 'string' },
    usesNonExemptEncryption: { type: 'boolean' },
    allowSubmitForReview: { type: 'boolean' },
    storeAssets: STORE_ASSETS_INPUT_SCHEMA,
    verificationCommands: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
  },
  required: [
    'appPath',
    'bundleId',
    'archivePath',
    'exportPath',
    'exportOptionsPlist',
    'ipaPath',
    'buildNumber',
    'destination',
  ],
  additionalProperties: false,
};

export const IOS_EXECUTE_INPUT_SCHEMA = {
  ...IOS_PLAN_INPUT_SCHEMA,
  properties: {
    ...IOS_PLAN_INPUT_SCHEMA.properties,
    buildId: { type: 'string' },
    betaGroupId: { type: 'string' },
    appStoreVersionId: { type: 'string' },
  },
  required: [
    ...IOS_PLAN_INPUT_SCHEMA.required,
    'ascKeyId',
    'ascIssuerId',
    'ascPrivateKeyPath',
    'buildId',
    'usesNonExemptEncryption',
  ],
};

export const NEW_APP_SETUP_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    appSlug: { type: 'string' },
    playPackageName: { type: 'string' },
    ascBundleId: { type: 'string' },
    includePlay: { type: 'boolean' },
    includeAsc: { type: 'boolean' },
  },
  required: ['appSlug', 'includePlay', 'includeAsc'],
  additionalProperties: false,
};

export const RELEASE_TOOL_SPECS = {
  build_release_operational_readiness_report: {
    description:
      'Build the machine-readable operational readiness report for the remaining physical rollout and live TestFlight/Play internal release gates. This does not mutate remote nodes or stores.',
    inputSchema: RELEASE_OPERATIONAL_READINESS_INPUT_SCHEMA,
  },
  build_ios_release_plan: {
    description:
      'Build a machine-readable API-first iOS release plan with blockers and verification gates. This does not upload or mutate App Store Connect.',
    inputSchema: IOS_PLAN_INPUT_SCHEMA,
  },
  build_android_release_plan: {
    description:
      'Build a machine-readable API-first Android/Google Play release plan with blockers and verification gates. This does not upload or mutate Play Console.',
    inputSchema: ANDROID_PLAN_INPUT_SCHEMA,
  },
  build_new_app_setup_plan: {
    description:
      'Build the checkpointed browser plan for console-only new-app setup work in Play Console and App Store Connect. This does not mutate the browser.',
    inputSchema: NEW_APP_SETUP_INPUT_SCHEMA,
  },
  execute_android_play_release: {
    description:
      'Execute the Play Developer Publishing API release transaction: create edit, upload AAB, update track, and commit. Reads the service-account JSON and AAB from local paths; never returns secret values.',
    inputSchema: ANDROID_EXECUTE_INPUT_SCHEMA,
  },
  execute_ios_asc_finalization: {
    description:
      'Execute App Store Connect API finalization for an already-uploaded build: poll/read build, set export compliance, attach TestFlight group, and optionally submit for review. Reads the ASC .p8 key from a local path; never returns key material.',
    inputSchema: IOS_EXECUTE_INPUT_SCHEMA,
  },
} satisfies Record<string, { description: string; inputSchema: Record<string, unknown> }>;

export type ReleaseToolName = keyof typeof RELEASE_TOOL_SPECS;
