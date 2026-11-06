import { describe, expect, it } from 'vitest';
import type { BrowserApprovalRequest, BrowserGrantProposal } from '@contracts/types/browser';

import { PERMISSION_SCOPE_WORDS } from '../../../../shared/permissions/permission-scope-presentation';
import {
  browserApprovalFailureText,
  presentBrowserApproval,
  type BrowserApprovalContext,
} from './browser-approval-request.rules';

const computers: Record<string, { name?: string; platform?: string }> = {
  'node-win': { name: 'Windows PC', platform: 'win32' },
  'node-unnamed': { platform: 'win32' },
};

const ctx: BrowserApprovalContext = {
  node: (id) => computers[id],
  localPlatform: 'darwin',
  formatTime: (timestamp) => `at ${timestamp}`,
};

const shop = { scheme: 'https', hostPattern: 'shop.example.com', includeSubdomains: false } as const;

function grant(overrides: Partial<BrowserGrantProposal> = {}): BrowserGrantProposal {
  return {
    mode: 'per_action',
    allowedOrigins: [shop],
    allowedActionClasses: ['submit'],
    allowExternalNavigation: false,
    autonomous: false,
    ...overrides,
  };
}

function makeApproval(overrides: Partial<BrowserApprovalRequest> = {}): BrowserApprovalRequest {
  return {
    id: 'request-1',
    requestId: 'request-1',
    instanceId: 'instance-1',
    provider: 'claude',
    profileId: 'existing-tab:n.node-win:1:2',
    targetId: 'existing-tab:n.node-win:1:2:target',
    computerId: 'node-win',
    toolName: 'browser.click',
    action: 'click',
    actionClass: 'submit',
    origin: 'https://shop.example.com',
    url: 'https://shop.example.com/checkout',
    selector: 'button#place-order',
    elementContext: { accessibleName: 'Submit order', role: 'button' },
    proposedGrant: grant(),
    status: 'pending',
    createdAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  };
}

function savedLogin(overrides: Partial<NonNullable<BrowserApprovalRequest['credentialAccess']>> = {}): BrowserApprovalRequest {
  return makeApproval({
    toolName: 'browser.request_credential_access',
    action: 'request_credential_access',
    actionClass: 'credential',
    origin: 'https://login.example.com',
    credentialAccess: {
      taskScope: 'conversation:placeholder-task',
      sessionName: '12steps',
      reason: 'Finish the requested sign-in',
      origin: 'https://login.example.com',
      computerName: 'windows-pc',
      computerId: 'placeholder-computer',
      scope: 'placeholder-scope',
      vaultItemRef: 'placeholder-item',
      itemTitle: 'Example login',
      vaultFolder: 'AgentVault',
      moveIntoFolder: true,
      purposes: ['login', 'totp'],
      permission: 'task',
      ...overrides,
    },
  });
}

