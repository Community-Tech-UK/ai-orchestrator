import { describe, expect, it } from 'vitest';
import { resolveEmailSenderDomains } from './browser-form-fill-operations';

const ORIGIN = 'https://portal.in-tendhost.co.uk';

describe('resolveEmailSenderDomains', () => {
  it('defaults to the origin host when no domains are requested', () => {
    expect(resolveEmailSenderDomains(ORIGIN, undefined)).toEqual(['portal.in-tendhost.co.uk']);
    expect(resolveEmailSenderDomains(ORIGIN, [])).toEqual(['portal.in-tendhost.co.uk']);
  });

  it('accepts the exact host, subdomains, the registrable domain, and siblings', () => {
    expect(resolveEmailSenderDomains(ORIGIN, ['portal.in-tendhost.co.uk'])).toBeTruthy();
    expect(resolveEmailSenderDomains(ORIGIN, ['mail.portal.in-tendhost.co.uk'])).toBeTruthy();
    // Registrable parent domain — the common noreply@ sender case.
    expect(resolveEmailSenderDomains(ORIGIN, ['in-tendhost.co.uk'])).toBeTruthy();
    // Sibling subdomain under the same registrable domain.
    expect(resolveEmailSenderDomains(ORIGIN, ['mailer.in-tendhost.co.uk'])).toBeTruthy();
  });

  it('rejects public suffixes — an eTLD is never "related"', () => {
    expect(resolveEmailSenderDomains(ORIGIN, ['co.uk'])).toBeNull();
    expect(resolveEmailSenderDomains(ORIGIN, ['uk'])).toBeNull();
    expect(resolveEmailSenderDomains('https://foo.github.io', ['github.io'])).toBeNull();
  });

  it('rejects unrelated domains outright', () => {
    expect(resolveEmailSenderDomains(ORIGIN, ['some-bank.com'])).toBeNull();
    expect(resolveEmailSenderDomains(ORIGIN, ['tendhost.co.uk'])).toBeNull();
    // One bad domain poisons the whole request.
    expect(resolveEmailSenderDomains(ORIGIN, ['in-tendhost.co.uk', 'evil.com'])).toBeNull();
  });

  it('fails closed to exact/subdomain matches for hosts with no registrable domain', () => {
    expect(resolveEmailSenderDomains('http://localhost:4567', ['localhost'])).toBeTruthy();
    expect(resolveEmailSenderDomains('http://localhost:4567', ['example.com'])).toBeNull();
  });

  it('normalizes case and whitespace', () => {
    expect(resolveEmailSenderDomains(ORIGIN, ['  In-TendHost.CO.UK '])).toEqual([
      'in-tendhost.co.uk',
    ]);
  });

  describe('authorization-declared senders (shared notification platforms)', () => {
    // GOV.UK services send their one-time codes through Notify, whose
    // registrable domain (service.gov.uk) differs from the service's own
    // (gca.gov.uk). Without an explicit allowance every such login is unusable.
    const GOV_ORIGIN = 'https://auth.reportmi.gca.gov.uk';
    const NOTIFY = 'notifications.service.gov.uk';

    it('rejects the unrelated sender when no authorization declares it', () => {
      expect(resolveEmailSenderDomains(GOV_ORIGIN, [NOTIFY])).toBeNull();
    });

    it('accepts it when the live authorization declares it', () => {
      expect(resolveEmailSenderDomains(GOV_ORIGIN, [NOTIFY], [NOTIFY])).toEqual([NOTIFY]);
    });

    it('includes declared senders alongside the origin host by default', () => {
      expect(resolveEmailSenderDomains(GOV_ORIGIN, undefined, [NOTIFY])).toEqual([
        'auth.reportmi.gca.gov.uk',
        NOTIFY,
      ]);
    });

    it('does not duplicate a declared sender that is the origin host', () => {
      expect(
        resolveEmailSenderDomains(GOV_ORIGIN, undefined, ['auth.reportmi.gca.gov.uk']),
      ).toEqual(['auth.reportmi.gca.gov.uk']);
    });

    it('still rejects any sender the authorization did not declare', () => {
      expect(resolveEmailSenderDomains(GOV_ORIGIN, ['evil.example'], [NOTIFY])).toBeNull();
      // One undeclared domain poisons the request even beside a declared one.
      expect(
        resolveEmailSenderDomains(GOV_ORIGIN, [NOTIFY, 'evil.example'], [NOTIFY]),
      ).toBeNull();
    });

    it('normalizes declared senders for case and whitespace', () => {
      expect(
        resolveEmailSenderDomains(GOV_ORIGIN, ['NOTIFICATIONS.Service.GOV.UK'], ['  notifications.service.gov.uk ']),
      ).toEqual([NOTIFY]);
    });

    it('ignores an empty declaration list', () => {
      expect(resolveEmailSenderDomains(GOV_ORIGIN, [NOTIFY], [])).toBeNull();
      expect(resolveEmailSenderDomains(GOV_ORIGIN, [NOTIFY], ['   '])).toBeNull();
    });
  });

  it('returns null for an unparseable origin', () => {
    expect(resolveEmailSenderDomains('not a url', ['example.com'])).toBeNull();
  });
});
