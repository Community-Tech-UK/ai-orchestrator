import type { BrowserPermissionGrant } from '@contracts/types/browser';

const ACTIONS: Readonly<Record<string, string>> = {
  'browser.click': 'Click on a page',
  'browser.type': 'Type into a page',
  'browser.fill_form': 'Fill in a form',
  'browser.select': 'Choose an option on a page',
  'browser.upload_file': 'Upload a file',
  'browser.download_file': 'Download a file',
  'browser.navigate': 'Open a page',
  'browser.find_or_open': 'Find or open a page',
  'browser.reload': 'Reload a page',
  'browser.close_tab': 'Close a tab',
  'browser.close_matching': 'Close matching tabs',
  'browser.snapshot': 'Read a page',
  'browser.screenshot': 'Capture a page screenshot',
  'browser.evaluate': 'Run a page action',
  'browser.request_user_login': 'Check a page login',
  'browser.request_credential_access': 'Use saved login details',
  'browser.pause_for_manual_step': 'Review a page manually',
  'browser.request_grant': 'Request browser access',
};

export const browserGrantLabels = {
  site(grant: Pick<BrowserPermissionGrant, 'allowedOrigins'>): string {
    const origin = grant.allowedOrigins[0];
    if (!origin) return 'All sites';
    return `${origin.includeSubdomains ? '*.' : ''}${origin.hostPattern}${origin.port ? ':' + origin.port : ''}`;
  },
  action(toolName: string): string {
    return Object.hasOwn(ACTIONS, toolName) ? ACTIONS[toolName] : 'Use a browser page';
  },
};
