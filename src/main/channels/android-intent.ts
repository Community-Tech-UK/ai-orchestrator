const ANDROID_KEYWORDS = [
  'android',
  'apk',
  'aab',
  'adb',
  'emulator',
  'avd',
  'maestro',
  'espresso',
  'uiautomator',
  'ui automator',
  'appium',
  'mobile-mcp',
  'mobile test',
  'test on phone',
  'phone screenshot',
  'take a screenshot of the app',
  'install the app',
  'launch the app',
];

/**
 * Heuristic: does this message content imply Android device/emulator work?
 * Used by the channel message router to set `nodePlacement.requiresAndroid`.
 */
export function detectAndroidIntent(content: string): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  return ANDROID_KEYWORDS.some((keyword) => lower.includes(keyword));
}

