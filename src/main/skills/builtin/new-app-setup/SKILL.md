---
name: new-app-setup
description: Checkpointed browser workflow for first-time Apple App Store Connect and Google Play Console app setup. Use for creating new app records, Play Content rating, Data safety, app-content declarations, app access credentials, ASC app records, privacy nutrition labels, agreements/tax prompts, Resolution Center review replies, and console-only setup for a new white-label brand.
triggers: ["/new-app-setup", "new app setup", "play console setup", "app store connect setup", "play data safety form", "play content rating questionnaire", "privacy nutrition labels"]
category: release
---

# New App Setup Skill

Use this for console-only release work. It is browser-first, checkpointed, and approval-gated. Do not use it for recurring AAB/IPA uploads when API-first `/android-release` or `/ios-release` can do the job.

## Checkpoint Contract
Record a checkpoint after every successful save or page transition:
- `workflow`: app slug and console name.
- `stepId`: stable step name, for example `play-content-rating` or `asc-privacy-labels`.
- `url`: current page URL.
- `fingerprint`: visible page heading, selected app/package/bundle id, and saved-status text.
- `verified`: selectors or page text read back after save.
- `completedAt`: timestamp.

On resume, reacquire the tab/profile, run `browser.check_session`, verify each completed checkpoint from the live page, then continue from the first unverified step. Never redo a submitted step unless read-back proves it is incomplete.

## Browser Runtime Rules
1. Run `browser_health` or equivalent target refresh before starting a long console session.
2. For an approved unattended run, call `browser.claim_campaign_lease` and stay within the campaign's origins, action classes, and budget.
3. Use `browser.check_session` before each console section and after any navigation that might hit a login wall.
4. Use verified mutations: every fill, select, click, and upload needs read-back or screenshot verification.
5. Use `browser.raise_escalation` for captcha, 2FA, identity checks, payment/tax/banking, policy/legal ambiguity, rejected saves, or pages that cannot be verified.

## Google Play Setup
1. Create the app record in Play Console. There is no public androidpublisher create-app endpoint.
2. Complete App content declarations: target audience, ads, app access credentials, news, financial features, health, government, advertising ID, sensitive permissions, VPN, exact alarms, accessibility/all-files where applicable.
3. Complete Content rating. Verify the rating summary after save.
4. Complete Data safety. Build rows from an exported current Play template, call
   `generate_play_data_safety_csv`, save the returned CSV locally, then import it
   through the console UI and verify every saved summary page. Never invent
   machine-readable question or response ids; they must come from Google's
   current exported template.
5. Configure tester list and internal testing only after the app record and required declarations are coherent.
6. For interrupted AAB browser uploads, check the artifact library and use `Add from library` before re-uploading.

## App Store Connect Setup
1. Create the app record through the logged-in ASC browser session when the public API path is unavailable or 2FA/private API fragility makes browser safer.
2. Complete privacy nutrition labels with read-back verification on each data category.
3. Surface agreements, tax, banking, account-holder verification, and legal prompts to James. Do not auto-answer them.
4. For Resolution Center or policy appeals, extract rejection details into the session, then draft the fix or reply for James to approve.

## Output
Return `done`, `stalled`, or `needs-permission` with the checkpoint list, verified sections, screenshots or page evidence, active campaign/grant status, and the exact console prompts still requiring James.
