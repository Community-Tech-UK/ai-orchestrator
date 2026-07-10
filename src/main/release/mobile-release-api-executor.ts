import type { MobileReleasePlan, StoreAssetManifestInput } from './mobile-release-plan';
import type { AppStoreConnectAssetUploadInput } from './app-store-connect-client';
import type {
  CommitEditInput,
  UploadImageInput,
  UpdateTrackInput,
  UploadBundleInput,
} from './play-developer-client';
import {
  prepareAndVerifyAndroidStoreAssets,
  prepareAndVerifyIosStoreAssets,
  uploadAscStoreAssets,
  uploadPlayStoreAssets,
  type StoreAssetExecutionResult,
} from './mobile-store-asset-executor';

export interface PlayReleaseApiClient {
  createEdit(packageName: string): Promise<unknown>;
  uploadBundle(input: UploadBundleInput): Promise<unknown>;
  uploadImage?(input: UploadImageInput): Promise<unknown>;
  updateTrack(input: UpdateTrackInput): Promise<unknown>;
  commitEdit(input: CommitEditInput): Promise<unknown>;
}

export interface AscReleaseApiClient {
  request<T = unknown>(
    path: string,
    options?: {
      method?: string;
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      scope?: string[];
    },
  ): Promise<T>;
  uploadAssetPart?(input: AppStoreConnectAssetUploadInput): Promise<void>;
}

export interface ExecuteAndroidPlayApiReleaseInput {
  plan: MobileReleasePlan;
  client: PlayReleaseApiClient;
  packageName: string;
  expectedVersionCode: number;
  track: string;
  aabPath: string;
  readFile: (path: string) => Promise<Uint8Array>;
  releases?: Record<string, unknown>[];
  changesInReviewBehavior?: CommitEditInput['changesInReviewBehavior'];
  storeAssets?: StoreAssetManifestInput;
  storeAssetLanguage?: string;
}

export interface AndroidPlayApiReleaseResult {
  editId: string;
  uploadedVersionCode?: number;
  committed: boolean;
  executedStepIds: string[];
  storeAssets?: StoreAssetExecutionResult;
}

export interface ExecuteIosAscApiReleaseInput {
  plan: MobileReleasePlan;
  client: AscReleaseApiClient;
  buildId: string;
  betaGroupId?: string;
  appStoreVersionId?: string;
  usesNonExemptEncryption: boolean;
  storeAssets?: StoreAssetManifestInput;
  readFile?: (path: string) => Promise<Uint8Array>;
}

export interface IosAscApiReleaseResult {
  buildId: string;
  processingState?: string;
  betaGroupAttached: boolean;
  submittedForReview: boolean;
  executedStepIds: string[];
  storeAssets?: StoreAssetExecutionResult;
}

