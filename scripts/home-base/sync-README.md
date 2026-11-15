# Home-base agent setup sync

This helper is prepared but has not been installed into James's global sync script or run against the test Mac.
The browser-rule sentence and reminder hook must first have the approval recorded by the owning plan.
Credential provisioning and account sign-ins remain separate steps.

Run from this checkout:

```sh
node scripts/home-base/sync-agent-setup.js inspect
node scripts/home-base/sync-agent-setup.js sync --remote ct-test-mac --destination-home /Users/suas
node scripts/home-base/sync-agent-setup.js install-hook --remote ct-test-mac --destination-home /Users/suas
```

`inspect` reads only approved source paths. It never prints file contents or environment values. On refusal it prints
at most six filenames/reasons and writes the complete filename-only list into the ignored
`_scratch/home-base/sync-refusals.log` with owner-only permissions. A refusal stops the complete transfer. Current
source inspection does refuse reference documents and memories containing credential-shaped examples, unsupported
assets, and a broken skill link. These need separate review/sanitisation; this is not evidence those files hold real
credentials, and it is not a successful setup copy. Known OS metadata, caches and backup files are omitted.

`sync` checks the saved SSH connection without a password prompt, bundles the remote apply code in memory, and sends
only the approved package over SSH stdin. The destination needs Node 22 or newer; `--remote-node /absolute/node/path`
selects a non-default installation. A failed connection preflight reports a skipped sync. A refusal or apply failure
fails the command; it never reports the home base down. No source login file, cookie, `.claude.json`, credential file,
provider account home or secret-valued environment entry enters the package.

The destination filters its own existing Claude and Codex configs, including known named-account roots, locally.
Its sign-in fields stay local and its credential-valued config fields are retained when approved setup is merged.
Shared settings symlinks inside the destination home are retained. Unknown bundled plugins cause a refusal; known
browser/desktop plugins are explicitly disabled while known document/visual plugins retain their state. Known native
Messages/provider-app/desktop-capture plugins are also disabled because they bypass the gateway. The current bundled
plugin directory is checked on each sync. MCP browser drivers, direct-browser skills, hooks and commands are filtered
from both copied setup and existing default/named homes. Unknown paths outside the destination home are refused.

Only settings belonging to the computer are merged; no Harness settings or permission rules are copied by this tool.
Source entries requiring absent Mac-only paths are omitted with an explicit report, or refused if the missing path
would leave an environment-dependent configuration broken. Required tools/scripts must be provisioned separately.

Project memory goes one way. A newer destination file wins, destination-only files are retained, and `MEMORY.md` is
merged by distinct line. New rules use the same instruction links as the source. Codex skill links are materialised
from approved skill roots; links to unknown sources are refused.

All package paths, links and destination configs are checked before the first write. Configuration changes detected
during preflight abort the run so an account refresh is not overwritten. Run setup sync when CLI configuration is
idle. File writes use owner-only temporary files and rename; an external filesystem failure during apply can still
leave a partial update and must be inspected before retrying. The sync never deletes memories. Its only removals are
forbidden browser/desktop setup files and skills named in the policy.

`install-hook` adds or replaces one marked invocation at the end of `~/.agents/sync-tool-files.sh`, retaining the
existing Copilot/Grok/Cursor refresh. It is idempotent and does not edit the global browser wording itself. Its path
points at this checkout, so the checkout must remain available. Do not install the hook before its required approval
and source refusals have been resolved.
