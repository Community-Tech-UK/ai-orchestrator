import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

private let protocolVersion = "1.2.0"
private let maxLineBytes = 1_048_576
private let maxApps = 512
private let maxWindowsPerApp = 128
private let maxTextLength = 4_096
private let maxSnapshotNodes = 2_000
private let maxSnapshotDepth = 50
private let maxChildrenPerNode = 100
private let maxStringLength = 2_048

private enum HelperFailure: Error {
    case invalidRequest
    case accessibilityDenied
    case targetNotFound
    case targetNotActive
    case targetOutsideWindow
    case sensitiveTarget
    case eventCreationFailed
    case unsupportedCommand
    case helperFailed

    var code: String {
        switch self {
        case .invalidRequest: return "invalid_request"
        case .accessibilityDenied: return "accessibility_denied"
        case .targetNotFound: return "target_not_found"
        case .targetNotActive: return "target_not_active"
        case .targetOutsideWindow: return "target_outside_window"
        case .sensitiveTarget: return "sensitive_target"
        case .eventCreationFailed: return "event_creation_failed"
        case .unsupportedCommand: return "unsupported_command"
        case .helperFailed: return "helper_failed"
        }
    }

    var safeMessage: String {
        switch self {
        case .invalidRequest: return "The request is invalid."
        case .accessibilityDenied: return "Accessibility permission is required."
        case .targetNotFound: return "The target application was not found."
        case .targetNotActive: return "The target application is not active."
        case .targetOutsideWindow: return "The input point is outside the target application window."
        case .sensitiveTarget: return "The focused target is sensitive."
        case .eventCreationFailed: return "The input event could not be created."
        case .unsupportedCommand: return "The command is not supported."
        case .helperFailed: return "The helper could not complete the command."
        }
    }
}

private struct Request {
    let id: String
    let command: String
    let payload: [String: Any]
}

private func boundedString(_ value: Any?, limit: Int = maxStringLength) -> String? {
    guard let string = value as? String, !string.isEmpty else {
        return nil
    }
    return String(string.prefix(limit))
}

private func finiteDouble(_ value: Any?, minimum: Double, maximum: Double) throws -> Double {
    guard let number = value as? NSNumber else {
        throw HelperFailure.invalidRequest
    }
    let result = number.doubleValue
    guard result.isFinite, result >= minimum, result <= maximum else {
        throw HelperFailure.invalidRequest
    }
    return result
}

private func boundedInteger(
    _ value: Any?,
    default defaultValue: Int? = nil,
    minimum: Int,
    maximum: Int
) throws -> Int {
    guard let number = value as? NSNumber else {
        if let defaultValue {
            return defaultValue
        }
        throw HelperFailure.invalidRequest
    }
    let result = number.intValue
    guard result >= minimum, result <= maximum else {
        throw HelperFailure.invalidRequest
    }
    return result
}

private func parseRequest(_ line: String) throws -> Request {
    guard line.utf8.count <= maxLineBytes,
          let data = line.data(using: .utf8),
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          object["protocolVersion"] as? String == protocolVersion,
          let id = object["id"] as? String,
          !id.isEmpty,
          id.count <= 128,
          let command = object["command"] as? String,
          let payload = object["payload"] as? [String: Any] else {
        throw HelperFailure.invalidRequest
    }
    return Request(id: id, command: command, payload: payload)
}

