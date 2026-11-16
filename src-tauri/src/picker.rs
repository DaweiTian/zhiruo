//! 快速插入面板（鼠标侧键 X1/X2 唤出，label `picker`）。
//!
//! 形态（产品定稿，见《功能方案设计.md》批次一）：
//!
//! * **手势**：X1/X2 全接管，单击即开（`mouse.rs` 吞事件后 enqueue 到
//!   [`toggle`]）；面板打开时再按一次侧键 = 收起（开关语义，不叠层）。
//! * **面板**：新窗口贴鼠标指针弹出（约 320×380），整只钳进锚点所在屏幕
//!   的工作区（复用 [`OverlayFrame`] 的夹取）；上下两区——常用词 /
//!   最近剪贴板；方向键 + Enter 键盘速选，Esc / 点外 / 再按侧键收起。
//! * **落点**：X1 默认「常用词」区、X2 默认「剪贴板」区；`picker.x1Action`
//!   / `picker.x2Action` 可改成 `snippets | clipboard | both`。
//! * **注入**：点选条目走 `inject::inject_text`（现有通道；批次二加
//!   `injectMode` 后自动受益）。插入前把前台窗口还给先前应用
//!   （[`restore_foreground`]）——面板是可聚焦窗口（键盘导航需要），
//!   不还焦点的话 Ctrl/V 会打进面板自己。
//! * **常用词**：手动管理在 `picker.userSnippets`（设置页编辑）；
//!   从历史学的候选（[`ngram_candidates`]）只进候选列表，人工确认才入库。
//!
//! 窗口生命周期照 `hub.rs` 的按需重建 + 点外收起模式（`windowing.rs`）。

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// 面板窗口的逻辑尺寸（与 `tauri.conf.json` 的 `picker` 条目一致）。
pub const PICKER_WINDOW_W: f64 = 320.0;
pub const PICKER_WINDOW_H: f64 = 380.0;

/// 面板是否开着（`mouse.rs` 点外收起钩子据此门禁；只读原子量）。
static PICKER_OPEN: AtomicBool = AtomicBool::new(false);

/// 打开面板前的前台窗口（`hwnd`，Windows）；插入前还焦点用。
/// `0` = 未知（不还焦点，注入打到当前焦点）。
static PREV_FOREGROUND: Mutex<isize> = Mutex::new(0);

/// 最近一次打开面板的落点（`get_picker_data` 兜底用：`picker-update` 事件
/// 可能先于渲染层监听器到达——面板首开时 React 还没挂载）。
static LAST_FOCUS: Mutex<PickerFocus> = Mutex::new(PickerFocus::Both);

/// 面板落点区（X1/X2 的 `snippets | clipboard | both`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickerFocus {
    Snippets,
    Clipboard,
    Both,
}

impl PickerFocus {
    fn as_str(self) -> &'static str {
        match self {
            PickerFocus::Snippets => "snippets",
            PickerFocus::Clipboard => "clipboard",
            PickerFocus::Both => "both",
        }
    }

    fn parse(raw: &str) -> Self {
        match raw {
            "clipboard" => PickerFocus::Clipboard,
            "both" => PickerFocus::Both,
            _ => PickerFocus::Snippets,
        }
    }
}

pub(crate) fn is_open() -> bool {
    PICKER_OPEN.load(Ordering::SeqCst)
}

/// 侧键单击入口（`mouse.rs` 的串行 worker 调用）。开关语义：开着就收起，
/// 关着就贴指针弹出。`button`：1 = X1，2 = X2。
pub fn toggle<R: Runtime>(app: &AppHandle<R>, button: u8, cursor: (i32, i32)) {
    if is_open() {
        close_picker(app);
        return;
    }
    let config = app
        .try_state::<crate::state::AppState>()
        .map(|s| s.config.load())
        .unwrap_or_default();
    if !config.picker.enabled {
        return;
    }
    let action = if button == 1 {
        &config.picker.x1_action
    } else {
        &config.picker.x2_action
    };
    let mut focus = PickerFocus::parse(action);
    // 剪贴板采集关着时，「剪贴板」落点退到「常用词」（面板不至于打开即空）。
    if focus == PickerFocus::Clipboard && !config.picker.clipboard_enabled {
        focus = PickerFocus::Snippets;
    }
    open_picker(app, focus, cursor);
}

/// 弹出面板：定位（贴指针 + 工作区夹取）→ 显示 → 下发数据。
/// `cursor` 是钩子记录的物理像素坐标。
pub fn open_picker<R: Runtime>(app: &AppHandle<R>, focus: PickerFocus, cursor: (i32, i32)) {
    if is_open() {
        return;
    }
    let Some(window) = crate::windowing::ensure_picker_window(app) else {
        log::warn!("picker: picker window unavailable");
        let _ = app.emit("error", json!({ "message": "快速插入面板窗口不可用。" }));
        return;
    };

    remember_foreground();
    let (px, py) = cursor;
    place_picker_window(app, &window, (px as f64, py as f64));
    crate::windowing::harden_overlay_window(&window);
    if let Err(e) = window.show() {
        log::warn!("picker: show failed: {e}");
        return;
    }
    // 键盘导航需要输入焦点（hub 是纯点击面板所以 non-focusable，这里相反）。
    let _ = window.set_focus();
    PICKER_OPEN.store(true, Ordering::SeqCst);
    *LAST_FOCUS.lock().unwrap_or_else(PoisonError::into_inner) = focus;

    let payload = picker_payload(focus);
    let _ = app.emit("picker-update", payload);
}