describe('presentBrowserApproval: an ordinary action', () => {
  const view = presentBrowserApproval(makeApproval(), ctx);

  it('says what will happen in one plain sentence, with the website and computer', () => {
    expect(view.kind).toBe('action');
    expect(view.kindLabel).toBe('Browser action');
    expect(view.headline).toBe("Click 'Submit order' on shop.example.com (Windows PC)");
  });

  it('shows why it needs a decision, the website and the computer, and nothing raw', () => {
    expect(view.facts).toEqual([
      { label: 'Why it needs your OK', value: "It sends what's on the page to the website." },
      { label: 'Website', value: 'shop.example.com' },
      { label: 'Computer', value: 'Windows PC' },
      { label: 'Reply before', value: 'at 2000' },
    ]);
    const visible = JSON.stringify([view.headline, view.facts]);
    for (const raw of ['browser.click', 'button#place-order', 'existing-tab', 'per_action', 'node-win']) {
      expect(visible).not.toContain(raw);
    }
  });

  it('keeps the raw tool, selector, scope and profile under Details', () => {
    expect(view.details).toEqual([
      { label: 'Tool', value: 'browser.click' },
      { label: 'Action type', value: 'submit' },
      { label: 'Requested scope', value: 'per_action - submit - https://shop.example.com' },
      { label: 'Page address', value: 'https://shop.example.com/checkout' },
      { label: 'Selector', value: 'button#place-order' },
      { label: 'Element (as the agent described it)', value: 'Submit order - button' },
      { label: 'Profile', value: 'existing-tab:n.node-win:1:2' },
      { label: 'Target', value: 'existing-tab:n.node-win:1:2:target' },
      { label: 'Computer id', value: 'node-win' },
    ]);
  });

  it('offers the three scope buttons in the shared words, each minting its own grant', () => {
    expect(view.choices.map((choice) => choice.id)).toEqual(['once', 'session', 'without-asking']);
    expect(view.choices.map((choice) => choice.label)).toEqual([
      'Allow this once',
      'Allow for this session',
      'Allow without asking (this session)',
    ]);
    expect(view.choices.map((choice) => choice.label)).toEqual([
      PERMISSION_SCOPE_WORDS.once.allow,
      PERMISSION_SCOPE_WORDS.session.allow,
      PERMISSION_SCOPE_WORDS['without-asking'].allow,
    ]);
    expect(view.choices.map((choice) => choice.grant.mode)).toEqual(['per_action', 'session', 'autonomous']);
    expect(view.choices.map((choice) => choice.grant.autonomous)).toEqual([false, false, true]);
    expect(view.choices.every((choice) => choice.grant.allowedActionClasses.join() === 'submit')).toBe(true);
  });

  it('describes what each button covers, in plain words, for its tooltip', () => {
    expect(view.choices.map((choice) => choice.hint)).toEqual([
      'Covers just this one action on shop.example.com. The next one asks again.',
      'Covers submitting forms on shop.example.com until this session ends.',
      "Covers submitting forms on shop.example.com until this session ends, without asking again. Meant for runs you're not watching.",
    ]);
  });

  it('keeps the typed phrase for publishing and deleting on every button that covers it', () => {
    expect(view.phrase).toBe('shop.example.com');
    expect(view.choices.map((choice) => choice.needsPhrase)).toEqual([true, true, true]);
  });

  it('records which button was pressed in the audit reason', () => {
    expect(view.choices.map((choice) => choice.auditReason)).toEqual([
      'Allowed once from session page',
      'Allowed for session from session page',
      'Allowed without asking from session page',
    ]);
  });
});

describe('presentBrowserApproval: the reason the agent gave', () => {
  it('shows it first, then why the action needs a decision', () => {
    const view = presentBrowserApproval(makeApproval({ requestReason: 'Placing the order you asked for' }), ctx);
    expect(view.facts.slice(0, 2)).toEqual([
      { label: 'Reason', value: 'Placing the order you asked for' },
      { label: 'Why it needs your OK', value: "It sends what's on the page to the website." },
    ]);
  });

  it('shows no Reason row when the agent gave none, and does not make one up', () => {
    const view = presentBrowserApproval(makeApproval(), ctx);
    expect(view.facts.map((fact) => fact.label)).not.toContain('Reason');
  });

  it('never repeats the reason under Details', () => {
    const view = presentBrowserApproval(makeApproval({ requestReason: 'Placing the order you asked for' }), ctx);
    expect(JSON.stringify(view.details)).not.toContain('Placing the order');
  });

  it('puts the reason ahead of what a standing-permission request would cover', () => {
    const view = presentBrowserApproval(makeApproval({
      toolName: 'browser.request_grant',
      action: 'request_grant',
      requestReason: 'Booking the venue you chose',
      proposedGrant: grant({ mode: 'session', allowedActionClasses: ['read', 'input'] }),
    }), ctx);
    expect(view.facts.slice(0, 2)).toEqual([
      { label: 'Reason', value: 'Booking the venue you chose' },
      { label: 'Would cover', value: 'reading pages, typing and clicking' },
    ]);
  });
});

describe('presentBrowserApproval: where the element description came from', () => {
  it('says a shared tab’s element is only what the agent described', () => {
    const view = presentBrowserApproval(makeApproval({ profileId: 'existing-tab:3:4', computerId: 'local' }), ctx);
    expect(view.details.map((detail) => detail.label)).toContain('Element (as the agent described it)');
  });

  it('says a managed profile’s element was read from the page', () => {
    const view = presentBrowserApproval(makeApproval({ profileId: 'profile-1', computerId: 'local' }), ctx);
    expect(view.details.map((detail) => detail.label)).toContain('Element (read from the page)');
    expect(view.details.map((detail) => detail.label)).not.toContain('Element (as the agent described it)');
  });
});

