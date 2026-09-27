# GitHub Actions remediation: production live checks

**Status — completed by consolidation 2026-09-27:** Open: 0 · Transferred: 1 campaign · Failed: 0.

All three checks require current external production events, account-administrator inspection or
human alert acknowledgement. They now form one bounded campaign in
[RES-019](../../plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-019--mytrademail-production-sentry-alert-and-firebase-iam-campaign).
Do not rerun historical workflow `30717081873`; it targets an old SHA. This source document follows
[the implementation plan](2026-08-03-github-actions-remediation_plan_completed.md) and is closed.

The 2026-09-23 production deploy passed, the three deployed DSNs map to their separate Community Tech Sentry projects, and the dedicated SBE FCM sender account and installed key match the SBE Firebase project. The checks below require live external events or account-level inspection and are not claims of verification.

## Transferred check 1: Sentry production event routing and tags

1. In a controlled production window, send one synthetic, non-sensitive error through each deployed surface: backend, MyTradeMail frontend, and Simple Business Email frontend. Use the app's normal Sentry reporting path; avoid user or payment data in the event.
2. In Community Tech's EU Sentry organization, open each resulting event and record its project, `environment`, `release`, and frontend tags where applicable.

Expected: each event appears only in its corresponding project (`mytrademail-backend`, `mytrademail-frontend`, or `simplebusinessemail-frontend`), marked production, with the deployed release and the expected frontend tags. Record event IDs and observed tags here; do not copy DSNs or tokens.

**Why deferred:** This needs live external Sentry ingestion from the deployed apps; repository tests and the read-only account inspection cannot prove delivery or event enrichment.

## Transferred check 2: Alert delivery and acknowledgement

1. Trigger safe synthetic backend payment and provisioning error events that match the two enabled rules, and a safe new or regressed issue that matches the enabled global rule. Confirm the three project high-priority rules remain enabled.
2. Verify notification arrival to the intended owner and record its timestamps. Have the owner acknowledge the alerts and compare elapsed times with the production runbook's 15-minute critical and 30-minute high-priority response targets.

Expected: matching rules fire once per intended event, notifications reach the owner, and acknowledgement meets the applicable target. Record alert/event IDs and timestamps here without notification secrets or customer data.

**Why deferred:** A configured rule does not prove external notification delivery or a person's acknowledgement; this check needs live events and human response.

## Transferred check 3: Firebase inherited IAM scope

1. In Google Cloud IAM for the My Trade Mail Firebase project, inspect the dedicated `MyTradeMail FCM sender` service account's effective permissions, including organization and folder inherited grants. Do not create or rotate a key as part of this read-only check.
2. Compare effective grants with the FCM send role required by the deployment runbook.

Expected: the sender has only the permissions needed to send FCM messages. The 2026-09-23 project view showed one direct grant, `Firebase Cloud Messaging API admin`, and no direct Editor or Owner grant; record any inherited grants and the effective conclusion here.

**Why deferred:** The project-level Firebase page does not enumerate organization or folder inheritance; an account administrator must inspect effective IAM in the external console.
