//! 选区快捷动作 hub：右键常驻胶囊唤出的圆环动作面板编排。
//!
//! 产品定稿的手势分工：中键 / 键盘 = 语音输入（PTT）；右键常驻胶囊 = 本 hub。
//! 形态：自由悬浮 = 完整圆环均分扇区围绕胶囊；贴边 = 只朝屏幕内展开半环
//! （贴边状态读 config `app.overlayDocked`，扇形几何在渲染层 `hub-geometry.ts`）。
//!
//! 窗口定位：整只窗口钳进锚点所在屏幕的工作区（[`crate::commands::OverlayFrame`]），
//! **圆环仍锚定胶囊中心**——环心相对窗口的偏移（`ringCenter`，webview CSS px）
//! 随 `hub-update` 载荷下发，渲染层据此偏移圆环 SVG。贴边时窗口不再半出屏，
//! 状态文字 / 结果卡片始终完整可见（旧布局把文字裁进屏外）。
//!
//! 时序：右键打开 → 立刻哨兵捕获选区（`translate::capture_selection_text`，文本
//! 暂存 [`HUB_SELECTION`]）→ 动作点击后走 `translate::run_with_text` 输出。
//! 捕获放在打开时而不是点击时，是为了当场给出「未检测到选区」提示与选区预览；
//! 改写类输出前 `run_with_text` 会复查选区未变，选区漂移绝不误替换。
//! 捕获与动作都持有 `translate::BusyGuard`，与翻译快捷键共用同一把互斥。
//!
//! 收起路径：结果卡片关闭按钮 / 面板背景点击（渲染层）、替换成功后的延时收起、
//! 以及 Windows `mouse.rs` 全局鼠标钩子的「点外收起」（任意按键落在 hub /
//! 胶囊窗口之外即 [`close_hub`]；hub 非激活窗口收不到 blur，只能靠钩子）。
//!
//! 窗口生命周期归 `windowing`（[`windowing::ensure_hub_window`]）；本模块只做
//! 编排与 `hub-update` 事件。失败路径一律 emit 可见中文提示，不静默吞错。

use crate::translate::{self, BusyGuard, ClipboardGuard, SelectionAction};
use crate::windowing::HUB_WINDOW_LABEL;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// hub 窗口逻辑尺寸（正方形）：完整圆环 + 解释结果卡片都落在窗口内。
pub const HUB_WINDOW_SIZE: f64 = 260.0;

/// 替换成功后「已替换」提示的停留时长，随后自动收起 hub。
const DONE_FLASH_MS: u64 = 900;

/// 环心默认值 = 窗口正中（窗口无偏移摆位时渲染层的原点约定）。
const RING_CENTER_DEFAULT: (f64, f64) = (HUB_WINDOW_SIZE / 2.0, HUB_WINDOW_SIZE / 2.0);

static HUB_OPEN: AtomicBool = AtomicBool::new(false);
static HUB_SELECTION: Mutex<Option<String>> = Mutex::new(None);
/// 环心相对 hub 窗口左上角的偏移（webview CSS px），每次 [`open_hub`] 落位后写入。
static HUB_RING_CENTER: Mutex<(f64, f64)> = Mutex::new(RING_CENTER_DEFAULT);

/// `hub-update` 事件载荷统一出口（hub 窗口渲染层监听）。
fn emit_hub<R: Runtime>(app: &AppHandle<R>, payload: Value) {
    let _ = app.emit("hub-update", payload);
}

/// 环心偏移（webview CSS px）：渲染层偏移圆环 SVG，把圆环钉在胶囊上。
fn ring_center_json() -> Value {
    let (x, y) = *HUB_RING_CENTER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    json!({ "x": x, "y": y })
}

/// 状态载荷出口：除调用方给的字段外，**每条载荷**都补上 `dockEdge` 与
/// `ringCenter`。动作中段（processing / done / result）也不能丢几何——
/// 渲染层据此重建扇区与偏移，缺字段会让贴边圆环闪回全环。
fn hub_status<R: Runtime>(app: &AppHandle<R>, status: &str, extra: Value) {
    let mut payload = json!({ "status": status });
    if let Some(obj) = payload.as_object_mut() {
        if let Some(extra_obj) = extra.as_object() {
            for (k, v) in extra_obj {
                obj.insert(k.clone(), v.clone());
            }
        }
        obj.insert("dockEdge".into(), dock_edge_json(app));
        obj.insert("ringCenter".into(), ring_center_json());
    }
    emit_hub(app, payload);
}

