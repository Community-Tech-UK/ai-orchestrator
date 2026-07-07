---
name: android-release
description: API-first Android Google Play release workflow. Use when releasing, uploading, staging, or preparing an Android build for Play Console, including Capacitor apps, versionCode bumps, signed AAB creation, Play Developer Publishing API uploads, tracks, rollout, listings, store images, tester lists, and Play-console browser fallback flows.
triggers: ["/android-release", "android release", "play release", "google play release", "upload aab", "play api"]
category: release
---

# Android Release Skill

Use this as the default path for Android releases. Prefer the Play Developer Publishing API for build, listing, image, and track updates; use the browser for console-only declarations.

## Inputs
- App path, brand slug, package name, target `versionCode`/`versionName`, destination track, rollout percent, tester list, and whether production rollout is allowed.
- Play service-account JSON location. Check project-local references first, then `/Users/suas/work/creds`. Never print secret values.
- Upload keystore property path, screenshots/assets, store listing copy, data-safety CSV, and app-access review credentials if needed.

## Workflow
1. Read repo instructions and current Android config before editing.
2. Bump `versionCode` every upload and update `versionName` when requested. Stores reject duplicate or lower version codes.
3. Verify signing prerequisites before building:
   - `keys/<slug>-upload.keystore.properties` exists and points to the same upload keystore used by prior releases.
   - `android-<slug>/local.properties` has `sdk.dir=...` when `ANDROID_HOME` is unset.
4. Run the repo's verification gates before packaging. Then build with Gradle, normally `bundleRelease`, to produce the signed AAB.
5. Use the Play Developer Publishing API to create an edit, upload the AAB, update the target track, assign tester lists, set rollout, and commit the edit.
6. Use the Play API for listings, store images, and release notes where available. Required listing assets include app icon 512, feature graphic 1024x500, phone screenshots, and 7 inch/10 inch tablet screenshots.
7. Use browser-only flow, preferably `/new-app-setup`, for Content rating, Data safety, app access, target audience, ads, financial/health/government declarations, and other console-only forms.
8. If a console AAB upload fails or is interrupted, check the artifact library and use `Add from library` before re-uploading. Reload the draft to clear stale dropzone clutter.
9. After first AAB upload, capture the Play App Signing SHA-256 for `assetlinks.json` alongside upload-key and debug SHAs.
10. Verify install and smoke behavior: launch, home screen, Google/Apple sign-in if present, push registration, and deep links.

## Browser Fallback
- Use the browser only for console-only declarations, app creation, policy appeals, or reviewer credentials.
- Use read-back verification after every save and capture screenshots around risky steps.
- Stop before payment, identity, legal/account-owner, or destructive controls and ask James.

## Output
Return `done`, `stalled`, or `needs-permission` with package name, versionCode, AAB path, Play edit/track status, tester status, asset/listing status, verification results, and remaining manual console prompts.
