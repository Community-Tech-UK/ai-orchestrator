import { describe, expect, it } from 'vitest';
import { detectTrailingContinueQuestion } from './continue-question-detector';

describe('detectTrailingContinueQuestion', () => {
  it('answers the reported mid-plan permission question', () => {
    const reply = [
      '## After the code (COM-419 steps 1–2)',
      '',
      'Map trustee measures from the trustee-access mapping doc, then email Lee: the two lists (trustees, measures) plus the',
      'two open questions (do South Glos / North Worcs really run at 0 hours, or are they just missing? do provision weeks',
      'change each year?). Written in your voice, no em dashes.',
      '',
      '**Blocked on Lee (unchanged):** COM-420, COM-421, COM-422, and COM-419 steps 3–4.',
      '',
      'Shall I implement?',
    ].join('\n');
    expect(detectTrailingContinueQuestion(reply)).toEqual({ excerpt: 'Shall I implement?' });
  });

  it('stays fast when many lines name the step being asked about', () => {
    const started = performance.now();
    const reply = `${'Step 2 note\n'.repeat(6000)}\nShall I continue with step 2?`;
    expect(detectTrailingContinueQuestion(reply)).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('stays fast on long runs of blank space', () => {
    for (const filler of ['\n'.repeat(200_000), ' '.repeat(200_000), ' \n'.repeat(100_000)]) {
      const started = performance.now();
      expect(detectTrailingContinueQuestion(`Step 1 is done.${filler}Shall I continue?`)).not.toBeNull();
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it('quotes the question, not an indented code line after it', () => {
    expect(detectTrailingContinueQuestion('Step 1 is done.\n\nShall I continue?\n    Should I force it?')).toEqual({ excerpt: 'Shall I continue?' });
  });

  it('keeps quoted words of the question in the excerpt', () => {
    expect(detectTrailingContinueQuestion('Step 1 is done.\n\nShall I continue with the “parser” step?')).toEqual({ excerpt: 'Shall I continue with the “parser” step?' });
  });

  it('stays fast on long runs of space after an announced step', () => {
    for (const reply of [
      `Done. I'll${' '.repeat(200_000)}x\n\nShall I continue?`,
      `Next I'll${' '.repeat(200_000)}x\n\nShall I continue?`,
      `I'll${'\t'.repeat(50_000)}x\n\nShall I continue?`,
      `${`we will${' '.repeat(1000)}`.repeat(200)}x\n\nShall I continue?`,
    ]) {
      const started = performance.now();
      detectTrailingContinueQuestion(reply);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it('stays fast on a long run of comma-separated numbers', () => {
    const started = performance.now();
    expect(detectTrailingContinueQuestion(`[${Array.from({ length: 50_000 }, () => '123').join(',')}]\n\nShall I continue?`)).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('stays fast on long runs of lead-in words', () => {
    for (const word of ['so', 'ok', 'then', 'now', 'well']) {
      const started = performance.now();
      // Kept under the question length cap so the pattern itself runs (the old one took minutes here).
      const reply = `${`${word} `.repeat(Math.floor(150 / (word.length + 1)))}banana?`;
      expect(reply.length).toBeLessThanOrEqual(160);
      expect(detectTrailingContinueQuestion(reply)).toBeNull();
      expect(performance.now() - started).toBeLessThan(50);
    }
  });

  it.each([
    'Shall I continue?',
    'Should I proceed with phase 2?',
    'Want me to carry on?',
    'Do you want me to start on step 3?',
    'Would you like me to go ahead and implement this?',
    'OK to proceed?',
    'Ready for me to implement the plan?',
    'Shall we keep going?',
    'Proceed?',
    'Continue with the remaining steps?',
    'So, shall I crack on?',
    'Happy for me to proceed?',
    'Shall I proceed with the implementation?',
    'Should I go ahead?',
    'Want me to keep going?',
    'Ready to implement?',
    'Shall I start implementing?',
    'Shall I continue implementing?',
    'Shall I move to step 3?',
    'Tests pass — want me to continue?',
    'Next I will update tests on CI and callers in the renderer.\n\nShall I proceed?',
    // Realistic progress notes full of ordinary coding words.
    'I added the `retryWithBackoff` helper and wired it into the fetch client. Unit tests pass.\n\nShall I move on to the API endpoints?',
    'The error message now shows the file name, and the message tests are updated.\n\nShall I continue?',
    'Phase 1 is in: the settings key is read on startup and the default is true.\n\nShall I proceed with phase 2?',
    'The server handler validates the payload with Zod now, which removes the manual checks.\n\nShall I continue with the handler?',
    'I removed the dead branch in `onClose` and the dropdown now closes on Escape.\n\nShall I keep going?',
    'Committed step 2 locally as you asked. Typecheck and lint are clean.\n\nShall I start on step 3?',
    'The client now uses a Map instead of a linear scan, which cuts lookup time.\n\nWant me to carry on?',
    'The layout is responsive now and keeps a record of the last width.\n\nShall I continue?',
    'Typecheck passes. I updated the callers in the renderer too.\n\nShall I move on to the tests?',
    'Step 2 is done: the email field validates on blur and the error message is announced.\n\nShall I continue with step 3?',
    'The plan has a few more steps and the parser uses a linear scan for now.\n\nShall I continue?',
    'The send button now disables while a request is in flight.\n\nShall I continue?',
    // An announced next step that is ordinary local coding work.
    "Step 1 is done.\n\nNext I'll wire the store into the component.\n\nShall I proceed?",
    'Step 1 is done.\n\nThen I will run the full test suite and fix anything that fails.\n\nShall I proceed?',
    'Step 1 is done.\n\nThe next step is to add the settings toggle.\n\nShall I go ahead?',
    'Step 1 is done.\n\nNext: refactor the parser into two functions.\n\nShall I go ahead?',
    ...[
      "Next I'll fix the import paths.",
      "Next I'll remove the dead code.",
      "Next I'll update the error message.",
      "Next I'll update each call site.",
      "Then I'll add tests for the store.",
      "I'm going to extract the parser into its own file.",
      "Now I'll run the typecheck.",
      'My next step is to wire the setting into the tab.',
      "Next we'll convert the component to signals.",
      "I'll refactor the dispatcher next.",
      "Next I'll add tests for Angular signals.",
      "Next I'll fix the same bug in Safari.",
      "Next I'll check it on Linux.",
      "Next I'll add retry handling to the uploader.",
      "Next I'll make the dialog keyboard accessible.",
      "I'll tackle the toolbar next.",
    ].map((line) => `Code is done.\n\n${line}\n\nShall I proceed?`),
    // Ordinary coding words used in their everyday coding sense.
    ...[
      'the store now pushes each entry onto the list',
      'the handler now sends a request',
      'the panel now responds to window resizes',
      'the store publishes a change event',
      'each render costs 6ms',
      'the delete button is disabled while saving',
      'removed the deleted-flag column from the view model',
      'the production build is clean',
      'the screen reader announcement now fires once',
      'it forwards each event to the main thread',
      'it now notifies listeners on change',
      'You can run it with npm test or the quiet runner',
      'the billing page component renders the plan name',
      'the draft spec is updated',
      'the GitHub Actions workflow is updated',
      'the header shares its state with the sidebar',
      'When you click Save the store updates',
      'it is cached permanently in memory',
    ].map((line) => `Done: ${line}.\n\nShall I continue?`),
    // A summary on the same line as the question, and code nouns named by the question.
    'I removed the dead branch and the tests pass. Shall I continue?',
    'The data table now sorts by date. Shall I continue?',
    'The import paths are fixed. Shall I continue?',
    'Step 1 is done; the user list now paginates. Shall I continue?',
    ...['the user settings page', 'the data layer', 'the import parser', 'the messages view', 'the accounts screen', 'the sync logic']
      .map((part) => `Step 1 is done.\n\nShall I move on to ${part}?`),
    // Code that uses risky-sounding names.
    'Step 1 is done: `cache.delete(key)` now runs on close.\n\nShall I continue?',
    'Step 1 is done:\n\n```ts\nmap.delete(id);\n```\n\nShall I continue?',
    'Step 1 is done: `deleteSession` now awaits the store.\n\nShall I continue?',
    'Step 1 is done: the invite dialog component renders.\n\nShall I continue?',
    'Step 1 is done: the publish step in the store is typed.\n\nShall I continue?',
    'Step 1 is done: the --force flag is parsed.\n\nShall I continue?',
    // A three-step plan whose question names one step is not a choice between two.
    '1. Fix the parser\n2. Wire the store\n3. Add tests\n\nStep 1 is done.\n\nShall I continue with the store?',
    'Step 2 is done.\n\nShall I start on the next task?',
    'Steps 1 and 2 are done.\n\nShall I continue with steps 3–5?',
    'The first leak is fixed.\n\nShall I proceed with the fix for the second leak?',
    'The store now notifies all subscribers on change.\n\nShall I continue?',
    'Step 2 is done.\n\nShall I continue with those?',
    '**Step 1:** fix the parser (done)\n**Step 2:** wire the store\n\nShall I continue with the store?',
    'Step 2 is done.\n\nShall I move on to the next one?',
    'The ticket asks for a worker thread, and the parser now runs in one.\n\nShall I continue with step 3?',
    '**Shall I continue?**',
    'Done with step 2.\n\n- Shall I move on to step 3?',
    'Plan:\n1. Fix the parser\n2. Wire it into the store\n\nStep 1 is done and tests pass.\n\nShall I continue with step 2?',
    'The admin page now loads the targets and the tests confirmed the fix.\n\nShall I proceed with phase 2?',
    '## Approach\nRead the config first, then the parser.\n\nThe parser reads the config now.\n\nShall I carry on?',
  ])('detects %j', (reply) => {
    expect(detectTrailingContinueQuestion(reply)).not.toBeNull();
  });

  it.each([
    ['a statement', 'I will carry on with step 3.'],
    ['a question that is not the last sentence', 'Shall I continue? I have left notes in the plan.'],
    ['a choice between options', 'Shall I implement option A or option B?'],
    ['a which-question', 'Which approach should I implement?'],
    ['an offer of extra work', 'All done. Want me to also add tests?'],
    ['an offer of further work', 'That is finished. Should I add another endpoint as well?'],
    ['sending an email', 'Shall I send the email to Lee?'],
    ['writing an email', 'Shall I write the email to Lee now?'],
    ['committing', 'Shall I commit?'],
    ['pushing', 'Want me to push the branch?'],
    ['deploying', 'Shall I deploy to production?'],
    ['deleting data', 'Shall I delete the old records?'],
    ['waiting on the user', 'Shall I proceed once you have added the key?'],
    ['asking for approval', 'Shall I go ahead after your approval?'],
    ['stacked questions', 'Which database do you use? Shall I proceed?'],
    ['an explanation offer', 'Do you want me to explain the design?'],
    ['a quoted question', 'The model replied "Shall I continue?"'],
    ['a fenced question', '```\nShall I continue?\n```'],
    ['a question about something else', 'Is the staging server still running?'],
    // Word forms of risky steps.
    ['deleting', 'Shall I proceed with deleting the old records?'],
    ['pushing', 'Shall I continue with pushing the branch?'],
    ['committing', 'Should I proceed with committing these changes?'],
    ['publishing', 'Shall I continue publishing the packages?'],
    ['sending invites', 'Shall I proceed with sending the invites?'],
    ['the deployment', 'Shall I go ahead with the deployment?'],
    ['the payment', 'Shall I proceed with the payment?'],
    ['the deletion', 'Shall I proceed with the deletion?'],
    ['the commits', 'Shall I proceed with the commits?'],
    ['the uploads', 'Shall I continue with the uploads?'],
    ['removing files', 'Shall I proceed with removing the files?'],
    // Risky commands hidden in code formatting.
    ['an inline git push', 'Shall I run `git push origin main`?'],
    ['an inline npm publish', 'Shall I run `npm publish`?'],
    ['an inline rm -rf', 'Shall I run `rm -rf ~/work/project`?'],
    ['an inline force push', 'Proceed with `git push --force`?'],
    ['an inline prod target', 'Shall I apply the migration to `prod`?'],
    ['an html code push', 'Shall I run <code>git push</code>?'],
    ['a fenced command after the question', 'Shall I proceed with the plan?\n\n```bash\ngit push --force\n```'],
    ['a fenced command before the question', 'I will run:\n\n```bash\ngit push --force\n```\n\nShall I proceed?'],
    // Warnings just before the question.
    ['an irreversible warning', 'This deletes all 3,000 rows and cannot be undone. Shall I proceed?'],
    ['an email warning', 'This will email all 500 customers. Shall I go ahead?'],
    ['a cost warning', 'Running this costs about $40 in API credits. Shall I proceed?'],
    ['a warning in the paragraph before', 'This step cannot be undone.\n\nShall I proceed?'],
    // Decisions rather than permission.
    ['a different language', 'Should I implement it in Rust instead?'],
    ['a different approach', 'Shall I implement it differently?'],
    ['continuing anyway', 'Should I continue anyway?'],
    ['a missing input', 'I need the API key first. Shall I proceed without it?'],
    ['an assumption', 'Should I continue assuming UTC?'],
    ['a stated assumption', 'Shall I proceed with my assumption that you want MySQL?'],
    ['skipping tests', 'Should I fix the failing tests by skipping them?'],
    // Steps off this computer or destructive local steps.
    ['another computer', 'Ok to run it on the windows PC?'],
    ['a server', 'Shall I apply the changes to the server?'],
    ['DNS', 'Shall I update the DNS records?'],
    ['terraform', 'Shall I run terraform apply?'],
    ['an outside service', 'Shall I update the customer records in Salesforce?'],
    ['a cancellation', 'Should I go ahead and cancel the subscription?'],
    ['a hard reset', 'Shall I proceed with the git reset --hard?'],
    // Decisions in the question or just before it.
    ['a chosen option', 'Option A keeps the schema, option B migrates it.\n\nShall I proceed with option B?'],
    ['a recommendation', '**Option A:** patch it.\n**Option B:** rewrite it.\n\nI would recommend B because it is simpler. Want me to go ahead with that?'],
    ['two ways', 'Two ways to do this: patch the adapter, or rewrite the parser.\n\nI would recommend rewriting the parser.\n\nShall I implement that?'],
    ['a language', 'Should I implement it in Rust?'],
    ['the defaults', 'Shall I proceed with the defaults?'],
    ['an old API', 'Should I continue using the old API?'],
    ['the recommended approach', 'Should I proceed with the recommended approach?'],
    ['a public API change', 'This would change the public API used by other teams.\n\nShall I proceed?'],
    ['the choice the user is asked to make', 'Shall I continue or not?'],
    // Specific actions are never on the allow-list.
    ['replying to someone', 'Shall I go ahead and reply to Sarah?'],
    ['opening a pull request', 'Shall I open the PR?'],
    ['a calendar entry', 'Want me to add the reminder to your Google calendar?'],
    ['booking', 'Shall I book the flight?'],
    ['a refund', 'Should I refund the customer?'],
    ['rotating keys', 'Shall I rotate the API keys?'],
    ['a database reset', 'Shall I reset the database?'],
    ['a redeploy', 'Shall I redeploy?'],
    ['the rollout', 'Shall I proceed with the rollout?'],
    ['another computer by name', 'Shall I run it on ct-test-mac?'],
    ['staging migrations', 'Shall I run the migrations against staging?'],
    ['an inline prisma reset', 'Shall I run `npx prisma migrate reset`?'],
    ['an inline docker prune', 'Proceed with `docker system prune -a`?'],
    ['an offer after finished work', 'Everything works.\n\nShall I add a README section?'],
    ['waiting on a key', 'Shall I continue now that you have the key?'],
    ['a key that must be in place', 'Once the key is in place, shall I proceed?'],
    // Risky steps hidden behind Markdown layout.
    ['a spaced plan list', 'Plan:\n\n1. Update the code\n\n2. Push to main\n\n3. Run tests\n\nShall I proceed?'],
    ['a list behind a rule', '- Deploy to production\n- Tests pass\n\n---\n\nShall I proceed?'],
    ['code behind a pointer line', '```bash\ngit push --force\n```\n\nThat is the command.\n\nShall I proceed?'],
    ['a redeploy in the paragraph before', 'Next I will redeploy the worker.\n\nShall I proceed?'],
    // Recommendations further up the reply.
    ['options above a recommendation', "Option A patches it; Option B rewrites it.\n\nI'd go with B.\n\nShall I go ahead?"],
    ['a list above a leaning', 'Two ways to do this.\n\n- Patch it\n- Rewrite it\n\nI lean towards rewriting.\n\nShall I go ahead?'],
    ['a numbered list above a preference', '1. Patch the adapter\n2. Rewrite the parser\n\nB looks cleaner to me.\n\nShall I implement that?'],
    ['a stated pick', 'I would go with Postgres here.\n\nShall I implement that?'],
    // Other questions or requests to the user nearby.
    ['an earlier question', 'Do you want Postgres? Let me know.\n\nShall I proceed?'],
    ['a request to confirm', 'Please confirm the account to use.\n\nShall I proceed?'],
    ['a request for input', 'Tell me the target branch first.\n\nShall I proceed?'],
    // A named step whose description is further up.
    ['an outward numbered step', 'Plan:\n1. Fix the parser\n2. Email Lee the results\n\nStep 1 is done and tests pass.\n\nShall I continue with step 2?'],
    ['an outward phase heading', '## Phase 2: deploy to production\n\nPhase 1 is complete.\n\nShall I proceed with phase 2?'],
    // Everyday wording of outward or destructive steps.
    ['texting', 'Next I will text Bob the results.\n\nShall I proceed?'],
    ['ringing', 'Next I will ring the plumber.\n\nShall I proceed?'],
    ['contacting', 'Next I will contact the landlord.\n\nShall I proceed?'],
    ['telling', 'Next I will tell Lee.\n\nShall I proceed?'],
    ['pinging', 'Next I will ping Lee on Teams.\n\nShall I proceed?'],
    ['a DM', 'Next I will DM Lee.\n\nShall I proceed?'],
    ['forwarding', 'Next I will forward this to Lee.\n\nShall I proceed?'],
    ['writing to someone', 'Next I will write to Lee.\n\nShall I proceed?'],
    ['a support ticket', 'Next I will answer the support ticket.\n\nShall I proceed?'],
    ['a tax return', 'This files the tax return with HMRC.\n\nShall I proceed?'],
    ['a contract', 'Next I will sign the contract via DocuSign.\n\nShall I proceed?'],
    ['admin rights', 'Next I will grant admin rights to the bot.\n\nShall I proceed?'],
    ['a public repo', 'Next I will make the repo public.\n\nShall I proceed?'],
    ['2FA', 'Next I will disable 2FA.\n\nShall I proceed?'],
    ['the firewall', 'Next I will turn off the firewall.\n\nShall I proceed?'],
    ['formatting a disk', 'Next I will format the disk.\n\nShall I proceed?'],
    ['erasing', 'Next I will erase the old data.\n\nShall I proceed?'],
    ['discarding changes', 'Next I will discard the local changes.\n\nShall I proceed?'],
    ['stashing', 'Next I will run git stash.\n\nShall I proceed?'],
    ['killing processes', 'Next I will kill all node processes.\n\nShall I proceed?'],
    ['shutting down', 'Next I will shut down the database.\n\nShall I proceed?'],
    ['uninstalling', 'Next I will uninstall the old version.\n\nShall I proceed?'],
    ['a paid API', 'Next I will run the paid API across 10k docs.\n\nShall I proceed?'],
    ...[
      "Next I'll let Lee know the results.",
      'Next I will reach out to Lee.',
      'Next I will follow up with Lee.',
      'Next I will get back to Lee with the numbers.',
      'Next I will update Lee on progress.',
      'Next I will raise it with the backend team.',
      'Next I will hand it over to Lee.',
      'Next I will update the page in Elementor.',
      'Next I will apply the changes on the website.',
      'Next I will run the import into the CRM.',
      "It's up to you whether we keep the legacy flag.",
      'We still need to pick between Postgres and SQLite.',
    ].map((line): [string, string] => [`"${line}"`, `Step 1 is done.\n\n${line}\n\nShall I proceed?`]),
    // Drafted messages: "go ahead" here means "send it".
    ['a fenced draft', "Here's the draft:\n\n```\nHi Lee,\nThe numbers are in.\nThanks,\nJames\n```\n\nShall I go ahead?"],
    ['a quoted draft', "Here's a draft for Lee:\n\n> Hi Lee, the numbers are in.\n\nShall I go ahead?"],
    ['a ready draft', 'The draft is ready. Shall I go ahead?'],
    ['a ready reply', 'The reply is ready. Shall I go ahead?'],
    ['a newsletter', 'The newsletter is ready. Shall I go ahead?'],
    ['an announcement', 'The announcement is written. Shall I go ahead?'],
    ['a response below', "I've written the response to Lee below.\n\nHi Lee, the numbers are in.\n\nShall I go ahead?"],
    ...[
      'Next I will set the env vars in Vercel.',
      'Next I will update the RLS policies in Supabase.',
      'Next I will change the plugin settings in wp-admin.',
      'Next I will update the product prices in WooCommerce.',
      'Next I will create the Mailchimp campaign.',
      'Next I will update the Cloudflare page rules.',
      'Next I will change the A record.',
      'Next I will run the job on the cluster.',
      'Next I will run it on the Windows box.',
      'Next I will run it on the Mac mini.',
      'Next I will comment on the ticket with the findings.',
      'Next I will open issues for each of these.',
      'Next I will file a bug with the vendor.',
      'Next I will open a support case with Krystal.',
      'Next I will reply on the thread.',
      'Next I will regenerate embeddings for all 40k documents with the OpenAI API.',
      'Next I will run the GPT-4 batch over the 10k tickets.',
      'Next I will kick off the batch job in BigQuery.',
      "**Open question:** the spec doesn't say what happens to archived users.",
      'Open question: whether to keep the legacy endpoint.',
      "It's your call whether we keep the legacy endpoint.",
      "You'll need to run npm login first.",
      "Before I continue, you'll need to add the API token to .env.",
    ].map((line): [string, string] => [`"${line}"`, `Step 1 is done.\n\n${line}\n\nShall I proceed?`]),
    // Multi-paragraph drafts and offers of extra work.
    ['a multi-paragraph email draft', "Here's the email for Lee:\n\nHi Lee,\n\nThe numbers are in.\n\nThe trustees list is attached.\n\nShall I go ahead?"],
    ['a draft signed with a name only', 'Hi Lee,\n\nThe numbers are in.\n\nMore detail follows.\n\nJames\n\nShall I go ahead?'],
    ['a draft with a subject line', 'Subject: Trustee numbers\n\nThe numbers are in.\n\nMore detail follows.\n\nShall I go ahead?'],
    ['a greeting without a comma', "Here's what I'll send:\n\nHi Lee\n\nThe numbers are in.\n\nShall I go ahead?"],
    ['an offer to add caching', 'Step 1 is done and tests pass.\n\nI could also add caching to the endpoint while I am here. Shall I go ahead?'],
    ['an offer to tidy up', 'Step 1 is done.\n\nI can also tidy up the old helper while I am at it.\n\nShall I go ahead?'],
    // Waiting on something from the user.
    ['a token from the user', 'I still need the API token from you.\n\nShall I proceed?'],
    ['a token needed first', 'I need the API token first. Shall I proceed?'],
    ['a name needed first', 'I need the bucket name before I can continue.\n\nShall I continue?'],
    // The step the question names is the user's call.
    ['continuing with the rollout', 'Shall I continue with the rollout?'],
    ['moving on to the commits', 'Shall I move on to the commits?'],
    ['continuing with the user import', 'Shall I continue with the user import?'],
    // Outward objects named by the question itself.
    ['the PR', 'Shall I go ahead with the PR?'],
    ['the pull request', 'Shall I continue with the pull request?'],
    ['a Slack post', 'Shall I continue with the Slack post?'],
    ['an App Store submission', 'Shall I move on to the App Store submission?'],
    ['the go-live', 'Shall I continue with the go-live?'],
    ['a quoted risky object', 'Shall I continue with the “user import” step?'],
    // Common outward wording and plain choices just before the question.
    ...[
      'Next I will commit and push.',
      'Next I will open a PR with these changes.',
      'Next I will raise a pull request.',
      'Next I will upload the files to S3.',
      'Next I will post it in Slack.',
      'Next I will ask Lee for the trustee list.',
      'Next step is to go live.',
      'Tests pass, so next I will ship it.',
      'Next I will run the migrations against the staging database.',
      'We could use Redis or keep the in-memory map.',
    ].map((line): [string, string] => [`"${line}"`, `Step 1 is done.\n\n${line}\n\nShall I proceed?`]),
    ['named approaches', 'Approach A: patch the adapter.\nApproach B: rewrite the parser.\n\nThe tests are ready.\n\nShall I proceed?'],
    ['named plans', 'Plan A is a quick patch. Plan B is a rewrite.\n\nThe tests are ready.\n\nShall I proceed?'],
    // Drafts in everyday shapes.
    ['a draft to all', "Here's what I'd send:\n\nHi all,\n\nThe fix is out.\n\nJames\n\nShall I go ahead?"],
    ['a draft to the team', 'Hi team,\n\nThe fix is out.\n\nMore detail follows.\n\nShall I go ahead?'],
    ['a draft to everyone', 'Hello everyone,\n\nThe fix is out.\n\nMore detail follows.\n\nShall I go ahead?'],
    ['a good-morning draft', 'Good morning Lee,\n\nThe fix is out.\n\nMore detail follows.\n\nShall I go ahead?'],
    ['a morning draft', 'Morning Lee,\n\nThe fix is out.\n\nMore detail follows.\n\nShall I go ahead?'],
    ['a formal draft', "Here's the draft:\n\nDear Mr Smith,\n\nThe fix is out.\n\nYours sincerely,\nJames\n\nShall I go ahead?"],
    ['an introduced message', "Here's the message for Lee:\n\nLee, numbers attached.\n\nMore detail follows.\n\nShall I go ahead?"],
    // Everyday ways of offering a choice.
    ['an alternatively', 'I can patch the parser. Alternatively, I can change the caller.\n\nThe tests are ready.\n\nShall I go ahead?'],
    ['another approach', 'Another approach would be to change the caller.\n\nThe tests are ready.\n\nShall I go ahead?'],
    ['an I could … or', 'I could patch the parser, or change the caller.\n\nThe tests are ready.\n\nShall I go ahead?'],
    ["an I'd go for", "I'd go for the second approach.\n\nThe tests are ready.\n\nShall I go ahead?"],
    // Risky next steps worded a little differently.
    ...[
      'Next I will drop the legacy users table.',
      'Next the migration drops the old email column.',
      'Next I will cancel the old subscription.',
      'Next I will remove the duplicate records from the database.',
      'Next I will roll it out to all users.',
      'Next I will let the client know.',
      'Next I will text the summary to Lee.',
      'Next I will tell the team in the channel.',
      'Next I will sign up for the paid plan.',
      'Next I will submit the build to Apple.',
      'The form is filled in. Next I submit it.',
      'Next I will forward the logs to the vendor.',
      'You said to check with you before step 2.',
      'You asked me to stop after step 1.',
    ].map((line): [string, string] => [`"${line}"`, `Step 1 is done.\n\n${line}\n\nShall I proceed?`]),
    ...['invitations', 'transfer', 'payout', 'charge', 'cancellation', 'renewal', 'shutdown', 'teardown', 'cutover', 'handover', 'handoff to Lee', 'outreach', 'texts']
      .map((object): [string, string] => [`the ${object}`, `Shall I proceed with the ${object}?`]),
    // Choices in common wording.
    ...[
      'We can keep it in memory or move it to SQLite.',
      'SQLite is the better option here.',
      'The best option is to rewrite it.',
      'I think the second approach is better.',
      "I'd rather rewrite it.",
    ].map((line): [string, string] => [`"${line}"`, `Step 1 is done.\n\n${line}\n\nShall I proceed?`]),
    // Drafts in everyday shapes.
    ['a draft heading', 'Draft email to Lee:\nThe numbers are in.\n\nShall I go ahead?'],
    ['a suggested message', 'Suggested message:\nThe numbers are in.\n\nShall I go ahead?'],
    ['a post intro', 'Here is what I would post:\nThe numbers are in.\n\nShall I go ahead?'],
    ['a bare draft label', 'Draft:\nLee — the numbers are in.\n\nShall I go ahead?'],
    ['a greeting with an exclamation mark', 'Hi Lee! The numbers are in.\n\nMore detail follows.\n\nShall I go ahead?'],
    ['a thanks opener', 'Thanks Lee, the numbers are in.\n\nMore detail follows.\n\nShall I go ahead?'],
    ['a name-only opener', 'Lee,\n\nThe numbers are in.\n\nJames\n\nShall I go ahead?'],
    // Announced next steps that are not ordinary local coding work.
    ...[
      'Next I will share the doc with Lee.',
      'Next I will post the update to the client.',
      'Next I will post the update on LinkedIn.',
      'Next I will charge the card.',
      'Next I will remove the old user accounts.',
      'Next I will deactivate the old user accounts.',
      'Next I will run the script that removes inactive accounts.',
      'Next I will create the calendar event.',
      'Next I will add the reminder to your calendar.',
      'Next I will update the Linear ticket.',
      'Next I will close the Linear issue.',
      'Next I will remove the old branches from the remote.',
      'Next I will run the release script.',
      'Next I will run npm run release.',
      'Next I will tag v1.2.0.',
      'Next I will run the bulk update on all 5,000 customer records.',
      'Next I will notarise the build.',
      'Then I will archive the old workspace.',
      'You said not to make any changes yet.',
    ].map((line): [string, string] => [`"${line}"`, `Step 1 is done.\n\n${line}\n\nShall I go ahead?`]),
    // Local verbs that still reach outside, and other ways of announcing a step.
    ...[
      "Next I'll update the client on progress.",
      "Next I'll add Lee to the repo.",
      "Next I'll create the release.",
      "Next I'll build and upload the installer.",
      "Next I'll check in with Lee.",
      "Next I'll check out the branch and commit it upstream.",
      "Next I'll change the password on the admin account.",
      "Next I'll update the website copy.",
      "Next I'll update the live config.",
      "Next I'll update the ticket with the results.",
      "Next I'll move the old records to the archive.",
      "I'm going to ping the team on Teams.",
      'Now I will ship the build to customers.',
      'I plan to text the client the link.',
      'The plan is to roll the change out to all customers.',
      "Next we'll update the client on progress.",
      "I'll update the client on progress next.",
      // More ways of offering a choice.
      'I can do it in the store or in the component.',
      'The fix could go in the adapter or in the dispatcher.',
      'Plan: A) patch the adapter, B) rewrite the dispatcher.',
      'There are two paths here.',
      'Keeping the cache is simpler, but rebuilding it is safer.',
      // Outward steps without an announcement.
      'The last bit is telling Lee.',
      'All set to go out to customers.',
    ].map((line): [string, string] => [`"${line}"`, `Code is done.\n\n${line}\n\nShall I proceed?`]),
    // A question that picks some offered items, and choices or drafts in other everyday shapes.
    ['a real choice of the first two', 'What I can do:\n1. Fix the parser\n2. Change the Microsoft admin setting through the browser\n3. Add caching, only if you want it\n\nShould I go ahead with the first two?'],
    ['three things, first two', 'I can do three things here: fix the parser, update the docs, rewrite the cache layer.\n\nShall I go ahead with the first two?'],
    ['a choice to make', "There's a choice to make here: keep the old format for a release, or switch now.\n\nShall I proceed?"],
    ['two ideas', 'Two ideas for the slow start: lazy-load the editor, or cache the parsed config.\n\nShall I proceed?'],
    ['both of them', 'Shall I go ahead with both?'],
    ['a summary for a person', 'Summary for Lee:\n\n- parser fixed\n- tests added\n\nShall I go ahead?'],
    ['a message for the team channel', "I've written this for the team channel:\n\n> Heads up: the API moves to v2 on Friday.\n\nShall I proceed?"],
    ['suggested wording', 'Suggested wording:\n\nThe API moves on Friday.\n\nThe code side is done.\n\nShall I proceed?'],
    ['proposed copy', 'Proposed homepage copy:\n\nFaster than ever.\n\nShall I go ahead?'],
    ...[
      'After that, the update goes out to all users.',
      'The build is ready to upload.',
      'Then it goes to the client for sign-off.',
      'Remaining: message the group with the new times.',
    ].map((line): [string, string] => [`"${line}"`, `Step 2 is done.\n\n${line}\n\nShall I proceed?`]),
    // More ways of listing options.
    ['here are the options', 'Here are the options:\n\n1. Keep the cache\n2. Drop the cache\n\nShall I proceed?'],
    ['the options are', 'The options are:\n\n- keep the cache\n- rebuild it\n\nShall I proceed?'],
    ['an options label', 'Options:\n- keep the cache\n- rebuild it\n\nShall I proceed?'],
    ['a couple of options', 'There are a couple of options: patch the adapter, or rewrite the parser.\n\nShall I proceed?'],
    ['a pros and cons table', '| Approach | Pros | Cons |\n|---|---|---|\n| Patch | quick | fragile |\n\nShall I proceed?'],
    ['fix A and fix B', '**Fix A:** patch the adapter.\n**Fix B:** rewrite the parser.\n\nShall I proceed?'],
    ['the second one', '1. Patch the adapter\n2. Rewrite the parser\n3. Leave it\n\nShall I go ahead with the second one?'],
    ['the latter', '1. Patch the adapter\n2. Rewrite the parser\n\nShall I go ahead with the latter?'],
    ['one of two listed items', '1. Patch the adapter\n2. Rewrite the parser\n\nShall I go ahead with the rewrite?'],
    ...[
      "I'd keep the old endpoint for one release.",
      'My pick would be the rewrite.',
      'This will reset the database.',
      'This clears all saved sessions.',
      'This removes every saved draft.',
      "That'll cost about $3.",
      'This will use about $5 of API credits.',
      'It costs around £8.',
      'It will cost 20 dollars.',
    ].map((line): [string, string] => [`"${line}"`, `Step 1 is done.\n\n${line}\n\nShall I proceed?`]),
    ['a draft below', 'Draft below.\n\nThe numbers are in.\n\nShall I go ahead?'],
    // Recommendation labels and counted options with a word in between.
    ['a bold recommendation label', '**Recommendation:** go with the rewrite.\n\nShall I proceed?'],
    ['a recommendation label', 'Recommendation: rewrite the parser.\n\nShall I go ahead?'],
    ['a suggestion label', '**Suggestion:** rewrite the parser.\n\nShall I proceed?'],
    ['a suggested approach', 'Suggested approach: rewrite the parser.\n\nShall I proceed?'],
    ['two possible approaches', 'There are two possible approaches:\n1. Patch the adapter\n2. Rewrite the parser\n\nShall I proceed?'],
    ['two different ways', 'Two different ways to fix it:\n- patch it\n- rewrite it\n\nShall I proceed?'],
    ['two possible fixes', 'Two possible fixes:\n1. patch it\n2. rewrite it\n\nShall I proceed?'],
    // Questions for the user listed further up.
    ['an open questions list', '## Open questions\n\n- Should the default be on or off?\n- Do we need a migration for old rows?\n\nI have kept the change small and local.\n\nShall I implement?'],
    ['questions before starting', 'Questions before I start:\n1. Keep the v1 endpoint?\n2. Include archived users?\n\nThe plan is in docs/plans/x.md.\n\nShall I proceed?'],
    // Issues and notifications.
    ...[
      "Next I'll update the GitHub issue with the findings.",
      'This will notify every customer.',
      "I'll notify Lee once the tests pass.",
    ].map((line): [string, string] => [`"${line}"`, `Step 1 is done.\n\n${line}\n\nShall I proceed?`]),
    // Caveats and choices hidden in the named part of the question.
    ...[
      'Shall I proceed with the rewrite or the patch?',
      'Shall I continue with the store or the component first?',
      'Should I move on to the tests or the docs?',
      'Shall I proceed with the plan or wait for Lee?',
      'Shall I proceed with the plan anyway?',
      'Shall I go ahead with the plan regardless?',
      'Shall I proceed with the plan without the API key?',
      'Shall I continue with the plan despite the failing tests?',
      'Shall I continue with the plan but skip the tests?',
      'Shall I proceed with the old approach instead?',
    ].map((question): [string, string] => [`"${question}"`, `Step 1 is done.\n\n${question}`]),
    // More draft shapes, outward wording and outward objects.
    ['a greeting with a dash', 'Hey Lee — sounds good, the numbers are in.\n\nMore detail follows.\n\nShall I go ahead?'],
    ['a greeting with a full stop', 'Hello Lee. Sounds good.\n\nMore detail follows.\n\nShall I go ahead?'],
    ['a To header', 'To: lee@example.com\nThe numbers are in.\n\nShall I go ahead?'],
    ["what I'd say", "Here's what I'd say:\nThe numbers are in.\n\nShall I go ahead?"],
    ...[
      'This will message every user.',
      'Next it will text everyone on the list.',
      'It will cost about 30 credits.',
      'Next I will update all 1200 customer records.',
    ].map((line): [string, string] => [`"${line}"`, `Step 1 is done.\n\n${line}\n\nShall I proceed?`]),
    ...['announcement', 'broadcast', 'mailout', 'mailshot'].map((object): [string, string] => [`the ${object}`, `Shall I proceed with the ${object}?`]),
    // "I'd" recommendations and picking one of several described options.
    ...[
      "We could patch the adapter, but rewriting the parser is cleaner. I'd recommend the rewrite.",
      "The simplest fix is a guard; the proper fix reworks the queue. I'd suggest the guard for now.",
      "I'd prefer the second approach.",
      'Both fixes are small. Either works.',
    ].map((line): [string, string] => [`"${line}"`, `${line}\n\nShall I proceed?`]),
    ['the quick one of three', '1. Add a guard (quick)\n2. Rewrite the queue (thorough)\n3. Do nothing\n\nShall I go ahead with the quick one?'],
    ['a bold-labelled option', '**Quick fix:** add a guard in the adapter.\n**Full fix:** rewrite the queue.\n\nShall I go ahead with the quick fix?'],
    ['the second approach in prose', 'The first approach keeps the cache; the second approach drops it.\n\nShall I proceed with the second approach?'],
    ...['the simpler one', 'the cheaper one', 'the other approach', 'the second option']
      .map((part): [string, string] => [part, `Step 1 is done.\n\nShall I go ahead with ${part}?`]),
    // Waiting on the user, release readiness and token spend.
    ...[
      'You asked me to only plan this, not implement it.',
      'You said to hold off until Monday.',
      'Everything is ready for release.',
      "I'll create the GitHub release after this.",
      "Next, I'll remove the old branches from GitHub.",
      'Running the full batch will use around 2M tokens.',
    ].map((line): [string, string] => [`"${line}"`, `Step 1 is done.\n\n${line}\n\nShall I proceed?`]),
    ['a step heading described below it', '## Step 2\nEmail Lee the results.\n\n## Status\nStep 1 is done.\n\nShall I continue with step 2?'],
  ])('ignores %s', (_label, reply) => {
    expect(detectTrailingContinueQuestion(reply)).toBeNull();
  });
});
