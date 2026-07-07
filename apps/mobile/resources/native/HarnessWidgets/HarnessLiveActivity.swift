// HarnessWidgets extension — Live Activity UI for running agent sessions.
// See docs/mobile-app/live-activities-setup.md for the one-time Xcode setup.
//
// NOTE: HarnessSessionAttributes is intentionally duplicated from
// resources/native/AppDelegate.swift (the app target). ActivityKit matches the
// two by type name + Codable shape — keep them identical.

import ActivityKit
import SwiftUI
import WidgetKit

struct HarnessSessionAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var status: String
        var detail: String
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
                statusDot(context.state.status)
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
                Text(context.state.status)
                    .font(.caption.weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(statusColor(context.state.status))
            }
            .padding(14)
            .activityBackgroundTint(Color.black.opacity(0.8))
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    statusDot(context.state.status)
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
                    Text(context.state.status)
                        .font(.caption.weight(.semibold))
                        .textCase(.uppercase)
                        .foregroundStyle(statusColor(context.state.status))
                }
            } compactLeading: {
                statusDot(context.state.status)
            } compactTrailing: {
                Text(shortStatus(context.state.status))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(statusColor(context.state.status))
            } minimal: {
                statusDot(context.state.status)
            }
        }
    }

    private func statusDot(_ status: String) -> some View {
        Circle()
            .fill(statusColor(status))
            .frame(width: 10, height: 10)
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "needs approval", "waiting":
            return .orange
        case "error":
            return .red
        case "idle", "done":
            return .green
        default:
            return .blue // working / thinking
        }
    }

    private func shortStatus(_ status: String) -> String {
        switch status {
        case "needs approval":
            return "?"
        case "idle", "done":
            return "✓"
        default:
            return "…"
        }
    }
}
