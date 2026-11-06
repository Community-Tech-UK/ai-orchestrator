/**
 * Main / packages / scripts / worker-agent / shared / preload Vitest setup.
 *
 * Loads zone.js (without Angular TestBed) so fire-and-forget async paths keep
 * the same microtask scheduling as the historical global setup. These projects
 * run in the `node` environment, so see test-setup-zone-flags.ts for the one
 * patch that has to stay off.
 *
 * Angular TestBed lives only in `test-setup.ts` for the renderer project.
 */

import './test-setup-zone-flags';
import 'zone.js';
import 'zone.js/testing';

import './test-setup-shared';
