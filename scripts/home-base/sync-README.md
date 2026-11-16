# Home-base agent setup sync

This helper is prepared but has not been installed into James's global sync script or run against the test Mac.
The browser-rule sentence and reminder hook must first have the approval recorded by the owning plan.
Credential provisioning and account sign-ins remain separate steps.

Run from this checkout:

```sh
node scripts/home-base/sync-agent-setup.js inspect
node scripts/home-base/sync-agent-setup.js sync --remote ct-test-mac --destination-home /Users/suas --remote-node /absolute/path/to/node
node scripts/home-base/sync-agent-setup.js install-hook --remote ct-test-mac --destination-home /Users/suas --remote-node /absolute/path/to/node
```

`inspect` reads only approved source paths. It never prints file contents or environment values. On refusal it prints
at most six filenames/reasons and writes the complete filename-only list into the ignored
`_scratch/home-base/sync-refusals.log` with owner-only permissions. A refusal stops the complete transfer. Source
inspection now passes after separately reviewing and sanitising ambiguous examples and memory labels, moving a
historical credential into the organisation vault, and archiving an unusable skill link. This is a source inspection,
not evidence that a setup copy has run. Known OS metadata, caches and historical memory backups are omitted.

A skill excluded by the existing direct-control policy contributes no supporting files or assets to the package,
even when its forbidden instructions appear after a refused resource in directory order. All retained text still
passes credential validation. Structured configurations are checked as parsed keys and string values, avoiding
false positives from serialised quotes. Complete environment references and empty shell defaults carry no literal
credential; malformed or nonempty fallbacks and literal additions are refused.
Command strings are also tokenised without execution, using the pinned `shell-quote` parser bundled into the receiver.
This retains adjacent quote boundaries and expansion provenance, so a literal suffix cannot hide beside a quoted
environment reference. Credential flags require a complete dynamic value; encoded words and nested command strings
are inspected too. Continued strings, comments in credential-bearing commands and unsupported
expansions require separate provisioning because the parser does not reproduce every shell's interpretation.
Credential assignments also require an entirely dynamic value. Inline substitutions are refused except the reviewed
Keychain lookup (`security find-generic-password -w -s <service> 2>/dev/null || true`) and credential-file read
(`tr -d '\r\n' < /absolute/file`) forms already used by this setup. Their full parsed argument/operator lists are
checked, then treated as dynamic words; extra commands, substitutions and literal suffixes are refused. No credential
lookup or command is executed while preparing or applying a package.
Credential checks retain flag/value context across command-argument arrays and reject numeric or other scalar
credentials as well as strings. Credential names in camel case and common header fields receive the same checks;
ordinary metadata and token-count settings retain their normal meaning.

The transfer format is version 2, sent together with its matching apply code. Text stays in the text-file collection;
reviewed binary assets have a separate bounded base64 collection. The only approved asset is the PDF skill icon at
`.codex/skills/pdf/assets/pdf.png`, pinned by its exact byte count and SHA-256 in `sync-assets.js` after visual review.
Both source and destination verify that pin, and destination validation completes before any setup write. Other
binary paths, changed bytes, malformed encoding and duplicate paths are refused. This does not permit arbitrary PNGs.
Destination aliases are resolved during preflight. Incoming text cannot redirect writes into account state or a
different kind of setup folder, and binary assets cannot use destination aliases. Intentional shared skill folders
and named-profile settings links remain supported without overwriting local sign-in data.

`sync` checks the saved SSH connection without a password prompt, bundles the remote apply code in memory, and sends
only the approved package over SSH stdin. The destination needs Node 22 or newer; `--remote-node /absolute/node/path`
selects a non-default installation. A failed connection preflight reports a skipped sync. A refusal or apply failure
fails the command; it never reports the home base down. No source login file, cookie, `.claude.json`, credential file,
provider account home or secret-valued environment entry enters the package.
The installed hook retains the selected remote Node path, including spaces or quotes; its future runs do not depend
on that executable being on the remote noninteractive shell's PATH.

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
