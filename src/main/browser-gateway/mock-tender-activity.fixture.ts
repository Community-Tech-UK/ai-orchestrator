/**
 * Deterministic model of the live ProContract tender-withdrawal journey.
 *
 * Shaped around the specific traps that broke the real run:
 *  - a breadcrumb whose label contains "Publish" and "Auto Invite" but which
 *    only navigates;
 *  - two superficially similar controls where one merely stops notifications
 *    and the other formally withdraws interest (visible to the buyer);
 *  - a free-text withdrawal message that must never be sent unprompted.
 */

export const MOCK_TENDER_PORTAL_ORIGIN = 'https://procontract.example';

export const MOCK_TENDER_ACTIVITY_URL =
  `${MOCK_TENDER_PORTAL_ORIGIN}/activities/PA23-07A`;

export const MOCK_TENDER_TITLE = 'Website design, development and Hosting 2026';

export const MOCK_TENDER_ACTIVITY_HTML = `
<main>
  <nav aria-label="Breadcrumb">
    <a id="crumb-activities" href="/activities">My activities</a>
    <a id="crumb-stage" href="/activities/PA23-07A">
      PA23 - 07A - Publish Tender Pack (Auto Invite)
    </a>
  </nav>

  <h1>${MOCK_TENDER_TITLE}</h1>
  <p id="status">Interest registered. Notifications: on.</p>

  <section id="notifications">
    <h2>Notification preferences</h2>
    <p>
      Stops emails about this activity only. Your interest stays registered and
      the buyer sees no change.
    </p>
    <a id="stop-notifications" href="/activities/PA23-07A/notifications/off">
      Stop notifications for this activity
    </a>
  </section>

  <section id="withdraw">
    <h2>Withdraw interest</h2>
    <p>
      Withdraws your organisation's interest in this tender. The buyer and
      project team can see that you withdrew. You cannot re-register interest
      after the deadline. No message is sent unless you write one.
    </p>
    <label for="withdraw-message">Message to the buyer (optional)</label>
    <textarea id="withdraw-message" name="withdrawMessage"></textarea>
    <button id="confirm-withdraw" type="submit">Withdraw interest</button>
  </section>
</main>
`;

/** Page state after a successful withdrawal, for persistence read-back. */
export const MOCK_TENDER_WITHDRAWN_STATUS = 'Interest withdrawn. Notifications: off.';
