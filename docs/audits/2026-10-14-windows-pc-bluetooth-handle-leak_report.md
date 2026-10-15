# windows-pc: MediaTek Bluetooth service handle leak

Date: 2026-10-14. Investigated remotely and read-only. Nothing on the PC was changed, restarted or installed.

## For James: what is wrong, does it matter, what to do

Times below are UK time (BST).

**What is wrong.** A small background program that comes with the PC's MediaTek Bluetooth driver
keeps creating Windows "event" objects (simple on/off signals) and never throws them away. It adds
somewhere between 4,000 and 13,000 an hour for most of the time measured. It sometimes runs faster
for short spells, for example about 32,000 an hour for five minutes, 50 minutes after today's restart. It also climbs very fast in the first few minutes after the PC starts: about 12,000 within seven minutes of starting on 12 October. On a few occasions it jumped by between 5,000 and 73,000
within ten minutes. Those jumps happened at the same time as Windows or Microsoft Store updates, but
that may be coincidence. The count only drops back to a low number when the PC, or that background program, restarts. Your PC has the
version of this program from autumn 2025. The motherboard maker has released two newer versions
since then.

**Is it what makes the PC drop out?** Probably not, though one of the three drop-outs can't be
ruled out.

- **Today's drop-out (14 October, 10:44):** a Windows Update restart to finish installing this
  month's security update. It shut down cleanly, restarted three times to finish installing, and
  came back. It was not a crash. I can't tell whether Windows did it on its own or someone clicked
  "Restart now": someone unlocked the PC at 10:18. Your "active hours" are 15:00 to 09:00, so if it
  was automatic, Windows was allowed to do it mid-morning.
