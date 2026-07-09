/**
 * Main / packages / scripts / worker-agent / shared / preload Vitest setup.
 *
 * Loads zone.js (without Angular TestBed) so fire-and-forget async paths keep
 * the same microtask scheduling as the historical global setup, and so
 * Worker/MessagePort-backed specs (plugin workers) stay reliable under jsdom.
 *
 * Angular TestBed lives only in `test-setup.ts` for the renderer project.
 */

import 'zone.js';
import 'zone.js/testing';

import './test-setup-shared';
