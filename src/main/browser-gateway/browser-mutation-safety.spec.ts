import { describe, expect, it } from 'vitest';
import {
  HEAVY_DOM_COMMAND_TIMEOUT_MS,
  isHeavyDomBrowserCommand,
  isHeavyDomBrowserMethod,
  isMutatingBrowserCommand,
  isMutatingBrowserMethod,
} from './browser-mutation-safety';

describe('browser-mutation-safety', () => {
  it('classifies page-mutating commands as unsafe to blind-retry', () => {
    for (const command of [
      'click',
      'type',
      'fill_form',
      'select',
      'navigate',
      'upload_file',
      'download_file',
      'evaluate',
      'open_tab',
      'find_or_open',
    ]) {
      expect(isMutatingBrowserCommand(command)).toBe(true);
    }
  });

  it('classifies read-only commands as safe to retry', () => {
    for (const command of [
      'snapshot',
      'accessibility_snapshot',
      'query_elements',
      'read_control',
      'screenshot',
      'console_messages',
      'network_requests',
      'wait_for',
      'health',
      'list_targets',
      'get_audit_log',
    ]) {
      expect(isMutatingBrowserCommand(command)).toBe(false);
    }
  });

  it('matches namespaced method ids and is case-insensitive', () => {
    expect(isMutatingBrowserMethod('browser.click')).toBe(true);
    expect(isMutatingBrowserMethod('browser.snapshot')).toBe(false);
    expect(isMutatingBrowserMethod('BROWSER.CLICK')).toBe(true);
  });

  it('treats builder-style designer command names as mutating (defense-in-depth)', () => {
    for (const command of [
      'element_builder',
      'whtml_builder',
      'create_section',
      'insert_node',
      'add_class',
      'delete_element',
      'duplicate_block',
    ]) {
      expect(isMutatingBrowserCommand(command)).toBe(true);
    }
    // Bare reads that merely start with similar letters must not be caught.
    expect(isMutatingBrowserCommand('selector_probe')).toBe(false);
    expect(isMutatingBrowserCommand('snapshot')).toBe(false);
  });

  it('classifies DOM-scaling reads as heavy', () => {
    for (const command of [
      'snapshot',
      'accessibility_snapshot',
      'query_elements',
      'screenshot',
      'evaluate',
    ]) {
      expect(isHeavyDomBrowserCommand(command)).toBe(true);
    }
    expect(isHeavyDomBrowserMethod('browser.query_elements')).toBe(true);
    expect(isHeavyDomBrowserCommand('click')).toBe(false);
    expect(isHeavyDomBrowserCommand('navigate')).toBe(false);
  });

  it('exposes a heavy-op timeout above the 30s default', () => {
    expect(HEAVY_DOM_COMMAND_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});
