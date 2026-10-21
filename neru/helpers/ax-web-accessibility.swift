// Turns on the accessibility tree of a Chromium/CEF app that hides it until an
// assistive client asks for it.
//
// Spotify renders its UI through Chromium Embedded Framework. Chromium keeps its
// accessibility tree off (the AXWindow holds a chain of anonymous AXGroups and
// nothing else) until a client sets the opt-in attributes on the elements that
// host web content. VoiceOver does this when it starts; nothing else does, so
// `neru query hints` sees only the three window buttons. Setting both
// AXEnhancedUserInterface and AXManualAccessibility makes Chromium build the
// tree: Spotify goes from 3 hintable elements to ~200. Either attribute alone
// is ignored, and the tree drops again after a while, so a focus hook re-runs
// this.
//
// Usage: ax-web-accessibility <bundle-id> [--force]
//   Prints "already-enabled" and exits when the tree is up, unless --force.
//   Requires Accessibility permission for the calling process.

import Cocoa
import ApplicationServices

func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var out: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &out) == .success else {
        return nil
    }
    return out
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    return value(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: ax-web-accessibility <bundle-id> [--force]\n".utf8))
    exit(2)
}
let bundleID = arguments[1]
let force = arguments.contains("--force")

guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else {
    // Not running: nothing to do, and not an error for a hook.
    print("not-running")
    exit(0)
}

let appElement = AXUIElementCreateApplication(app.processIdentifier)

// Breadth-first walk, bounded so a focus hook stays cheap.
func walk(limit: Int, maxDepth: Int, visit: (AXUIElement, Int) -> Bool) {
    var queue: [(AXUIElement, Int)] = [(appElement, 0)]
    if let windows = value(appElement, kAXWindowsAttribute) as? [AXUIElement] {
        queue.append(contentsOf: windows.map { ($0, 1) })
    }
    var index = 0
    while index < queue.count && index < limit {
        let (element, depth) = queue[index]
        index += 1
        if visit(element, depth) { return }
        guard depth < maxDepth else { continue }
        for child in children(element).prefix(32) {
            queue.append((child, depth + 1))
        }
    }
}

// Fast path: an AXWebArea means Chromium already built the tree.
var alreadyEnabled = false
walk(limit: 400, maxDepth: 12) { element, _ in
    if (value(element, kAXRoleAttribute) as? String) == "AXWebArea" {
        alreadyEnabled = true
        return true
    }
    return false
}

if alreadyEnabled && !force {
    print("already-enabled")
    exit(0)
}

var writes = 0
walk(limit: 3000, maxDepth: 20) { element, _ in
    // Both are needed: setting either one alone leaves the tree off.
    if AXUIElementSetAttributeValue(element, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) == .success {
        writes += 1
    }
    if AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
        writes += 1
    }
    return false
}

print("enabled (\(writes) attribute writes)")