private func emit(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          data.count <= maxLineBytes,
          let line = String(data: data, encoding: .utf8) else {
        return
    }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

private func emitSuccess(id: String, result: [String: Any]) {
    emit([
        "protocolVersion": protocolVersion,
        "id": id,
        "ok": true,
        "result": result,
    ])
}

private func emitFailure(id: String, failure: HelperFailure) {
    emit([
        "protocolVersion": protocolVersion,
        "id": id,
        "ok": false,
        "error": [
            "code": failure.code,
            "message": failure.safeMessage,
        ],
    ])
}

private func requireAccessibility() throws {
    guard AXIsProcessTrusted() else {
        throw HelperFailure.accessibilityDenied
    }
}

private func windowsByPID() -> [pid_t: [[String: Any]]] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let rawWindows = CGWindowListCopyWindowInfo(options, kCGNullWindowID)
        as? [[String: Any]] else {
        return [:]
    }
    var result: [pid_t: [[String: Any]]] = [:]
    for raw in rawWindows {
        guard let pidNumber = raw[kCGWindowOwnerPID as String] as? NSNumber,
              let windowNumber = raw[kCGWindowNumber as String] as? NSNumber else {
            continue
        }
        let pid = pid_t(pidNumber.int32Value)
        guard result[pid, default: []].count < maxWindowsPerApp else {
            continue
        }
        var window: [String: Any] = ["id": windowNumber.intValue]
        if let title = boundedString(raw[kCGWindowName as String], limit: 1_024) {
            window["title"] = title
        }
        if let bounds = raw[kCGWindowBounds as String] as? [String: Any],
           let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) {
            window["frame"] = frameDictionary(rect)
        }
        result[pid, default: []].append(window)
    }
    return result
}

private func listApplications() -> [String: Any] {
    let windows = windowsByPID()
    let running = NSWorkspace.shared.runningApplications
        .filter { app in
            app.activationPolicy == .regular && !app.isTerminated
        }
        .prefix(maxApps)
    let apps: [[String: Any]] = running.compactMap { app in
        guard let name = boundedString(app.localizedName, limit: 512) else {
            return nil
        }
        var record: [String: Any] = [
            "name": name,
            "pid": Int(app.processIdentifier),
            "windows": windows[app.processIdentifier] ?? [],
        ]
        if let bundleIdentifier = boundedString(app.bundleIdentifier, limit: 512) {
            record["bundleId"] = bundleIdentifier
        }
        return record
    }
    return ["apps": apps]
}

private func frameDictionary(_ rect: CGRect) -> [String: Double] {
    [
        "x": rect.origin.x,
        "y": rect.origin.y,
        "width": rect.size.width,
        "height": rect.size.height,
    ]
}

private func processID(for payload: [String: Any]) throws -> pid_t {
    if let windowID = try requestedWindowID(payload) {
        let windows = windowsByPID()
        if let match = windows.first(where: { entry in
            entry.value.contains(where: { ($0["id"] as? Int) == windowID })
        }) {
            return match.key
        }
    }

    guard let appID = boundedString(payload["appId"], limit: 1_024) else {
        throw HelperFailure.invalidRequest
    }
    if appID.hasPrefix("darwin-app:pid:"),
       let pid = Int32(appID.dropFirst("darwin-app:pid:".count)) {
        return pid_t(pid)
    }
    let bundleID = appID.hasPrefix("darwin-app:")
        ? String(appID.dropFirst("darwin-app:".count))
        : appID
    if let app = NSRunningApplication.runningApplications(
        withBundleIdentifier: bundleID
    ).first {
        return app.processIdentifier
    }
    if let pid = Int32(bundleID) {
        return pid_t(pid)
    }
    throw HelperFailure.targetNotFound
}

private func requestedWindowID(_ payload: [String: Any]) throws -> Int? {
    guard let windowValue = payload["windowId"] else {
        return nil
    }
    if let number = windowValue as? NSNumber {
        return number.intValue
    }
    if let string = windowValue as? String, let parsed = Int(string) {
        return parsed
    }
    throw HelperFailure.invalidRequest
}

private func assertTargetActive(_ payload: [String: Any]) throws -> pid_t {
    let pid = try processID(for: payload)
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        throw HelperFailure.targetNotActive
    }
    return pid
}

private func requireRequestedWindowActive(_ payload: [String: Any], pid: pid_t) throws {
    guard let windowID = try requestedWindowID(payload) else {
        return
    }
    let windows = windowsByPID()[pid] ?? []
    guard windows.contains(where: { ($0["id"] as? Int) == windowID }) else {
        throw HelperFailure.targetNotFound
    }
    guard (windows.first?["id"] as? Int) == windowID else {
        throw HelperFailure.targetNotActive
    }
}