/// 收起面板：隐藏窗口、清掉前台快照。幂等，任意路径可调。
pub fn close_picker<R: Runtime>(app: &AppHandle<R>) {
    PICKER_OPEN.store(false, Ordering::SeqCst);
    *PREV_FOREGROUND.lock().unwrap_or_else(PoisonError::into_inner) = 0;
    if let Some(window) = app.get_webview_window(crate::windowing::PICKER_WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            if let Err(e) = window.hide() {
                log::warn!("picker: hide failed: {e}");
            }
        }
    }
}

/// 面板数据：落点 + 常用词 + 最近剪贴板（最新在前）。命令边界/事件载荷，
/// 渲染层拿到的永远是形状正确的 JSON。
fn picker_payload(focus: PickerFocus) -> Value {
    let config = crate::config::ConfigStore::new().load();
    let snippets: Vec<&str> = config
        .picker
        .user_snippets
        .iter()
        .map(|s| s.as_str())
        .collect();
    let clipboard: Vec<Value> = crate::clipboard::get_entries()
        .into_iter()
        .map(|entry| json!({ "text": entry.text, "timestamp": entry.timestamp }))
        .collect();
    json!({
        "focus": focus.as_str(),
        "snippets": snippets,
        "clipboard": clipboard,
    })
}

/// 供 `commands.rs` 的 `get_picker_data` 使用（面板/设置页按需拉取；
/// `focus = None` 时取最近一次打开的落点）。
pub(crate) fn current_payload(focus: Option<PickerFocus>) -> Value {
    let focus = focus.unwrap_or_else(|| {
        *LAST_FOCUS.lock().unwrap_or_else(PoisonError::into_inner)
    });
    picker_payload(focus)
}

/// 把面板窗口摆到锚点（指针）上：窗口左上角贴锚点，整只钳进锚点所在屏幕
/// 的工作区（[`crate::commands::OverlayFrame`]，与 hub 同一几何兜底）。
fn place_picker_window<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    anchor: (f64, f64),
) {
    let (cx, cy) = anchor;
    if let Some(frame) = crate::commands::OverlayFrame::resolve(app, window, cx, cy) {
        let (x, y) = frame.clamp_window(cx, cy);
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    } else {
        let _ = window.set_position(tauri::PhysicalPosition::new(cx as i32, cy as i32));
    }
}

/// 记住当前前台窗口（打开面板瞬间），插入前 [`restore_foreground`] 还回去。
fn remember_foreground() {
    let mut slot = PREV_FOREGROUND.lock().unwrap_or_else(PoisonError::into_inner);
    *slot = current_foreground();
}

#[cfg(windows)]
fn current_foreground() -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe { GetForegroundWindow() as isize }
}

#[cfg(not(windows))]
fn current_foreground() -> isize {
    0
}

/// 插入前把焦点还给先前应用。Windows：先敲 Alt 解锁前台切换限制再
/// `SetForegroundWindow`。找不到先前窗口就什么都不做——注入会打到当前
/// 焦点。调用方（`commands::picker_insert`）在隐藏面板后调用。
pub(crate) fn restore_foreground() {
    let hwnd = {
        let mut slot = PREV_FOREGROUND.lock().unwrap_or_else(PoisonError::into_inner);
        let value = *slot;
        *slot = 0;
        value
    };
    restore_foreground_hwnd(hwnd);
}

/// `restore_foreground` 的无窗口句柄版（纯 Win32，测试/命令边界共用）。
#[cfg(windows)]
pub(crate) fn restore_foreground_hwnd(hwnd: isize) {
    if hwnd == 0 {
        return;
    }
    use windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    // Alt 敲击是 SetForegroundWindow 的经典前置：解锁前台切换限制
    // （系统只让「收到最后输入的进程」抢前台，我们吞了侧键事件，不敲
    // 这一下还焦经常静默失败）。
    tap_alt();
    unsafe {
        SetForegroundWindow(hwnd as _);
    }
}

#[cfg(not(windows))]
pub(crate) fn restore_foreground_hwnd(_hwnd: isize) {}

/// 敲一下 Alt（按下+抬起）：只用于解锁前台切换，不产生可见副作用。
#[cfg(windows)]
fn tap_alt() {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
        let _ = enigo.key(Key::Alt, Direction::Click);
    }
}

// ---------------------------------------------------------------------------
// 从历史学常用词候选（n-gram）
// ---------------------------------------------------------------------------

