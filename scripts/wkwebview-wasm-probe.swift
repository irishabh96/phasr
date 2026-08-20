// Q1 probe: will WKWebView fetch() a `data:application/wasm` URL from a
// CUSTOM-SCHEME origin (tauri://localhost) and compile it?
//
// This is the question ADR-002 leaves open. Chromium cannot answer it and
// neither can Playwright's WebKit, because the origin is what is in doubt:
// `pnpm dev` serves http://localhost:1420, which has ordinary web-origin
// rules, while the packaged app serves tauri://localhost through a custom
// URLSchemeHandler.
//
// So: same engine (WKWebView), same origin shape (custom scheme handler
// serving the REAL built dist/), same call the app makes
// (`import(chunk)` then `Ghostty.load()` with no argument, which fetches
// the inlined data: URL). Not identical to Tauri's own configuration --
// wry sets its own WKWebViewConfiguration -- so this is strong evidence,
// not a substitute for launching the .app.
//
//   swift wkprobe.swift <dist-dir> <ghostty-chunk-name>

import AppKit
import WebKit
import Foundation

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: wkprobe.swift <dist> <chunk>\n".data(using: .utf8)!)
    exit(2)
}
let distDir = URL(fileURLWithPath: args[1])
let chunk = args[2]

func mime(for path: String) -> String {
    if path.hasSuffix(".js") || path.hasSuffix(".mjs") { return "text/javascript" }
    if path.hasSuffix(".css") { return "text/css" }
    if path.hasSuffix(".wasm") { return "application/wasm" }
    if path.hasSuffix(".html") { return "text/html" }
    return "application/octet-stream"
}

let probePage = """
<!doctype html><meta charset="utf-8"><title>q1</title>
<script type="module">
function say(o) { window.webkit.messageHandlers.q1.postMessage(JSON.stringify(o)); }
(async () => {
  try {
    say({ stage: "origin", origin: location.origin, href: location.href });

    // (a) THE MECHANISM, using the REAL built chunk as the source of the
    // URL: read the shipped JS as text, pull out the inlined
    // data:application/wasm URL, then do exactly what ghostty-web's
    // loadFromPath does -- fetch() it and WebAssembly.compile the result.
    const src = await (await fetch("/assets/\(chunk)")).text();
    const m = src.match(/data:application\\/wasm;base64,[A-Za-z0-9+/=]+/);
    if (!m) { say({ ok: false, stage: "extract", error: "no data: wasm URL in chunk" }); return; }
    say({ stage: "extracted", dataUrlBytes: m[0].length });
    const resp = await fetch(m[0]);
    const buf = await resp.arrayBuffer();
    say({ stage: "fetched", status: resp.status, wasmBytes: buf.byteLength });
    const module = await WebAssembly.compile(buf);
    say({ stage: "compiled", exports: WebAssembly.Module.exports(module).length });

    // (b) THE REAL CALL: import the actual ghostty-web module phasr
    // bundles (pnpm-patched, from node_modules) and run Ghostty.load()
    // with no argument -- the same line preloadGhosttyEngine() runs.
    const mod = await import("/lib/ghostty-web.js");
    const g = await mod.Ghostty.load();
    const t = new mod.Terminal({ ghostty: g, cols: 20, rows: 5 });
    say({ ok: true, stage: "ghostty-load", ctor: g?.constructor?.name ?? null, terminal: t ? "constructed" : "null" });
  } catch (e) {
    say({ ok: false, stage: "threw", error: String(e && e.stack ? e.stack : e) });
  }
})();
</script>
<body>probe</body>
"""

final class SchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { task.didFailWithError(NSError(domain: "q1", code: 1)); return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        let body: Data
        let type: String
        if path == "/index.html" {
            body = probePage.data(using: .utf8)!
            type = "text/html"
        } else {
            let file: URL
            if path.hasPrefix("/lib/") {
                file = distDir.deletingLastPathComponent()
                    .appendingPathComponent("node_modules/ghostty-web/dist")
                    .appendingPathComponent(String(path.dropFirst(5)))
            } else {
                file = distDir.appendingPathComponent(String(path.dropFirst()))
            }
            guard let d = try? Data(contentsOf: file) else {
                let resp = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!
                task.didReceive(resp); task.didReceive(Data()); task.didFinish(); return
            }
            body = d
            type = mime(for: path)
        }
        let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": type,
                                                  "Access-Control-Allow-Origin": "*"])!
        task.didReceive(resp)
        task.didReceive(body)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class Bridge: NSObject, WKScriptMessageHandler {
    var done = false
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        let s = (message.body as? String) ?? "\(message.body)"
        print("Q1 \(s)")
        fflush(stdout)
        if s.contains("\"ok\":true") || s.contains("\"ok\":false") {
            done = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                exit(s.contains("\"ok\":true") ? 0 : 1)
            }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let cfg = WKWebViewConfiguration()
cfg.setURLSchemeHandler(SchemeHandler(), forURLScheme: "tauri")
let bridge = Bridge()
cfg.userContentController.add(bridge, name: "q1")

let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 600), configuration: cfg)
let window = NSWindow(contentRect: NSRect(x: -2000, y: -2000, width: 900, height: 600),
                      styleMask: [.titled], backing: .buffered, defer: false)
window.contentView = webView
window.orderBack(nil)

webView.load(URLRequest(url: URL(string: "tauri://localhost/")!))

DispatchQueue.main.asyncAfter(deadline: .now() + 45) {
    print("Q1 {\"ok\":false,\"stage\":\"timeout\"}")
    exit(3)
}
app.run()
