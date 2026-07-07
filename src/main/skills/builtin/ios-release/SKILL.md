---
name: ios-release
description: API-first iOS App Store/TestFlight release workflow. Use when releasing, uploading, submitting, or preparing an iOS build for TestFlight or App Store Connect, including Capacitor apps, version bumps, altool upload, ASC API build processing, export compliance, TestFlight group attachment, metadata, screenshots, or submit-for-review steps.
triggers: ["/ios-release", "ios release", "testflight release", "app store release", "upload ipa", "asc api"]
category: release
---

# iOS Release Skill

Use this as the default path for iOS releases. Prefer CLI/API channels; use the browser only for account-level prompts, agreements, tax/banking, or Resolution Center issues.

## Inputs
- App path, brand slug, bundle id, target version/build, and intended destination: TestFlight internal, TestFlight external, or App Store submit.
- ASC API key id, issuer id, and `.p8` key location. Check project-local references first, then `/Users/suas/work/creds`. Never print secret values.
- Existing release notes, screenshots, compliance answers, tester group name, and whether review submission is allowed.

## Workflow
1. Read repo instructions and current app config before editing.
2. Confirm the iOS project shape. For current Capacitor apps, use the SPM/Xcode project path, not stale `.xcworkspace` runbooks.
3. Bump `CURRENT_PROJECT_VERSION` in every build configuration. Update `MARKETING_VERSION` only when the requested release version changes.
4. Run the project verification gates before archiving. Prefer the repo's typecheck/test commands, then the web build and Capacitor sync.
5. Archive with `xcodebuild -project <path>/App.xcodeproj -scheme App -configuration Release -archivePath <archive> archive`.
6. Export with an app-store-connect ExportOptions plist.
7. Upload with `xcrun altool --upload-app --apiKey <KEYID> --apiIssuer <ISSUER>` using the key at `~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8`.
8. Poll the ASC API until the uploaded build finishes processing. Do not claim success while processing is pending.
9. Set export compliance through the ASC API. For TLS-only apps, verify `usesNonExemptEncryption` is answered or `ITSAppUsesNonExemptEncryption=false` is in `Info.plist` for future builds.
10. Attach the latest processed build to the intended TestFlight internal group. Internal groups are often `allBuilds=false`, so explicitly attach every new build.
11. For App Store submit, update metadata/screenshots through the ASC API where available, then submit only when James explicitly approved review submission.
12. Verify install and smoke behavior: launch, home screen, sign-in, push registration, and deep links if relevant.

## Browser Fallback
- Use logged-in browser sessions only for agreements, tax/banking, account-holder verification, Resolution Center replies, or ASC pages with no stable public API.
- Capture screenshots before and after browser-only submissions.
- Use read-back verification after every browser save; stop on captcha, payment, account-holder identity, or legal declarations.

## Output
Return `done`, `stalled`, or `needs-permission` with the build number, upload/processing status, TestFlight group status, commands run, verification results, and remaining manual prompts.