export async function executeAndroidPlayApiRelease(
  input: ExecuteAndroidPlayApiReleaseInput,
): Promise<AndroidPlayApiReleaseResult> {
  ensurePlan(input.plan, 'android');
  ensureNoBlockers(input.plan);
  requirePlanSteps(input.plan, [
    'create-play-edit',
    'upload-play-aab',
    'update-play-track',
    'commit-play-edit',
  ]);

  const edit = asRecord(await input.client.createEdit(input.packageName));
  const editId = stringField(edit, 'id', 'play_edit_id_missing');
  const aab = await input.readFile(input.aabPath);
  const upload = asRecord(await input.client.uploadBundle({
    packageName: input.packageName,
    editId,
    aab,
  }));
  const uploadedVersionCode = numberField(upload, 'versionCode');
  if (uploadedVersionCode === undefined) {
    throw new Error('play_uploaded_version_code_missing');
  }
  if (uploadedVersionCode !== input.expectedVersionCode) {
    throw new Error(
      `play_uploaded_version_code_mismatch:expected_${input.expectedVersionCode}:got_${uploadedVersionCode}`,
    );
  }
  let storeAssets: StoreAssetExecutionResult | undefined;
  if (hasStep(input.plan, 'prepare-store-assets') || hasStep(input.plan, 'verify-store-assets')) {
    if (!input.storeAssets) {
      throw new Error('release_api_input_missing:storeAssets');
    }
    const verifiedAssets = await prepareAndVerifyAndroidStoreAssets({
      assets: input.storeAssets,
      readFile: input.readFile,
    });
    const uploadedAssets = hasStep(input.plan, 'upload-play-store-assets')
      ? await uploadPlayStoreAssets({
        client: requirePlayImageUploadClient(input.client),
        packageName: input.packageName,
        editId,
        language: input.storeAssetLanguage,
        assets: verifiedAssets,
        readFile: input.readFile,
      })
      : [];
    storeAssets = { verifiedAssets, uploadedAssets };
  }
  const releases = input.releases ?? [{
    versionCodes: [String(uploadedVersionCode)],
    status: 'completed',
  }];
  await input.client.updateTrack({
    packageName: input.packageName,
    editId,
    track: input.track,
    releases,
  });
  await input.client.commitEdit({
    packageName: input.packageName,
    editId,
    changesInReviewBehavior: input.changesInReviewBehavior ?? 'ERROR_IF_IN_REVIEW',
  });
  return {
    editId,
    uploadedVersionCode,
    committed: true,
    executedStepIds: [
      'create-play-edit',
      'upload-play-aab',
      ...(storeAssets ? ['prepare-store-assets', 'verify-store-assets'] : []),
      ...(storeAssets?.uploadedAssets.length ? ['upload-play-store-assets'] : []),
      'update-play-track',
      'commit-play-edit',
    ],
    ...(storeAssets ? { storeAssets } : {}),
  };
}

export async function executeIosAscApiRelease(
  input: ExecuteIosAscApiReleaseInput,
): Promise<IosAscApiReleaseResult> {
  ensurePlan(input.plan, 'ios');
  ensureNoBlockers(input.plan);
  requirePlanSteps(input.plan, [
    'poll-asc-build-processing',
    'set-asc-export-compliance',
  ]);

  const executedStepIds: string[] = [];
  const build = asRecord(await input.client.request(`/v1/builds/${encodeURIComponent(input.buildId)}`, {
    method: 'GET',
    scope: [`GET /v1/builds/${input.buildId}`],
  }));
  executedStepIds.push('poll-asc-build-processing');
  const processingState = extractProcessingState(build);

  await input.client.request(`/v1/builds/${encodeURIComponent(input.buildId)}`, {
    method: 'PATCH',
    body: {
      data: {
        id: input.buildId,
        type: 'builds',
        attributes: {
          usesNonExemptEncryption: input.usesNonExemptEncryption,
        },
      },
    },
    scope: [`PATCH /v1/builds/${input.buildId}`],
  });
  executedStepIds.push('set-asc-export-compliance');

  let betaGroupAttached = false;
  if (hasStep(input.plan, 'attach-testflight-group')) {
    if (!input.betaGroupId) {
      throw new Error('release_api_input_missing:betaGroupId');
    }
    await input.client.request(
      `/v1/betaGroups/${encodeURIComponent(input.betaGroupId)}/relationships/builds`,
      {
        method: 'POST',
        body: {
          data: [{ id: input.buildId, type: 'builds' }],
        },
        scope: [`POST /v1/betaGroups/${input.betaGroupId}/relationships/builds`],
      },
    );
    betaGroupAttached = true;
    executedStepIds.push('attach-testflight-group');
  }

  let storeAssets: StoreAssetExecutionResult | undefined;
  if (hasStep(input.plan, 'prepare-store-assets') || hasStep(input.plan, 'verify-store-assets')) {
    if (!input.storeAssets || !input.readFile) {
      throw new Error('release_api_input_missing:storeAssets');
    }
    const verifiedAssets = await prepareAndVerifyIosStoreAssets({
      assets: input.storeAssets,
      readFile: input.readFile,
    });
    const uploadedAssets = hasStep(input.plan, 'upload-asc-store-assets')
      ? await uploadAscStoreAssets({
        client: requireAscAssetUploadClient(input.client),
        assets: input.storeAssets,
        verifiedAssets,
        readFile: input.readFile,
      })
      : [];
    storeAssets = { verifiedAssets, uploadedAssets };
    executedStepIds.push('prepare-store-assets', 'verify-store-assets');
    if (uploadedAssets.length > 0) {
      executedStepIds.push('upload-asc-store-assets');
    }
  }

  let submittedForReview = false;
  if (hasStep(input.plan, 'submit-app-store-review')) {
    if (!input.appStoreVersionId) {
      throw new Error('release_api_input_missing:appStoreVersionId');
    }
    await input.client.request('/v1/appStoreVersionSubmissions', {
      method: 'POST',
      body: {
        data: {
          type: 'appStoreVersionSubmissions',
          relationships: {
            appStoreVersion: {
              data: { id: input.appStoreVersionId, type: 'appStoreVersions' },
            },
          },
        },
      },
      scope: ['POST /v1/appStoreVersionSubmissions'],
    });
    submittedForReview = true;
    executedStepIds.push('submit-app-store-review');
  }

  return {
    buildId: input.buildId,
    processingState,
    betaGroupAttached,
    submittedForReview,
    executedStepIds,
    ...(storeAssets ? { storeAssets } : {}),
  };
}