describe('presentBrowserApproval: approval constraints', () => {
  it('needs no phrase for ordinary typing, and narrows Allow this once to the classified action', () => {
    const view = presentBrowserApproval(makeApproval({
      toolName: 'browser.type',
      action: 'type',
      actionClass: 'input',
      selector: 'input#email',
      elementContext: { label: 'Email' },
      proposedGrant: grant({ allowedActionClasses: ['read', 'navigate', 'input'] }),
    }), ctx);
    expect(view.headline).toBe("Type into 'Email' on shop.example.com (Windows PC)");
    expect(view.phrase).toBeNull();
    expect(view.choices.map((choice) => choice.needsPhrase)).toEqual([false, false, false]);
    expect(view.choices[0]!.grant.allowedActionClasses).toEqual(['input']);
    expect(view.choices[1]!.grant.allowedActionClasses).toEqual(['read', 'navigate', 'input']);
  });

  it('only needs the phrase on buttons whose grant covers submitting or deleting', () => {
    const view = presentBrowserApproval(makeApproval({
      toolName: 'browser.click',
      actionClass: 'input',
      proposedGrant: grant({ allowedActionClasses: ['input', 'submit'] }),
    }), ctx);
    expect(view.choices[0]!.grant.allowedActionClasses).toEqual(['input']);
    expect(view.choices.map((choice) => choice.needsPhrase)).toEqual([false, true, true]);
    expect(view.phrase).toBe('shop.example.com');
  });

  it('allows an action Harness could not classify one action at a time only', () => {
    const view = presentBrowserApproval(makeApproval({
      actionClass: 'unknown',
      proposedGrant: grant({ allowedActionClasses: ['unknown'] }),
    }), ctx);
    expect(view.choices.map((choice) => choice.id)).toEqual(['once']);
    expect(view.choices[0]!.label).toBe('Allow this once');
    expect(view.note).toBe('You can only allow this one action at a time.');
    expect(view.facts[0]).toEqual({
      label: 'Why it needs your OK',
      value: "Harness couldn't tell what this does, so it asks every time.",
    });
  });

  it.each(['payment', 'financial_identity', 'sensitive_identity'] as const)(
    'offers no allow button for %s, the way the permission bar sends it to review',
    (actionClass) => {
      const view = presentBrowserApproval(makeApproval({
        actionClass,
        proposedGrant: grant({ allowedActionClasses: [actionClass] }),
      }), ctx);
      expect(view.choices).toEqual([]);
      expect(view.note).toBe("You can't allow this one from here. Deny it, or review it on the Browser page.");
    },
  );

  it('does not claim the action is unclassified when a request simply has nothing wider to offer', () => {
    const view = presentBrowserApproval(makeApproval({
      proposedGrant: grant({ allowedActionClasses: [] }),
    }), ctx);
    expect(view.choices.map((choice) => choice.id)).toEqual(['once']);
    expect(view.note).toBeNull();
  });

  it('never offers Allow forever from this card', () => {
    const view = presentBrowserApproval(makeApproval({
      toolName: 'browser.request_grant',
      action: 'request_grant',
      actionClass: 'input',
      proposedGrant: grant({ mode: 'autonomous', autonomous: true, allowedActionClasses: ['read', 'navigate', 'input'] }),
    }), ctx);
    expect(view.choices.map((choice) => choice.grant.mode)).toEqual(['per_action', 'session', 'autonomous']);
  });
});

describe('presentBrowserApproval: a request for a standing permission', () => {
  const view = presentBrowserApproval(makeApproval({
    toolName: 'browser.request_grant',
    action: 'request_grant',
    actionClass: 'submit',
    selector: undefined,
    elementContext: undefined,
    proposedGrant: grant({
      mode: 'autonomous',
      autonomous: true,
      allowedActionClasses: ['read', 'navigate', 'input', 'submit'],
    }),
  }), ctx);

  it('says plainly that it asks for permission to work on the site, and lists what it covers', () => {
    expect(view.headline).toBe('Get permission to work on shop.example.com (Windows PC)');
    expect(view.facts[0]).toEqual({
      label: 'Would cover',
      value: 'reading pages, moving between pages, typing, clicking and submitting forms',
    });
  });

  it('lists the same coverage in the lasting buttons and keeps the phrase', () => {
    expect(view.choices[1]!.hint).toBe(
      'Covers reading pages, moving between pages, typing, clicking and submitting forms on shop.example.com until this session ends.',
    );
    expect(view.phrase).toBe('shop.example.com');
  });
});

