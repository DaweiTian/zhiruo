use crate::platform;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::process::Command;
use std::thread;
use std::time::Duration;

/// Inject text into the focused application.
/// Windows/macOS: clipboard paste (best fidelity for CJK + multiline).
/// Hyprland: wl-copy --sensitive + Shift+Insert.
///
/// 剥掉绝不能进目标应用的控制字符：C0 里只保留制表 / 换行 / 回车（多行
/// 转写需要），其余连同 DEL / C1 一并去除——逐字键入到终端时 ESC 序列是
/// 实打实的注入面（0.15 审计 LOW）。`translate.rs` 写回结果也走这里。
pub(crate) fn strip_control_chars(text: &str) -> String {
    text.chars()
        .filter(|c| matches!(c, '\t' | '\n' | '\r') || !c.is_control())
        .collect()
}

/// 注入结果见 [`InjectOutcome`]：`clipboard` 模式与 `auto` 兜底只保证文本
/// 进剪贴板（调用方发 `inject-fallback` 让 HUD 提示手动粘贴）。**失败契约**：
/// `Err` 时尽力把文本留在剪贴板（[`copy_to_clipboard_only`]），用户始终可以
/// 手动粘贴兜底。
pub fn inject_text_with_mode(text: &str, mode: &str) -> Result<InjectOutcome, String> {
    let text = strip_control_chars(text);
    let text = text.as_str();
    if text.trim().is_empty() {
        return Ok(InjectOutcome::Injected);
    }
    let result = match mode {
        "type" => inject_text_typed(text).map(|_| InjectOutcome::Injected),
        "clipboard" => copy_to_clipboard_only(text).map(|_| InjectOutcome::Copied),
        "paste" => paste_text(text).map(|_| InjectOutcome::Injected),
        // `auto`（含未知值）：paste → type → clipboard 逐级兜底（设计 2.2）。
        _ => match paste_text(text) {
            Ok(()) => Ok(InjectOutcome::Injected),
            Err(paste_err) => {
                log::warn!("inject auto: paste failed ({paste_err}), trying typed input");
                match inject_text_typed(text) {
                    Ok(()) => Ok(InjectOutcome::Injected),
                    Err(type_err) => {
                        log::warn!("inject auto: typed failed ({type_err}), clipboard fallback");
                        copy_to_clipboard_only(text).map(|_| InjectOutcome::Copied)
                    }
                }
            }
        },
    };
    if result.is_err() {
        // 失败契约：文本留在剪贴板可手动粘贴（尽力而为，写不进就随它去）。
        let _ = copy_to_clipboard_only(text);
    }
    result
}

/// 注入结果：`Injected` = 文本已进目标应用；`Copied` = 只写了剪贴板，需要
/// 用户手动粘贴（`clipboard` 模式 / `auto` 兜底），调用方据此发
/// `inject-fallback` 软提示。
pub enum InjectOutcome {
    Injected,
    Copied,
}

/// 当前平台的粘贴注入（现有 `paste` 模式行为）。
fn paste_text(text: &str) -> Result<(), String> {
    if platform::is_hyprland_session() {
        return paste_via_hyprland(text);
    }
    paste_via_clipboard(text)
}

