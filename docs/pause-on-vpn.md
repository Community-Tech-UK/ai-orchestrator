# Pause on VPN

Pause on VPN stops new AI-provider traffic when the app detects that a matching VPN interface is active. It uses three layers:

- Renderer queueing for user messages while paused.
- CLI adapter and IPC gates that refuse new sends while paused.
- A main-process `http`/`https`/`fetch` network gate for non-allow-listed hosts.

## Controls

Open Settings > Network.

- Network safety: master kill switch. When off, the feature is disabled, pause reasons are cleared, the network gate is uninstalled, detector state is stopped, and persisted pause queues are cleared.
- Pause on VPN: enables automatic detector-controlled pause reasons.
- Interface pattern: regex for VPN interface names, such as `utun0`, `ipsec0`, `ppp0`, or `tap0`.
- Treat existing VPN as active: fail closed when the app starts and a matching interface already exists.
- Reachability probe: optional host:port probe for VPNs that do not expose a clear interface.
- Allow private ranges: allows RFC 1918 hosts while paused. Loopback is always allowed.

The title-bar pause button adds or removes a manual pause reason. A manual pause is independent of the VPN detector and remains paused until you resume manually or disable the feature.

## Calibration

Run this once with your work VPN.

1. Start the app with the VPN disconnected.
2. Open Settings > Network and enable detector diagnostics.
3. Connect to the VPN.
4. Open Events and look for a `pause` decision. Note the matching interface name.
5. If the default pattern did not match your VPN, update Interface pattern.
6. Disconnect the VPN and verify a `resume` decision appears.
7. Repeat with the manual pause button enabled. The app should not auto-resume while manual pause is still active.

## Guarantees

- Messages typed while paused are queued and sent after resume.
- Drained queues are deleted from disk so stale messages are not resent after restart.
- Initial prompts created while paused are routed to the renderer queue. Attachments on that path are marked as dropped instead of silently replayed without files.
- Turning the master kill switch off clears pause state and persisted pause queues.

## Limits

- In-flight provider requests may continue until the provider process or request cancellation completes.
- Existing OS-level TCP buffers can drain briefly after pause begins.
- Interface detection depends on your VPN exposing a recognizable interface name. Use a reachability probe if it does not.

## Privacy

- The reachability probe host is stored in local settings.
- Recent detector diagnostics contain interface names, timestamps, decisions, and notes. They do not record URLs, headers, request bodies, or IP payloads.
- Queue persistence follows `persistSessionContent`; when persistence is disabled, queued messages live only in memory.
