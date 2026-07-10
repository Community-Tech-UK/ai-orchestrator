import { createHash } from 'node:crypto';
import type { AppStoreConnectAssetUploadInput } from './app-store-connect-client';
import type { StoreAssetManifestInput } from './mobile-release-plan';

export type StoreAssetKind =
  | 'play-icon'
  | 'play-feature-graphic'
  | 'play-phone-screenshot'
  | 'play-7-inch-tablet-screenshot'
  | 'play-10-inch-tablet-screenshot'
  | 'ios-iphone-screenshot'
  | 'ios-ipad-screenshot';

export interface StoreAssetVerification {
  kind: StoreAssetKind;
  path: string;
  width: number;
  height: number;
  size: number;
  sha256: string;
}

export interface StoreAssetExecutionResult {
  verifiedAssets: StoreAssetVerification[];
  uploadedAssets: {
    kind: StoreAssetKind;
    path: string;
    providerResult: unknown;
  }[];
}

export interface PlayStoreAssetUploadClient {
  uploadImage(input: {
    packageName: string;
    editId: string;
    language: string;
    imageType: string;
    image: Uint8Array;
    contentType?: string;
  }): Promise<unknown>;
}

export interface AscStoreAssetUploadClient {
  request<T = unknown>(
    path: string,
    options?: {
      method?: string;
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      scope?: string[];
    },
  ): Promise<T>;
  uploadAssetPart(input: AppStoreConnectAssetUploadInput): Promise<void>;
}

interface StoreAssetCheck {
  kind: StoreAssetKind;
  paths: string[];
  width?: number;
  height?: number;
  minCount: number;
  maxCount?: number;
  dimension?: (dimensions: { width: number; height: number }) => boolean;
}

export async function prepareAndVerifyAndroidStoreAssets(input: {
  assets: StoreAssetManifestInput;
  readFile: (path: string) => Promise<Uint8Array>;
}): Promise<StoreAssetVerification[]> {
  const checks: StoreAssetCheck[] = [
    {
      kind: 'play-icon',
      paths: maybePath(input.assets.appIcon512Path),
      width: 512,
      height: 512,
      minCount: 1,
      maxCount: 1,
    },
    {
      kind: 'play-feature-graphic',
      paths: maybePath(input.assets.featureGraphic1024x500Path),
      width: 1024,
      height: 500,
      minCount: 1,
      maxCount: 1,
    },
    {
      kind: 'play-phone-screenshot',
      paths: input.assets.phoneScreenshotPaths ?? [],
      minCount: 2,
      maxCount: 8,
      dimension: playScreenshotDimension,
    },
    {
      kind: 'play-7-inch-tablet-screenshot',
      paths: input.assets.sevenInchTabletScreenshotPaths ?? [],
      minCount: 1,
      maxCount: 8,
      dimension: playScreenshotDimension,
    },
    {
      kind: 'play-10-inch-tablet-screenshot',
      paths: input.assets.tenInchTabletScreenshotPaths ?? [],
      minCount: 1,
      maxCount: 8,
      dimension: playScreenshotDimension,
    },
  ];
  return verifyStoreAssets(checks, input.readFile);
}

export async function prepareAndVerifyIosStoreAssets(input: {
  assets: StoreAssetManifestInput;
  readFile: (path: string) => Promise<Uint8Array>;
}): Promise<StoreAssetVerification[]> {
  const iphoneDimension = iosScreenshotDimension(
    requiredString(
      input.assets.iphoneScreenshotDisplayType,
      'release_api_input_missing:iphoneScreenshotDisplayType',
    ),
  );
  const ipadDimension = iosScreenshotDimension(
    requiredString(
      input.assets.ipadScreenshotDisplayType,
      'release_api_input_missing:ipadScreenshotDisplayType',
    ),
  );
  return verifyStoreAssets([
    {
      kind: 'ios-iphone-screenshot',
      paths: input.assets.iphoneScreenshotPaths ?? [],
      minCount: 1,
      maxCount: 10,
      dimension: iphoneDimension,
    },
    {
      kind: 'ios-ipad-screenshot',
      paths: input.assets.ipadScreenshotPaths ?? [],
      minCount: 1,
      maxCount: 10,
      dimension: ipadDimension,
    },
  ], input.readFile);
}

