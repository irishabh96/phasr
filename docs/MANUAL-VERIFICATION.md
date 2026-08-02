# Manual verification — what the automated suites cannot reach

Phasr has four automated layers, and each is blind to something:

| Layer | Proves | Blind to |
|---|---|---|
| `cargo test` (~420) | Rust logic, real git in tempdirs, the policy ladder | the GUI, the webview, real remotes |
| `vitest` (~278) | pure derivations, components in jsdom | IPC truth, real data |
| `playwright` (~131) | flows fire the right command with the right args | **every Tauri `invoke` is mocked** — no real git/PTY/network |
| `real_loop` (Phase 11, `#[ignore]`) | the real spine: clone → worktrees → agent processes → CLI socket → merges → push | Clerk, the webview, window/OS integration |

Everything below is what remains **only** verifiable by a human driving the
built app. Run it after any change to auth, CSP, notifications, or the
window/tab chrome.

## Running the real-loop drive first

```bash
# the deterministic spine, against the real throwaway repo
PHASR_REAL_E2E=1 cargo test --manifest-path src-tauri/Cargo.toml \
    real_loop -- --ignored --nocapture --test-threads=1

# add the outward push leg (namespaced branch, master untouched, auto-deleted)
PHASR_REAL_E2E_PUSH=1 PHASR_REAL_E2E=1 cargo test --manifest-path src-tauri/Cargo.toml \
    real_loop_drives -- --ignored --nocapture --test-threads=1
```

It needs `claude` on PATH (planner test) and `gh`/git credentials (push leg).

## The GUI checklist

### 1. CSP — do this FIRST, it gates everything else
The webview only enforces `security.csp` in a **bundled** build, so `pnpm tauri
dev` is not sufficient evidence.

- [ ] `pnpm tauri build`, launch the `.app` from `src-tauri/target/release/bundle/`
- [ ] Sign in with Clerk end-to-end (this is the known landmine — a naive
      `script-src` broke Clerk before)
- [ ] Open the webview console: **zero** CSP violation entries
- [ ] Avatar image renders in Settings → Account
- [ ] A brief with an image asset renders the preview (`asset:` protocol)
- [ ] Cloud sync round-trips (theme change → relaunch → theme persists)

If sign-in breaks, revert the CSP commit alone — it is deliberately isolated.

### 2. Auth + deep links
- [ ] Sign out, sign back in
- [ ] The `phasr://` OAuth callback deep link returns to the app
- [ ] Relaunch: the session persists, the last workspace restores

### 3. The factory loop, driven by a LIVE agent
The real-loop drive uses a scripted agent by design (determinism). Only a human
can watch a real LLM work a brief.

- [ ] Add a repository, "New workflow", type a goal, Decompose
- [ ] The plan is sensible; edit a ticket, then Start
- [ ] A real agent appears in the ticket terminal and works from the brief
- [ ] Its status is honest: Working → Idle → (busy-but-quiet shows
      "busy, no output Nm" once the CPU sensor sees a long build)
- [ ] Validate → Request review → Approve moves the card to **Done**
- [ ] Integrate produces the combined diff; Ship merges into your default branch
- [ ] Push / Open PR from the post-ship actions
- [ ] Archive the workflow → it leaves the sidebar and lands under Completed

### 4. Autopilot (Stage A and B)
- [ ] Turn autopilot on: Validate + Request-review fire on their own
- [ ] Approve stays yours (the default gate); the kill switch halts everything
- [ ] Turn OFF "You approve" (the confirm names the guardrails) → a QAS
      reviewer spawns and delivers a verdict
- [ ] While it reviews, approve or bounce yourself: **your** decision wins and
      the agent's stale verdict is rejected
- [ ] Ship is still yours in both modes

### 5. OS integration
- [ ] Notifications fire on agent completion and activate the right ticket
- [ ] ⌘-shortcuts (⌘K, ⌘P, ⌘1–9, ⌘T, ⌘W) behave in the real window
- [ ] Quit with agents running → relaunch shows them honestly as interrupted,
      not silently "running"
- [ ] `~/Library/Logs/sh.phasr.desktop/phasr.log` exists and has content

### 6. Both themes, both widths
- [ ] Light and dark, at ~1280px and at the narrowest usable window
- [ ] No horizontal scroll on the board, the diff, or the worklist
