//! Hold fn (🌐) to dictate. macOS reports fn only as a modifier change
//! (`flagsChanged`), which never reaches the webview as a key event, so a
//! local event monitor (Phasr's own windows, while it's frontmost — no
//! Accessibility or Input Monitoring permission) watches for it and tells
//! the frontend: `down`, `up`, and `chord` when another key or modifier
//! joins in while fn is held (fn+← is Home, fn+⌫ is forward delete — not
//! a request to talk). The events pass through untouched.

use serde::Serialize;

/// `kVK_Function`; the globe key on newer Apple keyboards reports 179.
const FN_KEY_CODES: [u16; 2] = [63, 179];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FnKey {
    Down,
    Up,
    Chord,
}

/// Turns the monitor's raw events into `FnKey`s.
#[derive(Debug, Default)]
pub struct FnTracker {
    held: bool,
    chorded: bool,
}

impl FnTracker {
    /// A modifier changed: `key_code` is the key that did it, `fn_flag`
    /// whether fn is down now.
    pub fn flags_changed(&mut self, key_code: u16, fn_flag: bool) -> Option<FnKey> {
        if FN_KEY_CODES.contains(&key_code) {
            return match (self.held, fn_flag) {
                (false, true) => {
                    self.held = true;
                    self.chorded = false;
                    Some(FnKey::Down)
                }
                (true, false) => {
                    self.held = false;
                    Some(FnKey::Up)
                }
                _ => None,
            };
        }
        if self.held && !fn_flag {
            // fn's own release went missing (it happened in another app).
            self.held = false;
            return Some(FnKey::Up);
        }
        self.key_down()
    }

    /// Any key pressed.
    pub fn key_down(&mut self) -> Option<FnKey> {
        if self.held && !self.chorded {
            self.chorded = true;
            return Some(FnKey::Chord);
        }
        None
    }
}

#[derive(Clone, Serialize)]
struct FnKeyPayload {
    kind: FnKey,
}

/// Install the monitor for the app's lifetime. Main thread only.
#[cfg(target_os = "macos")]
pub fn install(app: tauri::AppHandle) {
    use std::cell::RefCell;
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use tauri::Emitter;

    let tracker = RefCell::new(FnTracker::default());
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the monitor a live event for the call.
        let ev = unsafe { event.as_ref() };
        let kind = match ev.r#type() {
            NSEventType::FlagsChanged => tracker.borrow_mut().flags_changed(
                ev.keyCode(),
                ev.modifierFlags().contains(NSEventModifierFlags::Function),
            ),
            NSEventType::KeyDown => tracker.borrow_mut().key_down(),
            _ => None,
        };
        if let Some(kind) = kind {
            let _ = app.emit(crate::commands::events::FN_KEY_EVENT, FnKeyPayload { kind });
        }
        event.as_ptr()
    });
    // SAFETY: the handler returns the event it was given.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::FlagsChanged | NSEventMask::KeyDown,
            &block,
        )
    };
    // Lives as long as the app; AppKit keeps the block.
    std::mem::forget(monitor);
}

/// What macOS does when fn (🌐) is pressed on its own: System Settings ›
/// Keyboard › "Press 🌐 key to". Anything but "Do Nothing" also happens
/// when you let go of fn after dictating.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GlobeKeyAction {
    Nothing,
    InputSource,
    Emoji,
    Dictation,
    /// Not macOS.
    Unsupported,
}

/// `defaults read com.apple.HIToolbox AppleFnUsageType`'s output (None =
/// never set: macOS's default, the emoji picker).
pub fn parse_globe_key_action(defaults_output: Option<&str>) -> GlobeKeyAction {
    match defaults_output.map(str::trim) {
        Some("0") => GlobeKeyAction::Nothing,
        Some("1") => GlobeKeyAction::InputSource,
        Some("3") => GlobeKeyAction::Dictation,
        _ => GlobeKeyAction::Emoji,
    }
}

pub async fn globe_key_action() -> GlobeKeyAction {
    if !cfg!(target_os = "macos") {
        return GlobeKeyAction::Unsupported;
    }
    let out = tokio::process::Command::new("/usr/bin/defaults")
        .args(["read", "com.apple.HIToolbox", "AppleFnUsageType"])
        .output()
        .await;
    let text = out.ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
    parse_globe_key_action(text.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hold_and_release() {
        let mut t = FnTracker::default();
        assert_eq!(t.flags_changed(63, true), Some(FnKey::Down));
        assert_eq!(t.flags_changed(63, true), None);
        assert_eq!(t.flags_changed(63, false), Some(FnKey::Up));
        assert_eq!(t.flags_changed(63, false), None);
        // The globe key's code too.
        assert_eq!(t.flags_changed(179, true), Some(FnKey::Down));
        assert_eq!(t.flags_changed(179, false), Some(FnKey::Up));
    }

    #[test]
    fn other_keys_while_held_are_a_chord_once() {
        let mut t = FnTracker::default();
        assert_eq!(t.key_down(), None, "no fn, no chord");
        t.flags_changed(63, true);
        assert_eq!(t.key_down(), Some(FnKey::Chord));
        assert_eq!(t.key_down(), None);
        assert_eq!(t.flags_changed(63, false), Some(FnKey::Up));
        // A modifier joining in (fn+⇧) counts too.
        t.flags_changed(63, true);
        assert_eq!(t.flags_changed(56, true), Some(FnKey::Chord));
        // fn released elsewhere: the next modifier change without the flag ends it.
        assert_eq!(t.flags_changed(56, false), Some(FnKey::Up));
        assert_eq!(t.key_down(), None);
    }

    #[test]
    fn globe_setting() {
        assert_eq!(parse_globe_key_action(Some("0\n")), GlobeKeyAction::Nothing);
        assert_eq!(parse_globe_key_action(Some("1")), GlobeKeyAction::InputSource);
        assert_eq!(parse_globe_key_action(Some("2")), GlobeKeyAction::Emoji);
        assert_eq!(parse_globe_key_action(Some("3")), GlobeKeyAction::Dictation);
        assert_eq!(parse_globe_key_action(None), GlobeKeyAction::Emoji);
    }
}