private func requirePointInsideTargetWindow(
    _ point: CGPoint,
    pid: pid_t,
    requestedWindowID: Int?
) throws {
    let windows = windowsByPID()[pid] ?? []
    let isInside = windows.contains { window in
        if let requestedWindowID,
           (window["id"] as? Int) != requestedWindowID {
            return false
        }
        guard let frame = window["frame"] as? [String: Double],
              let x = frame["x"],
              let y = frame["y"],
              let width = frame["width"],
              let height = frame["height"] else {
            return false
        }
        return CGRect(x: x, y: y, width: width, height: height).contains(point)
    }
    guard isInside else {
        throw HelperFailure.targetOutsideWindow
    }
}

private func requireNonSensitiveFocusedElement(pid: pid_t) throws {
    let appElement = AXUIElementCreateApplication(pid)
    guard let focusedValue = axAttribute(appElement, kAXFocusedUIElementAttribute),
          CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else {
        throw HelperFailure.targetNotFound
    }
    let focusedElement = focusedValue as! AXUIElement
    let role = axString(focusedElement, kAXRoleAttribute)
    let subrole = axString(focusedElement, kAXSubroleAttribute)
    guard role != "AXSecureTextField", subrole != "AXSecureTextField" else {
        throw HelperFailure.sensitiveTarget
    }
}

private func axAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value
}

private func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    boundedString(axAttribute(element, attribute))
}

private func axBoolean(_ element: AXUIElement, _ attribute: String) -> Bool? {
    (axAttribute(element, attribute) as? NSNumber)?.boolValue
}

/// AXURL arrives as an NSURL on most apps and as a plain string on some.
/// Bounded like every other string we return.
private func axURLString(_ element: AXUIElement) -> String? {
    guard let value = axAttribute(element, kAXURLAttribute) else {
        return nil
    }
    if let url = value as? NSURL, let absolute = url.absoluteString {
        return boundedString(absolute)
    }
    return boundedString(value)
}

private func axPoint(_ value: AnyObject?) -> CGPoint? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else {
        return nil
    }
    return point
}

private func axSize(_ value: AnyObject?) -> CGSize? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size) else {
        return nil
    }
    return size
}

private final class SnapshotBuilder {
    private let maxNodes: Int
    private let includeBounds: Bool
    private let roleFilters: Set<String>
    private(set) var count = 0
    private(set) var focusedUID: String?
    private var visitedElements: [AXUIElement] = []

    init(maxNodes: Int, includeBounds: Bool, roleFilters: Set<String>) {
        self.maxNodes = maxNodes
        self.includeBounds = includeBounds
        self.roleFilters = roleFilters
    }

    func node(_ element: AXUIElement, depth: Int) -> [String: Any]? {
        guard count < maxNodes,
              depth <= maxSnapshotDepth,
              !visitedElements.contains(where: { CFEqual($0, element) }) else {
            return nil
        }
        visitedElements.append(element)
        count += 1
        let uid = "ax_\(count)"
        let role = axString(element, kAXRoleAttribute) ?? "AXUnknown"
        let secure = role == "AXSecureTextField"
            || axString(element, kAXSubroleAttribute) == "AXSecureTextField"
        var result: [String: Any] = [
            "uid": uid,
            "role": role,
        ]
        if let label = axString(element, kAXTitleAttribute)
            ?? axString(element, kAXDescriptionAttribute) {
            result["label"] = label
        }
        if secure {
            result["redacted"] = true
        } else if let value = safeAXValue(axAttribute(element, kAXValueAttribute)) {
            result["value"] = value
        }
        // Link destination. Lets the gateway distinguish a navigation link from
        // a command control that merely has an action verb in its label, so a
        // breadcrumb such as "Publish Tender Pack (Auto Invite)" is not blocked
        // as a sensitive publish/invite action.
        if let url = axURLString(element) {
            result["url"] = url
        }
        if let enabled = axBoolean(element, kAXEnabledAttribute) {
            result["enabled"] = enabled
        }
        if let focused = axBoolean(element, kAXFocusedAttribute) {
            result["focused"] = focused
            if focused {
                focusedUID = uid
            }
        }
        if includeBounds,
           let position = axPoint(axAttribute(element, kAXPositionAttribute)),
           let size = axSize(axAttribute(element, kAXSizeAttribute)) {
            result["bounds"] = frameDictionary(CGRect(origin: position, size: size))
        }

        let rawChildren = axAttribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
        let children = rawChildren.prefix(maxChildrenPerNode).compactMap {
            node($0, depth: depth + 1)
        }
        if !children.isEmpty {
            result["children"] = children
        }
        if roleFilters.isEmpty || roleFilters.contains(role) || !children.isEmpty || depth == 0 {
            return result
        }
        return nil
    }
}

