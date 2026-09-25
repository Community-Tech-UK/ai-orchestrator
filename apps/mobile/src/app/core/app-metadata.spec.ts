import capacitorConfig from '../../../capacitor.config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface MobilePackageJson {
  scripts?: Record<string, string>;
}

function readMobilePackageJson(): MobilePackageJson {
  return JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as MobilePackageJson;
}

function readProjectFile(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf8');
}

describe('mobile app metadata', () => {
  it('uses the harness display name for the native app shell', () => {
    expect(capacitorConfig.appName).toBe('harness');
  });

  it('keeps the tracked native project as the source of truth after Capacitor sync', () => {
    const packageJson = readMobilePackageJson();

    expect(packageJson.scripts?.sync).toBe(
      'npm run build && npx cap sync ios && npm run ios:ensure-brand-assets',
    );
    expect(packageJson.scripts?.['ios:ensure-brand-assets']).toBe(
      'node scripts/ensure-ios-brand-assets.mjs',
    );
    expect(packageJson.scripts?.['ios:ensure-display-name']).toBeUndefined();
    expect(packageJson.scripts?.['ios:ensure-scene-lifecycle']).toBeUndefined();
    expect(packageJson.scripts?.['ios:ensure-native-sources']).toBeUndefined();
  });

  it('tracks the iOS metadata and required permission descriptions', () => {
    const plist = readProjectFile('ios/App/App/Info.plist');
    const entitlements = readProjectFile('ios/App/App/App.entitlements');

    expect(plist).toContain('<key>CFBundleDisplayName</key>\n\t<string>harness</string>');
    expect(plist).toContain('<key>CFBundleIdentifier</key>\n\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>');
    for (const key of [
      'NSCameraUsageDescription',
      'NSPhotoLibraryUsageDescription',
      'NSMicrophoneUsageDescription',
      'NSSpeechRecognitionUsageDescription',
      'NSFaceIDUsageDescription',
      'UIApplicationSceneManifest',
    ]) {
      expect(plist).toContain(`<key>${key}</key>`);
    }
    expect(entitlements).toContain('<key>aps-environment</key>');
  });

  it('tracks a reusable iOS 16 widget target without a developer-team identifier', () => {
    const project = readProjectFile('ios/App/App.xcodeproj/project.pbxproj');
    const widgetPlist = readProjectFile('resources/native/HarnessWidgets/Info.plist');

    expect(project).toContain('HarnessWidgets.appex');
    expect(project).toContain('path = ../../resources/native/HarnessWidgets;');
    expect(project).toContain('INFOPLIST_FILE = ../../resources/native/HarnessWidgets/Info.plist;');
    expect(project).toContain('PRODUCT_NAME = "$(TARGET_NAME)";');
    expect(project).toContain('IPHONEOS_DEPLOYMENT_TARGET = 16.0;');
    expect(project).toContain('IPHONEOS_DEPLOYMENT_TARGET = 16.1;');
    expect(project).not.toMatch(/DEVELOPMENT_TEAM = [A-Z0-9]{10};/);
    expect(widgetPlist).toContain(
      '<key>CFBundleIdentifier</key>\n\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>',
    );
  });
});
