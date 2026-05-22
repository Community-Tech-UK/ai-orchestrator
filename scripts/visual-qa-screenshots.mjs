#!/usr/bin/env node
/**
 * Visual QA screenshot capture (copilot_todo.md item 18).
 *
 * Captures the app window in both dark and light themes so shell/settings
 * changes can be diffed against a baseline. By default it captures the
 * currently visible route; pass --all to visit the standard shell/settings
 * routes before capturing.
 *
 * Usage:
 *   1. Launch the app with the DevTools protocol exposed:
 *        npm run dev -- --remote-debugging-port=9222
 *      (or launch a packaged build with the same flag)
 *   2. Navigate to the screen you want to capture.
 *   3. Run:  node scripts/visual-qa-screenshots.mjs <label>
 *      Or:   node scripts/visual-qa-screenshots.mjs --all
 *
 * Screenshots are written to ./visual-qa/<label>-<theme>.png
 * Override the endpoint with VISUAL_QA_DEBUG_URL.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const DEBUG_URL = process.env.VISUAL_QA_DEBUG_URL ?? 'http://localhost:9222';
const OUT_DIR = join(process.cwd(), 'visual-qa');
const THEMES = ['dark', 'light'];
const SETTLE_MS = 350;
const ROUTE_SETTLE_MS = 650;
const ROUTES = [
  { label: 'dashboard', path: '/' },
  { label: 'settings-display', path: '/settings#display' },
  { label: 'settings-remote-nodes', path: '/settings#remote-nodes' },
  { label: 'settings-doctor', path: '/settings#doctor' },
  { label: 'setup', path: '/setup' },
];

async function main() {
  const args = process.argv.slice(2);
  const captureRoutes = args.includes('--all') || args.includes('--routes');
  const routeArg = args.find((arg) => arg.startsWith('--route='));
  const labelArg = args.find((arg) => !arg.startsWith('--'));
  const label = sanitizeLabel(labelArg ?? 'screen');
  await mkdir(OUT_DIR, { recursive: true });

  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: DEBUG_URL, defaultViewport: null });
  } catch (err) {
    console.error(`Could not connect to ${DEBUG_URL}.`);
    console.error('Launch the app with the debugging port first, e.g.:');
    console.error('  npm run dev -- --remote-debugging-port=9222');
    console.error(String(err?.message ?? err));
    process.exit(1);
  }

  const pages = await browser.pages();
  const page = pages.find((p) => !p.url().startsWith('devtools://'));
  if (!page) {
    console.error('No app window found on the debugging endpoint.');
    await browser.disconnect();
    process.exit(1);
  }

  const originalState = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
  }));

  const targets = captureRoutes
    ? ROUTES
    : routeArg
      ? [{ label, path: routeArg.slice('--route='.length) }]
      : [{ label, path: null }];

  for (const target of targets) {
    if (target.path) {
      await navigateToRoute(page, target.path);
    }
    await captureThemes(page, target.label);
  }

  // Restore whatever route and theme the operator was using.
  if (originalState.path) {
    await navigateToRoute(page, originalState.path);
  }
  await page.evaluate((value) => {
    if (value) {
      document.documentElement.setAttribute('data-theme', value);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, originalState.theme);

  await browser.disconnect();
  console.log(`Done — screenshots written to ${OUT_DIR}`);
}

function sanitizeLabel(value) {
  return value.replace(/[^a-z0-9._-]/gi, '-');
}

async function navigateToRoute(page, path) {
  await page.evaluate((target) => {
    window.history.pushState(null, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await new Promise((resolve) => setTimeout(resolve, ROUTE_SETTLE_MS));
}

async function captureThemes(page, label) {
  for (const theme of THEMES) {
    await page.evaluate((value) => {
      document.documentElement.setAttribute('data-theme', value);
    }, theme);
    // Let theme-dependent styles settle before capturing.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const file = join(OUT_DIR, `${sanitizeLabel(label)}-${theme}.png`);
    await page.screenshot({ path: file });
    console.log(`captured ${file}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
