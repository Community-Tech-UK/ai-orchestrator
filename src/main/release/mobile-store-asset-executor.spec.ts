import { describe, expect, it } from 'vitest';
import { prepareAndVerifyIosStoreAssets } from './mobile-store-asset-executor';

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.set([0x89, 0x50, 0x4e, 0x47], 0);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('mobile store asset executor', () => {
  it('rejects iOS screenshots that do not match the declared display type', async () => {
    await expect(prepareAndVerifyIosStoreAssets({
      assets: {
        appStoreVersionLocalizationId: 'localization-1',
        iphoneScreenshotPaths: ['/assets/iphone.png'],
        iphoneScreenshotDisplayType: 'APP_IPHONE_67',
        ipadScreenshotPaths: ['/assets/ipad.png'],
        ipadScreenshotDisplayType: 'APP_IPAD_PRO_3GEN_129',
      },
      readFile: async (filePath) => filePath.includes('iphone')
        ? png(1080, 1920)
        : png(1200, 1920),
    })).rejects.toThrow('store_asset_dimension_mismatch:ios-iphone-screenshot');
  });

  it('accepts current required iPhone and iPad screenshot dimensions in either orientation', async () => {
    const verified = await prepareAndVerifyIosStoreAssets({
      assets: {
        appStoreVersionLocalizationId: 'localization-1',
        iphoneScreenshotPaths: ['/assets/iphone.png'],
        iphoneScreenshotDisplayType: 'APP_IPHONE_67',
        ipadScreenshotPaths: ['/assets/ipad.png'],
        ipadScreenshotDisplayType: 'APP_IPAD_PRO_3GEN_129',
      },
      readFile: async (filePath) => filePath.includes('iphone')
        ? png(2868, 1320)
        : png(2064, 2752),
    });

    expect(verified).toHaveLength(2);
  });

  it('rejects more screenshots than App Store Connect allows per display type', async () => {
    await expect(prepareAndVerifyIosStoreAssets({
      assets: {
        appStoreVersionLocalizationId: 'localization-1',
        iphoneScreenshotPaths: Array.from({ length: 11 }, (_, index) => `/assets/iphone-${index}.png`),
        iphoneScreenshotDisplayType: 'APP_IPHONE_67',
        ipadScreenshotPaths: ['/assets/ipad.png'],
        ipadScreenshotDisplayType: 'APP_IPAD_PRO_3GEN_129',
      },
      readFile: async (filePath) => filePath.includes('iphone')
        ? png(1290, 2796)
        : png(2048, 2732),
    })).rejects.toThrow(
      'store_asset_count_mismatch:ios-iphone-screenshot:expected_at_most_10:got_11',
    );
  });
});