export async function uploadPlayStoreAssets(input: {
  client: PlayStoreAssetUploadClient;
  packageName: string;
  editId: string;
  language?: string;
  assets: StoreAssetVerification[];
  readFile: (path: string) => Promise<Uint8Array>;
}): Promise<StoreAssetExecutionResult['uploadedAssets']> {
  const uploadedAssets: StoreAssetExecutionResult['uploadedAssets'] = [];
  for (const asset of input.assets) {
    const imageType = playImageType(asset.kind);
    if (!imageType) {
      continue;
    }
    const providerResult = await input.client.uploadImage({
      packageName: input.packageName,
      editId: input.editId,
      language: input.language ?? 'en-US',
      imageType,
      image: await input.readFile(asset.path),
      contentType: 'image/png',
    });
    uploadedAssets.push({
      kind: asset.kind,
      path: asset.path,
      providerResult,
    });
  }
  return uploadedAssets;
}

export async function uploadAscStoreAssets(input: {
  client: AscStoreAssetUploadClient;
  assets: StoreAssetManifestInput;
  verifiedAssets: StoreAssetVerification[];
  readFile: (path: string) => Promise<Uint8Array>;
}): Promise<StoreAssetExecutionResult['uploadedAssets']> {
  const localizationId = requiredString(
    input.assets.appStoreVersionLocalizationId,
    'release_api_input_missing:appStoreVersionLocalizationId',
  );
  const mappings = iosScreenshotMappings(input.assets, input.verifiedAssets);
  const screenshotSetIds = await resolveAscScreenshotSets(
    input.client,
    localizationId,
    mappings.map((mapping) => mapping.displayType),
  );
  const uploadedAssets: StoreAssetExecutionResult['uploadedAssets'] = [];
  for (const mapping of mappings) {
    const screenshotSetId = screenshotSetIds.get(mapping.displayType);
    if (!screenshotSetId) {
      throw new Error(`asc_screenshot_set_missing:${mapping.displayType}`);
    }
    for (const asset of mapping.assets) {
      const bytes = await input.readFile(asset.path);
      if (bytes.byteLength !== asset.size) {
        throw new Error(`store_asset_size_changed:${asset.path}`);
      }
      const reservation = parseAscResource(await input.client.request('/v1/appScreenshots', {
        method: 'POST',
        body: {
          data: {
            type: 'appScreenshots',
            attributes: {
              fileName: fileName(asset.path),
              fileSize: bytes.byteLength,
            },
            relationships: {
              appScreenshotSet: {
                data: {
                  id: screenshotSetId,
                  type: 'appScreenshotSets',
                },
              },
            },
          },
        },
        scope: ['POST /v1/appScreenshots'],
      }), 'asc_screenshot_reservation_invalid');
      const uploadOperations = parseUploadOperations(reservation.attributes, bytes.byteLength);
      for (const operation of uploadOperations) {
        await input.client.uploadAssetPart({
          method: operation.method,
          url: operation.url,
          headers: operation.headers,
          body: bytes.slice(operation.offset, operation.offset + operation.length),
        });
      }
      await input.client.request(`/v1/appScreenshots/${encodeURIComponent(reservation.id)}`, {
        method: 'PATCH',
        body: {
          data: {
            type: 'appScreenshots',
            id: reservation.id,
            attributes: {
              uploaded: true,
              sourceFileChecksum: createHash('md5').update(bytes).digest('hex'),
            },
          },
        },
        scope: [`PATCH /v1/appScreenshots/${reservation.id}`],
      });
      const providerResult = await verifyAscScreenshot(input.client, reservation.id);
      uploadedAssets.push({
        kind: asset.kind,
        path: asset.path,
        providerResult,
      });
    }
  }
  return uploadedAssets;
}

interface IosScreenshotMapping {
  displayType: string;
  assets: StoreAssetVerification[];
}

interface AscResource {
  id: string;
  attributes: Record<string, unknown>;
}

interface AscUploadOperation {
  method: string;
  url: string;
  offset: number;
  length: number;
  headers: Record<string, string>;
}

function iosScreenshotMappings(
  manifest: StoreAssetManifestInput,
  verifiedAssets: StoreAssetVerification[],
): IosScreenshotMapping[] {
  return [
    {
      displayType: requiredString(
        manifest.iphoneScreenshotDisplayType,
        'release_api_input_missing:iphoneScreenshotDisplayType',
      ),
      assets: verifiedAssets.filter((asset) => asset.kind === 'ios-iphone-screenshot'),
    },
    {
      displayType: requiredString(
        manifest.ipadScreenshotDisplayType,
        'release_api_input_missing:ipadScreenshotDisplayType',
      ),
      assets: verifiedAssets.filter((asset) => asset.kind === 'ios-ipad-screenshot'),
    },
  ];
}