private func safeAXValue(_ value: AnyObject?) -> Any? {
    if let string = value as? String {
        return String(string.prefix(maxStringLength))
    }
    if let number = value as? NSNumber {
        return number
    }
    return nil
}

private func accessibilitySnapshot(_ payload: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    let pid = try processID(for: payload)
    let maxNodes = try boundedInteger(
        payload["maxNodes"],
        default: 500,
        minimum: 1,
        maximum: maxSnapshotNodes
    )
    let includeBounds = (payload["includeBounds"] as? Bool) ?? true
    let rawFilters = payload["roleFilters"] as? [String] ?? []
    guard rawFilters.count <= 64,
          rawFilters.allSatisfy({ !$0.isEmpty && $0.count <= 128 }) else {
        throw HelperFailure.invalidRequest
    }
    let builder = SnapshotBuilder(
        maxNodes: maxNodes,
        includeBounds: includeBounds,
        roleFilters: Set(rawFilters)
    )
    let root = AXUIElementCreateApplication(pid)
    let rootNode = builder.node(root, depth: 0)
    var result: [String: Any] = [
        "appId": boundedString(payload["appId"], limit: 1_024)
            ?? "darwin-app:pid:\(pid)",
        "nodes": rootNode.map { [$0] } ?? [],
        "capturedAt": Int(Date().timeIntervalSince1970 * 1_000),
    ]
    if let windowID = boundedString(payload["windowId"], limit: 128) {
        result["windowId"] = windowID
    } else if let windowNumber = payload["windowId"] as? NSNumber {
        result["windowId"] = windowNumber.stringValue
    }
    if let focusedUID = builder.focusedUID {
        result["focusedUid"] = focusedUID
    }
    return result
}

private func postMouseEvent(
    type: CGEventType,
    point: CGPoint,
    button: CGMouseButton,
    clickCount: Int = 1
) throws {
    guard let event = CGEvent(
        mouseEventSource: nil,
        mouseType: type,
        mouseCursorPosition: point,
        mouseButton: button
    ) else {
        throw HelperFailure.eventCreationFailed
    }
    event.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
    event.post(tap: .cghidEventTap)
}

private func click(_ payload: [String: Any]) throws {
    try requireAccessibility()
    let pid = try assertTargetActive(payload)
    let x = try finiteDouble(payload["x"], minimum: -100_000, maximum: 100_000)
    let y = try finiteDouble(payload["y"], minimum: -100_000, maximum: 100_000)
    let count = try boundedInteger(
        payload["clickCount"],
        default: 1,
        minimum: 1,
        maximum: 3
    )
    let point = CGPoint(x: x, y: y)
    try requireRequestedWindowActive(payload, pid: pid)
    try requirePointInsideTargetWindow(
        point,
        pid: pid,
        requestedWindowID: try requestedWindowID(payload)
    )
    switch payload["button"] as? String ?? "left" {
    case "left":
        try postMouseEvent(type: .leftMouseDown, point: point, button: .left, clickCount: count)
        try postMouseEvent(type: .leftMouseUp, point: point, button: .left, clickCount: count)
    case "right":
        try postMouseEvent(type: .rightMouseDown, point: point, button: .right, clickCount: count)
        try postMouseEvent(type: .rightMouseUp, point: point, button: .right, clickCount: count)
    case "middle":
        try postMouseEvent(type: .otherMouseDown, point: point, button: .center, clickCount: count)
        try postMouseEvent(type: .otherMouseUp, point: point, button: .center, clickCount: count)
    default:
        throw HelperFailure.invalidRequest
    }
}

