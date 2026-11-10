//! A "needs you" notification the user can answer from the banner: Allow /
//! Deny answer the agent's dialog without opening Phasr; a click on the
//! body opens the task on its agent pane.
//!
//! Whether to send one at all is still the frontend's call
//! (`useNeedsYouNotifications` → `notificationPolicy.ts`: the user's
//! matrix, background-only, quiet hours, what's on screen) — it asks for
//! this one through `notify_attention`, so the policy lives in one place.
//!
//! Tauri-agnostic. The OS side is `AttentionNotifier` (macOS:
//! `mac::MacNotifier`), what an answer does is `AttentionActions` (the app:
//! `commands::events::AppAttentionActions`), so the answer → action mapping
//! and the stale-attention guard are testable without a notification UI.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::broadcast;

use crate::agent_signals::state::{AgentStateKind, Attention, AttentionKind};
use crate::agent_signals::{AgentSignalEvent, AttentionResponse, TaskAgentState};
use crate::domain::Workspace;

use super::attention_text;

/// What the banner shows and which dialog it answers.
#[derive(Debug, Clone, PartialEq)]
pub struct AttentionPrompt {
    pub task_id: String,
    pub repository_id: String,
    /// The dialog this banner answers. An answer is sent with this id, so
    /// it can never land on a newer dialog (`claim_attention`).
    pub attention_id: String,
    pub title: String,
    pub body: String,
    /// Allow / Deny buttons. Only when Phasr knows the dialog's keys, and
    /// never on the trust dialog (its "Deny" exits the agent — not
    /// something to do from a banner).
    pub answerable: bool,
    pub sound: bool,
}

impl AttentionPrompt {
    pub fn new(task: &Workspace, attention: &Attention, sound: bool) -> Self {
        Self {
            task_id: task.id.clone(),
            repository_id: task.repository_id.clone(),
            attention_id: attention.id.clone(),
            title: attention_text::title(&task.name, task.agent),
            body: attention_text::body(attention.kind, &attention.title, attention.detail.as_deref()),
            answerable: attention.can_respond && attention.kind != AttentionKind::Trust,
            sound,
        }
    }
}

/// How the user left the banner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptAnswer {
    Allow,
    Deny,
    /// Clicked the banner itself.
    Open,
    /// Closed, expired, withdrawn, or the OS couldn't show it.
    Dismissed,
}

/// The OS notification. Implementations block, so they are only ever
/// called on a dedicated thread (`AttentionNotifications::deliver`).
pub trait AttentionNotifier: Send + Sync + 'static {
    /// Show `prompt` and wait for the user's answer.
    fn prompt(&self, prompt: &AttentionPrompt) -> PromptAnswer;
    /// Take `prompt` down if it is still showing (answered in the app, or
    /// the agent moved on). Best effort; a late answer is harmless anyway:
    /// it carries the old attention id and is rejected as stale.
    fn withdraw(&self, prompt: &AttentionPrompt);
}

/// What an answer does in the app.
#[async_trait::async_trait]
pub trait AttentionActions: Send + Sync + 'static {
    /// The same path as the `respond_to_attention` command. `Err` carries
    /// the user-facing reason (`"stale attention"` when the dialog changed).
    async fn respond(
        &self,
        task_id: &str,
        attention_id: &str,
        response: AttentionResponse,
    ) -> Result<(), String>;
    /// Bring Phasr forward on the task's agent pane.
    fn open(&self, task_id: &str, repository_id: &str);
}

/// What a banner answer turns into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Followup {
    Respond(AttentionResponse),
    Open,
    Nothing,
}

/// Allow is allow-ONCE only: "allow for this task" depends on which
/// options the dialog on screen offers (`can_allow_for_task`), which a
/// banner can't show. A banner without buttons can't answer at all.
pub fn followup(answer: PromptAnswer, answerable: bool) -> Followup {
    match answer {
        PromptAnswer::Allow if answerable => Followup::Respond(AttentionResponse::AllowOnce),
        PromptAnswer::Deny if answerable => Followup::Respond(AttentionResponse::Deny),
        PromptAnswer::Open => Followup::Open,
        _ => Followup::Nothing,
    }
}

