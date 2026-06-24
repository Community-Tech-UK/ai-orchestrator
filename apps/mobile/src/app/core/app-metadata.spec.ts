import capacitorConfig from '../../../capacitor.config';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withHarnessIosDisplayName } from '../../../scripts/ensure-ios-display-name.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface MobilePackageJson {
  scripts?: Record<string, string>;
}

function readMobilePackageJson(): MobilePackageJson {
  return JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as MobilePackageJson;
}

describe('mobile app metadata', () => {
  it('uses the harness display name for the native app shell', () => {
    expect(capacitorConfig.appName).toBe('harness');
  });

  it('patches ignored iOS project metadata after Capacitor sync', () => {
    const packageJson = readMobilePackageJson();

    expect(packageJson.scripts?.['ios:ensure-display-name']).toBe('node scripts/ensure-ios-display-name.mjs');
    expect(packageJson.scripts?.sync).toContain('npx cap sync ios && npm run ios:ensure-display-name');
    expect(existsSync(resolve(projectRoot, 'scripts/ensure-ios-display-name.mjs'))).toBe(true);
  });

  it('rewrites iOS display metadata without changing the bundle identifier', () => {
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<dict>',
      '\t<key>CFBundleDisplayName</key>',
      '\t<string>AI Orchestrator</string>',
      '\t<key>CFBundleIdentifier</key>',
      '\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>',
      '\t<key>CFBundleName</key>',
      '\t<string>$(PRODUCT_NAME)</string>',
      '\t<key>NSFaceIDUsageDescription</key>',
      '\t<string>AI Orchestrator uses Face ID.</string>',
      '</dict>',
      '</plist>',
    ].join('\n');

    const updated = withHarnessIosDisplayName(plist);

    expect(updated).toContain('<key>CFBundleDisplayName</key>\n\t<string>harness</string>');
    expect(updated).toContain('<key>CFBundleName</key>\n\t<string>harness</string>');
    expect(updated).toContain('<key>CFBundleIdentifier</key>\n\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>');
    expect(updated).toContain('<string>harness uses Face ID to unlock the app and protect your agent sessions.</string>');
  });
});
