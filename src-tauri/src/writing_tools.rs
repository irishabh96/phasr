//! macOS Writing Tools ("Write with Siri") off for the app's webview.
//!
//! Writing Tools attaches to whatever editable element has focus. The agent
//! terminal's input is a hidden textarea and a contenteditable host (both
//! ghostty-web's), so macOS put its round icon and a "Write with Siri"
//! bubble at the terminal's top-left corner, and anything it wrote would be
//! typed into the PTY.
//!
//! WebKit has no per-element switch for Writing Tools (the HTML attributes
//! the frontend sets cover predictions, spellcheck and autocorrect; see
//! `src/lib/terminal/textAssist.ts`). The one public control is
//! `WKWebViewConfiguration.writingToolsBehavior` (macOS 15+), which is read
//! when the webview is created, so the main window is built in `setup` with
//! this configuration instead of straight from `tauri.conf.json`. That turns
//! Writing Tools off app-wide, the composer and New task prompt included.

use objc2::rc::Retained;
use objc2::runtime::NSObjectProtocol;
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_web_kit::WKWebViewConfiguration;

/// `NSWritingToolsBehaviorNone` (AppKit `NSTextCheckingClient.h`).
const NS_WRITING_TOOLS_BEHAVIOR_NONE: isize = -1;

/// A fresh webview configuration with Writing Tools disabled where the OS
/// has it. Everything else is WebKit's default, which is what wry would
/// have created: the default website data store (no incognito, no data
/// store identifier in `tauri.conf.json`), so storage is unchanged.
pub fn webview_configuration(mtm: MainThreadMarker) -> Retained<WKWebViewConfiguration> {
    // SAFETY: plain allocation of a WebKit configuration on the main thread.
    let config = unsafe { WKWebViewConfiguration::new(mtm) };
    // Before macOS 15 there is no Writing Tools and no such property.
    if config.respondsToSelector(sel!(setWritingToolsBehavior:)) {
        // SAFETY: the selector exists (checked above) and takes an
        // `NSWritingToolsBehavior`, an `NSInteger` enum.
        unsafe {
            let _: () =
                msg_send![&*config, setWritingToolsBehavior: NS_WRITING_TOOLS_BEHAVIOR_NONE];
        }
    }
    config
}