/// 逐字键入（enigo unicode 输入，不碰剪贴板）：游戏 / 远程桌面 / 屏蔽粘贴
/// 的输入框。对中文不友好（部分场景依赖 IME 状态），帮助文案已写明。
/// `enigo.text()` 只发 unicode 字符、`\n` 不会被目标应用当成回车——按行切
/// 开、行间真发 Return，多行转写才不丢换行。
fn inject_text_typed(text: &str) -> Result<(), String> {
    let mut enigo =
        Enigo::new(&Settings::default()).map_err(|e| format!("keyboard backend failed: {e}"))?;
    let mut first = true;
    for line in text.split('\n') {
        if !first {
            enigo
                .key(Key::Return, Direction::Click)
                .map_err(|e| e.to_string())?;
        }
        first = false;
        let line = line.strip_suffix('\r').unwrap_or(line);
        if !line.is_empty() {
            enigo.text(line).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 只写剪贴板、不发粘贴按键（`clipboard` 模式与失败契约的兜底）。
pub fn copy_to_clipboard_only(text: &str) -> Result<(), String> {
    if platform::is_hyprland_session() {
        return hyprland_set_clipboard(text);
    }
    crate::clipboard::mark_self_write(text);
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard unavailable: {e}"))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|e| format!("clipboard write failed: {e}"))
}

fn paste_via_clipboard(text: &str) -> Result<(), String> {
    // 自写抑制：注入用的写剪贴板不进最近剪贴板历史（自产自销）。**写入前**
    // 登记——`WM_CLIPBOARDUPDATE` 是异步通知，成功后才登记会留抢先窗口。
    crate::clipboard::mark_self_write(text);
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard unavailable: {e}"))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|e| format!("clipboard write failed: {e}"))?;

    thread::sleep(Duration::from_millis(40));

    // Ctrl+V on Windows/Linux, Cmd+V on macOS
    chord(modifier_key(), Key::Unicode('v'))?;

    thread::sleep(Duration::from_millis(50));
    Ok(())
}

fn paste_via_hyprland(text: &str) -> Result<(), String> {
    hyprland_set_clipboard(text)?;

    thread::sleep(Duration::from_millis(75));

    // Shift+Insert is the conventional paste on Hyprland GUI targets.
    chord(Key::Shift, Key::Insert)?;
    thread::sleep(Duration::from_millis(100));
    Ok(())
}

/// Write text into the Wayland clipboard via `wl-copy --sensitive` (Hyprland).
/// Public so the selection-translation flow (translate.rs) can set / restore
/// clipboard contents on the same path paste uses. 写入前登记自写抑制
/// （同 [`paste_via_clipboard`] 的理由）。
pub fn hyprland_set_clipboard(text: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    crate::clipboard::mark_self_write(text);
    let mut child = Command::new("wl-copy")
        .arg("--sensitive")
        .env("XDG_SESSION_TYPE", "wayland")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("wl-copy spawn failed: {e}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| format!("wl-copy write failed: {e}"))?;
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("wl-copy failed".into());
    }
    Ok(())
}

/// Ctrl on Windows/Linux, Cmd on macOS.
fn modifier_key() -> Key {
    if cfg!(target_os = "macos") {
        Key::Meta
    } else {
        Key::Control
    }
}

/// Press `modifier` down, tap `key`, release `modifier` (the clipboard chord
/// pattern used by copy / paste). No sleeps here: callers own their settle
/// delays.
fn chord(modifier: Key, key: Key) -> Result<(), String> {
    let mut enigo =
        Enigo::new(&Settings::default()).map_err(|e| format!("keyboard backend failed: {e}"))?;
    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| e.to_string())?;
    enigo
        .key(key, Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| e.to_string())
}

/// Simulate the platform copy chord (Ctrl+C / Cmd+C) so the foreground app
/// writes its current selection to the clipboard. Used by the selection
/// translation flow (translate.rs); deliberately does not touch clipboard
/// contents itself.
pub fn simulate_copy() -> Result<(), String> {
    chord(modifier_key(), Key::Unicode('c'))
}

/// Simulate the platform paste chord *without* writing the clipboard: callers
/// that manage clipboard save/restore themselves (translate.rs) use this so
/// they can restore the original clipboard content afterwards.
pub fn simulate_paste() -> Result<(), String> {
    if platform::is_hyprland_session() {
        return chord(Key::Shift, Key::Insert);
    }
    chord(modifier_key(), Key::Unicode('v'))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 控制字符剥除：制表 / 换行 / 回车保留，ESC（终端序列引导符）、NUL、
    /// DEL 与 C1 一律去除——ESC 去掉后序列体只剩字面打印字符，不再构成
    /// 可执行的终端序列。
    #[test]
    fn strip_control_chars_keeps_layout_and_drops_escapes() {
        assert_eq!(strip_control_chars("a\tb\nc\rd"), "a\tb\nc\rd");
        assert_eq!(strip_control_chars("x\u{1b}[31my\u{0}z\u{7f}"), "x[31myz");
        assert_eq!(strip_control_chars("好\u{9b}嗯"), "好嗯");
    }
}