describe('presentBrowserApproval: a manual handoff', () => {
  const handoff = (overrides: Partial<BrowserApprovalRequest> = {}) => presentBrowserApproval(makeApproval({
    toolName: 'browser.request_user_login',
    action: 'request_user_login',
    actionClass: 'credential',
    selector: undefined,
    origin: 'https://login.example.com',
    url: 'https://login.example.com/sign-in',
    profileId: 'existing-tab:3:4',
    targetId: 'existing-tab:3:4:target',
    computerId: 'local',
    elementContext: { nearbyText: 'User login is required before Browser Gateway automation can continue.' },
    proposedGrant: grant({ allowedActionClasses: ['read'] }),
    ...overrides,
  }), ctx);

  it('shows the agent’s own message as the reason', () => {
    const view = handoff({ requestReason: 'Please sign in to your account, then tell me.' });
    expect(view.headline).toBe('Wait while you sign in yourself on login.example.com (this Mac)');
    expect(view.facts[0]).toEqual({ label: 'Reason', value: 'Please sign in to your account, then tell me.' });
  });

  it('does not pass the system’s default prompt off as the agent’s reason', () => {
    const view = handoff();
    expect(view.facts[0]).toEqual({ label: 'Why it needs your OK', value: 'You need to do this step by hand.' });
    expect(JSON.stringify(view.facts)).not.toContain('Browser Gateway');
    expect(view.details).toContainEqual({
      label: 'Message',
      value: 'User login is required before Browser Gateway automation can continue.',
    });
  });

  it('offers one honest button, because approving only tells the agent to carry on', () => {
    const view = handoff();
    expect(view.choices).toHaveLength(1);
    expect(view.choices[0]!.label).toBe('Done, carry on');
    expect(view.choices[0]!.grant.mode).toBe('per_action');
    expect(view.note).toBe("Approving only tells the agent to carry on. It doesn't allow anything else.");
    expect(view.phrase).toBeNull();
  });
});

describe('presentBrowserApproval: a saved login', () => {
  const approval = savedLogin();
  const view = presentBrowserApproval(approval, { ...ctx, credentialDuration: 'task' });

  it('names the login, the website and the computer in the headline', () => {
    expect(view.kind).toBe('saved-login');
    expect(view.kindLabel).toBe('Saved login');
    expect(view.headline).toBe("Sign in to login.example.com with 'Example login' and its one-time code (windows-pc)");
  });

  it('keeps every row the saved-login card has always shown, with session instead of task', () => {
    expect(view.facts).toEqual([
      { label: 'Session', value: '12steps' },
      { label: 'Reason', value: 'Finish the requested sign-in' },
      { label: 'Website', value: 'login.example.com' },
      { label: 'Computer', value: 'windows-pc' },
      { label: 'Access', value: 'sign in with this saved login and use a one-time sign-in code. Only this website, computer and saved login.' },
      { label: 'Vault folder', value: 'Approval will move this login into the AgentVault agent vault folder.' },
      { label: 'Lasts', value: 'Until this session ends.' },
      { label: 'Reply before', value: 'at 2000' },
    ]);
    expect(JSON.stringify(view.facts).toLowerCase()).not.toContain('task');
  });

  it('keeps the raw ids under Details', () => {
    expect(view.details).toEqual([
      { label: 'Tool', value: 'browser.request_credential_access' },
      { label: 'Profile', value: 'existing-tab:n.node-win:1:2' },
      { label: 'Target', value: 'existing-tab:n.node-win:1:2:target' },
      { label: 'Scope', value: 'placeholder-scope' },
      { label: 'Computer id', value: 'placeholder-computer' },
    ]);
  });

  it('has no scope buttons of its own: the saved-login controls decide how long it lasts', () => {
    expect(view.choices).toEqual([]);
    expect(view.phrase).toBeNull();
  });

  it('shows the latest expiry for a session permission when the backend reports one', () => {
    const withExpiry = presentBrowserApproval(
      savedLogin({ permissionExpiresAt: 5_000 }),
      { ...ctx, credentialDuration: 'task' },
    );
    expect(withExpiry.facts.find((fact) => fact.label === 'Latest expiry')).toEqual({
      label: 'Latest expiry',
      value: 'at 5000',
    });
  });

  it('warns that a longer choice lets any session sign in without asking', () => {
    const longer = presentBrowserApproval(approval, { ...ctx, credentialDuration: '7d' });
    expect(longer.facts.find((fact) => fact.label === 'Lasts')).toEqual({
      label: 'Lasts',
      value: 'For 7 days. Any session can use this saved login on login.example.com without asking again.',
    });
  });

  it('describes a one-time-code-only request without mentioning a password', () => {
    const codeOnly = presentBrowserApproval(savedLogin({ purposes: ['totp'] }), ctx);
    expect(codeOnly.headline).toBe("Use a one-time code from 'Example login' on login.example.com (windows-pc)");
  });

  it('names this computer, and a known remote one by its own name, in the same words as everywhere else', () => {
    const local = presentBrowserApproval(savedLogin({ computerId: 'local', computerName: 'This computer' }), ctx);
    expect(local.facts.find((fact) => fact.label === 'Computer')?.value).toBe('this Mac');
    expect(local.headline.endsWith('(this Mac)')).toBe(true);
    const known = presentBrowserApproval(savedLogin({ computerId: 'node-win', computerName: 'windows-pc' }), ctx);
    expect(known.facts.find((fact) => fact.label === 'Computer')?.value).toBe('Windows PC');
  });
});

