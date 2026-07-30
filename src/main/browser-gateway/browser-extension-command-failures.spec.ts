import { describe, expect, it } from 'vitest';
import {
  cdpTimeoutStep,
  isDeliveredCommandTimeout,
  isMissingExtensionTabError,
  mutationTimeoutError,
  notDeliveredError,
  readTimeoutError,
  receiptMissingError,
} from './browser-extension-command-failures';

describe('browser-extension-command-failures', () => {
  it('classifies every delivered-but-unanswered timeout, including named CDP hops', () => {
    expect(isDeliveredCommandTimeout('browser_extension_command_timeout')).toBe(true);
    expect(isDeliveredCommandTimeout(
      'browser_extension_command_timeout (channel active - command not answered; node n1)',
    )).toBe(true);
    expect(isDeliveredCommandTimeout(
      'browser_extension_cdp_timeout:Accessibility.getFullAXTree after 48000ms',
    )).toBe(true);
    expect(isDeliveredCommandTimeout('browser_extension_channel_down (node n1: silent)')).toBe(true);

    // Not delivered / never acked have their own guarantees and wording.
    expect(isDeliveredCommandTimeout('browser_extension_command_not_delivered')).toBe(false);
    expect(isDeliveredCommandTimeout('browser_extension_command_receipt_missing')).toBe(false);
    expect(isDeliveredCommandTimeout('No tab with id: 42')).toBe(false);
  });

  it('extracts the stalled CDP step when the extension names one', () => {
    expect(cdpTimeoutStep('browser_extension_cdp_timeout:attach after 10000ms')).toBe('attach');
    expect(cdpTimeoutStep(
      'browser_extension_cdp_timeout:Accessibility.getFullAXTree after 48000ms',
    )).toBe('Accessibility.getFullAXTree');
    expect(cdpTimeoutStep('browser_extension_command_timeout')).toBeUndefined();
  });

  it('detects a stale tab id so the attachment can be dropped', () => {
    expect(isMissingExtensionTabError('No tab with id: 42')).toBe(true);
    expect(isMissingExtensionTabError('no tab with id 42.')).toBe(true);
    expect(isMissingExtensionTabError('browser_extension_command_timeout')).toBe(false);
  });

  it('tells an agent a read timeout is not a permission problem', () => {
    const error = readTimeoutError(
      'browser_extension_cdp_timeout:Accessibility.getFullAXTree after 48000ms',
      'accessibility_snapshot',
      'node n1: extension last contacted 2s ago',
    );

    expect(error.message).toContain('browser_extension_cdp_timeout:Accessibility.getFullAXTree');
    expect(error.message).toContain('node n1');
    expect(error.message).toContain('NOT a permission problem');
    expect(error.message).toContain('do not call browser.request_grant');
  });

  it('keeps the run/did-not-run guarantee distinct for delivery failures', () => {
    expect(notDeliveredError('node n1').message).toContain('did NOT run — safe to retry');
    expect(receiptMissingError('node n1').message)
      .toContain('verify page state before retrying a mutation');
  });

  it('appends the post-timeout probe verdict for mutations', () => {
    expect(mutationTimeoutError('browser_extension_command_timeout', 'timed_out_applied').message)
      .toBe('browser_extension_command_timeout_timed_out_applied');
    expect(mutationTimeoutError(
      'browser_extension_cdp_timeout:attach after 10000ms',
      'timed_out_not_applied',
    ).message).toBe(
      'browser_extension_cdp_timeout:attach after 10000ms; '
      + 'post-timeout mutation probe: timed_out_not_applied',
    );
  });
});
