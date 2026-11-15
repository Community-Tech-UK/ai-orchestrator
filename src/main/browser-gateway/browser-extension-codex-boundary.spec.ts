import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractFunctionSource } from './browser-extension-function-source.testutil';

const source = readFileSync('resources/browser-extension/background.js', 'utf8');
describe('Codex extension native result boundary', () => {
  it('preserves only exact internally verified document metadata on a tainted origin', () => {
    const sanitize = new Function(`const extensionInstanceId='test-install'; const SW_STARTED_AT=1000;
      ${extractFunctionSource(source, 'sanitizeCodexDeviceResult')}; return sanitizeCodexDeviceResult;`)();
    const context = { documentId: 'test-document', extensionInstanceId: 'test-install', extensionGeneration: '1000', identityMatches: true };
    expect(sanitize({ command: 'codex_device_context' }, context)).toEqual(context);
    expect(() => sanitize({ command: 'codex_device_context' }, { ...context, value: 'TEST_ONLY_PRIVATE' })).toThrow('codex_device_handoff_refused');
    expect(() => sanitize({ command: 'codex_device_fill' }, { completed: true, valueApplied: true })).toThrow('codex_device_handoff_refused');
    expect(() => sanitize({ command: 'codex_device_context' }, { ...context, extensionGeneration: '1001' })).toThrow('codex_device_handoff_refused');
  });

  it('never serializes page or Chrome error text for any internal Codex command', () => {
    const message = new Function(`const secretObservationGuardErrors=new WeakSet(); const dialogErrorMessages=new WeakMap();
      ${extractFunctionSource(source, 'browserCommandErrorMessage')}; return browserCommandErrorMessage;`)();
    for (const command of ['codex_device_context', 'codex_device_attest', 'codex_device_fill', 'codex_device_submit', 'codex_device_cancel']) {
      expect(message({ command }, new Error('TEST_ONLY_PRIVATE'))).toBe('codex_device_handoff_refused');
    }
  });
});
