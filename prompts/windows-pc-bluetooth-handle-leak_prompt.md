# Investigate the MediaTek Bluetooth service handle leak on windows-pc

You are investigating one specific problem on James's Windows worker PC (`windows-pc`, node id
`bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be`, Windows account `9950X3D\shutu`). Work from the AI
Orchestrator repo at `/Users/suas/work/orchestrat0r/ai-orchestrator` on the Mac.

## The question

The MediaTek Bluetooth service on windows-pc (`mtkbtsvc`) keeps opening Windows handles and
never closes them. Find out:

1. What exactly is leaking, and how fast.
2. Whether it is what makes the PC hang or reboot (it has dropped off the network several
   times, most recently today).
3. What James should do about it, ranked from least to most disruptive.

Write the answer for James in plain English first (what is wrong, does it matter, what to do),
then the evidence for anyone who wants it.

## What is already known (verify, do not trust)

| When | Handles held by `mtkbtsvc` | Context |
| --- | --- | --- |
| 2026-10-07, ~15 h after boot | 127,519 | next highest process 11.8k (UA Connect) |
| 2026-10-07, 45 min later | 132,873 | about 7,000 an hour, so a live leak |
| 2026-10-14 08:56 UTC, ~34 h after boot | 320,791 | next highest 25k (UA Connect) |
| 2026-10-14 10:43 UTC, ~55 min after a restart | 17,658 | count resets only at reboot |

Other evidence gathered earlier, all unproven as causes:

- 2026-10-07 16:43 UTC: the PC hung hard and James power-cycled it. Kernel-Power 41 with
  BugcheckCode 0 and no minidump.
- 2026-10-07: Tcpip event 4266 (UDP ephemeral ports exhausted) at 16:21 and 22:48 UTC.
- BTHUSB "HCI size" errors at boot.
- 2026-10-14: the PC went offline at about 09:44 UTC and booted again at 09:48 UTC. The worker
  came back at logon, 10:40 UTC. The cause of this restart is NOT known. A Windows Update
  restart, James restarting it, and a hang plus automatic reboot are all still possible.
- The worker logs a `[HostHealth]` line every 5 minutes with the top handle holders. These
  have been in `C:\Users\shutu\.orchestrator\logs\worker-agent.log*` since 2026-10-08, which is
  a ready-made history across several boots. The sampler is `src/worker-agent/host-health-sampler.ts`.
- Background notes: `~/.claude/projects/-Users-suas-work-orchestrat0r-ai-orchestrator/memory/windows-pc-outages-2026-10-07.md`.

## Questions to answer, with evidence

1. **Leak rate over time.** Parse every `[HostHealth]` line in the worker logs (all rotated
   files). For each boot, plot `mtkbtsvc` handle count against hours since boot (one table is
   fine). Is it steady growth, bursts, or tied to something such as sleep, a Bluetooth device
   connecting, or time of day? What count was it at just before each outage?
2. **What the handles are.** Handle count alone does not say which kind is leaking (events,
   registry keys, files, threads, sections). Check whether Sysinternals `handle.exe` is
   already on the PC. Do not download or install anything without asking James first. If
   nothing suitable is available, say what tool you need and why.
3. **Which driver this is.** Find the service name, binary path, file version, signer and file
   date. Find the Bluetooth device (likely a MediaTek Wi-Fi/Bluetooth combo chip on the
   motherboard) and its driver version and date. Find the driver install history (Windows
   Update and pnputil). Check the vendor's and the motherboard maker's current driver versions
   and any published fixes. Web search and plain fetches are fine.
4. **Did it cause the outages?** For 2026-10-07 16:43 and 2026-10-14 09:44 UTC, read the System
   and Application event logs around each time: Kernel-Power 41, EventLog 6008, User32 1074
   (and its initiating process), BugCheck 1001, WER, Tcpip 4266, resource-exhaustion events
   (Resource-Exhaustion-Detector 2004), and anything from BTHUSB or the MediaTek service.
   Answer plainly whether each outage was a restart someone chose, a Windows Update, or a
   hang/crash, and whether the handle count plausibly contributed. "Not proven either way" is an
   acceptable answer if that is what the evidence says.
5. **Is Bluetooth even needed?** List the Bluetooth devices paired with this PC. If none are in
   use, turning the service off becomes a real option.
6. **Known issue?** Search for reports of `mtkbtsvc` handle or memory leaks and which driver
   versions fixed them.

## How to work on windows-pc

- Check the worker is connected first (`list_remote_nodes`). If windows-pc is offline, stop and
  say so. Do not guess.
- Remote commands: write a read-only PowerShell `.ps1`, send it with `upload_to_node` (it lands
  in `C:\Users\shutu\.orchestrator\_scratch\aio-transfers\`), then use `run_on_node` with
  provider `antigravity` (the only CLI signed in there) and tell the agent to run exactly that
  one command and change nothing. Have the script write its results to a file in the same
  scratch folder, then `download_from_node` the file. Always address uploaded scripts by their
  exact uploaded path. Terminate each `run_on_node` instance when done.
- `exec_on_node` only runs PowerShell that prints literal text. It refuses anything that
  inspects processes, so do not use it for this.
- Antigravity turns end after about 5 minutes, so keep each script quick or split it.
- Windows PowerShell 5 turns stderr from native commands into fatal errors under
  `$ErrorActionPreference = 'Stop'`. Use `'Continue'` and check `$LASTEXITCODE`.
- The worker logs are not in a folder you can download from directly; have your script copy
  or summarise them into the scratch folder.
- If something needs an administrator window: on this PC, "Run as administrator" signs in as a
  different account (`CTAdmin`), not as `shutu`. Tell James, and do not run elevated commands
  yourself.

## Hard limits

- **Diagnose only.** Do not restart the Bluetooth service, disable it, update or uninstall
  drivers, change power settings, or restart the PC or the worker. Write the exact steps for
  each fix as a recommendation for James to approve. Restarting the service would also
  disconnect any Bluetooth devices he is using.
- **No browsers on the Mac.** Browser work, if any is needed, goes through the Windows PC via
  the Browser Gateway. Web search and plain fetches are fine.
- Never print or save secrets, tokens or passwords.
- Do not commit anything. Do not edit repo source code.

## What to hand back

Save a report as an untracked file at
`docs/audits/2026-10-14-windows-pc-bluetooth-handle-leak_report.md` and tell James its path.

Put this at the top, in plain English with no jargon:

- What is wrong (one or two sentences).
- Whether it is causing the PC to drop out, or what you could and could not prove.
- What he should do, as numbered options from least to most disruptive. For example: update
  the driver to version X from Y; restart the service on a schedule as a stop-gap; turn
  Bluetooth off if he does not use it; leave it. Say which you recommend and why.

Then the evidence: the leak-rate table, driver details, event-log findings for each outage,
and the exact commands for each option, marked "not run".
