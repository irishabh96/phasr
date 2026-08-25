// Q2 probe: does WKWebView's Edit ▸ Copy / Paste machinery reach a
// terminal whose selection is painted on a canvas?
//
// ADR-002 Q2. The focus shape replicates ghostty-web exactly: a
// contenteditable container (tabindex=0, beforeinput prevented) with a
// hidden 1px textarea inside it, and phasr's rung-1 capture-phase
// clipboard listeners from backends/ghostty/clipboard.ts. Two states:
//
//   rung1  container focused, DOM selection COLLAPSED (the canvas holds
//          the "real" selection, invisibly to WebKit's Editor)
//   rung2  the selection mirror: textarea.value = selection, select()ed
//          (installSelectionMirror's exact mechanism)
//
// For each state it asks the two questions the Edit menu asks:
//   validate  — validateUserInterfaceItem(copy:/paste:)  (menu enabled?)
//   dispatch  — sendAction(copy:/paste:) down the responder chain: does a
//               DOM copy/paste event fire, and does rung 1's setData
//               actually land on the pasteboard?
//
// Same caveat as the Q1 probe: this is WKWebView with our configuration,
// not wry's — strong evidence, not a substitute for the 2-minute in-app
// check in docs/MANUAL-VERIFICATION.md.

import AppKit
import WebKit
import Foundation

let page = """
<!doctype html><meta charset="utf-8"><title>q2</title>
<div id="term" contenteditable="true" tabindex="0" role="textbox"
     style="width:600px;height:300px;background:#111;color:#eee;outline:none">
  <canvas width="600" height="280"></canvas>
  <textarea id="mirror" tabindex="0" aria-label="Terminal input"
    style="position:absolute;left:0;top:0;width:1px;height:1px;padding:0;border:none;margin:0;opacity:0;clip-path:inset(50%);overflow:hidden;white-space:nowrap;resize:none"></textarea>
</div>
<script>
  const say = (o) => window.webkit.messageHandlers.q2.postMessage(JSON.stringify(o));
  const term = document.getElementById("term");
  const mirror = document.getElementById("mirror");
  term.addEventListener("beforeinput", (e) => e.preventDefault());
  const fired = { copy: 0, cut: 0, paste: 0, pasted: "" };
  // Rung 1, verbatim shape (clipboard.ts): the terminal "has a selection"
  // as far as phasr is concerned, whatever the DOM says.
  term.addEventListener("copy", (e) => {
    fired.copy++;
    e.clipboardData.setData("text/plain", "RUNG1-CANVAS-SELECTION");
    e.preventDefault(); e.stopPropagation();
  }, { capture: true });
  term.addEventListener("cut", (e) => { fired.cut++; e.preventDefault(); }, { capture: true });
  term.addEventListener("paste", (e) => {
    fired.paste++;
    fired.pasted = e.clipboardData.getData("text");
    e.preventDefault(); e.stopPropagation();
  }, { capture: true });

  window.__setState = (state) => {
    const sel = document.getSelection();
    sel.removeAllRanges();
    mirror.value = "";
    term.focus();
    if (state === "rung1") {
      // Collapsed caret inside the contenteditable — ghostty's real shape.
      const r = document.createRange();
      r.setStart(term, 0); r.collapse(true);
      sel.addRange(r);
    } else if (state === "rung2") {
      // installSelectionMirror, verbatim.
      mirror.value = "MIRRORED-SELECTION";
      mirror.select();
      mirror.setSelectionRange(0, mirror.value.length);
    }
    return {
      state,
      active: document.activeElement && document.activeElement.id || document.activeElement.tagName,
      selCollapsed: document.getSelection().isCollapsed,
      queryCopy: document.queryCommandEnabled && document.queryCommandEnabled("copy"),
    };
  };
  window.__events = () => { const f = { ...fired }; return f; };
  window.__resetEvents = () => { fired.copy = 0; fired.cut = 0; fired.paste = 0; fired.pasted = ""; };
  say({ stage: "ready" });
</script>
"""

var jsLogs: [String] = []
final class Handler: NSObject, WKScriptMessageHandler {
    var ready = false
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        if let s = m.body as? String {
            jsLogs.append(s)
            if s.contains("\"stage\":\"ready\"") { ready = true }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
let handler = Handler()
let cfg = WKWebViewConfiguration()
cfg.userContentController.add(handler, name: "q2")
let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 700, height: 400), configuration: cfg)
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 400),
                      styleMask: [.titled], backing: .buffered, defer: false)
window.contentView = webView
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(webView)
webView.loadHTMLString(page, baseURL: nil)

func pump(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
func evalSync(_ js: String) -> Any? {
    var out: Any?; var done = false
    webView.evaluateJavaScript(js) { r, e in out = e.map { "JSERR \($0.localizedDescription)" } ?? r; done = true }
    let deadline = Date().addingTimeInterval(5)
    while !done && Date() < deadline { pump(0.05) }
    return out
}
func emit(_ o: [String: Any]) {
    let d = try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
    print("Q2 " + String(data: d, encoding: .utf8)!)
}

let start = Date()
while !handler.ready && Date().timeIntervalSince(start) < 10 { pump(0.1) }
guard handler.ready else { emit(["ok": false, "error": "page never ready"]); exit(5) }

let copySel = NSSelectorFromString("copy:")
let pasteSel = NSSelectorFromString("paste:")

func validate(_ sel: Selector) -> Any {
    let item = NSMenuItem(title: "probe", action: sel, keyEquivalent: "")
    item.target = webView
    if let v = webView as? any NSUserInterfaceValidations {
        return v.validateUserInterfaceItem(item)
    }
    return "unavailable"
}

for state in ["rung1", "rung2"] {
    let setup = evalSync("JSON.stringify(window.__setState('\(state)'))") as? String ?? "?"
    _ = evalSync("window.__resetEvents()")
    pump(0.2)

    let canCopy = validate(copySel)
    let canPaste = validate(pasteSel)

    let pb = NSPasteboard.general
    pb.clearContents(); pb.setString("SENTINEL", forType: .string)
    // Route like the Edit menu does: at the window's real first responder
    // (WKWebView installs an internal content view there).
    let responder = window.firstResponder ?? webView
    _ = responder.tryToPerform(copySel, with: nil)
    NSApp.sendAction(copySel, to: nil, from: nil)
    pump(0.8)
    let afterCopy = pb.string(forType: .string) ?? "<nil>"

    pb.clearContents(); pb.setString("PASTE-PAYLOAD", forType: .string)
    _ = responder.tryToPerform(pasteSel, with: nil)
    NSApp.sendAction(pasteSel, to: nil, from: nil)
    pump(0.8)
    let events = evalSync("JSON.stringify(window.__events())") as? String ?? "?"

    emit([
        "state": state, "setup": setup,
        "validateCopy": "\(canCopy)", "validatePaste": "\(canPaste)",
        "pasteboardAfterCopy": afterCopy, "events": events,
    ])
}
emit(["ok": true, "done": true])
exit(0)