async function resolveAscScreenshotSets(
  client: AscStoreAssetUploadClient,
  localizationId: string,
  displayTypes: string[],
): Promise<Map<string, string>> {
  const response = asRecord(await client.request(
    `/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}/appScreenshotSets`,
    {
      method: 'GET',
      scope: [`GET /v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`],
    },
  ));
  const resources = Array.isArray(response['data'])
    ? response['data'].map((resource) => parseAscResource(resource, 'asc_screenshot_set_invalid'))
    : [];
  const screenshotSetIds = new Map<string, string>();
  for (const resource of resources) {
    const displayType = resource.attributes['screenshotDisplayType'];
    if (typeof displayType === 'string' && !screenshotSetIds.has(displayType)) {
      screenshotSetIds.set(displayType, resource.id);
    }
  }
  for (const displayType of new Set(displayTypes)) {
    if (screenshotSetIds.has(displayType)) {
      continue;
    }
    const created = parseAscResource(await client.request('/v1/appScreenshotSets', {
      method: 'POST',
      body: {
        data: {
          type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: displayType },
          relationships: {
            appStoreVersionLocalization: {
              data: {
                id: localizationId,
                type: 'appStoreVersionLocalizations',
              },
            },
          },
        },
      },
      scope: ['POST /v1/appScreenshotSets'],
    }), 'asc_screenshot_set_create_invalid');
    screenshotSetIds.set(displayType, created.id);
  }
  return screenshotSetIds;
}

function parseUploadOperations(
  attributes: Record<string, unknown>,
  fileSize: number,
): AscUploadOperation[] {
  const rawOperations = attributes['uploadOperations'];
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    throw new Error('asc_screenshot_upload_operations_missing');
  }
  const operations = rawOperations.map((rawOperation) => {
    const operation = asRecord(rawOperation);
    const method = requiredString(operation['method'], 'asc_screenshot_upload_operation_invalid:method');
    if (method !== 'PUT') {
      throw new Error('asc_screenshot_upload_operation_invalid:method');
    }
    const url = requiredString(operation['url'], 'asc_screenshot_upload_operation_invalid:url');
    const offset = requiredInteger(operation['offset'], 'asc_screenshot_upload_operation_invalid:offset');
    const length = requiredInteger(operation['length'], 'asc_screenshot_upload_operation_invalid:length');
    const headers = parseUploadHeaders(operation['requestHeaders']);
    if (offset < 0 || length <= 0 || offset + length > fileSize) {
      throw new Error('asc_screenshot_upload_operation_invalid:range');
    }
    return { method, url, offset, length, headers };
  });
  let expectedOffset = 0;
  for (const operation of [...operations].sort((left, right) => left.offset - right.offset)) {
    if (operation.offset !== expectedOffset) {
      throw new Error('asc_screenshot_upload_operations_invalid:coverage');
    }
    expectedOffset += operation.length;
  }
  if (expectedOffset !== fileSize) {
    throw new Error('asc_screenshot_upload_operations_invalid:coverage');
  }
  return operations;
}

function parseUploadHeaders(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) {
    throw new Error('asc_screenshot_upload_operation_invalid:requestHeaders');
  }
  const headers: Record<string, string> = {};
  for (const rawHeader of value) {
    const header = asRecord(rawHeader);
    const name = requiredString(header['name'], 'asc_screenshot_upload_operation_invalid:headerName');
    headers[name] = requiredString(
      header['value'],
      'asc_screenshot_upload_operation_invalid:headerValue',
    );
  }
  return headers;
}

async function verifyAscScreenshot(
  client: AscStoreAssetUploadClient,
  screenshotId: string,
): Promise<unknown> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await client.request(
      `/v1/appScreenshots/${encodeURIComponent(screenshotId)}`,
      {
        method: 'GET',
        scope: [`GET /v1/appScreenshots/${screenshotId}`],
      },
    );
    const resource = parseAscResource(response, 'asc_screenshot_verification_invalid');
    const deliveryState = asRecord(resource.attributes['assetDeliveryState']);
    const state = deliveryState['state'];
    if (state === 'COMPLETE') {
      return response;
    }
    if (state === 'FAILED') {
      throw new Error(`asc_screenshot_processing_failed:${screenshotId}`);
    }
    if (attempt < 59) {
      await delay(2_000);
    }
  }
  throw new Error(`asc_screenshot_processing_timeout:${screenshotId}`);
}

