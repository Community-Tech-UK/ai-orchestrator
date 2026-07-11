/**
 * A self-contained mock procurement portal for DOM-level end-to-end tests of the
 * secret broker + action classifier. It deliberately mixes the field types a
 * real tender/supplier portal has:
 *  - a supplier BANK section (financial_identity: account no, sort code, IBAN, BIC)
 *  - an INSURANCE section (document upload + an expiry date + an ordinary Save)
 *  - a legal DECLARATION checkbox
 *  - a genuine CARD PAYMENT section (must stay hard-blocked)
 *
 * The IDs/labels here are the anchors the e2e spec drives; keep them stable.
 */
export const MOCK_PROCUREMENT_PORTAL_ORIGIN = 'https://portal.example.gov.uk';

export const MOCK_PROCUREMENT_PORTAL_HTML = `
<main>
  <section id="section-bank" data-section="bank">
    <h2>Supplier bank details</h2>
    <label for="account-number">Account number</label>
    <input id="account-number" name="accountNumber" type="text" />

    <label for="sort-code">Sort code</label>
    <input id="sort-code" name="sortCode" type="text" />

    <label for="iban">IBAN</label>
    <input id="iban" name="iban" type="text" />

    <label for="bic">BIC / SWIFT</label>
    <input id="bic" name="bic" type="text" />

    <button id="save-bank" type="button">Save bank details</button>
  </section>

  <section id="section-insurance" data-section="insurance">
    <h2>Insurance certificate</h2>
    <label for="insurance-file">Upload insurance certificate</label>
    <input id="insurance-file" name="insuranceFile" type="file" />

    <label for="insurance-expiry">Insurance certificate expiry date</label>
    <input id="insurance-expiry" name="insuranceExpiry" type="date" />

    <button id="save-insurance" type="button">Save</button>
  </section>

  <section id="section-declaration" data-section="declaration">
    <h2>Declaration</h2>
    <label for="declaration">
      I declare that the information provided is accurate to the best of my knowledge.
    </label>
    <input id="declaration" name="declaration" type="checkbox" />
  </section>

  <section id="section-payment" data-section="payment">
    <h2>Card payment</h2>
    <label for="card-number">Card number</label>
    <input id="card-number" name="cardNumber" type="text" />

    <label for="card-expiry">Card expiry</label>
    <input id="card-expiry" name="cardExpiry" type="text" />

    <label for="cvc">Security code (CVC)</label>
    <input id="cvc" name="cvc" type="text" />

    <button id="pay" type="button">Pay now</button>
  </section>
</main>
`;
