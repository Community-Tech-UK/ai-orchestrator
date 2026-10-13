import { describe, expect, it } from 'vitest';
import { assertRunOnNodeUsesWorkerBrowserSurface } from './run-on-node-support';

const STARTUP_PROMPT = 'Inspect existing startup entries and create a chrome.exe Startup shortcut.';

describe('run_on_node startup safety sentence boundaries', () => {
  it.each([
    'Leave running browsers and tabs untouched; then inspect them.',
    'Do not touch tabs; then read them.',
    'Without touching tabs; then inspect them.',
    'Leave running browsers and tabs untouched. Then inspect them.',
    'Do not touch tabs. Read their titles.',
    'Without touching tabs. Then inspect them.',
  ])('retains browser intent in a continuation: %s', (continuation) => {
    expect(() => assertRunOnNodeUsesWorkerBrowserSurface({
      node: 'windows-pc',
      prompt: `${STARTUP_PROMPT} ${continuation}`,
    })).toThrow(/stay on the coordinator/i);
  });

  it.each([
    'Leave running browsers and tabs untouched.',
    'Do not touch tabs.',
    'Without touching tabs.',
    'Leave running browsers and tabs untouched',
    'Leave running browsers and tabs untouched. Then read the shortcut TargetPath.',
    'Do not touch tabs. Read the registry values.',
  ])('allows a finished safety sentence: %s', (safety) => {
    expect(() => assertRunOnNodeUsesWorkerBrowserSurface({
      node: 'windows-pc',
      prompt: `${STARTUP_PROMPT} ${safety}`,
    })).not.toThrow();
  });

  it.each([
    'Do not leave running browsers and tabs untouched.',
    'Never leave running browsers and tabs untouched.',
    'Leave running browsers and tabs untouched, then inspect them.',
    'Leave running browsers and tabs untouched and then inspect them.',
    'Leave running browsers and tabs untouched. Read the shared Chrome tab.',
  ])('retains negated safety and explicit shared-tab access: %s', (continuation) => {
    expect(() => assertRunOnNodeUsesWorkerBrowserSurface({
      node: 'windows-pc',
      prompt: `${STARTUP_PROMPT} ${continuation}`,
    })).toThrow(/stay on the coordinator/i);
  });
});