fn lock_hub_selection() -> std::sync::MutexGuard<'static, Option<String>> {
    HUB_SELECTION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// hub 当前是否开着（`mouse.rs` 点外收起钩子据此门禁；只读原子量）。
pub(crate) fn is_open() -> bool {
    HUB_OPEN.load(Ordering::SeqCst)
}

/// 当前胶囊贴边状态（`"left" | "right" | "top" | "bottom"` 或 `null`），
/// 渲染层据此决定完整圆环还是朝屏幕内的半环。
fn dock_edge_json<R: Runtime>(app: &AppHandle<R>) -> Value {
    app.try_state::<crate::state::AppState>()
        .map(|s| match s.config.load().app.overlay_docked {
            Some(edge) => json!(edge),
            None => Value::Null,
        })
        .unwrap_or(Value::Null)
}

/// hub 锚点：可见胶囊中心（渲染层测量的物理像素锚点）。锚点缺失时退回
/// overlay 窗口中心。命令边界不可信：非有限值一律丢弃，回退默认。
fn anchor_center<R: Runtime>(app: &AppHandle<R>, center: Option<(f64, f64)>) -> Option<(f64, f64)> {
    if let Some((x, y)) = center {
        if x.is_finite() && y.is_finite() {
            return Some((x, y));
        }
    }
    let overlay = app.get_webview_window(crate::windowing::OVERLAY_WINDOW_LABEL)?;
    let pos = overlay.outer_position().ok()?;
    let size = overlay.outer_size().ok()?;
    Some((
        pos.x as f64 + size.width as f64 / 2.0,
        pos.y as f64 + size.height as f64 / 2.0,
    ))
}