/// The result of acting on an answer (logged; returned for tests).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Settled {
    Answered(AttentionResponse),
    /// The dialog was already answered or replaced: nothing was typed.
    Stale,
    Failed(String),
    Opened,
    Ignored,
}

/// Apply `answer` for `prompt`.
pub async fn settle(
    prompt: &AttentionPrompt,
    answer: PromptAnswer,
    actions: &dyn AttentionActions,
) -> Settled {
    match followup(answer, prompt.answerable) {
        Followup::Respond(response) => {
            match actions
                .respond(&prompt.task_id, &prompt.attention_id, response)
                .await
            {
                Ok(()) => Settled::Answered(response),
                Err(err) if err.contains("stale attention") => Settled::Stale,
                Err(err) => Settled::Failed(err),
            }
        }
        Followup::Open => {
            actions.open(&prompt.task_id, &prompt.repository_id);
            Settled::Opened
        }
        Followup::Nothing => Settled::Ignored,
    }
}

/// What `notify_attention` did. Wire form: `"sent" | "stale" | "unsupported"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NotifyOutcome {
    Sent,
    /// That dialog is no longer up: nothing to say (and no fallback).
    Stale,
    /// No native notifier here: the caller shows its own banner.
    Unsupported,
}

struct Inner {
    /// `None` where there's no native notifier (not macOS): the frontend
    /// falls back to the notification plugin.
    notifier: Option<Arc<dyn AttentionNotifier>>,
    actions: Arc<dyn AttentionActions>,
    /// The banner up per task, until it is answered or withdrawn. One
    /// needs-you dialog per task at a time, so one banner.
    showing: Mutex<HashMap<String, Arc<AttentionPrompt>>>,
}

#[derive(Clone)]
pub struct AttentionNotifications {
    inner: Arc<Inner>,
}