private func typeText(_ payload: [String: Any]) throws {
    try requireAccessibility()
    let pid = try assertTargetActive(payload)
    try requireRequestedWindowActive(payload, pid: pid)
    try requireNonSensitiveFocusedElement(pid: pid)
    guard let text = payload["text"] as? String,
          text.count <= maxTextLength,
          text.utf8.count <= maxLineBytes / 2 else {
        throw HelperFailure.invalidRequest
    }
    let characters = Array(text.utf16)
    guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
        throw HelperFailure.eventCreationFailed
    }
    characters.withUnsafeBufferPointer { buffer in
        keyDown.keyboardSetUnicodeString(
            stringLength: buffer.count,
            unicodeString: buffer.baseAddress
        )
        keyUp.keyboardSetUnicodeString(
            stringLength: buffer.count,
            unicodeString: buffer.baseAddress
        )
    }
    keyDown.post(tap: .cghidEventTap)
    keyUp.post(tap: .cghidEventTap)
}

private let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
    "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
    "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "enter": 36, "return": 36, "l": 37, "j": 38, "'": 39, "k": 40,
    ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
    "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125,
    "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
]

private func hotkey(_ payload: [String: Any]) throws {
    try requireAccessibility()
    let pid = try assertTargetActive(payload)
    try requireRequestedWindowActive(payload, pid: pid)
    try requireNonSensitiveFocusedElement(pid: pid)
    guard let rawKeys = payload["keys"] as? [String],
          !rawKeys.isEmpty,
          rawKeys.count <= 8 else {
        throw HelperFailure.invalidRequest
    }
    var flags: CGEventFlags = []
    var actionKey: String?
    for rawKey in rawKeys {
        let key = rawKey.lowercased()
        switch key {
        case "cmd", "command", "meta":
            flags.insert(.maskCommand)
        case "shift":
            flags.insert(.maskShift)
        case "alt", "option":
            flags.insert(.maskAlternate)
        case "ctrl", "control":
            flags.insert(.maskControl)
        default:
            guard actionKey == nil else {
                throw HelperFailure.invalidRequest
            }
            actionKey = key
        }
    }
    guard let actionKey, let keyCode = keyCodes[actionKey],
          let keyDown = CGEvent(
            keyboardEventSource: nil,
            virtualKey: keyCode,
            keyDown: true
          ),
          let keyUp = CGEvent(
            keyboardEventSource: nil,
            virtualKey: keyCode,
            keyDown: false
          ) else {
        throw HelperFailure.invalidRequest
    }
    keyDown.flags = flags
    keyUp.flags = flags
    keyDown.post(tap: .cghidEventTap)
    keyUp.post(tap: .cghidEventTap)
}

private func scroll(_ payload: [String: Any]) throws {
    try requireAccessibility()
    let pid = try assertTargetActive(payload)
    let amount = try finiteDouble(payload["amount"], minimum: 1, maximum: 10_000)
    let pixels = Int32(min(amount.rounded(), Double(Int32.max)))
    let vertical: Int32
    let horizontal: Int32
    switch payload["direction"] as? String {
    case "up":
        vertical = pixels
        horizontal = 0
    case "down":
        vertical = -pixels
        horizontal = 0
    case "left":
        vertical = 0
        horizontal = pixels
    case "right":
        vertical = 0
        horizontal = -pixels
    default:
        throw HelperFailure.invalidRequest
    }
    let x = try finiteDouble(payload["x"], minimum: -100_000, maximum: 100_000)
    let y = try finiteDouble(payload["y"], minimum: -100_000, maximum: 100_000)
    let point = CGPoint(x: x, y: y)
    try requireRequestedWindowActive(payload, pid: pid)
    try requirePointInsideTargetWindow(
        point,
        pid: pid,
        requestedWindowID: try requestedWindowID(payload)
    )
    try postMouseEvent(type: .mouseMoved, point: point, button: .left)
    guard let event = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .pixel,
        wheelCount: 2,
        wheel1: vertical,
        wheel2: horizontal,
        wheel3: 0
    ) else {
        throw HelperFailure.eventCreationFailed
    }
    event.post(tap: .cghidEventTap)
}