function parseAscResource(value: unknown, reason: string): AscResource {
  const wrapper = asRecord(value);
  const data = 'data' in wrapper ? asRecord(wrapper['data']) : wrapper;
  const id = requiredString(data['id'], `${reason}:id`);
  return {
    id,
    attributes: asRecord(data['attributes']),
  };
}

async function verifyStoreAssets(
  checks: StoreAssetCheck[],
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<StoreAssetVerification[]> {
  const verified: StoreAssetVerification[] = [];
  for (const check of checks) {
    if (check.paths.length < check.minCount) {
      throw new Error(`store_asset_count_mismatch:${check.kind}:expected_at_least_${check.minCount}:got_${check.paths.length}`);
    }
    if (check.maxCount !== undefined && check.paths.length > check.maxCount) {
      throw new Error(`store_asset_count_mismatch:${check.kind}:expected_at_most_${check.maxCount}:got_${check.paths.length}`);
    }
    for (const assetPath of check.paths) {
      const bytes = await readFile(assetPath);
      const dimensions = readPngDimensions(bytes, assetPath);
      if (
        (check.width !== undefined && dimensions.width !== check.width) ||
        (check.height !== undefined && dimensions.height !== check.height) ||
        (check.dimension && !check.dimension(dimensions))
      ) {
        throw new Error(
          `store_asset_dimension_mismatch:${check.kind}:${assetPath}:expected_${expectedDimension(check)}:got_${dimensions.width}x${dimensions.height}`,
        );
      }
      verified.push({
        kind: check.kind,
        path: assetPath,
        width: dimensions.width,
        height: dimensions.height,
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  return verified;
}

function playScreenshotDimension(dimensions: { width: number; height: number }): boolean {
  const shortest = Math.min(dimensions.width, dimensions.height);
  const longest = Math.max(dimensions.width, dimensions.height);
  return shortest >= 320 && longest <= 3840 && longest / shortest <= 2;
}

const IOS_SCREENSHOT_DIMENSIONS: Record<string, ReadonlySet<string>> = {
  APP_IPHONE_67: new Set([
    '1260x2736',
    '1290x2796',
    '1320x2868',
    '1284x2778',
    '1242x2688',
  ]),
  APP_IPHONE_65: new Set(['1284x2778', '1242x2688']),
  APP_IPHONE_61: new Set([
    '1080x2340',
    '1125x2436',
    '1170x2532',
    '1179x2556',
    '1206x2622',
  ]),
  APP_IPHONE_55: new Set(['1242x2208']),
  APP_IPAD_PRO_3GEN_129: new Set(['2048x2732', '2064x2752']),
  APP_IPAD_PRO_129: new Set(['2048x2732']),
  APP_IPAD_PRO_3GEN_11: new Set(['1668x2388']),
};

function iosScreenshotDimension(
  displayType: string,
): (dimensions: { width: number; height: number }) => boolean {
  const allowed = IOS_SCREENSHOT_DIMENSIONS[displayType];
  if (!allowed) {
    throw new Error(`asc_screenshot_display_type_unsupported:${displayType}`);
  }
  return ({ width, height }) =>
    allowed.has(`${width}x${height}`) || allowed.has(`${height}x${width}`);
}

function expectedDimension(check: {
  width?: number;
  height?: number;
  dimension?: (dimensions: { width: number; height: number }) => boolean;
}): string {
  if (check.width !== undefined || check.height !== undefined) {
    return `${check.width ?? '*'}x${check.height ?? '*'}`;
  }
  if (check.dimension === playScreenshotDimension) {
    return 'play_screenshot_320_to_3840_max_2_to_1_ratio';
  }
  return 'valid_image_dimensions';
}

function readPngDimensions(bytes: Uint8Array, assetPath: string): { width: number; height: number } {
  const buffer = Buffer.from(bytes);
  if (
    buffer.length < 24 ||
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47 ||
    buffer.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error(`store_asset_not_png:${assetPath}`);
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function maybePath(value: string | undefined): string[] {
  return value ? [value] : [];
}

function playImageType(kind: StoreAssetKind): string | null {
  switch (kind) {
    case 'play-icon':
      return 'icon';
    case 'play-feature-graphic':
      return 'featureGraphic';
    case 'play-phone-screenshot':
      return 'phoneScreenshots';
    case 'play-7-inch-tablet-screenshot':
      return 'sevenInchScreenshots';
    case 'play-10-inch-tablet-screenshot':
      return 'tenInchScreenshots';
    default:
      return null;
  }
}

function requiredString(value: unknown, reason: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(reason);
  }
  return value;
}

function requiredInteger(value: unknown, reason: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(reason);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function fileName(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
