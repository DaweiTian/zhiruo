mod asr;
mod audio;
mod commands;
mod config;
mod filler;
mod history;
mod hotkey;
mod inject;
mod llm;
mod mouse;
mod platform;
mod refine_prompt;
#[cfg(test)]
mod refine_eval;
mod state;
mod stats;
mod translate;
mod tray;
mod updater;
mod windowing;

use state::AppState;
use tauri::Manager;

pub fn run() {
    // Stderr logging with a `warn` default filter: info/debug! calls (e.g. the
    // translation pipeline's progress lines) are suppressed at the macro level,
    // so their formatting never even runs. `RUST_LOG` still overrides the
    // filter (`Env::default` keeps the usual precedence); note this is the
    // stderr sink only - `voice-key.log` is a separate file written through
    // `commands::log` (renderer) and `windowing::trace` (opt-in, see there).
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();

    // MUST be the first thing that happens: `WEBVIEW2_DEFAULT_BACKGROUND_COLOR`
    // is consumed when the WebView2 environment is created, so it has to be in
    // the process environment before any window/webview exists. It makes the
    // layer WebView2 paints underneath the transparent capsules transparent
    // instead of the default white, which is what flashes on `show()` /
    // bounds changes (see `windowing::enable_transparent_webview_background`).
    windowing::enable_transparent_webview_background();

    tauri::Builder::default()
        // Shared state is registered here, on the builder chain, so it exists
        // *before* the config-created windows (main / overlay / session /
        // background) load their webviews. Those webviews call `get_config` /
        // `get_app_language` as soon as they run, which happens before `setup()`
        // executes — managing in `setup()` lost that first call ("state not
        // managed"), and the overlay HUD then silently fell back to its expanded
        // capsule while its window sat at a persisted half-hidden dock (the
        // "new-install capsule half off-screen until you drag it" bug).
        .manage(AppState::new())
        // Single-instance guard, registered FIRST: a second launch hands its
        // argv to the running instance and exits before any other plugin or
        // `setup` work can double-run (no second tray icon / overlay / hotkey
        // grab / stats-store race). The callback runs in the FIRST instance.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second process spawned by the OS autostart entry (its argv
            // carries the `--autostart` marker) must never wake the main
            // window: that is exactly the "login pops the settings window" bug
            // the marker exists for. A *manual* second launch keeps its
            // original meaning: show and focus the running instance's main
            // window, rebuilding it on a worker thread if the delayed destroy
            // reclaimed it.
            if windowing::has_autostart_arg(argv.iter()) {
                return;
            }
            windowing::open_main_window(app, "/home");
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        // Launch-at-login; toggled from the tray menu's checkable item (tray.rs).
        // The `Some(vec![--autostart])` marker arg is written *into the
        // autostart entry itself* (`"{exe}" --autostart` in the Run registry
        // key / launch agent - `auto-launch`'s `enable()` composes the value
        // from app path + args), which is the only thing that tells an
        // OS-triggered login start apart from a manual launch. `setup` checks
        // the argv for it and keeps the main window completely silent on
        // autostart; entries registered before the marker existed are healed
        // in `setup` (see `tray::heal_autostart_entry`).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![windowing::AUTOSTART_LAUNCH_ARG]),
        ))
        .on_window_event(|window, event| {
            // A focus / activation change is what makes WebView2 runtime 144+
            // paint its "ghost titlebar" over a transparent window
            // (tauri#14764); the reported triggers are opening the settings page
            // and switching windows. Clear it (a guarded 1px resize) on every
            // focus change of either window, skipped while the capsule is
            // hidden - the stale bar only exists on screen.
            if let tauri::WindowEvent::Focused(focused) = event {
                windowing::trace(&format!(
                    "focused label={} focused={focused}",
                    window.label()
                ));
                // Re-assert the DWM border suppression on activation: Windows 11
                // (build 22000+) redraws its accent-color focus border the
                // moment a window is activated unless the app re-sets
                // DWMWA_BORDER_COLOR (MSDN: the app "is responsible for changing
                // the border color according to state changes, such as a change
                // in window activation"). The setup-time pass alone does not
                // survive the first activation - that is why the main window
                // still showed a blue focus ring. Both passes are idempotent.
                let label = window.label();
                let app = window.app_handle();
                if let Some(win) = app.get_webview_window(label) {
                    if label == windowing::MAIN_WINDOW_LABEL {
                        windowing::harden_main_window(&win);
                    } else if label == windowing::OVERLAY_WINDOW_LABEL
                        || label == windowing::SESSION_WINDOW_LABEL
                    {
                        // The session capsule shares the overlay's shape and
                        // no-activate hardening; without this branch it would
                        // re-draw the blue DWM focus border on activation,
                        // exactly like the overlay bug before it.
                        windowing::harden_overlay_window(&win);
                    }
                }
                // NOTE: the focus path used to run `clear_capsule_ghost_titlebars`
                // here (a 1px resize of both capsules). That was the white-flash
                // bug: a bounds change on a *visible* transparent window makes
                // WebView2 present a white frame (WebView2Feedback#5607), and the
                // patch was aimed at the 144.x ghost titlebar, which the upstream
                // fix in Edge 146 already removed (the field machine runs 155).
                // Removed in 0.5.9 - never re-add a bounds change on a visible
                // capsule. The stale-bar mitigation now only ever runs while the
                // capsule is hidden (`show_overlay_window` / `show_session_window`).
            }
            // Closing the main window hides it to the tray and arms a 5-minute
            // delayed destroy of its WebView (`windowing`); reopening rebuilds
            // the window on demand. The tray "Quit" item (`app.exit`) remains
            // the only real exit path.
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    windowing::hide_main_window_to_tray(window.app_handle());
                }
            } else if window.label() == windowing::OVERLAY_WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // The HUD capsule must never be destroyed (the renderer
                    // holds `core:window:allow-close`): convert a close into
                    // hide + persist, so the tray "Show floating capsule"
                    // entry can always bring it back.
                    api.prevent_close();
                    commands::hide_overlay(window.app_handle());
                }
            } else if window.label() == windowing::SESSION_WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Same rule as the overlay: never destroy the session
                    // capsule. Convert a close into a plain hide — and only a
                    // hide: this must NOT touch the overlay's persisted
                    // visibility flag (`hide_session` is flag-free by
                    // construction, `hide_overlay` would not be).
                    api.prevent_close();
                    commands::hide_session(window.app_handle());
                }
            }
        })
        .setup(|app| {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.set_title("芷若");
            }

            // Registry self-heal for launch-at-login entries that predate the
            // `--autostart` marker: rewrite them (in place, still enabled) so
            // they carry the marker. See `tray::heal_autostart_entry`.
            tray::heal_autostart_entry(app.handle());

            tray::setup_tray(app.handle())?;
            hotkey::bind_default_hotkeys(app.handle())?;
            // Best-effort first pass of the Windows focus-frame hardening (main
            // window: border only; overlay: no-activate + no border). Anything
            // missing here is covered by the per-show re-application in
            // `overlay_show` / `windowing::ensure_main_window`.
            windowing::harden_app_windows(app.handle());
            // Startup visibility of the main window. `tauri.conf.json` creates
            // it **hidden** (`"visible": false`) so an autostart launch can
            // stay completely silent - the window is never shown at all, so
            // there is no flash either way - while the tray icon and the HUD
            // capsule come up as usual (the capsule is the PTT surface and must
            // survive a silent start). A manual launch shows the window right
            // away through `open_main_window`, the same hardened show path
            // every other open uses (tray x2 / settings hotkey /
            // `show_settings_window` / single-instance), so the close->hide-
            // to-tray + delayed-destroy lifecycle, the DWM border suppression
            // and the pre-show hardening are all reused unchanged.
            if !windowing::launched_by_autostart() {
                windowing::open_main_window(app.handle(), "/home");
            }
            // Middle mouse button push-to-talk (Windows only; no-op elsewhere).
            // The hook installs / removes itself as the setting flips.
            mouse::init(app.handle());
            mouse::set_middle_click_ptt(
                app.state::<AppState>().config.load().mouse.middle_click_ptt,
            );
            // The HUD capsule is an always-on standby launcher now. The show
            // path re-applies the Windows hardening around `show()` and honors
            // the tray "hide floating capsule" toggle.
            commands::show_overlay_idle(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_config,
            commands::set_hotkey_capture_active,
            commands::test_refine_connection,
            commands::connect_token_dance,
            commands::get_app_language,
            commands::set_app_language,
            commands::get_history,
            commands::get_stats,
            commands::clear_history,
            commands::delete_history_item,
            commands::start_session,
            commands::stop_session,
            commands::cancel_session,
            commands::get_session_status,
            commands::send_audio_chunk,
            commands::send_streaming_audio_frame,
            commands::send_streaming_audio_end,
            commands::send_error,
            commands::send_audio_level,
            commands::check_for_updates,
            commands::get_update_status,
            commands::get_app_version,
            commands::open_external,
            commands::get_log_tail,
            commands::open_log_folder,
            commands::get_storage_status,
            commands::switch_storage_root,
            commands::log,
            commands::get_linux_integration_status,
            commands::install_linux_integration,
            commands::remove_linux_integration,
            commands::set_ignore_mouse_events,
            commands::set_overlay_size,
            commands::set_overlay_position,
            commands::set_overlay_hit_rect,
            commands::set_overlay_hover_grab,
            commands::show_settings_window,
            commands::refine_text,
            commands::translate_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zhiruo");
}