- **7 October, about 17:43:** the PC stopped responding and you had to power it off (you confirmed this on 8 October; the logs alone can't tell a freeze from a power cut). But it happened only four
  hours after a restart, when the leak would have been somewhere around 30,000 to 65,000. This week
  the PC ran fine for 34 hours with almost 382,000, so the leak is very unlikely to explain that
  freeze.
- **12 October, about 19:59: a second sudden stop that we had not spotted before.** The PC stopped
  logging. At the next start, just after midnight, Windows recorded that it had not shut down
  properly. From the logs alone I can't tell whether it froze or lost power. This one came after
  five days without a restart. The leak was only measured on that boot's first day (about 130,000 on 8 October), but by the stop would have been somewhere
  between 600,000 and 1.4 million. That is far more than we have ever seen, so I can't rule it out.
  I still think it is unlikely. Windows allows each program about 16 million of these. Even at the
  high end, my rough, unmeasured estimate is a few hundred megabytes of the PC's 192 gigabytes of
  memory.
- Neither stop left a blue-screen record, a crash dump in the places I could check, or a hardware-error record. These stops need
  their own investigation. This leak is a nuisance and probably not the cause.

**What to do, from least to most disruptive:**

1. **Leave it.** Nothing went wrong at the levels we actually measured (up to about 382,000), and any
   restart resets it. The open risk is a PC that stays on for many days, where the count is untested.
2. **Update the Bluetooth driver to version 1.1147.0.610** from the ASUS page for your board (ROG
   Crosshair X870E Hero, released 16 July 2026). You have 1.1044.0.556. The update replaces the
   leaking program: yours is 1.0.0.2, the new one is 1.0.0.7. **This is what I recommend trying
   first.** It is the official driver for your board, the old driver stays on the PC so it can be put back, and checking the result is
   simple. Be clear that it is only a *possible* fix. Nothing public says the leak was fixed, and a
   quick look at the new program found no obvious sign of a fix. Bluetooth will probably drop
   briefly while it installs, and it may ask for a restart.
3. **If the update doesn't stop it,** schedule a nightly restart of just this background service
   (4am, for example) as a stop-gap. It needs an administrator window once to set up.
4. **Stop the background service** (set it to start manually). This is the only option certain to
   stop the leak. Bluetooth itself probably keeps working, because the service seems to handle extras
   such as region settings, Wi-Fi/Bluetooth coordination and Bluetooth audio. That is not tested.
   Check the Xbox controller afterwards.
5. **Turn Bluetooth off completely.** Only sensible if you don't use it. The PC has an Xbox Wireless
   Controller paired, and six other remembered devices whose names came back blank. If you use the
   controller or any Bluetooth headphones, don't do this. Turning the adapter off may not stop the
   background service on its own, so do this together with option 4.

Options 2 to 5 need an administrator window, which on this PC signs in as `CTAdmin`. I haven't done
any of them. The exact steps are at the end, marked "not run".

---

## Evidence

### How this was gathered

- windows-pc was connected throughout (node `bb62e3ee-…`, booted 2026-10-14 09:48:44Z).
- Five read-only PowerShell scripts were uploaded to `C:\Users\shutu\.orchestrator\_scratch\aio-transfers\`.
  Four of them ran (A, B, C and D; C was uploaded as `btleak-c2-bursts.ps1`, local copy `btleak-c-bursts.ps1`); the fifth, a tool search, never started. The antigravity CLI ran
  them via `run_on_node`, and the results were written to
  `...\aio-transfers\btleak-out\` and downloaded. Local copies of the scripts and raw outputs are in
  `_scratch/btleak/` (gitignored scratch).
- No elevated (administrator) command was run. Nothing was installed or downloaded on the PC.

### Corrections to the brief

- The `[HostHealth]` history does not go back to 2026-10-08. The first `[HostHealth]` line in any
  worker log is **2026-10-12 23:11:05Z**, six minutes after the worker started on that boot. Earlier
  worker runs (10-08 07:43, 21:22, 21:30, 10-11 10:38) logged no samples, so the sampler only reached
  this PC's build on 10-12. The history therefore covers one full boot (10-12 23:04 to 10-14 09:44)
  plus the current one.
- The two "2026-10-07" counts in the brief (127,519, then 132,873) were taken on the morning of
  **10-08**, about 15 hours after the 10-07 16:58 boot. Source: the earlier outage note. The
  timestamps were not re-checked against raw data because no sampler data exists for that boot.
- The cause of today's restart is now known (see Outages below).
- There was a further unexpected shutdown on **2026-10-12** that the brief did not list.

### 1. Leak rate over time

Boot of 2026-10-12 23:04:03Z (from Kernel-General 12). 416 samples, no gaps over 6 minutes until
09:39:56Z on 10-14.

| Hours since boot | Time (UTC) | `mtkbtsvc` handles |
| ---: | --- | ---: |
| 0.1 | 10-12 23:11 | 12,216 |
| 1 | 10-13 00:04 | 18,354 |
| 2 | 10-13 01:04 | 23,063 |
| 4 | 10-13 03:04 | 31,821 |
| 8 | 10-13 07:05 | 49,728 |
| 12 | 10-13 11:03 | 66,773 |
| 16 | 10-13 15:04 | 92,491 |
| 20 | 10-13 19:04 | 110,265 |
| 24 | 10-13 23:05 | 129,403 |
| 28 | 10-14 03:06 | 173,165 |
| 32 | 10-14 07:01 | 289,274 |
| 34.6 | 10-14 09:39:56 (last sample before the Windows Update restart) | **381,956** |

Current boot (2026-10-14 09:48:44Z):

| Hours since boot | Time (UTC) | `mtkbtsvc` handles | Source |
| ---: | --- | ---: | --- |
| 0.9 | 10:41:25 | 17,658 | worker log |
| 1.6 | 11:26:40 | 28,279 | worker log |
| 2.05 | 11:51:48 | 32,433 | coordinator heartbeat (`_scratch/btleak/coordinator-hosthealth-snapshots.txt`) |
| 2.1 | 11:56:50 | 33,406 | coordinator heartbeat |

**Shape:** steady growth with occasional bursts on top. The count never fell.

- **Baseline, and a step change:**
  - On the 10-12 boot the 5-minute growth was about 4,300/hour (median) until **10-14 02:06Z**.
  - From then on it was about 11,300/hour (median of 92 intervals), with no burst at the change
    (02:01 161,005, 02:06 161,752, 02:11 162,690).
  - The higher rate continued after the 09:44 restart. On the current boot the 5-minute samples run
    at about 11,000 to 13,400/hour, mostly 11,000 to 12,500. The exception is the first sampled
    interval (10:41:25 to 10:46:26Z, about 52 minutes after boot and a minute after the worker
    started): +2,653, about 31,700/hour.
  - The first minutes after boot are faster still. On the 10-12 boot the count was already 12,216
    at the first sample, about 7 minutes after boot (roughly 100,000+/hour on average).
  - Something that persisted across the reboot changed at about 02:00Z. I did not look at the event
    logs for that time, so it is an open lead.
- **Short measurements are noisy:**
  - 11:30 to 11:32Z: +99 in 90 seconds (about 4,000/hour).
  - 11:42Z: +28 to +35 every 10 seconds (about 10,800/hour).
  - 11:30 to 11:43Z overall: about 2.15 a second (about 7,700/hour).
- **Bursts, all on the 10-12 boot:**

  | When (UTC) | Increase |
  | --- | ---: |
  | 10-13 11:58 to 12:03 | +5,265 |
  | 10-14 00:20 to 00:25 | +18,609 |
  | 10-14 05:06 to 05:16 | +73,005 |
  | 10-14 08:49 to 08:59 | +63,307 |

- **What the bursts coincide with.** This is correlation only: I did not compare with quiet windows,
  and servicing at other times did not always cause a burst. For example, the October security
  update KB5127648 shows as installed at 07:57:49Z in the update history, and the 5-minute interval
  containing that time (07:57:07 to 08:02:07Z) grew by only +946. Windows Update's "Installation
  Successful" event for the same update is logged at 09:49:26Z, after the restart.
  - 10-13 11:58 to 12:03: Microsoft Store app installs (Install-Agent 2005/2006, AppXDeployment),
    plus signs of someone using the PC.
    - 11:58:16: Windows logged keyboard or mouse input changing its idle state (Kernel-Power 566
      "InputHid", session 4 to 6).
    - 11:58:22: the camera service started.
    - Outlook and audio events.

    User activity is as plausible a trigger as the Store installs.
  - 10-14 00:20 to 00:25: System Restore events (probably a restore point, inferred from event IDs only), VSS, and Windows servicing.
  - 10-14 05:06 to 05:16: Windows servicing (85 Setup `Servicing` events) and Store updates.
  - 10-14 08:49 to 08:59: servicing, System Restore event 8216 (probably a restore point, inferred from the ID), Windows Update client
    events, and a Defender signature update at 08:59:38. The earlier diagnostic session was also
    running then: the brief's 320,791 is exactly the 08:54:48 sample.

  None lined up with Bluetooth events in the uncapped BTH/MediaTek System-log read. The event listing for each window was capped at 60
  entries, so I can't say whether there was user input in the last three windows.
- **Sleep and Bluetooth devices.** A targeted sleep/wake query (Kernel-Power 42, 107, 506 and 507)
  found none from 10-12 16:30 to 10-13 12:00, which covers the first burst only. For the three 10-14
  bursts, the per-window listings were capped (top 40 groups, first 60 events, 400 per log), so the
  absence of sleep events there is unproven. In the uncapped System-log read of the BTH and MediaTek
  providers, Bluetooth events appear only at boot.
  The only Wi-Fi driver activity during that boot was a burst of nine `mtkwecx` roam, connect and
  disassociate events at 10-13 02:53:22 to 02:53:28, which doesn't match any burst.
- **Five kinds of read-only query are not the trigger.** In a controlled test at 11:42Z, each of the
  following produced +30 to +42 per 10 s, against +28 to +35 at idle. Only `Win32_PnPSignedDriver`
  was slightly higher (+42), which is probably noise:
  - `Get-PnpDevice`
  - `Win32_PnPSignedDriver`
  - `pnputil /enum-drivers`
  - `Get-NetAdapter` plus `netsh wlan show interfaces`
  - `Get-Process` plus `Win32_Process`

  An earlier attempt at this experiment, in script C, recorded blank values because of a script bug.
  This rules out those query types only. It does not prove the earlier session's other activity
  played no part in the 08:54 to 08:59 burst.

**Count just before each outage:**

| Outage | Uptime at outage | `mtkbtsvc` handles |
| --- | --- | --- |
| 10-07 ~16:43 hang | 4.0 h (booted 12:43:32Z) | Not measured. The 10-12 boot was at 31,821 at 4 h. The faster rate seen since 10-14 02:06 (about 11–12k/h) would give about 55–65k. Estimate: 30–65k. |
| 10-12 ~18:59 hang | 122 h (booted 10-07 16:58:31Z, no reboot in between) | Not measured. 127.5k at about 15 h on that boot (earlier note). Extrapolates to roughly 0.6 to 1.4 million (an estimate). |
| 10-14 09:44 Windows Update restart | 34.7 h | **381,956** (measured 09:39:56Z) |

### 2. What the handles are

Sysinternals `handle.exe` is not needed for this question. Windows' own handle table was read with
`NtQuerySystemInformation(SystemExtendedHandleInformation)` plus `NtQueryObject(ObjectTypesInformation)`
from a compiled C# snippet. This lists every handle's owner process and object type without opening
the process, and needs no admin rights. Kernel object addresses came back as zero (normal for a
non-admin caller on 24H2), so object names are not available.

Snapshot at 11:30:34Z, PID 6368:

| Type | Count | Access mask |
| --- | ---: | --- |
| **Event** | **28,932** (99.7 %) | all `0x001F0003` (EVENT_ALL_ACCESS) |
| EtwRegistration | 40 | |
| Key | 10 | |
| WaitCompletionPacket | 8 | |
| Mutant | 6 | |
| IRTimer | 6 | |
| everything else | 17 | |

90 seconds later the total was 29,118, and **Event was the only type that grew** (+99). The service
runs as LocalSystem with only **2 threads**, 1.3 MB of private memory, and 7.6 KB of non-paged
quota. So this is one code path creating an event (e.g. `CreateEvent`) and never closing it, rather
than threads or files piling up.

The research helper read strings in the binary (not verified by disassembly): `CreateEventA`,
`WaitForMultipleObjects`, `RegNotifyChangeKeyValue`, plus watches on Wi-Fi region and AMD/NVIDIA audio
services. A registry-watch loop that creates a new event each time it re-arms, without closing the
old one, would match both the steady rate and the bursts during servicing, which writes heavily to
the registry. That is a hypothesis. Naming the exact event would need an admin `handle.exe -a -p 6368`
run. That is not needed to decide what to do.

`handle.exe` presence is **not established**. The first search was cut off when its run was
terminated. A dedicated read-only search script (`btleak-e-tools.ps1`) was uploaded, but both launch
attempts timed out in the orchestrator before the job started, and no result file was ever written.
Nothing was downloaded or installed. If James wants the event names, Sysinternals Handle (or Process
Explorer) run as administrator would show them. It is not required for any recommendation here.

### 3. Which driver this is

| Item | Value |
| --- | --- |
| Service | `MTKBTSVC` ("MTKBTSVC"). Auto start, LocalSystem, PID 6368, own process, no dependencies or dependents, no failure actions |
| Binary | `C:\WINDOWS\System32\mtkbtsvc.exe`, 535,432 bytes, file date 2025-10-01 17:54:48Z |
| File version | **1.0.0.2**, "MediaTek Bluetooth Service Application", MediaTek Inc. |
| Signature | Valid, catalog-signed by Microsoft Windows Hardware Compatibility Publisher |
| Bluetooth adapter | "MediaTek Bluetooth Adapter" `USB\VID_0489&PID_E13A&MI_00` (the Bluetooth half of the on-board MT7927 Wi-Fi 7 card) |
| Bluetooth driver | `mtkbtfilter.inf` (oem88.inf) **1.1044.0.556**, dated 2025-09-17. Older 1.1043.0.542 (oem116.inf) is still in the driver store |
| Bluetooth audio driver | `mtkbtacx.inf` (oem90.inf) 1.5.0.46, dated 2025-09-17 |
| Wi-Fi | MediaTek Wi-Fi 7 MT7927, `mtkwecx.inf` 5.7.0.4669 (2025-09-27). ASUS latest is 5.7.0.6054 (2026-07-16) |
| Board / BIOS | ASUS ROG CROSSHAIR X870E HERO, BIOS 2202 (2026-09-04) |
| Windows | 24H2 build 26100.9711 (the October security update installed today) |

Install history:

- Windows Update history (last 400 entries) shows **no** MediaTek driver installs, so 1.1044.0.556
  came from a manual or ASUS install, or from an update older than that history.
- The only driver entry in that history is an NVIDIA display driver on 2026-09-18, and it
  **failed** (result code 4).
- The Bluetooth adapter's own record (Get-PnpDeviceProperty) shows:
  - first install 2025-02-20 04:31:44
  - current driver installed 2025-12-22 21:09:15
  - driver 1.1044.0.556, dated 2025-09-17, `oem88.inf`

  The 22 December 2025 date is probably when the current driver (and so the leaking program) arrived.
  That is not certain, for two reasons:
  - This property records the device's install date, not strictly the driver's.
  - The older 1.1043.0.542 package (`oem116.inf`) is also still in the driver store. The `oemNN`
    numbers can be reused, so they don't show which package arrived first.
- `setupapi.dev.log` gave no matching install sections. The search may simply have missed them.

Current versions, checked directly with ASUS's driver API for this exact board (GetPDDrivers, model
ROG-CROSSHAIR-X870E-HERO, Windows 11 64-bit):

| ASUS Bluetooth package | Released | `mtkbtsvc.exe` inside |
| --- | --- | --- |
| **1.1147.0.610** (latest) | 2026-07-16 | **1.0.0.7**, 545,216 bytes |
| 1.1146.0.576 | 2026-04-20 | 1.0.0.5, 536,512 bytes |
| 1.1044.0.556 (installed) | not listed for this board (ASUS lists it for other X870/B850 boards) | 535,432 bytes dated 2025-10-01 17:54, the same size and date as the installed 1.0.0.2 file |
| 1.1043.0.542 | 2025-07-09 | none. The 1.1038, 1.1041 and 1.1043 zips contain only `mtkbtfilter.inf` and the driver, with no service |

How the newest package was checked:

- The 1.1147.0.610 zip is byte-for-byte the size of ASUS's file for this board: 7,142,068 bytes,
  last modified 2026-07-16.
- Its `mtkbtfilter.inf` explicitly lists this adapter's hardware ID `USB\VID_0489&PID_E13A&MI_00`.
- Its `Install.bat` runs `pnputil -a "%~dp0BT\*.inf" /install` and does the same for the `ACX`
  folder. It also tries an Intel `Non-Production\IntelMvaExtensionInf` pnputil, an `ICPS_UWD` pnputil,
  a `dism /Add-ProvisionedAppxPackage ... ICPS.appx`, and a `pnputil /add-driver .\UWD\Win64\DRIVERS\*.inf`.
  Those folders are not in this package, so they would only print errors. The Option 2 commands below call pnputil for `BT` and `ACX` directly
  instead.

The Microsoft Update Catalog has newer builds of the same family (26.40.3.69, 2026-08-24, per the
research helper, not re-checked).

### 4. Did it cause the outages?

| Outage | Verdict | Evidence |
| --- | --- | --- |
| **2026-10-07 12:37 to 12:44Z** | Restart started from the Start menu to finish an update (James confirmed this on 10-08, per the earlier note). Not a fault | User32 1074 at 12:37:10, StartMenuExperienceHost on behalf of `shutu`. Then two TrustedInstaller "Upgrade (Planned)" restarts at 12:41:16 and 12:42:38. Clean shutdowns (6006, 109, 13). KB5124010 had installed at 11:34. |
| **2026-10-07 ~16:43Z** | **Hang or sudden power-off, no blue screen.** Leak **not plausible** as the cause | Last worker log line 16:42:55 (it logs every 60 s). Next boot 16:58:31. Kernel-Power 41 with BugcheckCode=0 and PowerButtonTimestamp=0. EventLog 6008. No minidump (newest is from 2025-07-23) and no `MEMORY.DMP`. `C:\Windows\LiveKernelReports` returned nothing to the non-admin listing, although WER references files in it, so that folder is effectively unread. No WHEA hardware errors since 10-01. No Resource-Exhaustion-Detector 2004. No System events between the Tcpip 4266 at 16:21:27 and the reboot. The Application log has routine licensing (SPP) events at 16:37 to 16:38. The 48 WER "BlueScreen/LiveKernelEvent" entries at 16:28 are old 2025 reports being re-sent: 47 of 48 attach files dated 2025. One is a LiveKernelEvent 141 (a graphics-driver timeout the system recovered from) whose file is dated 2026-09-16. That is weeks before this crash, but it may be worth a look in the separate freeze investigation. The 6008 says the unexpected shutdown was at "17:03:59 on 07/10" local, which is 16:03:59Z. That is 39 minutes **before** the worker's last log line, so for this crash the 6008 time is stale. It probably comes from a periodic "last alive" stamp, which on 10-12 happened to fall within 30 s of the stop; I haven't confirmed how often that stamp is written. The worker log (alive at 16:42:55) is the better clock. Uptime was only about 4 h, so `mtkbtsvc` was at roughly 30–65k handles, well below the 382k the PC ran with this week. That makes the leak very unlikely as the cause. |
| **2026-10-12 ~18:59Z** (new) | **Hang or sudden power-off, no blue screen.** Leak contribution **not proven either way, but unlikely** | Worker vitals log every minute until 18:58:21Z, then stop. 6008: "previous system shutdown at 19:58:49 on 12/10/2026 was unexpected" (local time, BST, = 18:58:49Z). Next boot 23:04:03Z with Kernel-Power 41, BugcheckCode=0, PowerButtonTimestamp=0. No minidump or `MEMORY.DMP` (LiveKernelReports unread), no WHEA, no 2004. Nothing unusual in System or Application from 18:30Z; the last events were routine BITS start-type changes at 18:37 to 18:39 and licensing (SPP) at 18:53, after filtering out four high-volume providers as noise: HttpService, googledrivefs, Kernel-Processor-Power and DistributedCOM. These logs cannot tell a freeze from a sudden power loss. Uptime was 122 h, so the leak was probably 0.6 to 1.4 million (an extrapolation: no sampler ran that week). That is about 4 to 8 % of the ~16.7 million per-process limit. My rough, unmeasured estimate is a few hundred MB of kernel memory on a 192 GB machine. Missing warnings prove little here, because a PC that hangs may not get the chance to log one. |
| **2026-10-14 09:44Z** | **Windows Update restart** (automatic or a "Restart now" click; not distinguishable). Not a fault and not the leak | User32 1074 at 09:44:05 by `C:\WINDOWS\uus\AMD64\MoUsoCoreWorker.exe` on behalf of SYSTEM, "Operating System: Service pack (Planned)". Clean shutdown (6006 09:44:59, 109, 13 at 09:45:07). Then two TrustedInstaller "Upgrade (Planned)" restarts at 09:46:24 and 09:47:50. Final boot 09:48:44. KB5127648 (26100.9711) installed at 07:57Z. Someone was at the PC: Kernel-Power 566 "SessionUnlock" at 09:18:02Z. A 566 "InputHid" was logged 0.66 s after the 1074, but that may be part of the shutdown itself. So a user clicking "Restart now" can't be excluded. Active hours are 15:00 to 09:00 (`ActiveHoursStart=15`, `End=9`), so an automatic 10:44 BST restart would have been allowed. Worker back at logon 10:40Z. |

Other notes:

- **UDP port exhaustion (Tcpip 4266)** was logged 10 times since 10-02, roughly once a day:
  10-02, 10-03, 10-05, 10-06, 10-07 16:21, 10-08, 10-10, 10-11, 10-12 15:48 and 10-13 09:06. Only one
  falls near a freeze (10-07, 22 minutes before). The earlier note's second 10-07 entry at 22:48 is
  not in the System log now. So it does not line up with the freezes. `mtkbtsvc` cannot be the
  cause, because it holds only 2 File-type handles in total, so almost no network sockets. It is a
  separate, unexplained issue.
- **Both Kernel-Power 41 records show `ConnectedStandbyInProgress=true`**, but `powercfg /a` reports
  this PC uses S3 standby. There were no sleep or wake events (Kernel-Power 42/107/506/507,
  Power-Troubleshooter 1) near either freeze. I can't interpret that flag reliably on this PC. It is
  a lead for the freeze investigation, not a finding.
- **BTHUSB events at every boot:** event 18 ("cannot store link keys on the local adapter") and four
  event 5s ("expected an HCI event with a certain size"). These appear on every boot, including all
  the healthy ones, and never at any other time. They are not linked to the freezes.
- **MTKBTSVC's own events:** at every boot in the windows read, the service writes four Application
  events (IDs 5, 2, 2, 5) with no text. This includes the boot after the 7 October hang (16:59:02Z).
  Nothing else from the service appears in the logs around either stop.
- **Another session was checking memory settings and hardware errors** on this PC during this
  investigation (a separate `run_on_node` job). Independently, this investigation found **no WHEA
  (hardware error) events since 2026-10-01**.

### 5. Is Bluetooth needed?

Paired or known devices:

- **Xbox Wireless Controller** (Bluetooth LE, `ac8ebd34402c`). Present with its HID/XINPUT device,
  so it is set up as a game controller.
- Six further addresses are remembered in `BTHPORT\Parameters\Devices`. Their names came back blank
  for reasons I don't know: the same script read the Xbox controller's name from the same place, and
  errors were silenced. The addresses are: `9cdf0333ff68`, `b4b8591cc9c2`, `bc7536411eba`, `bc75365f9c82`, `bc7536be9134`,
  `f81a2bfb7078`.
- The MediaTek Bluetooth Audio (LE Audio) driver is installed. That doesn't prove anything is
  using it.

Whether any of these are in use needs James. Turning Bluetooth off is only reasonable if he never
uses the controller or any Bluetooth audio.

### 6. Is it a known issue?

**What I confirmed myself:**

- I listed the ASUS zips the research helper downloaded. The service first appears in the 1.1044
  package and is absent from 1.1038, 1.1041 and 1.1043.
- It has been revised twice since: 1.0.0.5 in 1.1146 and 1.0.0.7 in 1.1147. I read these version
  numbers from the files myself.

**What I could not open (search-result snippets only, collected by a research helper):**

- Reddit r/pcmasterrace, 2026-04-05, "mtkbtsvc.exe keeps leaking handles". Handles climb steadily
  while idle. Reinstalling didn't help. The top suggestions were the generic Microsoft Bluetooth
  driver or disabling the service.
- linux.do, 2026-06-26: an HP laptop where mtkbtsvc handles overflowed at every boot until the
  system froze. The workaround was ending the process after each boot.

**What I could not find:** no MediaTek, ASUS or Microsoft release note mentions a handle-leak fix.
My own web searches for the process name with "handle leak" found nothing specific. So whether
1.0.0.7 fixes it is **unknown until tested**. A second reviewer compared the three versions' text. The functions that
create and wait on events (`CreateEventA`, `RegNotifyChangeKeyValue`, `WaitForMultipleObjects`)
appear the same number of times in 1.0.0.2, 1.0.0.5 and 1.0.0.7. The added text looks like new
features, not a fix. That is weak evidence, but it argues against assuming the update fixes the
leak.

---

## Exact steps for each option (none of these has been run)

Options 2 to 5 need an administrator PowerShell window, which signs in as `CTAdmin`. Paths below use
`C:\Users\shutu\...` explicitly for that reason.

### Option 1: leave it

Nothing to do. To check the leak at any time, run this without admin rights:

```powershell
(Get-Process mtkbtsvc).HandleCount
```

### Option 2: update the Bluetooth driver to 1.1147.0.610 (recommended). NOT RUN

The simple way:

1. Download "MTK Bluetooth Driver V1.1147.0.610" from the ASUS support page for the ROG CROSSHAIR
   X870E HERO.
2. Unzip it and double-click `AsusSetup.exe`.
3. Restart if asked.

The equivalent commands:

```powershell
# Admin PowerShell (CTAdmin)
$zip = 'C:\Users\shutu\Downloads\DRV_Bluetooth_MTK_MT7925_27_TP_W11_64_V111470610_20260706R.zip'
Invoke-WebRequest 'https://dlcdnets.asus.com/pub/ASUS/mb/02BT/DRV_Bluetooth_MTK_MT7925_27_TP_W11_64_V111470610_20260706R.zip' -OutFile $zip -UseBasicParsing
(Get-Item $zip).Length                               # expect 7142068
(Get-FileHash $zip -Algorithm SHA256).Hash           # expect FC088966F2357AF65F16F48178E047FA553ED5EABAD34BCF0C7AB4CE2033435A
$dir = 'C:\Users\shutu\Downloads\mtkbt-1.1147.0.610'
Expand-Archive $zip -DestinationPath $dir
pnputil /add-driver "$dir\BT\*.inf" /install    # Bluetooth driver + MTKBTSVC service
pnputil /add-driver "$dir\ACX\*.inf" /install   # MediaTek Bluetooth audio driver
# (ASUS's own Install.bat or AsusSetup.exe does the same, plus some steps for files that aren't in this package)
```

Check it worked. Restart the PC first if the installer asked for it: the old program is in use, so
the version may not change until a restart. This is an inference, not tested.

```powershell
(Get-Item C:\Windows\System32\mtkbtsvc.exe).VersionInfo.FileVersion   # expect 1.0.0.7
Get-PnpDevice -FriendlyName 'MediaTek Bluetooth Adapter' | Get-PnpDeviceProperty -KeyName DEVPKEY_Device_DriverVersion   # expect 1.1147.0.610
(Get-Process mtkbtsvc).HandleCount   # repeat after an hour
```

How to judge success: no healthy start-up level has been measured, and the count is already
12,000 to 18,000 within the first hour after a boot. So don't judge by the absolute number.

1. Wait about 15 minutes after the restart.
2. Read `(Get-Process mtkbtsvc).HandleCount`.
3. Read it again an hour later.

Before the update it grew by at least 4,000 an hour, and recently by about 11,000. Little or no growth
between the two readings means the update worked. The worker's `[HostHealth]` lines list only the top
three handle holders, so `mtkbtsvc` may stop appearing in them. Use `Get-Process` to confirm rather
than reading anything into that.

To roll back, try one of these:

- Device Manager, MediaTek Bluetooth Adapter, Driver, Roll Back Driver. This may not be offered for a
  driver added with pnputil.
- Device Manager, Update driver, Browse, "Let me pick", and choose 1.1044.0.556 (`oem88.inf`, still in
  the driver store).
- Use `pnputil /enum-drivers` to find the new `oemNN.inf`, then run
  `pnputil /delete-driver oemNN.inf /uninstall`.

### Option 3: nightly restart of the service (stop-gap). NOT RUN

```powershell
# Admin PowerShell (CTAdmin)
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -Command "Restart-Service -Name MTKBTSVC -Force"'
$trigger = New-ScheduledTaskTrigger -Daily -At 4am
Register-ScheduledTask -TaskName 'Restart MTKBTSVC (handle leak stop-gap)' -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest
# Undo:
# Unregister-ScheduledTask -TaskName 'Restart MTKBTSVC (handle leak stop-gap)' -Confirm:$false
```

Restarting the service may briefly interrupt Bluetooth devices. That is untested. Run it once by hand
while using the controller to see.

### Option 4: stop the service and set it to manual. NOT RUN

```powershell
# Admin PowerShell (CTAdmin)
Stop-Service -Name MTKBTSVC -Force
Set-Service  -Name MTKBTSVC -StartupType Manual
# Then confirm the Xbox controller (and any headphones) still pair and work.
# Undo:
# Set-Service -Name MTKBTSVC -StartupType Automatic; Start-Service -Name MTKBTSVC
```

### Option 5: turn Bluetooth off completely. NOT RUN

```powershell
# Admin PowerShell (CTAdmin)
Get-PnpDevice -FriendlyName 'MediaTek Bluetooth Adapter' | Disable-PnpDevice -Confirm:$false
# Disabling the adapter may leave the auto-start MTKBTSVC service running (and leaking), so also do Option 4:
Stop-Service -Name MTKBTSVC -Force; Set-Service -Name MTKBTSVC -StartupType Manual
# Undo:
# Get-PnpDevice -FriendlyName 'MediaTek Bluetooth Adapter' | Enable-PnpDevice -Confirm:$false
# Set-Service -Name MTKBTSVC -StartupType Automatic; Start-Service -Name MTKBTSVC
```

### Not part of the fix, but related to today's drop-out

If nobody clicked "Restart now" this morning, and you want to stop Windows Update restarting the PC
mid-morning, go to Settings, Windows Update, Advanced options, Active hours. It is currently 15:00 to 09:00, which is already the
longest window Windows allows (18 hours). So it can only be moved, not made longer, and update
restarts will still happen at some point outside it. To control the timing yourself, use "Pause
updates", or "Schedule the restart" when Windows says a restart is due.
