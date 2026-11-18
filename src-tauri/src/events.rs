//! Window-targeted event routing (0.15 audit MEDIUM).
//!
//! `app.emit` broadcasts to every window: transcripts, recent-clipboard
//! entries and selection previews ended up in windows that never display
//! them (HUD, background recorder, ...). Every event now goes through exactly
//! one fan-out helper here, so the target set lives in a single place and a
//! call site cannot misroute an event. Listener map (verified against
//! `src/lib/tauri-api.ts` consumers):
//!
//! - `overlay-update` / `audio-level` → overlay + session (HUD & SessionHUD)
//! - `transcription` / `error` → main (toasts + page refreshes)
//! - `inject-fallback` → overlay (HUD soft hint)
//! - `picker-update` → picker (contains recent-clipboard text)
//! - `hub-update` → hub (contains selection preview + LLM results)
//! - `start-recording` / `stop-recording` / `streaming-final` → background
//! - `config-updated` → background (masked config, mic hot-reload)
//! - `app-language-changed` stays a broadcast: every window retranslates
//!   (`main.tsx`) and the payload is only a language snapshot.

use crate::windowing::{
    BACKGROUND_WINDOW_LABEL, HUB_WINDOW_LABEL, MAIN_WINDOW_LABEL, OVERLAY_WINDOW_LABEL,
    PICKER_WINDOW_LABEL, SESSION_WINDOW_LABEL,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

fn to_all<R: Runtime, S: Serialize>(
    app: &AppHandle<R>,
    targets: &[&str],
    event: &str,
    payload: &S,
) {
    for target in targets {
        let _ = app.emit_to(*target, event, payload);
    }
}

/// 会话胶囊内容（状态 / 流式转写增量 / 成功转写）：待机胶囊 + 会话胶囊。
pub(crate) fn overlay_update<R: Runtime>(app: &AppHandle<R>, payload: &serde_json::Value) {
    to_all(
        app,
        &[OVERLAY_WINDOW_LABEL, SESSION_WINDOW_LABEL],
        "overlay-update",
        payload,
    );
}

/// 完整转写结果：主窗口（toast + 首页 / 历史刷新）。
pub(crate) fn transcription<R: Runtime>(app: &AppHandle<R>, text: &str) {
    let _ = app.emit_to(MAIN_WINDOW_LABEL, "transcription", text);
}

/// 会话错误（消息可能含 LLM / ASR 错误细节）：主窗口 toast。
pub(crate) fn session_error<R: Runtime>(app: &AppHandle<R>, message: &serde_json::Value) {
    let _ = app.emit_to(MAIN_WINDOW_LABEL, "error", message);
}

/// 录音电平：会话胶囊波形 + 待机胶囊 latch 静音判定。
pub(crate) fn audio_level<R: Runtime>(app: &AppHandle<R>, level: f32) {
    to_all(
        app,
        &[OVERLAY_WINDOW_LABEL, SESSION_WINDOW_LABEL],
        "audio-level",
        &level,
    );
}

/// 注入兼容回退软提示：待机胶囊。
pub(crate) fn inject_fallback<R: Runtime>(app: &AppHandle<R>, reason: &serde_json::Value) {
    let _ = app.emit_to(OVERLAY_WINDOW_LABEL, "inject-fallback", reason);
}

/// 速插面板数据（含最近剪贴板全文）：仅 picker。
pub(crate) fn picker_update<R: Runtime>(app: &AppHandle<R>, payload: &serde_json::Value) {
    let _ = app.emit_to(PICKER_WINDOW_LABEL, "picker-update", payload);
}

/// 选区 hub 数据（含选区预览与 LLM 结果）：仅 hub。
pub(crate) fn hub_update<R: Runtime>(app: &AppHandle<R>, payload: &serde_json::Value) {
    let _ = app.emit_to(HUB_WINDOW_LABEL, "hub-update", payload);
}

/// 录音器控制（start / stop / 流式收尾标记）：仅 background。
pub(crate) fn recorder_event<R: Runtime, S: Serialize>(
    app: &AppHandle<R>,
    event: &str,
    payload: &S,
) {
    let _ = app.emit_to(BACKGROUND_WINDOW_LABEL, event, payload);
}

/// 配置快照（已脱敏）：录音窗（麦克风设备热更新）。
pub(crate) fn config_updated<R: Runtime, S: Serialize>(app: &AppHandle<R>, payload: &S) {
    let _ = app.emit_to(BACKGROUND_WINDOW_LABEL, "config-updated", payload);
}