/// 把 hub 窗口摆到锚点上并记录环心偏移：
/// - 首选整窗钳进锚点所在屏幕的工作区（[`crate::commands::OverlayFrame`]），
///   状态文字 / 结果卡片因此永远完整可见；圆环不跟随窗口移动——环心偏移
///   （`ringCenter`）随 `hub-update` 下发，渲染层把圆环钉回胶囊中心；
/// - 找不到显示器（几何兜底失败）时退回旧行为：窗口中心压锚点，
///   环心即窗口正中（[`RING_CENTER_DEFAULT`]）。
fn place_hub_window<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    anchor: (f64, f64),
) {
    let (cx, cy) = anchor;
    let mut ring_center = RING_CENTER_DEFAULT;
    if let Some(frame) = crate::commands::OverlayFrame::resolve(app, window, cx, cy) {
        let (x, y) = frame.clamp_window(cx - frame.window_w / 2.0, cy - frame.window_h / 2.0);
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        // 以实际落位为准（set_position 失败时窗口可能仍在旧位置），换算成
        // webview CSS px（圆环 SVG 与 `hub-geometry.ts` 同一坐标系）。
        if let Ok(pos) = window.outer_position() {
            let scale = if frame.window_scale > 0.0 {
                frame.window_scale
            } else {
                1.0
            };
            ring_center = ((cx - pos.x as f64) / scale, (cy - pos.y as f64) / scale);
        }
    } else if let Ok(size) = window.outer_size() {
        let x = cx - size.width as f64 / 2.0;
        let y = cy - size.height as f64 / 2.0;
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
    *HUB_RING_CENTER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = ring_center;
}

/// 右键胶囊入口：已开则收起（toggle）；未开则定位显示 hub 并捕获选区。
///
/// `center` = 可见胶囊中心（**物理像素**，渲染层测量）。命令边界不可信：
/// 非有限值回退 overlay 窗口中心。
pub async fn open_hub<R: Runtime>(app: &AppHandle<R>, center: Option<(f64, f64)>) {
    if is_open() {
        close_hub(app);
        return;
    }

    let Some(window) = crate::windowing::ensure_hub_window(app) else {
        log::warn!("hub: hub window unavailable");
        let _ = app.emit("error", json!({ "message": "快捷动作面板窗口不可用。" }));
        return;
    };

    if let Some(anchor) = anchor_center(app, center) {
        place_hub_window(app, &window, anchor);
    }
    crate::windowing::harden_overlay_window(&window);
    if let Err(e) = window.show() {
        log::warn!("hub: show failed: {e}");
        return;
    }
    HUB_OPEN.store(true, Ordering::SeqCst);
    *lock_hub_selection() = None;

    hub_status(app, "capturing", json!({}));

    // 捕获与翻译快捷键互斥：拿不到锁就明说，不排队插队。
    let Some(_busy) = BusyGuard::acquire() else {
        hub_status(
            app,
            "error",
            json!({ "message": "有其他选区任务正在进行，请稍后再试。" }),
        );
        return;
    };
    // 等右键松开稳定后再发 Ctrl+C，避免按键事件干扰前台应用选区
    // （与翻译快捷键的 HOTKEY_RELEASE_DELAY_MS 同一理由）。
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let captured = translate::capture_selection_text().await;

    // 捕获期间可能已被收起：丢弃迟到结果，不复活面板。
    if !is_open() {
        return;
    }

    match captured {
        Ok(Some(text)) => {
            log::info!("hub: captured selection ({} chars)", text.chars().count());
            let preview: String = text.chars().take(80).collect();
            *lock_hub_selection() = Some(text);
            hub_status(app, "ready", json!({ "preview": preview }));
        }
        Ok(None) => {
            hub_status(app, "empty", json!({}));
        }
        Err(message) => {
            hub_status(app, "error", json!({ "message": message }));
        }
    }
}

/// 动作点击入口：对已捕获的选区执行动作并输出。
pub async fn run_hub_action<R: Runtime>(app: &AppHandle<R>, action_raw: &str) {
    let action = match SelectionAction::parse(action_raw) {
        Ok(action) => action,
        Err(message) => {
            hub_status(app, "error", json!({ "message": message }));
            return;
        }
    };

    let Some(_busy) = BusyGuard::acquire() else {
        hub_status(
            app,
            "error",
            json!({ "message": "有其他选区任务正在进行，请稍后再试。" }),
        );
        return;
    };

    let original = lock_hub_selection().clone();
    let Some(original) = original else {
        hub_status(
            app,
            "empty",
            json!({ "message": "未检测到选区：请先选中文字再试。" }),
        );
        return;
    };

    let config = app
        .try_state::<crate::state::AppState>()
        .map(|s| s.config.load())
        .unwrap_or_default();
    if let Err(message) = translate::gate_action(&config, action) {
        hub_status(app, "error", json!({ "message": message }));
        return;
    }

    hub_status(app, "processing", json!({ "action": action_raw }));

    let mut guard = ClipboardGuard::capture();
    match translate::run_with_text(app, action, &original, &mut guard).await {
        Ok(output) => {
            if action.replaces_selection() {
                log::info!("hub: {action:?} replaced selection");
                hub_status(app, "done", json!({ "action": action_raw }));
                close_hub_later(app, DONE_FLASH_MS);
            } else {
                log::info!("hub: {action:?} produced explanation");
                hub_status(
                    app,
                    "result",
                    json!({ "result": output, "action": action_raw }),
                );
            }
        }
        Err(message) => {
            log::warn!("hub: {action:?} failed: {message}");
            hub_status(app, "error", json!({ "message": message }));
        }
    }
}

/// 收起 hub：隐藏窗口、清掉暂存选区。幂等，任意路径可调。
pub fn close_hub<R: Runtime>(app: &AppHandle<R>) {
    HUB_OPEN.store(false, Ordering::SeqCst);
    *lock_hub_selection() = None;
    if let Some(window) = app.get_webview_window(HUB_WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            if let Err(e) = window.hide() {
                log::warn!("hub: hide failed: {e}");
            }
        }
    }
}

/// 替换成功后短暂展示「已替换」再收起（复用 [`close_hub`]）。
fn close_hub_later<R: Runtime>(app: &AppHandle<R>, delay_ms: u64) {
    let app = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        if is_open() {
            close_hub(&app);
        }
    });
}