describe('browserApprovalFailureText', () => {
  it.each([
    ['approval_request_not_found', 'This request is no longer there.'],
    ['approval_request_expired', 'This request timed out.'],
    ['approval_request_approved', 'This request was already approved.'],
    ['approval_request_denied', 'This request was already denied.'],
  ])('turns %s into a sentence', (reason, text) => {
    expect(browserApprovalFailureText(reason)).toBe(text);
  });

  it('keeps unknown diagnostic codes out of the visible sentence', () => {
    expect(browserApprovalFailureText('PRIVATE_DIAGNOSTIC_TEXT')).toBe("Harness couldn't record this decision. Check Details, then try again.");
  });
});

describe('presentBrowserApproval: website and computer', () => {
  it.each([
    ['darwin', 'this Mac'],
    ['win32', 'this PC'],
    ['linux', 'this computer'],
    [undefined, 'this computer'],
  ])('names the computer Harness runs on by its kind (%s)', (localPlatform, name) => {
    const view = presentBrowserApproval(makeApproval({ computerId: 'local' }), { ...ctx, localPlatform });
    expect(view.headline).toBe(`Click 'Submit order' on shop.example.com (${name})`);
    expect(view.facts).toContainEqual({ label: 'Computer', value: name });
    expect(view.details.map((detail) => detail.label)).not.toContain('Computer id');
  });

  it('uses a remote computer’s own name, and falls back to what it is when it has none', () => {
    expect(presentBrowserApproval(makeApproval({ computerId: 'node-win' }), ctx).headline)
      .toBe("Click 'Submit order' on shop.example.com (Windows PC)");
    expect(presentBrowserApproval(makeApproval({ computerId: 'node-unnamed' }), ctx).headline)
      .toBe("Click 'Submit order' on shop.example.com (your Windows PC)");
  });

  it('does not show a raw computer id when the computer list does not know the computer', () => {
    const view = presentBrowserApproval(makeApproval({ computerId: 'node-gone' }), ctx);
    expect(view.headline).toBe("Click 'Submit order' on shop.example.com (another computer)");
    expect(view.details).toContainEqual({ label: 'Computer id', value: 'node-gone' });
  });

  it('names no computer when the gateway did not say which, rather than guessing', () => {
    const view = presentBrowserApproval(makeApproval({ profileId: 'profile-1', computerId: undefined }), ctx);
    expect(view.headline).toBe("Click 'Submit order' on shop.example.com");
    expect(view.facts.map((fact) => fact.label)).not.toContain('Computer');
  });

  it('does not work the computer out from the profile name itself', () => {
    // The gateway says which computer; a shared-tab profile id is not read here.
    const view = presentBrowserApproval(makeApproval({ computerId: undefined }), ctx);
    expect(view.facts.map((fact) => fact.label)).not.toContain('Computer');
  });

  it('falls back to the page address, then the requested sites', () => {
    const fromUrl = presentBrowserApproval(makeApproval({ origin: undefined, url: 'http://localhost:4567/form' }), ctx);
    expect(fromUrl.headline).toBe("Click 'Submit order' on localhost:4567 (Windows PC)");
    const fromGrant = presentBrowserApproval(makeApproval({
      origin: undefined,
      url: undefined,
      proposedGrant: grant({ allowedOrigins: [{ scheme: 'https', hostPattern: 'example.com', includeSubdomains: true }] }),
    }), ctx);
    expect(fromGrant.headline).toBe("Click 'Submit order' on *.example.com (Windows PC)");
    const nowhere = presentBrowserApproval(makeApproval({
      origin: undefined,
      url: undefined,
      proposedGrant: grant({ allowedOrigins: [] }),
      computerId: undefined,
    }), ctx);
    expect(nowhere.headline).toBe("Click 'Submit order'");
    expect(nowhere.facts.map((fact) => fact.label)).not.toContain('Website');
  });

  it('trims a long element label instead of filling the headline', () => {
    const label = 'A'.repeat(200);
    const view = presentBrowserApproval(makeApproval({ elementContext: { visibleText: label } }), ctx);
    expect(view.headline.length).toBeLessThan(120);
    expect(view.headline).toContain('…');
  });
});

