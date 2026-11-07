//! Windows mouse hook: middle-button push-to-talk **and** capsule hover
//! passthrough (Windows only).
//!
//! A dedicated background thread owns a low-level mouse hook
//! (`SetWindowsHookExW(WH_MOUSE_LL)`) and its message pump. Three independent
//! consumers share it:
//!
//! 1. **Middle-button PTT.** `WM_MBUTTONDOWN` starts a recording session and
//!    `WM_MBUTTONUP` stops it — the same press/release semantics as the
//!    keyboard PTT binding in [`crate::hotkey`]. Gated by the
//!    `mouse.middleClickPtt` setting ([`ENABLED`]).
//! 2. **Capsule hover passthrough.** The HUD / session windows are 280×64
//!    transparent windows whose visible capsule covers only part of them; the
//!    rest must click/scroll **through** to the app below (the reported bug:
//!    a ~3cm invisible strip next to the docked capsule swallowed scrollbar
//!    drags and mis-triggered recording). The window's
//!    `set_ignore_cursor_events` flag is therefore driven from **hover over the
//!    capsule's visible rect**, which the hook can see even while the window is
//!    in pass-through mode (a webview `mouseenter` cannot — that is why the old
//!    "no hover passthrough" decision, recorded in `HUD.tsx`, no longer
//!    applies). The rect is pushed by the renderer
//!    (`commands::set_overlay_hit_rect`); hits outside it flip the flag to
//!    "ignore", hits inside (or an active gesture lock) flip it back.
//! 3. **Selection-hub outside-click dismiss.** The hub (`hub.rs`) is a
//!    non-focusable always-on-top panel, so it never receives a blur when the
//!    user clicks another application. While a hub is open, any button press
//!    that lands outside our own capsule windows closes it
//!    ([`crate::hub::close_hub`]) — the standard popup-menu dismissal. The
//!    hub's own background click already closes it in the renderer; the hook
//!    only covers clicks that leave the hub window entirely.
//!
//! The hook itself is installed **whenever the process runs** (decoupled from
//! [`ENABLED`]); the middle-button branch simply does nothing while the
//! setting is off.
//!
//! Design notes:
//!
//! * **Observing only.** The hook never swallows input: every event is passed
//!   on through `CallNextHookEx`, so middle-click paste in terminals and other
//!   middle-button behaviors keep working (they may fire *together* with the
//!   recording trigger — the settings copy warns about this).
//! * **Wheel is inert.** The callback acts on `WM_MBUTTONDOWN` /
//!   `WM_MBUTTONUP` and nothing else, so `WM_MOUSEWHEEL` / `WM_MOUSEHWHEEL` (and
//!   every other mouse message) can never start, stop or otherwise disturb a
//!   held session — scrolling mid-press leaves the down/up pair intact. The
//!   message→action decision is the pure `win::classify` whitelist, locked by
//!   regression tests; see its comment for the `WM_MOUSELAST`/wheel range trap
//!   it guards.
//! * **Bounce-tolerant release — event-driven, never key-state-driven.**
//!   Scrolling the wheel vibrates the middle switch, and a mechanical switch
//!   can chatter *open* for a moment: Windows then delivers a real
//!   `WM_MBUTTONUP` immediately followed by another `WM_MBUTTONDOWN`, although
//!   the finger still holds the button. The worker therefore never acts on a
//!   release at once: it waits out a short grace window
//!   (`win::RELEASE_BOUNCE_WINDOW`) for that re-press. A press inside the
//!   window is the causal proof that the switch never really opened — the
//!   release is absorbed as chatter and both the session and the ownership
//!   token are kept, so the genuine release still stops later. No press inside
//!   the window (or a press only after it) is a genuine release and the stop
//!   proceeds. Chatter can thus only *delay* a stop, never veto it.
//!
//!   **Regression trap (P0: "middle-button release never stops").** The first
//!   attempt gated the release on `GetAsyncKeyState(VK_MBUTTON)` (high bit =
//!   "currently held") read on the worker, "vetoing" the stop while held. That
//!   signal is unusable for the event being handled: a low-level hook callback
//!   runs *before* the asynchronous key state is updated (documented on
//!   `LowLevelKeyboardProc`/`LowLevelMouseProc`), so reading it from the worker
//!   right after the enqueue still observes the pre-event (held) state on real
//!   hardware — every genuine release was swallowed as a bounce and the
//!   recording only ended at the 5-minute cap. The event *pair* is the causal
//!   evidence; a sampled key state is not. Decision logic is the pure
//!   `win::release_after_bounce_window`, locked by tests. The `Disable` stop
//!   decision never enters the grace window (it must always stop).
//! * **Hook latency budget.** `WH_MOUSE_LL` callbacks must return quickly (the
//!   system silently removes hooks that block, ~300 ms), so the hook procedure
//!   only performs *local* Win32 calls (the `WindowFromPoint`/`GetAncestor`
//!   hit test for the middle button, `GetWindowRect` + pure rect math for the
//!   hover hit test) and a non-blocking channel send. Every Tauri call (focus
//!   guard, overlay lookup, session start, `set_ignore_cursor_events`) runs on
//!   a **single serial worker** task. Hover is only *decided* in the hook
//!   ([`ignore_flip`]); the flip is dispatched to the worker and applied
//!   there, so mouse movement never becomes an IPC storm (state changes only).
//! * **Serial worker + session token.** Mouse events are queued (mpsc) and
//!   processed strictly in order by one async task. A Start that succeeds
//!   records the id of the session it started (the ownership token); a Stop
//!   only stops a session when `session.id == token && status == Recording`
//!   and then clears the token. Every other start / stop / cancel / error path
//!   clears the token too (`clear_owned_session`), so a stale release can never
//!   kill a session it does not own (e.g. keyboard-PTT session S2 after a
//!   middle-click session S1 ended early) and never produces a bogus
//!   "no recording in progress" error toast. Because Start/Stop decisions are
//!   serialized, a fast click (down immediately followed by up) can never leave
//!   an orphan recording: the Stop is decided after its Start, always.
//!   The long-running finalize (transcribe) is spawned detached so the worker
//!   keeps draining events; a Start during `Processing` is then rejected by
//!   `commands::start_session_internal` (W3) instead of queueing behind the
//!   transcription and firing minutes later.
//! * **Same guards as keyboard PTT.** No trigger while the main window is
//!   focused (`hotkey::main_window_focused`) or while the settings hotkey
//!   recorder owns the keyboard (`AppState::hotkey_capture_active`). The
//!   guards run on the worker, before the start.
//! * **De-dup with the HUD capsule.** Middle clicks that land on the always-on
//!   overlay capsule belong to its pointer handlers (feature A wins); the hook
//!   records the root window under the cursor with pure Win32 calls and the
//!   worker compares it against the overlay's `hwnd`.
//! * **Thread-safe toggling.** The hook handle is only ever touched by the pump
//!   thread (single owner) and is now **permanent** — hover passthrough needs
//!   it even while middle-click PTT is off, so the thread installs it at
//!   startup (retrying slowly on failure) and `set_middle_click_ptt` only
//!   flips [`ENABLED`], so enable/disable can never race
//!   `SetWindowsHookExW`/`UnhookWindowsHookEx`. Disabling mid-press queues the
//!   same stop decision as a button release (minus the bounce re-check) so the
//!   recording cannot orphan.
//! * **Hover passthrough state machine.** Per capsule window (overlay /
//!   session) the module keeps: the renderer-pushed visible rect
//!   ([`HitRect`], physical px relative to the window, packed lock-free into
//!   one `AtomicU64` — the hook reads it without locking, see [`pack_hit_rect`]),
//!   the window `hwnd`, a **grab** lock (renderer says "an interaction is in
//!   flight": pending / holding / dragging / latched / recording — the flag
//!   must stay interactive or the gesture would be torn in half by a hover
//!   flip), and the last-applied ignore flag (flip de-dup). The pure decision
//!   [`ignore_flip`] computes the next flag and returns `Some` **only on a
//!   state change**; changes go to the worker, which calls Tauri and then
//!   re-runs the idempotent `windowing::harden_overlay_window`. **Before the
//!   renderer has ever pushed a rect (`CAPSULE_RECEIVED = false`) the flag is
//!   never touched**: the window stays interactive exactly like pre-hover
//!   builds, so a renderer that fails to push can never leave an unclickable
//!   capsule (the 0.5.1 lesson). After the first push the mechanism owns the
//!   flag exclusively; a cleared rect (capsule hidden / webview gone) means
//!   "always pass through". The hit test uses the window's current
//!   `GetWindowRect` origin, so a dragged / repositioned window cannot stale
//!   it; a stationary cursor + a moving window is re-evaluated through
//!   [`refresh_capsule_hover`], which every Rust-side window move
//!   (`commands::OverlayFrame::apply`) and every rect / grab push calls.
//!
//! Non-Windows builds compile to no-op stubs; no extra crate is required
//! (`windows-sys` with `Win32_UI_WindowsAndMessaging` already ships).

