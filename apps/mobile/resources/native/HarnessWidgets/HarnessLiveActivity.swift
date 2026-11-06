// HarnessWidgets extension — Live Activity UI for running agent sessions.
// The tracked Xcode project references this source directly.
//
// NOTE: HarnessSessionAttributes is intentionally duplicated from
// ios/App/App/AppDelegate.swift (the app target). ActivityKit matches the two by
// type name + Codable shape — keep them identical.
//
// STATUS WORDS: the Mac (mobile-gateway-push.ts) and the app (core/status.ts)
// send two things. `displayLabel` is the exact words to show ("Thinking",
// "Needs your OK", "Asleep"), taken from the desktop's status presenter
// (src/shared/attention/instance-status-presentation.ts); the widget shows it
// as sent and colours by it. `status` is the older short key: "working",
// "waiting", "needs approval", "error", "idle", "looping". Phones built earlier
// colour by exactly those keys, so the keys never change. An activity from a
// build that predates `displayLabel` has none, and the widget then turns the key
// into the same words itself. A question ("waiting") is never an approval
// ("needs approval").
// apps/mobile/src/app/core/phone-status-parity.spec.ts reads this file and
// fails when displayLabel, statusColor or shortStatus drift from the desktop.

import ActivityKit
import SwiftUI
import WidgetKit

struct HarnessSessionAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var status: String
        var detail: String
        // Optional so an activity started or pushed by an older build still decodes.
        var displayLabel: String?
        var displayTone: String?
    }

    var sessionName: String
    var projectName: String
}

@main
struct HarnessWidgetsBundle: WidgetBundle {
    var body: some Widget {
        HarnessSessionLiveActivity()
    }
}

struct HarnessSessionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: HarnessSessionAttributes.self) { context in
            // Lock screen / banner UI.
            HStack(spacing: 12) {
                statusDot(context.state)
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.attributes.sessionName)
                        .font(.headline)
                        .lineLimit(1)
                    Text(context.state.detail.isEmpty
                        ? context.attributes.projectName
                        : context.state.detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Text(shownWords(context.state))
                    .font(.caption.weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(activityColor(context.state))
            }
            .padding(14)
            .activityBackgroundTint(Color.black.opacity(0.8))
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    statusDot(context.state)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.attributes.sessionName)
                            .font(.headline)
                            .lineLimit(1)
                        Text(context.state.detail.isEmpty
                            ? context.attributes.projectName
                            : context.state.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(shownWords(context.state))
                        .font(.caption.weight(.semibold))
                        .textCase(.uppercase)
                        .foregroundStyle(activityColor(context.state))
                }
            } compactLeading: {
                statusDot(context.state)
            } compactTrailing: {
                Text(shortStatus(colourKey(context.state)))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(activityColor(context.state))
            } minimal: {
                statusDot(context.state)
            }
        }
    }

    private func statusDot(_ state: HarnessSessionAttributes.ContentState) -> some View {
        Circle()
            .fill(activityColor(state))
            .frame(width: 10, height: 10)
    }

    /// The sender's own words, when it sent any (an older build sends none).
    private func senderWords(_ state: HarnessSessionAttributes.ContentState) -> String? {
        guard let words = state.displayLabel?.trimmingCharacters(in: .whitespacesAndNewlines),
              !words.isEmpty else { return nil }
        return words
    }

    /// What the activity says: the sender's words as sent, so "Thinking", "Restarting",
    /// "Asleep" and "Stopped" stay themselves; with none, the old key in the desktop's words.
    private func shownWords(_ state: HarnessSessionAttributes.ContentState) -> String {
        return senderWords(state) ?? displayLabel(state.status)
    }

    /// What colour and the compact symbol go by: the words when sent, else the old key.
    /// statusColor and shortStatus understand both.
    private func colourKey(_ state: HarnessSessionAttributes.ContentState) -> String {
        return senderWords(state) ?? state.status
    }

    /// The words shown next to the dot: the desktop's status words for each key.
    private func displayLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "waiting", "needs your answer":
            return "Needs your answer"
        case "needs approval", "needs your ok":
            return "Needs your OK"
        case "error", "problem":
            return "Problem"
        case "idle", "done", "ready":
            return "Ready"
        case "looping":
            return "Loop running"
        case "thinking":
            return "Thinking"
        case "restarting":
            return "Restarting"
        case "stopping":
            return "Stopping"
        case "asleep":
            return "Asleep"
        case "stopped":
            return "Stopped"
        default:
            return "Working"
        }
    }

    /// Exact desktop tone when present; older activities retain their key/word fallback.
    private func activityColor(_ state: HarnessSessionAttributes.ContentState) -> Color {
        switch state.displayTone {
        case "working": return toneColor(0x3b82f6)
        case "thinking": return toneColor(0x4fa3a5)
        case "attention": return toneColor(0xf59e0b)
        case "stopping": return toneColor(0xb89a66)
        case "asleep": return toneColor(0x4b5563)
        case "quiet": return toneColor(0x6b7280)
        case "ok": return toneColor(0x10b981)
        case "warning": return toneColor(0xf97316)
        case "danger": return toneColor(0xef4444)
        case "background": return toneColor(0x7aa2c8)
        case "loop": return toneColor(0xa78bfa)
        default: return statusColor(colourKey(state))
        }
    }

    private func toneColor(_ hex: UInt32) -> Color {
        return Color(red: Double((hex >> 16) & 0xff) / 255,
                     green: Double((hex >> 8) & 0xff) / 255,
                     blue: Double(hex & 0xff) / 255)
    }

    private func statusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "needs approval", "waiting", "needs your answer", "needs your ok":
            return .orange
        case "error", "problem":
            return .red
        case "idle", "done", "ready":
            return .green
        case "asleep", "stopped":
            return .gray
        default:
            return .blue // working / thinking / restarting / stopping
        }
    }

    private func shortStatus(_ status: String) -> String {
        switch status.lowercased() {
        case "needs approval", "waiting", "needs your answer", "needs your ok":
            return "?"
        case "error", "problem":
            return "!"
        case "idle", "done", "ready":
            return "✓"
        case "asleep", "stopped":
            return "–"
        default:
            return "…"
        }
    }
}