describe('presentBrowserApproval: other tools', () => {
  it.each([
    ['browser.fill_form', 'fill_form', 'Fill in a form on shop.example.com (Windows PC)'],
    ['browser.select', 'select', "Choose an option in 'Submit order' on shop.example.com (Windows PC)"],
    ['browser.press_key', 'press_key', 'Press a key on shop.example.com (Windows PC)'],
    ['browser.navigate', 'navigate', 'Open a page on shop.example.com (Windows PC)'],
    ['browser.reload', 'reload', 'Reload the page on shop.example.com (Windows PC)'],
    ['browser.download_file', 'download_file', 'Download a file on shop.example.com (Windows PC)'],
    ['browser.close_tab', 'close_tab', 'Close a browser tab on shop.example.com (Windows PC)'],
    ['browser.something_new', 'something_new', 'Use the browser: something new on shop.example.com (Windows PC)'],
  ])('%s reads as a plain sentence', (toolName, action, headline) => {
    expect(presentBrowserApproval(makeApproval({ toolName, action, actionClass: 'input' }), ctx).headline).toBe(headline);
  });

  it('names the uploaded file but keeps its folder under Details', () => {
    const view = presentBrowserApproval(makeApproval({
      toolName: 'browser.upload_file',
      action: 'upload_file',
      actionClass: 'file-upload',
      filePath: '/Users/example/Documents/invoice.pdf',
      detectedFileType: 'application/pdf',
      proposedGrant: grant({ allowedActionClasses: ['file-upload'], uploadRoots: ['/Users/example/Documents'] }),
    }), ctx);
    expect(view.headline).toBe('Upload invoice.pdf on shop.example.com (Windows PC)');
    expect(JSON.stringify(view.facts)).not.toContain('/Users/example');
    expect(view.details).toContainEqual({ label: 'File', value: '/Users/example/Documents/invoice.pdf' });
    expect(view.details).toContainEqual({ label: 'File type', value: 'application/pdf' });
    expect(view.details).toContainEqual({ label: 'Upload folders', value: '/Users/example/Documents' });
  });

  it.each([
    ['read', "It reads what's on the page."],
    ['navigate', 'It moves the browser to another page.'],
    ['input', 'It types or clicks on the page.'],
    ['credential', 'It uses a saved sign-in on the page.'],
    ['file-upload', 'It sends a file from your computer to the website.'],
    ['file-download', 'It saves a file from the website to your computer.'],
    ['submit', "It sends what's on the page to the website."],
    ['destructive', 'It could delete or remove something.'],
  ] as const)('explains a %s action in plain words', (actionClass, why) => {
    const view = presentBrowserApproval(makeApproval({
      actionClass,
      proposedGrant: grant({ allowedActionClasses: [actionClass] }),
    }), ctx);
    expect(view.facts[0]).toEqual({ label: 'Why it needs your OK', value: why });
  });
});
