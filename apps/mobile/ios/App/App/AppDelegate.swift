import UIKit
import Capacitor
import Security
import UserNotifications
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Uses the UIScene lifecycle: iOS 27 kills apps built with the iOS 27 SDK that
/// don't adopt it (EXC_BREAKPOINT in
/// `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`). The window
/// and the Capacitor bridge view controller belong to `SceneDelegate`, wired up by
/// the `UIApplicationSceneManifest` in the tracked Info.plist. URL and
/// user-activity callbacks arrive on the scene, not here.
@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        registerNotificationCategories()
        return true
    }

    /// One-tap Approve/Deny directly on approval pushes. The gateway sends
    /// `category: "AIO_APPROVAL"` on permission prompts; these actions surface
    /// on long-press/pull-down of the notification. `.authenticationRequired`
    /// keeps a pocketed, locked phone from approving tool runs, while
    /// `.foreground` guarantees routing failures can show their recovery sheet.
    private func registerNotificationCategories() {
        let approve = UNNotificationAction(
            identifier: "APPROVE",
            title: "Approve",
            options: [.authenticationRequired, .foreground]
        )
        let deny = UNNotificationAction(
            identifier: "DENY",
            title: "Deny",
            options: [.destructive, .authenticationRequired, .foreground]
        )
        let approval = UNNotificationCategory(
            identifier: "AIO_APPROVAL",
            actions: [approve, deny],
            intentIdentifiers: [],
            options: []
        )
        let complete = UNNotificationCategory(
            identifier: "AIO_COMPLETE",
            actions: [],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([approval, complete])
    }

}

/// The window comes from `UISceneStoryboardFile` (Main.storyboard, whose initial
/// view controller is `CAPBridgeViewController`). URL opens and universal-link
/// activities are forwarded to Capacitor's `ApplicationDelegateProxy`, as the
/// app delegate did before the scene lifecycle.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // Cold launch: these never arrive through the callbacks below.
        forward(urlContexts: connectionOptions.urlContexts)
        for userActivity in connectionOptions.userActivities {
            forward(userActivity: userActivity)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        forward(urlContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        forward(userActivity: userActivity)
    }

    private func forward(urlContexts: Set<UIOpenURLContext>) {
        for context in urlContexts {
            var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
            if let sourceApplication = context.options.sourceApplication {
                options[.sourceApplication] = sourceApplication
            }
            if let annotation = context.options.annotation {
                options[.annotation] = annotation
            }
            options[.openInPlace] = context.options.openInPlace
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: options)
        }
    }

    private func forward(userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }

}

@objc(SecureHostStoragePlugin)
public class SecureHostStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureHostStoragePlugin"
    public let jsName = "SecureHostStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private var service: String {
        Bundle.main.bundleIdentifier.map { "\($0).secure-host-storage" } ?? "ai-orchestrator.secure-host-storage"
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("Key is required")
            return
        }

        let query = keychainQuery(for: key)
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard
                let data = item as? Data,
                let value = String(data: data, encoding: .utf8)
            else {
                call.reject("Stored value is unreadable")
                return
            }
            call.resolve(["value": value])
        case errSecItemNotFound:
            call.resolve()
        default:
            call.reject("Keychain read failed", "\(status)", nil)
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("Key is required")
            return
        }
        guard let value = call.getString("value") else {
            call.reject("Value is required")
            return
        }
        guard let data = value.data(using: .utf8) else {
            call.reject("Value encoding failed")
            return
        }

        let query = keychainQuery(for: key)
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            call.reject("Keychain write failed", "\(status)", nil)
            return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("Key is required")
            return
        }

        let status = SecItemDelete(keychainQuery(for: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Keychain delete failed", "\(status)", nil)
            return
        }
        call.resolve()
    }

    private func keychainQuery(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: service,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
    }
}

// MARK: - Live Activities

#if canImport(ActivityKit)

/// Shared shape between the app and the HarnessWidgets extension. The widget
/// target compiles its own identical copy (see resources/native/HarnessWidgets/
/// HarnessLiveActivity.swift) — keep BOTH definitions in sync.
@available(iOS 16.1, *)
struct HarnessSessionAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var status: String
        var detail: String
    }

    var sessionName: String
    var projectName: String
}

/// Lock-screen Live Activity for the session the user is watching. Driven from
/// JS (LiveActivityService); per-activity APNs push tokens are forwarded to JS
/// via the `activityPushToken` event so the Mac gateway can keep the activity
/// fresh with `apns-push-type: liveactivity` while the app is suspended.
@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivityPlugin"
    public let jsName = "LiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise)
    ]

    @objc func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 16.2, *) {
            call.resolve(["available": ActivityAuthorizationInfo().areActivitiesEnabled])
        } else {
            call.resolve(["available": false])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activities need iOS 16.2+")
            return
        }
        let instanceId = call.getString("instanceId") ?? ""
        let attributes = HarnessSessionAttributes(
            sessionName: call.getString("sessionName") ?? "Session",
            projectName: call.getString("projectName") ?? ""
        )
        let state = HarnessSessionAttributes.ContentState(
            status: call.getString("status") ?? "working",
            detail: call.getString("detail") ?? ""
        )
        Task {
            // One live activity at a time — replace any stale ones.
            await Self.endAll()
            do {
                let activity = try Activity.request(
                    attributes: attributes,
                    content: .init(state: state, staleDate: nil),
                    pushType: .token
                )
                self.observePushToken(activity, instanceId: instanceId)
                call.resolve(["id": activity.id])
            } catch {
                call.reject("Activity.request failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.resolve()
            return
        }
        let state = HarnessSessionAttributes.ContentState(
            status: call.getString("status") ?? "working",
            detail: call.getString("detail") ?? ""
        )
        Task {
            for activity in Activity<HarnessSessionAttributes>.activities {
                await activity.update(.init(state: state, staleDate: nil))
            }
            call.resolve()
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.resolve()
            return
        }
        Task {
            await Self.endAll()
            call.resolve()
        }
    }

    @available(iOS 16.2, *)
    private static func endAll() async {
        for activity in Activity<HarnessSessionAttributes>.activities {
            await activity.end(activity.content, dismissalPolicy: .immediate)
        }
    }

    @available(iOS 16.2, *)
    private func observePushToken(_ activity: Activity<HarnessSessionAttributes>, instanceId: String) {
        Task {
            for await tokenData in activity.pushTokenUpdates {
                let token = tokenData.map { String(format: "%02x", $0) }.joined()
                self.notifyListeners("activityPushToken", data: [
                    "instanceId": instanceId,
                    "token": token
                ])
            }
        }
    }
}

#endif