/// Which capsule window a hover-passthrough entry belongs to. The two windows
/// are fully independent: each owns its own rect / grab / flag state.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum CapsuleKind {
    /// The draggable standby HUD (`windowing::OVERLAY_WINDOW_LABEL`).
    Overlay = 0,
    /// The session capsule (`windowing::SESSION_WINDOW_LABEL`).
    Session = 1,
}

// The kind table is consumed by the Windows hook module; non-Windows builds
// compile only the stubs below, so keep the helpers warning-free there.
#[cfg_attr(not(windows), allow(dead_code))]
impl CapsuleKind {
    /// Every kind, for iteration over the per-window state tables.
    pub const ALL: [CapsuleKind; 2] = [CapsuleKind::Overlay, CapsuleKind::Session];

    /// Resolve the capsule a window label belongs to. `None` for any other
    /// window (`main`, `background`, ...): invoke callers are untrusted and a
    /// non-capsule window must never be able to grab hover-passthrough state.
    pub fn from_label(label: &str) -> Option<CapsuleKind> {
        match label {
            crate::windowing::OVERLAY_WINDOW_LABEL => Some(CapsuleKind::Overlay),
            crate::windowing::SESSION_WINDOW_LABEL => Some(CapsuleKind::Session),
            _ => None,
        }
    }

    /// The window label this kind owns.
    pub fn label(self) -> &'static str {
        match self {
            CapsuleKind::Overlay => crate::windowing::OVERLAY_WINDOW_LABEL,
            CapsuleKind::Session => crate::windowing::SESSION_WINDOW_LABEL,
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// Axis-aligned integer-pixel rect. Used in two coordinate spaces:
///
/// * **window-relative physical px** — what [`pack_hit_rect`] stores (the
///   renderer pushes logical px; the command converts), and
/// * **screen physical px** — what [`point_in_rect`] tests against (the hook's
///   `POINT` is a desktop coordinate; the window's `GetWindowRect` origin is
///   added to the stored rect at test time).
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct HitRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Pure hit test: `point` inside `rect`. Left/top edges are inclusive,
/// right/bottom exclusive — exactly one of two abutting rects can claim a
/// point on their shared edge, and a point exactly on the capsule's outer edge
/// still belongs to the capsule (0.5.1: edge presses must work).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn point_in_rect(point: (i32, i32), rect: HitRect) -> bool {
    let (px, py) = point;
    let inside_x = px >= rect.x && (px as i64) < rect.x as i64 + rect.w as i64;
    let inside_y = py >= rect.y && (py as i64) < rect.y as i64 + rect.h as i64;
    inside_x && inside_y
}

/// Pack a [`HitRect`] into one `u64` (4 × i16, saturating). One atomic word is
/// the whole point: the hook callback reads the rect with a single relaxed
/// load — no lock, no torn multi-field snapshot — while the renderer-side
/// command writes it with a single store. Every field fits i16 comfortably
/// (the rect is clamped to the 280×64 window before it ever gets here).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn pack_hit_rect(rect: HitRect) -> u64 {
    let field = |v: i32| v.clamp(i16::MIN as i32, i16::MAX as i32) as u16 as u64;
    field(rect.x) | (field(rect.y) << 16) | (field(rect.w) << 32) | (field(rect.h) << 48)
}

/// Unpack what [`pack_hit_rect`] stored. `None` for the zero word and for any
/// degenerate rect (non-positive width / height) — "no capsule" means the
/// window is fully pass-through.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn unpack_hit_rect(packed: u64) -> Option<HitRect> {
    let field = |shift: u32| ((packed >> shift) as u16 as i16) as i32;
    let rect = HitRect {
        x: field(0),
        y: field(16),
        w: field(32),
        h: field(48),
    };
    if rect.w > 0 && rect.h > 0 {
        Some(rect)
    } else {
        None
    }
}