private func point(_ value: Any?) throws -> CGPoint {
    guard let raw = value as? [String: Any] else {
        throw HelperFailure.invalidRequest
    }
    return CGPoint(
        x: try finiteDouble(raw["x"], minimum: -100_000, maximum: 100_000),
        y: try finiteDouble(raw["y"], minimum: -100_000, maximum: 100_000)
    )
}

private func drag(_ payload: [String: Any]) throws {
    try requireAccessibility()
    let pid = try assertTargetActive(payload)
    let start = try point(payload["start"])
    let end = try point(payload["end"])
    try requireRequestedWindowActive(payload, pid: pid)
    let windowID = try requestedWindowID(payload)
    try requirePointInsideTargetWindow(start, pid: pid, requestedWindowID: windowID)
    try requirePointInsideTargetWindow(end, pid: pid, requestedWindowID: windowID)
    let durationMilliseconds = try boundedInteger(
        payload["durationMs"],
        default: 250,
        minimum: 0,
        maximum: 5_000
    )
    let steps = max(1, min(300, durationMilliseconds / 16))
    try postMouseEvent(type: .leftMouseDown, point: start, button: .left)
    for step in 1...steps {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            try? postMouseEvent(type: .leftMouseUp, point: start, button: .left)
            throw HelperFailure.targetNotActive
        }
        let progress = CGFloat(step) / CGFloat(steps)
        let current = CGPoint(
            x: start.x + ((end.x - start.x) * progress),
            y: start.y + ((end.y - start.y) * progress)
        )
        try postMouseEvent(type: .leftMouseDragged, point: current, button: .left)
        if durationMilliseconds > 0 {
            Thread.sleep(
                forTimeInterval: Double(durationMilliseconds) / 1_000.0 / Double(steps)
            )
        }
    }
    try postMouseEvent(type: .leftMouseUp, point: end, button: .left)
}

/// Bring one already-observed window of an already-granted app to the front.
///
/// A navigation prerequisite, not permission to mutate: it only ever raises a
/// window of the app the caller already holds a grant for. It never enumerates
/// or activates arbitrary processes, and it synthesizes no keystrokes — it uses
/// the app activation API plus an AXRaise on the specific window, so a
/// multi-window app on multiple monitors can be targeted precisely.
private func activateWindow(_ payload: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    let pid = try processID(for: payload)
    let requestedID = try requestedWindowID(payload)

    // The window must already be visible on screen; this cannot summon a
    // minimized/closed window or one belonging to another process.
    let windows = windowsByPID()[pid] ?? []
    guard !windows.isEmpty else {
        throw HelperFailure.targetNotFound
    }
    if let requestedID, !windows.contains(where: { ($0["id"] as? Int) == requestedID }) {
        throw HelperFailure.targetNotFound
    }

    guard let app = NSRunningApplication(processIdentifier: pid) else {
        throw HelperFailure.targetNotFound
    }
    app.activate(options: [])

    if let requestedID,
       let requestedFrame = windows.first(where: { ($0["id"] as? Int) == requestedID })?["frame"]
           as? [String: Double] {
        raiseAXWindow(pid: pid, frame: requestedFrame)
    }

    // Verify rather than assume: poll until the app is frontmost and (when a
    // specific window was requested) that window is its front window.
    let deadline = Date().addingTimeInterval(2.0)
    while Date() < deadline {
        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        let current = windowsByPID()[pid] ?? []
        let frontWindowID = current.first?["id"] as? Int
        if frontmost && (requestedID == nil || frontWindowID == requestedID) {
            var result: [String: Any] = ["activated": true]
            for (key, value) in activeWindowFields(current.first) {
                result[key] = value
            }
            return result
        }
        Thread.sleep(forTimeInterval: 0.05)
    }
    throw HelperFailure.targetNotActive
}

