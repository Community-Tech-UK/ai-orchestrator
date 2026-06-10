import { describe, it, expect } from 'vitest';
import { detectAndroidIntent } from '../android-intent';

describe('detectAndroidIntent', () => {
  it('returns true for Android device and emulator keywords', () => {
    expect(detectAndroidIntent('install the APK and test it on Android')).toBe(true);
    expect(detectAndroidIntent('run the Maestro login flow on an emulator')).toBe(true);
    expect(detectAndroidIntent('use adb to take a screenshot')).toBe(true);
    expect(detectAndroidIntent('open the app in an AVD')).toBe(true);
    expect(detectAndroidIntent('run Appium against the mobile build')).toBe(true);
  });

  it('returns false for unrelated prompts', () => {
    expect(detectAndroidIntent('fix the TypeScript compilation error')).toBe(false);
    expect(detectAndroidIntent('open the website in Chrome')).toBe(false);
    expect(detectAndroidIntent('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(detectAndroidIntent('RUN ADB DEVICES')).toBe(true);
    expect(detectAndroidIntent('Test the APK on ANDROID')).toBe(true);
  });
});