/// Pure hover-passthrough decision: the next `set_ignore_cursor_events` value
/// for one capsule window, or `None` when nothing changes.
///
/// The window passes input through **unless** the cursor is over the visible
/// capsule (`hover_inside`) or the renderer grabbed the interaction
/// (`grabbed`: a gesture / recording is in flight and must never be cut in
/// half by a hover flip). Returning `None` on "no change" is what keeps mouse
/// movement from turning into IPC: only actual state flips are dispatched.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn ignore_flip(prev_ignore: bool, hover_inside: bool, grabbed: bool) -> Option<bool> {
    let want = !(hover_inside || grabbed);
    if want != prev_ignore {
        Some(want)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hover over the visible capsule: the window must take the click (ignore
    /// off). Off the capsule: pass through. Edge semantics are locked here
    /// (left/top inclusive, right/bottom exclusive) so the capsule can never
    /// grow or shrink a pixel at its boundary.
    #[test]
    fn point_in_rect_hits_only_inside_the_capsule() {
        let rect = HitRect {
            x: 10,
            y: 20,
            w: 32,
            h: 32,
        };
        assert!(point_in_rect((10, 20), rect), "left/top edge is inside");
        assert!(point_in_rect((41, 51), rect), "deepest inside pixel");
        assert!(!point_in_rect((42, 20), rect), "right edge is outside");
        assert!(!point_in_rect((10, 52), rect), "bottom edge is outside");
        assert!(!point_in_rect((9, 30), rect));
        assert!(!point_in_rect((30, 19), rect));
    }

    /// The rect math is done in i64 for the max edge so hostile or degenerate
    /// input can never overflow and wrap a hit test open.
    #[test]
    fn point_in_rect_is_overflow_safe() {
        let rect = HitRect {
            x: i32::MAX - 1,
            y: 0,
            w: i32::MAX,
            h: 1,
        };
        assert!(!point_in_rect((-1, 0), rect));
        assert!(point_in_rect((i32::MAX - 1, 0), rect));
    }

    /// The packed word is the hook's lock-free snapshot: every field must
    /// round-trip bit-exact, and a degenerate rect must unpack to "no capsule".
    #[test]
    fn packed_hit_rect_round_trips() {
        for rect in [
            HitRect {
                x: 0,
                y: 0,
                w: 1,
                h: 1,
            },
            HitRect {
                x: -16,
                y: 48,
                w: 130,
                h: 45,
            },
            HitRect {
                x: 280,
                y: 64,
                w: 400,
                h: 120,
            },
        ] {
            assert_eq!(unpack_hit_rect(pack_hit_rect(rect)), Some(rect));
        }
        assert_eq!(unpack_hit_rect(0), None, "the zero word is 'no capsule'");
        let degenerate = HitRect {
            x: 5,
            y: 5,
            w: 0,
            h: 10,
        };
        assert_eq!(unpack_hit_rect(pack_hit_rect(degenerate)), None);
    }

    /// Flips are dispatched **only** on state change ("no 60Hz IPC storm") and
    /// the decision is exactly `!(hover || grab)`.
    #[test]
    fn ignore_flip_only_fires_on_state_change() {
        // Cursor on the capsule: the window must become interactive.
        assert_eq!(ignore_flip(true, true, false), Some(false));
        // Already interactive: nothing to dispatch.
        assert_eq!(ignore_flip(false, true, false), None);
        // Cursor off the capsule, no gesture: pass through.
        assert_eq!(ignore_flip(false, false, false), Some(true));
        assert_eq!(ignore_flip(true, false, false), None);
    }

    /// Regression (gesture lock): while a gesture / recording is in flight the
    /// window must stay interactive even with the cursor outside the capsule,
    /// otherwise a hover flip mid-press tears the gesture in half (the pointer
    /// capture is moot if the window starts ignoring input under the finger).
    #[test]
    fn grab_keeps_the_window_interactive_regardless_of_hover() {
        assert_eq!(ignore_flip(true, false, true), Some(false));
        assert_eq!(ignore_flip(false, false, true), None);
        assert_eq!(ignore_flip(false, true, true), None);
    }
}

#[cfg(not(windows))]
pub fn init(_app: &tauri::AppHandle) {}

#[cfg(not(windows))]
pub fn set_middle_click_ptt(_enabled: bool) {}

#[cfg(not(windows))]
pub fn clear_owned_session() {}

/// Non-Windows hover-passthrough stubs: there is no `WH_MOUSE_LL` hook to see
/// hover through a pass-through window, so the flag simply stays interactive
/// (pre-hover behavior — no regression) and these are no-ops.
#[cfg(not(windows))]
pub fn register_capsule_window(_kind: CapsuleKind, _hwnd: isize) {}

#[cfg(not(windows))]
pub fn set_capsule_hit_rect(_kind: CapsuleKind, _rect: Option<HitRect>) {}

#[cfg(not(windows))]
pub fn set_capsule_grab(_kind: CapsuleKind, _grabbed: bool) {}

#[cfg(not(windows))]
pub fn refresh_capsule_hover(_kind: CapsuleKind) {}

#[cfg(not(windows))]
pub fn sync_ignore_state(_kind: CapsuleKind, _ignore: bool) {}

#[cfg(windows)]
pub use win::{
    clear_owned_session, init, refresh_capsule_hover, register_capsule_window, set_capsule_grab,
    set_capsule_hit_rect, set_middle_click_ptt, sync_ignore_state,
};

#[cfg(windows)]
mod win {
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock, PoisonError};
    use std::time::Duration;

    use tauri::{AppHandle, Manager};
    use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
    use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetAncestor, GetCursorPos, GetWindowRect, PeekMessageW,
        SetWindowsHookExW, TranslateMessage, WindowFromPoint, GA_ROOT, HHOOK, MSG, MSLLHOOKSTRUCT,
        PM_REMOVE, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
        WM_MOUSEMOVE, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
    };

    use super::{ignore_flip, pack_hit_rect, point_in_rect, unpack_hit_rect, CapsuleKind, HitRect};

    /// Process-wide app handle shared with the hook procedure (a plain
    /// `extern "system"` callback cannot capture state).
    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// Desired state of the middle-click push-to-talk hook; mirrors the
    /// persisted `mouse.middleClickPtt` config. **Only gates the middle-button
    /// branch** — the hook itself is permanent (hover passthrough needs it).
    static ENABLED: AtomicBool = AtomicBool::new(false);

    /// Spawn guard: the pump thread runs for the whole process lifetime.
    static THREAD_RUNNING: AtomicBool = AtomicBool::new(false);

    /// Hover-passthrough state, indexed by [`CapsuleKind::index`]. The hook
    /// callback reads all of it with atomic loads only (module header: no
    /// locks in the hook).
    ///
    /// `hwnd` of the capsule window (0 = unknown; refreshed on every rect
    /// push). The hit test needs its current `GetWindowRect` origin because
    /// the window moves (drag, snap, reset) while the rect stays
    /// window-relative.
    static CAPSULE_HWND: [AtomicIsize; 2] = [AtomicIsize::new(0), AtomicIsize::new(0)];
    /// Visible-capsule rect packed by [`pack_hit_rect`] (0 = none).
    static CAPSULE_RECT: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];
    /// Whether the renderer ever pushed a rect for this capsule. While this is
    /// `false` the ignore flag is **never touched** (safe default: interactive,
    /// exactly like pre-hover builds) — a renderer that fails to push can
    /// never leave an unclickable capsule behind.
    static CAPSULE_RECEIVED: [AtomicBool; 2] = [AtomicBool::new(false), AtomicBool::new(false)];
    /// Renderer-declared interaction lock: a gesture / recording is in flight,
    /// so the window must stay interactive whatever hover says.
    static CAPSULE_GRAB: [AtomicBool; 2] = [AtomicBool::new(false), AtomicBool::new(false)];
    /// Last applied `set_ignore_cursor_events` value, used to dispatch flips
    /// only on state change.
    static CAPSULE_IGNORE: [AtomicBool; 2] = [AtomicBool::new(false), AtomicBool::new(false)];

    /// Hook -> serial worker event queue. Unbounded and non-blocking on the
    /// send side so the hook procedure never waits; FIFO order is what makes
    /// "down then up" (fast click) deterministic.
    static EVENT_TX: OnceLock<UnboundedSender<HookEvent>> = OnceLock::new();

    /// Ownership token: id of the session the middle button press started.
    /// Only the worker's Stop decision reads it; any start/stop/cancel/error
    /// path may clear it via [`clear_owned_session`]. `None` means "the release
    /// must not stop anything".
    static OWNED_SESSION: Mutex<Option<String>> = Mutex::new(None);

    /// Events forwarded from the hook to the serial worker.
    enum HookEvent {
        /// `WM_MBUTTONDOWN`. `root_hwnd` is the top-level window under the
        /// cursor at event time (`GetAncestor(WindowFromPoint(..), GA_ROOT)`),
        /// computed with pure Win32 calls in the hook; the worker compares it
        /// with the overlay window handle.
        Down { root_hwnd: isize },
        /// `WM_MBUTTONUP`.
        Up,
        /// The setting was turned off (possibly mid-press): same stop decision
        /// as a release (but never held back by the bounce grace window), so an
        /// owned recording cannot be orphaned.
        Disable,
        /// Hover-passthrough state flip: the worker performs the Tauri call
        /// (`set_ignore_cursor_events`) — the hook only decides ([`ignore_flip`])
        /// and enqueues, so mouse movement never becomes an IPC storm.
        SetIgnore { kind: CapsuleKind, ignore: bool },
        /// A button press while the selection hub is open
        /// ([`is_dismiss_press`]): close the hub unless it landed on our own
        /// capsule windows. `root_hwnd` is captured in the hook like [`Down`].
        OutsidePress { root_hwnd: isize },
    }

    /// Whether the stop decision came from a real button release or from the
    /// setting turning off: only a real release goes through the bounce grace
    /// window (see [`handle_deferred_release`]).
    #[derive(Debug, Copy, Clone, PartialEq, Eq)]
    enum StopCause {
        /// `WM_MBUTTONUP`, already past the bounce grace window.
        Release,
        /// Setting turned off mid-press: stop unconditionally.
        Disable,
    }

    /// Pump tick. The message queue must be drained continuously — that is
    /// what delivers hook callbacks — so this stays at the low "armed" value
    /// for the whole process lifetime now (hover flips want low latency: the
    /// flip must land long before a deliberate click arrives on the capsule).
    const POLL_ARMED: Duration = Duration::from_millis(5);

    /// Retry delay after `SetWindowsHookExW` fails. Slow on purpose: a hot
    /// retry loop would spam the log and burn CPU for a condition that is
    /// effectively permanent (a hook install fails for process-wide reasons).
    const HOOK_RETRY_INTERVAL: Duration = Duration::from_secs(5);

    /// Grace window a release waits out for a possible re-press before it is
    /// allowed to stop the session. Middle-switch chatter (a contact that
    /// momentarily opens while the finger still holds the button, e.g. while
    /// scrolling the wheel) re-presses within a few milliseconds; the window
    /// leaves a wide margin over that. It must stay well under human
    /// re-click speed (≈200 ms and up) so two deliberate press/release pairs
    /// are never merged into one session, and it only *delays* the stop — the
    /// recording itself keeps running until the stop, so a short window costs
    /// the user a few tens of milliseconds before transcription starts.
    const RELEASE_BOUNCE_WINDOW: Duration = Duration::from_millis(120);

    /// Outcome of a release once its grace window has been waited out.
    #[derive(Debug, Copy, Clone, PartialEq, Eq)]
    enum ReleaseResolution {
        /// A press re-asserted the button inside the window: switch chatter,
        /// the session must survive.
        Bounce,
        /// No re-press: the button really left the user's finger, stop it.
        Stop,
    }

    /// Pure decision for a release after its grace window.
    ///
    /// `next_press_delay` is how long after the release a `WM_MBUTTONDOWN`
    /// arrived, or `None` when no press arrived before
    /// [`RELEASE_BOUNCE_WINDOW`] expired. A press inside the window proves the
    /// switch never really opened (scroll-vibration chatter) and must NOT stop
    /// the session; everything else — no press at all, or a press only after
    /// the window — is a genuine release that must stop. Chatter can only
    /// delay a stop, never veto it. Pure so the release semantics are
    /// unit-testable without a real hook or mouse (the old
    /// `GetAsyncKeyState`-based test read a sample the OS does not settle until
    /// after the hook callback, which is exactly how it passed while breaking
    /// on real hardware).
    fn release_after_bounce_window(next_press_delay: Option<Duration>) -> ReleaseResolution {
        match next_press_delay {
            Some(delay) if delay <= RELEASE_BOUNCE_WINDOW => ReleaseResolution::Bounce,
            _ => ReleaseResolution::Stop,
        }
    }

    /// Remember the app handle used by the hook procedure, start the serial
    /// worker that performs all Tauri-side work, and spawn the pump thread
    /// (which installs the permanent hook). Idempotent.
    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
        spawn_worker();
        spawn_pump_thread();
    }

    /// Apply the `mouse.middleClickPtt` setting. Idempotent and thread-safe;
    /// effective within one poll tick (≤ 5 ms while turning on). Only gates the
    /// middle-button branch — the hook stays installed either way (hover
    /// passthrough owns it independently).
    pub fn set_middle_click_ptt(enabled: bool) {
        let was_enabled = ENABLED.swap(enabled, Ordering::SeqCst);
        if was_enabled && !enabled {
            // Disabling while the button still owns a recording must not leave
            // it running forever (no release event will be delivered once the
            // branch is gated off): queue the same stop decision a release makes.
            post_event(HookEvent::Disable);
        }
    }

    /// Drop the ownership token. Called from every session start / stop /
    /// cancel / error path outside this hook (`commands.rs`) so a later middle
    /// release can only ever stop a session this hook started itself.
    pub fn clear_owned_session() {
        *OWNED_SESSION.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    fn set_owned_session(id: Option<String>) {
        *OWNED_SESSION.lock().unwrap_or_else(PoisonError::into_inner) = id;
    }

    /// Non-blocking enqueue; safe to call from the hook procedure.
    fn post_event(event: HookEvent) {
        if let Some(tx) = EVENT_TX.get() {
            let _ = tx.send(event);
        }
    }

    /// Start the single serial worker. Runs for the whole process lifetime.
    fn spawn_worker() {
        if EVENT_TX.get().is_some() {
            return;
        }
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        if EVENT_TX.set(tx).is_err() {
            return;
        }
        tauri::async_runtime::spawn(worker_loop(rx));
    }

    /// Spawn the pump thread (once). It installs the permanent hook itself.
    fn spawn_pump_thread() {
        if THREAD_RUNNING.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Err(e) = std::thread::Builder::new()
            .name("voicekey-mouse-ptt".into())
            .spawn(pump_loop)
        {
            THREAD_RUNNING.store(false, Ordering::SeqCst);
            log::error!("mouse: failed to spawn hook thread: {e}");
        }
    }

    async fn worker_loop(mut rx: UnboundedReceiver<HookEvent>) {
        while let Some(event) = rx.recv().await {
            match event {
                HookEvent::Down { root_hwnd } => handle_middle_down(root_hwnd),
                HookEvent::Up => handle_deferred_release(&mut rx).await,
                HookEvent::Disable => handle_middle_up(StopCause::Disable),
                HookEvent::SetIgnore { kind, ignore } => apply_ignore_cursor_events(kind, ignore),
                HookEvent::OutsidePress { root_hwnd } => handle_outside_press(root_hwnd),
            }
        }
    }

    /// Worker-side `WM_MBUTTONDOWN`: de-dup with the HUD capsule, apply the
    /// keyboard-PTT guards, start the session and remember its id.
    fn handle_middle_down(root_hwnd: isize) {
        let Some(app) = APP.get() else {
            return;
        };
        // Middle clicks landing on the HUD capsule belong to its pointer
        // handlers (the always-on overlay owns that geometry).
        if point_over_overlay(app, root_hwnd) {
            return;
        }
        let state = app.state::<crate::state::AppState>();
        // Same guards as the keyboard PTT binding (hotkey.rs): app-external
        // only, never while the settings hotkey recorder owns the keyboard.
        if state.hotkey_capture_active() || crate::hotkey::main_window_focused(app) {
            return;
        }
        // `start_session_internal` rejects Recording / Processing sessions
        // itself (W3); a rejection is a silent no-op here, exactly like the
        // keyboard PTT path.
        match crate::commands::start_session_internal(app) {
            Ok(payload) => {
                // Ownership token = the session WE just started (id from the
                // start payload; fall back to the session state). The release
                // may only stop this exact session.
                let id = payload
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
                    .or_else(|| {
                        state
                            .session
                            .lock()
                            .map(|s| s.id.clone())
                            .ok()
                            .filter(|id| !id.is_empty())
                    });
                match id {
                    Some(id) => {
                        // Boundary instrumentation: a hardware switch bounce
                        // (spurious release while scrolling) shows up as a
                        // "release absorbed as switch chatter" line followed by
                        // a "start rejected: Already recording" line for the
                        // re-press; a genuine release shows up as the
                        // release/stop line instead.
                        log::debug!("mouse: middle-button press started session {id}");
                        set_owned_session(Some(id));
                    }
                    None => {
                        clear_owned_session();
                        log::warn!("mouse: started a session but could not read its id; release will be a no-op");
                    }
                }
            }
            Err(e) => log::debug!("mouse: start rejected: {e}"),
        }
    }

    /// Worker-side `WM_MBUTTONUP`, bounce-tolerant.
    ///
    /// A release is never acted on at once: the worker waits out
    /// [`RELEASE_BOUNCE_WINDOW`] for a possible re-press. A mechanical middle
    /// switch that is still held (the vibration of scrolling the wheel chatters
    /// the contacts open) makes Windows emit a real `WM_MBUTTONUP` immediately
    /// followed by a `WM_MBUTTONDOWN`; that press is the proof the button never
    /// left the user's finger, so the release is absorbed as chatter
    /// ([`release_after_bounce_window`]) and the session keeps running. No press
    /// inside the window means the release was genuine and the stop always
    /// proceeds, so chatter can only ever *delay* a stop — never cancel it (the
    /// P0 regression: the old `GetAsyncKeyState` veto could, and did, swallow
    /// every genuine release).
    ///
    /// Only the physical button decides this; `Disable` deliberately skips the
    /// window (it must always stop, even mid-press). The wait is safe on the
    /// serial worker: events stay queued in order and any `Disable`/press that
    /// does arrive is handled immediately by this same loop. Hover-passthrough
    /// flips (`SetIgnore`) are orthogonal to the button timeline: they are
    /// applied immediately and the wait simply continues for the decisive
    /// event, inside the same overall grace window.
    async fn handle_deferred_release(rx: &mut UnboundedReceiver<HookEvent>) {
        let started = std::time::Instant::now();
        loop {
            let remaining = RELEASE_BOUNCE_WINDOW.saturating_sub(started.elapsed());
            match tokio::time::timeout(remaining, rx.recv()).await {
                // Re-press inside the window: chatter while the button is still
                // held. Absorb the release and treat the press normally (the
                // session is still `Recording`, so `start_session_internal`
                // rejects it as "Already recording" and the token is untouched).
                Ok(Some(HookEvent::Down { root_hwnd })) => {
                    match release_after_bounce_window(Some(started.elapsed())) {
                        ReleaseResolution::Bounce => {
                            log::debug!("mouse: release absorbed as switch chatter while scrolling");
                            handle_middle_down(root_hwnd);
                        }
                        // Only reachable if the timer expired in the same instant
                        // the press was dequeued: the release had already matured,
                        // so it stops and the press is a fresh one.
                        ReleaseResolution::Stop => {
                            handle_middle_up(StopCause::Release);
                            handle_middle_down(root_hwnd);
                        }
                    }
                    return;
                }
                // The setting turned off inside the window must still stop at once.
                Ok(Some(HookEvent::Disable)) => {
                    handle_middle_up(StopCause::Disable);
                    return;
                }
                // Two releases with no press between them: the button is genuinely
                // up (chatter would have re-pressed first), so stop.
                Ok(Some(HookEvent::Up)) => {
                    handle_middle_up(StopCause::Release);
                    return;
                }
                // Hover flip during the window: orthogonal, apply and keep waiting.
                Ok(Some(HookEvent::SetIgnore { kind, ignore })) => {
                    apply_ignore_cursor_events(kind, ignore);
                }
                // Hub outside-click during the window: orthogonal to the button
                // timeline, apply and keep waiting for the decisive event.
                Ok(Some(HookEvent::OutsidePress { root_hwnd })) => {
                    handle_outside_press(root_hwnd);
                }
                // Channel closed (worker shutting down): the release is moot.
                Ok(None) => return,
                // The window elapsed with no re-press: the release is genuine.
                Err(_elapsed) => {
                    handle_middle_up(StopCause::Release);
                    return;
                }
            }
        }
    }

    /// Worker-side stop decision for a release past its grace window / for a
    /// disable: stop only the session this hook started and that is still
    /// recording; anything else is a no-op.
    fn handle_middle_up(cause: StopCause) {
        // Taking the token clears ownership unconditionally, as required for
        // every Stop decision.
        let owned_id = OWNED_SESSION
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let Some(owned_id) = owned_id else {
            return;
        };
        let Some(app) = APP.get() else {
            return;
        };
        let still_ours = app
            .state::<crate::state::AppState>()
            .session
            .lock()
            .map(|s| s.id == owned_id && s.status == crate::audio::SessionStatus::Recording)
            .unwrap_or(false);
        if !still_ours {
            // The session already ended on its own or was replaced (e.g.
            // keyboard PTT started a new one): never stop a foreign session
            // and never emit a bogus "no recording" error toast.
            log::debug!(
                "mouse: middle-button {cause:?} ignored (owned session {owned_id} is no longer recording)"
            );
            return;
        }
        log::debug!("mouse: middle-button {cause:?} stopping session {owned_id}");
        // The hook must return fast and the worker must keep draining events
        // in order (so a queued Start is decided against the current state,
        // not against a transcription that may run for a minute): run the
        // finalize detached.
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::commands::stop_session_internal(&handle).await {
                log::warn!("mouse: stop_session_internal failed: {e}");
            }
        });
    }

    /// True when the given root window (top-level window under the cursor at
    /// event time) is one of our interactive capsules: the HUD overlay or the
    /// selection hub. The hit test itself ran in the hook with pure Win32
    /// calls; only this comparison needs Tauri (window `hwnd`s), so it happens
    /// here on the worker. A hidden window can never match: a hidden window is
    /// not the root window under the cursor.
    fn point_over_overlay(app: &AppHandle, root_hwnd: isize) -> bool {
        [
            crate::windowing::OVERLAY_WINDOW_LABEL,
            crate::windowing::HUB_WINDOW_LABEL,
        ]
        .iter()
        .any(|label| {
            app.get_webview_window(label)
                // `hwnd.0` is the raw pointer windows-sys expects (see windowing.rs).
                .and_then(|win| win.hwnd().ok())
                .map(|hwnd| hwnd.0 as isize == root_hwnd)
                .unwrap_or(false)
        })
    }

    /// Worker-side hub outside-click: close the open selection hub unless the
    /// press landed on one of our own capsule windows (the hub's own
    /// background click is the renderer's dismiss surface; the capsule's
    /// right-click toggles the hub — neither may double-fire). Re-checks
    /// [`crate::hub::is_open`] on the worker: the hub may have closed on its
    /// own between the hook's enqueue and this decision.
    fn handle_outside_press(root_hwnd: isize) {
        if !crate::hub::is_open() {
            return;
        }
        let Some(app) = APP.get() else {
            return;
        };
        if point_over_overlay(app, root_hwnd) {
            return;
        }
        log::debug!("mouse: outside click dismissing the selection hub");
        crate::hub::close_hub(app);
    }

    // ---- hover passthrough -------------------------------------------------

    /// Remember the capsule window handle the hit test needs. Refreshed by
    /// every renderer rect push (`commands::set_overlay_hit_rect`), so a
    /// rebuilt window (the never-destroyed capsules are only rebuilt after a
    /// hard failure) is picked up with the next push.
    pub fn register_capsule_window(kind: CapsuleKind, hwnd: isize) {
        CAPSULE_HWND[kind.index()].store(hwnd, Ordering::SeqCst);
    }

    /// Store the renderer-reported visible-capsule rect (physical px, relative
    /// to the window; `None` = capsule gone) and re-evaluate hover at the
    /// current cursor position. `set_capsule_hit_rect` is the only writer of
    /// the rect and the only thing that arms the mechanism
    /// ([`CAPSULE_RECEIVED`]).
    pub fn set_capsule_hit_rect(kind: CapsuleKind, rect: Option<HitRect>) {
        CAPSULE_RECEIVED[kind.index()].store(true, Ordering::SeqCst);
        CAPSULE_RECT[kind.index()].store(rect.map(pack_hit_rect).unwrap_or(0), Ordering::SeqCst);
        refresh_capsule_hover(kind);
    }

    /// Renderer interaction lock: while `grabbed`, the window stays
    /// interactive no matter where the cursor is (a gesture / recording must
    /// never be torn in half by a hover flip).
    pub fn set_capsule_grab(kind: CapsuleKind, grabbed: bool) {
        CAPSULE_GRAB[kind.index()].store(grabbed, Ordering::SeqCst);
        refresh_capsule_hover(kind);
    }

    /// Re-evaluate hover at the *current* cursor position. Called from every
    /// rect / grab push and from `commands::OverlayFrame::apply` after every
    /// Rust-side window move: a stationary cursor plus a moving capsule
    /// (double-click reset, drag end, show) changes "is the cursor over the
    /// capsule" without producing a single mouse message.
    ///
    /// The caller's `kind` is accepted for symmetry with the other capsule
    /// pushes but is not needed here: `evaluate_hover` re-checks *both*
    /// capsules from one cursor position (idempotent — flips only dispatch on
    /// a real state change), so no per-kind branch is required.
    pub fn refresh_capsule_hover(_kind: CapsuleKind) {
        let mut pt: POINT = unsafe { std::mem::zeroed() };
        if unsafe { GetCursorPos(&mut pt) } == 0 {
            return;
        }
        evaluate_hover((pt.x, pt.y));
    }

    /// Mirror an externally applied `set_ignore_cursor_events` value into the
    /// flip de-dup state. Only the legacy `set_ignore_mouse_events` command
    /// uses this — hover passthrough is the sole owner of the flag otherwise,
    /// and without this mirror its "only dispatch on change" bookkeeping could
    /// go stale and swallow a real flip.
    pub fn sync_ignore_state(kind: CapsuleKind, ignore: bool) {
        CAPSULE_IGNORE[kind.index()].store(ignore, Ordering::SeqCst);
    }

    /// Pure-hit-test wrapper: is `pt` (desktop physical px) inside this
    /// capsule's visible rect? The stored rect is window-relative, so the
    /// window's *current* `GetWindowRect` origin is added at test time — that
    /// is what makes the answer immune to drags / re-anchors. Local Win32
    /// calls only, so this is safe inside the hook procedure.
    fn capsule_hit(kind: CapsuleKind, pt: (i32, i32)) -> bool {
        let Some(rect) = unpack_hit_rect(CAPSULE_RECT[kind.index()].load(Ordering::Relaxed)) else {
            return false;
        };
        let hwnd = CAPSULE_HWND[kind.index()].load(Ordering::Relaxed);
        if hwnd == 0 {
            return false;
        }
        let mut wr: RECT = unsafe { std::mem::zeroed() };
        if unsafe { GetWindowRect(hwnd as HWND, &mut wr) } == 0 {
            return false;
        }
        let screen = HitRect {
            x: rect.x.saturating_add(wr.left),
            y: rect.y.saturating_add(wr.top),
            w: rect.w,
            h: rect.h,
        };
        point_in_rect(pt, screen)
    }

    /// Hover decision + flip dispatch for one cursor position, for both
    /// capsule windows. Never touches the flag before the renderer's first
    /// rect push ([`CAPSULE_RECEIVED`] — the unclickable-capsule guard) and
    /// enqueues a worker event **only** on a real state flip ([`ignore_flip`]).
    /// Atomic loads/stores plus a non-blocking send: safe from the hook, safe
    /// from any other thread (`refresh_capsule_hover`).
    fn evaluate_hover(pt: (i32, i32)) {
        for kind in CapsuleKind::ALL {
            let index = kind.index();
            if !CAPSULE_RECEIVED[index].load(Ordering::SeqCst) {
                continue;
            }
            let hover = capsule_hit(kind, pt);
            let grabbed = CAPSULE_GRAB[index].load(Ordering::Relaxed);
            let prev = CAPSULE_IGNORE[index].load(Ordering::Relaxed);
            if let Some(next) = ignore_flip(prev, hover, grabbed) {
                // A flip is by definition an inversion, so the expected
                // previous value is `!next`; the CAS both de-dups concurrent
                // evaluators (hook thread vs. command threads) and keeps the
                // "dispatch only on change" promise exact.
                if CAPSULE_IGNORE[index]
                    .compare_exchange(!next, next, Ordering::SeqCst, Ordering::Relaxed)
                    .is_ok()
                {
                    post_event(HookEvent::SetIgnore {
                        kind,
                        ignore: next,
                    });
                }
            }
        }
    }

    /// Apply one hover flip on the serial worker (the Tauri call the hook is
    /// not allowed to make).
    fn apply_ignore_cursor_events(kind: CapsuleKind, ignore: bool) {
        let Some(app) = APP.get() else {
            return;
        };
        let Some(win) = app.get_webview_window(kind.label()) else {
            return;
        };
        if let Err(e) = win.set_ignore_cursor_events(ignore) {
            log::warn!(
                "mouse: set_ignore_cursor_events({ignore}) failed for {}: {e}",
                kind.label()
            );
        }
        // Belt-and-braces: tao rewrites the **whole** `GWL_EXSTYLE` word from
        // its computed styles on any flag change (`windowing.rs` 0.5.8 lesson —
        // `apply_diff` runs `SetWindowLongW(GWL_EXSTYLE, to_window_styles().1)`
        // first), and `set_ignore_cursor_events` is exactly such a change. The
        // computed word only keeps `WS_EX_NOACTIVATE` while the window is
        // non-focusable, so re-run the idempotent hardening after every flip:
        // clicking the now-interactive capsule must never activate it and steal
        // focus from the app the user is dictating into (the `Focused` handler
        // in `lib.rs` re-hardens on activation as a second net).
        crate::windowing::harden_overlay_window(&win);
    }

    /// Hook thread body: keep the message queue pumped (that is what delivers
    /// low-level hook callbacks) and install the hook. The hook is **permanent**
    /// (hover passthrough needs it whatever `mouse.middleClickPtt` says), so it
    /// is installed once and only re-attempted slowly on failure; the handle
    /// never leaves this thread.
    fn pump_loop() {
        let mut hook: HHOOK = std::ptr::null_mut();
        let mut msg: MSG = unsafe { std::mem::zeroed() };
        let mut next_install_attempt = std::time::Instant::now();
        loop {
            if hook.is_null() && std::time::Instant::now() >= next_install_attempt {
                hook = unsafe {
                    SetWindowsHookExW(
                        WH_MOUSE_LL as _,
                        Some(low_level_mouse_proc),
                        std::ptr::null_mut(),
                        0,
                    )
                };
                if hook.is_null() {
                    // Never retry in a hot loop (a failed install is a
                    // process-wide condition); back off and try again slowly.
                    log::error!(
                        "mouse: SetWindowsHookExW(WH_MOUSE_LL) failed; hover passthrough and middle-click push-to-talk are inactive"
                    );
                    next_install_attempt = std::time::Instant::now() + HOOK_RETRY_INTERVAL;
                }
            }

            // Drain the thread message queue. Retrieving messages is also what
            // makes the system call the low-level hook on this thread.
            while unsafe { PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) } != 0 {
                unsafe {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }

            std::thread::sleep(POLL_ARMED);
        }
    }

    /// The session action a hook message may cause. `None` (from [`classify`])
    /// means "no action": the message is ignored entirely.
    #[derive(Debug, Copy, Clone, PartialEq, Eq)]
    enum Trigger {
        /// `WM_MBUTTONDOWN`: begin a middle-button push-to-talk session.
        Down,
        /// `WM_MBUTTONUP`: end it, after waiting out the bounce grace window
        /// (see [`handle_deferred_release`] / [`release_after_bounce_window`]).
        Up,
    }

    /// Strict message-type whitelist: `WM_MBUTTONDOWN` / `WM_MBUTTONUP` and
    /// nothing else. Pure so it can be unit-tested without a real hook.
    ///
    /// **Regression trap.** `WM_MOUSEWHEEL` (522) and `WM_MOUSEHWHEEL` (526)
    /// sit *above* `WM_MBUTTONDOWN`/`WM_MBUTTONUP` (519/520) and *inside*
    /// `WM_MOUSEFIRST..=WM_MOUSELAST` (512..=526). Widening this test in any way
    /// — a range check (`WM_MBUTTONDOWN..=WM_MOUSELAST`), a threshold
    /// (`message >= WM_MBUTTONDOWN`), the whole `WM_MOUSEFIRST..=WM_MOUSELAST`
    /// span, or a "everything except `WM_MOUSEMOVE`" exclusion — silently maps
    /// the wheel to Down/Up and re-introduces the reported bug where rolling the
    /// wheel during a held middle button interrupts the recording. The low-level
    /// hook receives the *message id* in `wParam` (never button state: for a
    /// wheel, the high word of a window's `wParam` is the delta, but that rule
    /// does not apply here). Only an exact `==` match keeps scrolling harmless
    /// and the down/up pair intact.
    fn classify(message: u32) -> Option<Trigger> {
        // `as u32` on both sides keeps this independent of how windows-sys
        // types the WM_* / hook-id constants.
        if message == WM_MBUTTONDOWN as u32 {
            Some(Trigger::Down)
        } else if message == WM_MBUTTONUP as u32 {
            Some(Trigger::Up)
        } else {
            None
        }
    }

    /// Strict whitelist for hub outside-click dismissal: the four button
    /// **presses** and nothing else. Pure so it can be unit-tested without a
    /// real hook. Same wheel-range trap as [`classify`] — an exact `==`
    /// chain keeps `WM_MOUSEWHEEL` / `WM_MOUSEHWHEEL` (which sit inside
    /// `WM_MOUSEFIRST..=WM_MOUSELAST`) inert: scrolling must never dismiss
    /// the hub, only a deliberate press may.
    fn is_dismiss_press(message: u32) -> bool {
        message == WM_LBUTTONDOWN as u32
            || message == WM_RBUTTONDOWN as u32
            || message == WM_MBUTTONDOWN as u32
            || message == WM_XBUTTONDOWN as u32
    }

    /// `WH_MOUSE_LL` callback. Observing only: `CallNextHookEx` always runs so
    /// the click keeps its normal meaning in the target application.
    ///
    /// Latency-critical (the system removes slow hooks): only local Win32
    /// calls plus a non-blocking enqueue — no Tauri calls, no locks, no I/O.
    unsafe extern "system" fn low_level_mouse_proc(
        code: i32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        if code >= 0 && lparam != 0 {
            let info = &*(lparam as *const MSLLHOOKSTRUCT);
            let message = wparam as u32;
            // Middle-button PTT: gated by its setting (the hook itself is
            // permanent, see `pump_loop`).
            if ENABLED.load(Ordering::SeqCst) {
                match classify(message) {
                    Some(Trigger::Down) => {
                        post_event(HookEvent::Down {
                            root_hwnd: root_window_at(info.pt),
                        });
                    }
                    Some(Trigger::Up) => post_event(HookEvent::Up),
                    // Wheel / move / other buttons: intentionally inert, so scrolling
                    // cannot disturb an in-flight middle-button PTT session.
                    None => {}
                }
            }
            // Hover passthrough: independent of the middle-button setting.
            // Only flips are enqueued ([`evaluate_hover`] / [`ignore_flip`]),
            // and only with local Win32 calls on this thread.
            if is_hover_update(message) {
                evaluate_hover((info.pt.x, info.pt.y));
            }
            // Selection-hub outside-click dismiss: gated on the hub being open
            // (one atomic load; ordinary clicks cost nothing). The hit test is
            // the same local Win32 call pair the middle-button branch uses;
            // the worker owns every Tauri call.
            if crate::hub::is_open() && is_dismiss_press(message) {
                post_event(HookEvent::OutsidePress {
                    root_hwnd: root_window_at(info.pt),
                });
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    /// Mouse messages that can change where the cursor is relative to a
    /// capsule: moves plus button transitions (a button event is also the
    /// recovery nudge for a stationary cursor whose capsule moved underneath
    /// it). Strict whitelist, deliberately narrow — same wheel-range trap as
    /// [`classify`]: `WM_MOUSEWHEEL`/`WM_MOUSEHWHEEL` sit between
    /// `WM_MBUTTONUP` and `WM_MOUSELAST`, and a wheel does not move the cursor
    /// anyway, so widening this can only reintroduce message-range bugs for no
    /// benefit.
    fn is_hover_update(message: u32) -> bool {
        matches!(
            message,
            WM_MOUSEMOVE
                | WM_LBUTTONDOWN
                | WM_LBUTTONUP
                | WM_RBUTTONDOWN
                | WM_RBUTTONUP
                | WM_MBUTTONDOWN
                | WM_MBUTTONUP
                | WM_XBUTTONDOWN
                | WM_XBUTTONUP
        )
    }

    /// Pure Win32 hit test: the top-level window under the desktop point,
    /// captured at event time (so it cannot change before the worker looks at
    /// it). Child windows (WebView2) resolve to their top-level owner.
    fn root_window_at(point: POINT) -> isize {
        unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT as _) as isize }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDBLCLK, WM_MOUSEFIRST, WM_MOUSEHWHEEL,
            WM_MOUSELAST, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP,
            WM_XBUTTONDOWN, WM_XBUTTONUP,
        };

        /// The only messages that may drive a middle-button PTT session.
        #[test]
        fn middle_button_messages_map_to_down_and_up() {
            assert_eq!(classify(WM_MBUTTONDOWN as u32), Some(Trigger::Down));
            assert_eq!(classify(WM_MBUTTONUP as u32), Some(Trigger::Up));
        }

        /// Regression: rolling the wheel — vertical (`WM_MOUSEWHEEL`) or
        /// horizontal (`WM_MOUSEHWHEEL`) — during a held middle button must
        /// produce no action at all, so the held down/up pair stays intact and
        /// the recording is never interrupted.
        #[test]
        fn wheel_messages_are_inert() {
            assert_eq!(classify(WM_MOUSEWHEEL as u32), None);
            assert_eq!(classify(WM_MOUSEHWHEEL as u32), None);
        }

        /// Regression: every other mouse message (move, middle double-click,
        /// left/right, X buttons) is inert too — the hook only ever tracks the
        /// middle button press/release.
        #[test]
        fn other_mouse_messages_are_inert() {
            for message in [
                WM_MOUSEMOVE,
                WM_MBUTTONDBLCLK,
                WM_LBUTTONDOWN,
                WM_LBUTTONUP,
                WM_RBUTTONDOWN,
                WM_RBUTTONUP,
                WM_XBUTTONDOWN,
                WM_XBUTTONUP,
            ] {
                assert_eq!(
                    classify(message as u32),
                    None,
                    "message {message:#06x} must be inert"
                );
            }
        }

        /// Hub outside-click dismissal fires on the four button presses only.
        #[test]
        fn dismiss_press_is_button_downs_only() {
            for message in [
                WM_LBUTTONDOWN,
                WM_RBUTTONDOWN,
                WM_MBUTTONDOWN,
                WM_XBUTTONDOWN,
            ] {
                assert!(
                    is_dismiss_press(message as u32),
                    "message {message:#06x} must dismiss the hub"
                );
            }
        }

        /// Regression (wheel-range trap, same as [`classify`]): scrolling must
        /// never dismiss the hub, and a button release is not a "click
        /// outside" either — only the press decides, so a press on the hub
        /// itself can never be half-eaten by its own release.
        #[test]
        fn dismiss_ignores_wheel_moves_and_releases() {
            for message in [
                WM_MOUSEWHEEL,
                WM_MOUSEHWHEEL,
                WM_MOUSEMOVE,
                WM_MBUTTONDBLCLK,
                WM_LBUTTONUP,
                WM_RBUTTONUP,
                WM_MBUTTONUP,
                WM_XBUTTONUP,
            ] {
                assert!(
                    !is_dismiss_press(message as u32),
                    "message {message:#06x} must not dismiss the hub"
                );
            }
        }

        /// Documents *why* [`classify`] must stay an exact `==` whitelist and
        /// never become a range/threshold test: the wheel messages live between
        /// `WM_MBUTTONDOWN` and `WM_MOUSELAST`, so a widened check would catch
        /// them and re-introduce the "scrolling interrupts recording" bug that
        /// these tests exist to prevent.
        #[test]
        fn wheel_messages_sit_inside_the_range_trap() {
            for wheel in [WM_MOUSEWHEEL as u32, WM_MOUSEHWHEEL as u32] {
                assert!(wheel > WM_MBUTTONUP as u32 && wheel <= WM_MOUSELAST as u32);
                assert!((WM_MOUSEFIRST..=WM_MOUSELAST).contains(&wheel));
            }
        }

        /// Regression (bug ⑦, hardware bounce): a release whose button
        /// re-presses inside the grace window is switch chatter caused by
        /// scrolling with the middle button held — the session must survive,
        /// with its ownership token intact so the genuine release still stops
        /// it later.
        #[test]
        fn press_inside_the_window_is_bounce_chatter() {
            assert_eq!(
                release_after_bounce_window(Some(Duration::ZERO)),
                ReleaseResolution::Bounce
            );
            assert_eq!(
                release_after_bounce_window(Some(Duration::from_millis(1))),
                ReleaseResolution::Bounce
            );
            assert_eq!(
                release_after_bounce_window(Some(RELEASE_BOUNCE_WINDOW)),
                ReleaseResolution::Bounce,
                "the window boundary is inclusive"
            );
        }

        /// Regression (P0, bug 2): a genuine release must ALWAYS stop. No press
        /// inside the window — or a press only after it — is not chatter, so
        /// the stop must never be vetoed. The removed
        /// `GetAsyncKeyState`-based check vetoed every real release and left the
        /// recording running until the 5-minute cap.
        #[test]
        fn genuine_release_always_stops() {
            assert_eq!(release_after_bounce_window(None), ReleaseResolution::Stop);
            assert_eq!(
                release_after_bounce_window(Some(RELEASE_BOUNCE_WINDOW + Duration::from_millis(1))),
                ReleaseResolution::Stop
            );
            assert_eq!(
                release_after_bounce_window(Some(Duration::from_secs(5))),
                ReleaseResolution::Stop
            );
        }

        /// The window must be a real chatter filter yet stay well below human
        /// re-click speed, so a genuine release still stops promptly and two
        /// deliberate press/release pairs are never merged.
        #[test]
        fn bounce_window_is_tuned_between_chatter_and_human_speed() {
            assert!(RELEASE_BOUNCE_WINDOW >= Duration::from_millis(5));
            assert!(RELEASE_BOUNCE_WINDOW <= Duration::from_millis(200));
        }

        /// Full scroll-chatter timeline: while the user scrolls with the
        /// button held, the switch chatters (each Up/Down pair) and every Up
        /// must be absorbed; the final Up with no press after it must stop the
        /// session. Locks bug ⑦ and P0 (bug 2) together in one sequence.
        #[test]
        fn scroll_chatter_then_final_release_still_stops() {
            for chatter in [
                Duration::ZERO,
                Duration::from_millis(3),
                Duration::from_millis(15),
            ] {
                assert_eq!(
                    release_after_bounce_window(Some(chatter)),
                    ReleaseResolution::Bounce,
                    "chatter {chatter:?} after a release must not stop the session"
                );
            }
            // The finger finally lifts: no re-press ever arrives.
            assert_eq!(release_after_bounce_window(None), ReleaseResolution::Stop);
        }

        /// Hover-passthrough updates are moves plus button transitions — the
        /// button events are the recovery nudge for a stationary cursor whose
        /// capsule moved underneath it (double-click reset, drag end). The
        /// wheel stays out: it does not move the cursor and lives in the same
        /// `WM_MOUSELAST` range trap as [`classify`], so widening this
        /// whitelist can only reintroduce message-range bugs.
        #[test]
        fn hover_updates_are_moves_and_button_transitions_only() {
            for message in [
                WM_MOUSEMOVE,
                WM_LBUTTONDOWN,
                WM_LBUTTONUP,
                WM_RBUTTONDOWN,
                WM_RBUTTONUP,
                WM_MBUTTONDOWN,
                WM_MBUTTONUP,
                WM_XBUTTONDOWN,
                WM_XBUTTONUP,
            ] {
                assert!(
                    is_hover_update(message as u32),
                    "message {message:#06x} must update hover"
                );
            }
            for message in [WM_MOUSEWHEEL, WM_MOUSEHWHEEL, WM_MBUTTONDBLCLK] {
                assert!(
                    !is_hover_update(message as u32),
                    "message {message:#06x} must not update hover"
                );
            }
        }
    }
}