/// 2–6 字片段在历史转写中出现 ≥ `min_count` 次 → 候选（人工确认才入库）。
///
/// 中文分词不可靠，因此只做字符级 n-gram：片段必须含 CJK 字符且全部
/// 字符为字母/数字（挡掉标点夹杂的碎屑）。同一长片段覆盖的子串让位
/// （只留「极大」片段）；被已有常用词**覆盖**的片段（等于或含于其内）
/// 也不进候选——内容已经收编。纯函数，单测直调。
pub(crate) fn ngram_candidates(
    texts: &[String],
    existing: &[String],
    min_count: usize,
    max_out: usize,
) -> Vec<String> {
    use std::collections::HashMap;

    let mut counts: HashMap<String, usize> = HashMap::new();
    for text in texts {
        let chars: Vec<char> = text.chars().collect();
        for len in 2..=6 {
            if chars.len() < len {
                continue;
            }
            for window in chars.windows(len) {
                let gram: String = window.iter().collect();
                if !is_candidate_gram(&gram) {
                    continue;
                }
                *counts.entry(gram).or_insert(0) += 1;
            }
        }
    }

    let mut qualifying: Vec<(String, usize)> = counts
        .into_iter()
        .filter(|(gram, count)| {
            *count >= min_count && !existing.iter().any(|snippet| snippet.contains(gram.as_str()))
        })
        .collect();
    // 极大性：先长后短，被已留长片段覆盖的子串丢弃。
    qualifying.sort_by(|a, b| b.0.chars().count().cmp(&a.0.chars().count()));
    let mut maximal: Vec<(String, usize)> = Vec::new();
    for (gram, count) in qualifying {
        if maximal
            .iter()
            .any(|(kept, _)| kept.contains(&gram))
        {
            continue;
        }
        maximal.push((gram, count));
    }
    // 按频次降序、同频按字典序，截断到 max_out。
    maximal.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    maximal.truncate(max_out);
    maximal.into_iter().map(|(gram, _)| gram).collect()
}

/// 候选片段形状：含至少一个 CJK 字符，且全部字符字母/数字（2–6 字由
/// 调用方的窗口长度保证）。
fn is_candidate_gram(gram: &str) -> bool {
    let mut has_cjk = false;
    for ch in gram.chars() {
        if is_cjk(ch) {
            has_cjk = true;
        } else if !ch.is_alphanumeric() {
            return false;
        }
    }
    has_cjk
}

fn is_cjk(ch: char) -> bool {
    matches!(ch as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

/// 供设置页拉取候选（`picker.learnSnippets` 开着才扫描）。
pub(crate) fn learned_candidates(existing: &[String]) -> Vec<String> {
    let config = crate::config::ConfigStore::new().load();
    if !config.picker.learn_snippets {
        return Vec::new();
    }
    // 只扫语音听写原文（`source: None`），选区原文快照不当学习材料。
    let texts: Vec<String> = crate::history::HistoryManager::get_all()
        .into_iter()
        .filter(|item| item.source.is_none())
        .map(|item| item.text)
        .collect();
    ngram_candidates(&texts, existing, 3, 30)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(list: &[&str]) -> Vec<String> {
        list.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn ngram_candidates_collects_frequent_cjk_fragments() {
        // 「张伟」出现 3 次 → 候选；「李雷」只 2 次 → 不够。
        let texts = s(&[
            "张伟你好今天开会",
            "麻烦转告张伟",
            "张伟下午来",
            "李雷在吗",
            "帮我叫李雷",
        ]);
        let out = ngram_candidates(&texts, &[], 3, 30);
        assert!(out.contains(&"张伟".to_string()), "got: {out:?}");
        assert!(!out.contains(&"李雷".to_string()), "got: {out:?}");
    }

    #[test]
    fn ngram_candidates_keeps_maximal_grams_only() {
        // 「北京天气」3 次 → 它的子串「北京」「京天」… 让位。
        let texts = s(&["北京天气不错", "北京天气如何", "看北京天气"]);
        let out = ngram_candidates(&texts, &[], 3, 30);
        assert!(out.contains(&"北京天气".to_string()), "got: {out:?}");
        assert!(!out.contains(&"北京".to_string()), "got: {out:?}");
    }

    #[test]
    fn ngram_candidates_skips_existing_coverage_and_punctuation_debris() {
        // 已有常用词「张伟你好」覆盖了它的全部子串：不再进候选。
        let texts = s(&["张伟你好", "张伟你好", "张伟你好"]);
        let out = ngram_candidates(&texts, &s(&["张伟你好"]), 3, 30);
        assert!(out.is_empty(), "got: {out:?}");
        // 含标点的窗口整只拒掉；纯片段（「好的」）仍然可以进。
        let noisy = s(&["嗯……好的！", "嗯……好的！", "嗯……好的！"]);
        let out = ngram_candidates(&noisy, &[], 3, 30);
        assert_eq!(out, vec!["好的".to_string()], "got: {out:?}");
    }

    #[test]
    fn focus_parse_round_trips() {
        assert_eq!(PickerFocus::parse("snippets"), PickerFocus::Snippets);
        assert_eq!(PickerFocus::parse("clipboard"), PickerFocus::Clipboard);
        assert_eq!(PickerFocus::parse("both"), PickerFocus::Both);
        assert_eq!(PickerFocus::parse("bogus"), PickerFocus::Snippets);
    }
}