private func activeWindowFields(_ window: [String: Any]?) -> [String: Any] {
    guard let window else {
        return [:]
    }
    var fields: [String: Any] = [:]
    if let id = window["id"] as? Int {
        fields["windowId"] = String(id)
    }
    if let title = window["title"] as? String {
        fields["title"] = title
    }
    if let frame = window["frame"] {
        fields["bounds"] = frame
    }
    return fields
}

/// Raise a specific window via the accessibility API so the right window of a
/// multi-window app comes forward, not merely the app's last-focused one.
///
/// AXUIElement carries no public CGWindowID, so the AX window is matched to the
/// CGWindowList entry by frame. Best-effort by design: if no AX window matches,
/// plain app activation still ran and the caller's verification loop decides
/// whether that was enough.
private func raiseAXWindow(pid: pid_t, frame: [String: Double]) {
    let appElement = AXUIElementCreateApplication(pid)
    guard let rawWindows = axAttribute(appElement, kAXWindowsAttribute) as? [AXUIElement] else {
        return
    }
    for window in rawWindows.prefix(maxWindowsPerApp) {
        guard let position = axPoint(axAttribute(window, kAXPositionAttribute)),
              let size = axSize(axAttribute(window, kAXSizeAttribute)),
              framesMatch(CGRect(origin: position, size: size), frame) else {
            continue
        }
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        return
    }
}

/// One-point tolerance absorbs the rounding differences between the CoreGraphics
/// window list and the accessibility API.
private func framesMatch(_ rect: CGRect, _ frame: [String: Double]) -> Bool {
    guard let x = frame["x"], let y = frame["y"],
          let width = frame["width"], let height = frame["height"] else {
        return false
    }
    return abs(rect.origin.x - x) <= 1
        && abs(rect.origin.y - y) <= 1
        && abs(rect.size.width - width) <= 1
        && abs(rect.size.height - height) <= 1
}

private func execute(_ request: Request) throws -> [String: Any] {
    switch request.command {
    case "health":
        guard request.payload.isEmpty else {
            throw HelperFailure.invalidRequest
        }
        let accessibility = AXIsProcessTrusted()
        return [
            "version": protocolVersion,
            "screenRecording": CGPreflightScreenCaptureAccess(),
            "accessibility": accessibility,
            "input": accessibility,
        ]
    case "requestAccessibility":
        guard request.payload.isEmpty else {
            throw HelperFailure.invalidRequest
        }
        // Prompting is asynchronous: the return value is the *current* trust
        // state, so `false` right after a first-time prompt is expected and
        // must not be treated as an execution error.
        let options = [
            kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
        ] as CFDictionary
        return ["trusted": AXIsProcessTrustedWithOptions(options)]
    case "listApps":
        guard request.payload.isEmpty else {
            throw HelperFailure.invalidRequest
        }
        return listApplications()
    case "accessibilitySnapshot":
        return try accessibilitySnapshot(request.payload)
    case "activateWindow":
        return try activateWindow(request.payload)
    case "click":
        try click(request.payload)
    case "typeText":
        try typeText(request.payload)
    case "hotkey":
        try hotkey(request.payload)
    case "scroll":
        try scroll(request.payload)
    case "drag":
        try drag(request.payload)
    default:
        throw HelperFailure.unsupportedCommand
    }
    return ["completed": true]
}

while let line = readLine(strippingNewline: true) {
    autoreleasepool {
        var requestID = "invalid"
        do {
            let request = try parseRequest(line)
            requestID = request.id
            emitSuccess(id: request.id, result: try execute(request))
        } catch let failure as HelperFailure {
            emitFailure(id: requestID, failure: failure)
        } catch {
            emitFailure(id: requestID, failure: .helperFailed)
        }
    }
}