impl AttentionNotifications {
    pub fn new(
        notifier: Option<Arc<dyn AttentionNotifier>>,
        actions: Arc<dyn AttentionActions>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                notifier,
                actions,
                showing: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn supported(&self) -> bool {
        self.inner.notifier.is_some()
    }

    /// Show `prompt` (on its own thread: the OS call blocks until the user
    /// answers) and apply the answer on the async runtime. A second
    /// request for the dialog already showing is a no-op; a newer dialog
    /// replaces the task's old banner. Returns false when unsupported.
    /// Call inside a Tokio runtime.
    pub fn deliver(&self, prompt: AttentionPrompt) -> bool {
        let Some(notifier) = self.inner.notifier.clone() else {
            return false;
        };
        let prompt = Arc::new(prompt);
        let replaced = {
            let mut showing = self.inner.showing.lock();
            if showing
                .get(&prompt.task_id)
                .is_some_and(|p| p.attention_id == prompt.attention_id)
            {
                return true;
            }
            showing.insert(prompt.task_id.clone(), prompt.clone())
        };
        if let Some(old) = replaced {
            notifier.withdraw(&old);
        }
        let runtime = tokio::runtime::Handle::current();
        let this = self.clone();
        let task_id = prompt.task_id.clone();
        let spawned = std::thread::Builder::new()
            .name("phasr-attention-notification".into())
            .spawn(move || {
                let answer = notifier.prompt(&prompt);
                runtime.spawn(async move {
                    let settled = this.finish(&prompt, answer).await;
                    if let Settled::Failed(err) = settled {
                        eprintln!("answering from the notification failed: {err}");
                    }
                });
            });
        if let Err(err) = spawned {
            eprintln!("couldn't show the needs-you notification: {err}");
            self.inner.showing.lock().remove(&task_id);
        }
        true
    }

    /// Notify about `attention_id` if it is still the dialog `state` shows
    /// for `task` — the frontend decided to notify a moment ago, from an
    /// event the agent may already have moved past.
    pub fn notify_if_current(
        &self,
        task: &Workspace,
        state: Option<TaskAgentState>,
        attention_id: &str,
        sound: bool,
    ) -> NotifyOutcome {
        let attention = state
            .filter(|s| s.task_id == task.id && s.state == AgentStateKind::NeedsYou)
            .and_then(|s| s.attention)
            .filter(|a| a.id == attention_id);
        let Some(attention) = attention else {
            return NotifyOutcome::Stale;
        };
        if self.deliver(AttentionPrompt::new(task, &attention, sound)) {
            NotifyOutcome::Sent
        } else {
            NotifyOutcome::Unsupported
        }
    }

    async fn finish(&self, prompt: &Arc<AttentionPrompt>, answer: PromptAnswer) -> Settled {
        {
            let mut showing = self.inner.showing.lock();
            if showing
                .get(&prompt.task_id)
                .is_some_and(|p| Arc::ptr_eq(p, prompt))
            {
                showing.remove(&prompt.task_id);
            }
        }
        settle(prompt, answer, self.inner.actions.as_ref()).await
    }

    /// The task's agent state changed: a banner for a dialog that is no
    /// longer up (answered in the app or the terminal, replaced, the agent
    /// exited) comes down.
    pub fn on_agent_state(&self, state: &TaskAgentState) {
        let current = match state.state {
            AgentStateKind::NeedsYou => state.attention.as_ref().map(|a| a.id.as_str()),
            _ => None,
        };
        let stale = {
            let mut showing = self.inner.showing.lock();
            match showing.get(&state.task_id) {
                Some(p) if Some(p.attention_id.as_str()) != current => {
                    showing.remove(&state.task_id)
                }
                _ => None,
            }
        };
        if let (Some(prompt), Some(notifier)) = (stale, self.inner.notifier.as_ref()) {
            notifier.withdraw(&prompt);
        }
    }

    /// Follow agent-state changes. Call once, inside a Tokio runtime.
    pub fn start(&self, mut signals: broadcast::Receiver<AgentSignalEvent>) {
        if !self.supported() {
            return;
        }
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                match signals.recv().await {
                    Ok(AgentSignalEvent::State(state)) => this.on_agent_state(&state),
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    #[cfg(test)]
    fn showing(&self, task_id: &str) -> Option<String> {
        self.inner
            .showing
            .lock()
            .get(task_id)
            .map(|p| p.attention_id.clone())
    }
}

/// macOS: `NSUserNotification` through `mac-notification-sys` (already in
/// the tree under `tauri-plugin-notification`), which can show buttons and
/// report which one was pressed — the plugin can do neither on desktop.
///
/// What the user must know (also in Settings › Notifications):
/// - The buttons stay on screen only with Phasr's style set to **Alerts**
///   (System Settings › Notifications › Phasr). As a Banner they appear on
///   hover and leave with the banner; it's still in Notification Center.
/// - A dev build (`tauri dev`) isn't a registered bundle: like the plugin,
///   it posts as Terminal (`com.apple.Terminal`), so the banner wears
///   Terminal's icon and a click on it raises Terminal as well as Phasr.
/// - The OS shows nothing while Phasr is the frontmost app (no
///   `shouldPresentNotification` delegate) — the default "only when in the
///   background" policy never asks then anyway.
#[cfg(target_os = "macos")]
pub mod mac {
    use super::{AttentionNotifier, AttentionPrompt, PromptAnswer};
    use mac_notification_sys::{MainButton, Notification, NotificationResponse};

    pub const ALLOW: &str = "Allow";
    pub const DENY: &str = "Deny";

    /// Runs a closure on the main thread (AppKit objects live there).
    pub type MainThread = Box<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

    pub struct MacNotifier {
        bundle_id: String,
        main_thread: MainThread,
    }

    impl MacNotifier {
        pub fn new(bundle_id: impl Into<String>, main_thread: MainThread) -> Self {
            Self {
                bundle_id: bundle_id.into(),
                main_thread,
            }
        }
    }

    impl AttentionNotifier for MacNotifier {
        fn prompt(&self, prompt: &AttentionPrompt) -> PromptAnswer {
            // Process-wide and set-once (shared with the plugin, which sets
            // the same id): `AlreadySet` is the normal case. Unset, the
            // crate would guess, and post as Finder.
            let _ = mac_notification_sys::set_application(&self.bundle_id);
            let mut n = Notification::new();
            n.title(&prompt.title).message(&prompt.body);
            if prompt.sound {
                n.default_sound();
            }
            if prompt.answerable {
                // The close ("other") button is Deny: NSUserNotification
                // has exactly one action button besides the dropdown.
                n.main_button(MainButton::SingleAction(ALLOW)).close_button(DENY);
            } else {
                n.wait_for_click(true);
            }
            match n.send() {
                Ok(response) => answer_of(&response),
                Err(err) => {
                    eprintln!("needs-you notification failed: {err}");
                    PromptAnswer::Dismissed
                }
            }
        }

        fn withdraw(&self, prompt: &AttentionPrompt) {
            let (title, body) = (prompt.title.clone(), prompt.body.clone());
            (self.main_thread)(Box::new(move || remove_delivered(&title, &body)));
        }
    }

    /// The crate doesn't expose the notification's identifier, so match on
    /// its text (task name + command: specific enough). Removing it also
    /// releases the thread waiting on it: the crate sees it gone and
    /// reports `None`.
    #[allow(deprecated)]
    fn remove_delivered(title: &str, body: &str) {
        use objc2_foundation::NSUserNotificationCenter;
        let center = NSUserNotificationCenter::defaultUserNotificationCenter();
        for n in center.deliveredNotifications().iter() {
            let same_title = n.title().is_some_and(|t| t.to_string() == title);
            let same_body = n.informativeText().is_some_and(|t| t.to_string() == body);
            if same_title && same_body {
                center.removeDeliveredNotification(&n);
            }
        }
    }

    pub fn answer_of(response: &NotificationResponse) -> PromptAnswer {
        match response {
            NotificationResponse::ActionButton(label) if label == ALLOW => PromptAnswer::Allow,
            NotificationResponse::CloseButton(label) if label == DENY => PromptAnswer::Deny,
            NotificationResponse::Click => PromptAnswer::Open,
            _ => PromptAnswer::Dismissed,
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn os_responses_map_to_answers() {
            let action = |s: &str| NotificationResponse::ActionButton(s.into());
            let close = |s: &str| NotificationResponse::CloseButton(s.into());
            assert_eq!(answer_of(&action("Allow")), PromptAnswer::Allow);
            assert_eq!(answer_of(&close("Deny")), PromptAnswer::Deny);
            assert_eq!(answer_of(&NotificationResponse::Click), PromptAnswer::Open);
            assert_eq!(answer_of(&NotificationResponse::None), PromptAnswer::Dismissed);
            // Labels that aren't ours (another notification's) do nothing.
            assert_eq!(answer_of(&action("Show")), PromptAnswer::Dismissed);
            assert_eq!(answer_of(&close("Close")), PromptAnswer::Dismissed);
            assert_eq!(answer_of(&NotificationResponse::Reply("y".into())), PromptAnswer::Dismissed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_signals::state::{AttentionSource, KeyOverrides};
    use chrono::Utc;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Answers like `claim_attention`: only the dialog currently up.
    struct FakeActions {
        current: Mutex<Option<String>>,
        responded: Mutex<Vec<(String, String, AttentionResponse)>>,
        opened: Mutex<Vec<(String, String)>>,
        done: Mutex<Option<mpsc::Sender<()>>>,
    }

    impl FakeActions {
        fn with_current(id: &str) -> Arc<Self> {
            Arc::new(Self {
                current: Mutex::new(Some(id.into())),
                responded: Mutex::new(Vec::new()),
                opened: Mutex::new(Vec::new()),
                done: Mutex::new(None),
            })
        }
        fn ping(&self) {
            if let Some(tx) = self.done.lock().as_ref() {
                let _ = tx.send(());
            }
        }
    }

    #[async_trait::async_trait]
    impl AttentionActions for FakeActions {
        async fn respond(
            &self,
            task_id: &str,
            attention_id: &str,
            response: AttentionResponse,
        ) -> Result<(), String> {
            let result = {
                let mut current = self.current.lock();
                if current.as_deref() != Some(attention_id) {
                    Err("stale attention".to_string())
                } else {
                    *current = None;
                    self.responded
                        .lock()
                        .push((task_id.into(), attention_id.into(), response));
                    Ok(())
                }
            };
            self.ping();
            result
        }
        fn open(&self, task_id: &str, repository_id: &str) {
            self.opened.lock().push((task_id.into(), repository_id.into()));
            self.ping();
        }
    }

    struct FakeNotifier {
        answer: PromptAnswer,
        withdrawn: Mutex<Vec<String>>,
        /// While true, every `prompt` waits (the user hasn't looked yet).
        held: std::sync::Mutex<bool>,
        release: std::sync::Condvar,
    }

    impl FakeNotifier {
        fn answering(answer: PromptAnswer) -> Arc<Self> {
            Arc::new(Self {
                answer,
                withdrawn: Mutex::new(Vec::new()),
                held: std::sync::Mutex::new(false),
                release: std::sync::Condvar::new(),
            })
        }
        fn hold(&self) {
            *self.held.lock().unwrap() = true;
        }
        fn let_go(&self) {
            *self.held.lock().unwrap() = false;
            self.release.notify_all();
        }
    }

    impl AttentionNotifier for FakeNotifier {
        fn prompt(&self, _prompt: &AttentionPrompt) -> PromptAnswer {
            let held = self.held.lock().unwrap();
            let _ = self
                .release
                .wait_timeout_while(held, Duration::from_secs(5), |h| *h)
                .unwrap();
            self.answer
        }
        fn withdraw(&self, prompt: &AttentionPrompt) {
            self.withdrawn.lock().push(prompt.attention_id.clone());
        }
    }

    fn prompt(attention_id: &str, answerable: bool) -> AttentionPrompt {
        AttentionPrompt {
            task_id: "t1".into(),
            repository_id: "r1".into(),
            attention_id: attention_id.into(),
            title: "hello sir · Claude needs you".into(),
            body: "Run: ls".into(),
            answerable,
            sound: false,
        }
    }

    fn attention(id: &str, kind: AttentionKind, can_respond: bool) -> Attention {
        Attention {
            id: id.into(),
            kind,
            title: "Run a shell command".into(),
            detail: Some("pnpm test && pnpm lint".into()),
            since: Utc::now(),
            source: AttentionSource::Hook,
            can_respond,
            can_allow_for_task: true,
            keys: KeyOverrides::default(),
        }
    }

    fn state(kind: AgentStateKind, attention_id: Option<&str>) -> TaskAgentState {
        TaskAgentState {
            task_id: "t1".into(),
            repository_id: "r1".into(),
            state: kind,
            attention: attention_id.map(|id| attention(id, AttentionKind::Shell, true)),
            last_activity: None,
            last_turn_ended_at: None,
        }
    }

    #[test]
    fn answers_map_to_followups_and_allow_is_only_ever_once() {
        assert_eq!(
            followup(PromptAnswer::Allow, true),
            Followup::Respond(AttentionResponse::AllowOnce)
        );
        assert_eq!(
            followup(PromptAnswer::Deny, true),
            Followup::Respond(AttentionResponse::Deny)
        );
        assert_eq!(followup(PromptAnswer::Open, true), Followup::Open);
        assert_eq!(followup(PromptAnswer::Dismissed, true), Followup::Nothing);
        // No buttons were shown: a stray answer can't type anything.
        assert_eq!(followup(PromptAnswer::Allow, false), Followup::Nothing);
        assert_eq!(followup(PromptAnswer::Deny, false), Followup::Nothing);
        assert_eq!(followup(PromptAnswer::Open, false), Followup::Open);
    }

    #[test]
    fn the_prompt_is_short_and_offers_buttons_only_when_answerable() {
        let mut task = Workspace::new("r1".into(), "hello sir".into(), "claude".into());
        task.agent = Some(crate::domain::Agent::Claude);
        let p = AttentionPrompt::new(&task, &attention("a1", AttentionKind::Shell, true), true);
        assert_eq!(p.title, "hello sir · Claude needs you");
        assert_eq!(p.body, "Run: pnpm test");
        assert_eq!(p.attention_id, "a1");
        assert!(p.answerable && p.sound);
        assert!(!AttentionPrompt::new(&task, &attention("a1", AttentionKind::Shell, false), false).answerable);
        // The trust dialog's "Deny" exits the agent: never from a banner.
        assert!(!AttentionPrompt::new(&task, &attention("a1", AttentionKind::Trust, true), false).answerable);
    }

    #[tokio::test]
    async fn allow_and_deny_answer_the_dialog_they_were_sent_for() {
        let actions = FakeActions::with_current("a1");
        let got = settle(&prompt("a1", true), PromptAnswer::Allow, actions.as_ref()).await;
        assert_eq!(got, Settled::Answered(AttentionResponse::AllowOnce));
        assert_eq!(
            *actions.responded.lock(),
            vec![("t1".into(), "a1".into(), AttentionResponse::AllowOnce)]
        );

        let actions = FakeActions::with_current("a1");
        let got = settle(&prompt("a1", true), PromptAnswer::Deny, actions.as_ref()).await;
        assert_eq!(got, Settled::Answered(AttentionResponse::Deny));
        assert!(actions.opened.lock().is_empty());
    }

    #[tokio::test]
    async fn a_stale_banner_answers_nothing_not_even_the_newer_dialog() {
        // The banner was for a1; the agent has since asked a2.
        let actions = FakeActions::with_current("a2");
        let got = settle(&prompt("a1", true), PromptAnswer::Allow, actions.as_ref()).await;
        assert_eq!(got, Settled::Stale);
        assert!(actions.responded.lock().is_empty());
        assert!(actions.opened.lock().is_empty());
        assert_eq!(actions.current.lock().as_deref(), Some("a2"));

        // Answered in the app already (nothing up).
        let actions = FakeActions::with_current("a1");
        *actions.current.lock() = None;
        let got = settle(&prompt("a1", true), PromptAnswer::Deny, actions.as_ref()).await;
        assert_eq!(got, Settled::Stale);
        assert!(actions.responded.lock().is_empty());
    }

    #[tokio::test]
    async fn a_click_opens_the_task_and_a_dismissal_does_nothing() {
        let actions = FakeActions::with_current("a1");
        assert_eq!(
            settle(&prompt("a1", true), PromptAnswer::Open, actions.as_ref()).await,
            Settled::Opened
        );
        assert_eq!(*actions.opened.lock(), vec![("t1".into(), "r1".into())]);
        assert_eq!(
            settle(&prompt("a1", true), PromptAnswer::Dismissed, actions.as_ref()).await,
            Settled::Ignored
        );
        assert!(actions.responded.lock().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn deliver_answers_off_the_runtime_and_forgets_the_banner() {
        let actions = FakeActions::with_current("a1");
        let (tx, rx) = mpsc::channel();
        *actions.done.lock() = Some(tx);
        let notifier = FakeNotifier::answering(PromptAnswer::Allow);
        let service = AttentionNotifications::new(Some(notifier.clone()), actions.clone());
        assert!(service.deliver(prompt("a1", true)));
        tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)))
            .await
            .unwrap()
            .expect("the answer was applied");
        assert_eq!(
            *actions.responded.lock(),
            vec![("t1".into(), "a1".into(), AttentionResponse::AllowOnce)]
        );
        // Let `finish` clear it (it runs before `respond` pings).
        assert_eq!(service.showing("t1"), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_banner_comes_down_when_the_dialog_is_answered_in_the_app() {
        let actions = FakeActions::with_current("a1");
        let notifier = FakeNotifier::answering(PromptAnswer::Dismissed);
        notifier.hold();
        let service = AttentionNotifications::new(Some(notifier.clone()), actions.clone());
        service.deliver(prompt("a1", true));
        assert_eq!(service.showing("t1").as_deref(), Some("a1"));

        // Same dialog, still up: stays.
        service.on_agent_state(&state(AgentStateKind::NeedsYou, Some("a1")));
        assert!(notifier.withdrawn.lock().is_empty());
        // Answered in the app → the agent works again: withdrawn.
        service.on_agent_state(&state(AgentStateKind::Working, None));
        assert_eq!(*notifier.withdrawn.lock(), vec!["a1".to_string()]);
        assert_eq!(service.showing("t1"), None);
        notifier.let_go();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_newer_dialog_replaces_the_old_banner_and_a_repeat_is_ignored() {
        let actions = FakeActions::with_current("a2");
        let notifier = FakeNotifier::answering(PromptAnswer::Dismissed);
        notifier.hold();
        let service = AttentionNotifications::new(Some(notifier.clone()), actions.clone());
        service.deliver(prompt("a1", true));
        assert!(service.deliver(prompt("a1", true)));
        assert!(notifier.withdrawn.lock().is_empty());

        service.deliver(prompt("a2", true));
        assert_eq!(*notifier.withdrawn.lock(), vec!["a1".to_string()]);
        assert_eq!(service.showing("t1").as_deref(), Some("a2"));
        // A different dialog took over: the a2 banner goes too.
        service.on_agent_state(&state(AgentStateKind::NeedsYou, Some("a3")));
        assert_eq!(
            *notifier.withdrawn.lock(),
            vec!["a1".to_string(), "a2".to_string()]
        );
        notifier.let_go();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn only_the_dialog_still_up_is_notified() {
        let notifier = FakeNotifier::answering(PromptAnswer::Dismissed);
        notifier.hold();
        let service = AttentionNotifications::new(
            Some(notifier.clone()),
            FakeActions::with_current("a1"),
        );
        let mut task = Workspace::new("r1".into(), "hello sir".into(), "claude".into());
        task.id = "t1".into();
        let up = |id: &str| Some(state(AgentStateKind::NeedsYou, Some(id)));

        assert_eq!(service.notify_if_current(&task, None, "a1", false), NotifyOutcome::Stale);
        assert_eq!(
            service.notify_if_current(&task, Some(state(AgentStateKind::Working, None)), "a1", false),
            NotifyOutcome::Stale
        );
        assert_eq!(service.notify_if_current(&task, up("a2"), "a1", false), NotifyOutcome::Stale);
        assert_eq!(service.showing("t1"), None);
        assert_eq!(service.notify_if_current(&task, up("a1"), "a1", true), NotifyOutcome::Sent);
        assert_eq!(service.showing("t1").as_deref(), Some("a1"));
        notifier.let_go();

        let unsupported = AttentionNotifications::new(None, FakeActions::with_current("a1"));
        assert_eq!(
            unsupported.notify_if_current(&task, up("a1"), "a1", false),
            NotifyOutcome::Unsupported
        );
        // Stale wins: the caller must not fall back to its own banner.
        assert_eq!(unsupported.notify_if_current(&task, up("a2"), "a1", false), NotifyOutcome::Stale);
        assert_eq!(serde_json::to_value(NotifyOutcome::Unsupported).unwrap(), "unsupported");
    }

    #[test]
    fn without_a_native_notifier_nothing_is_delivered() {
        let service = AttentionNotifications::new(None, FakeActions::with_current("a1"));
        assert!(!service.supported());
        assert!(!service.deliver(prompt("a1", true)));
    }
}