function ensurePlan(plan: MobileReleasePlan, expectedKind: MobileReleasePlan['kind']): void {
  if (plan.kind !== expectedKind) {
    throw new Error(`release_plan_kind_mismatch:${plan.kind}`);
  }
}

function ensureNoBlockers(plan: MobileReleasePlan): void {
  if (plan.blockers.length > 0) {
    throw new Error(`release_plan_blocked:${plan.blockers.join(',')}`);
  }
}

function requirePlanSteps(plan: MobileReleasePlan, stepIds: string[]): void {
  for (const stepId of stepIds) {
    if (!hasStep(plan, stepId)) {
      throw new Error(`release_plan_step_missing:${stepId}`);
    }
  }
}

function hasStep(plan: MobileReleasePlan, stepId: string): boolean {
  return plan.steps.some((step) => step.id === stepId);
}

function requirePlayImageUploadClient(client: PlayReleaseApiClient): PlayReleaseApiClient & {
  uploadImage: NonNullable<PlayReleaseApiClient['uploadImage']>;
} {
  if (!client.uploadImage) {
    throw new Error('release_api_client_missing:uploadImage');
  }
  return client as PlayReleaseApiClient & {
    uploadImage: NonNullable<PlayReleaseApiClient['uploadImage']>;
  };
}

function requireAscAssetUploadClient(client: AscReleaseApiClient): AscReleaseApiClient & {
  uploadAssetPart: NonNullable<AscReleaseApiClient['uploadAssetPart']>;
} {
  if (!client.uploadAssetPart) {
    throw new Error('release_api_client_missing:uploadAssetPart');
  }
  return client as AscReleaseApiClient & {
    uploadAssetPart: NonNullable<AscReleaseApiClient['uploadAssetPart']>;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(record: Record<string, unknown>, field: string, reason: string): string {
  const value = record[field];
  if (typeof value !== 'string' || !value) {
    throw new Error(reason);
  }
  return value;
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === 'number' ? value : undefined;
}

function extractProcessingState(build: Record<string, unknown>): string | undefined {
  const data = build['data'];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }
  const attributes = (data as Record<string, unknown>)['attributes'];
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    return undefined;
  }
  const state = (attributes as Record<string, unknown>)['processingState'];
  return typeof state === 'string' ? state : undefined;
}
