//! 选区快捷动作 hub：圆环动作面板编排（右键常驻胶囊 / 鼠标侧键唤出）。
//!
//! 手势分工：中键 / 键盘 = 语音输入（PTT）；右键常驻胶囊 = 本 hub；鼠标侧键
//! 可在设置里把落点设为「快捷 Hub」一键唤出本 hub（`picker.x1Action` /
//! `picker.x2Action` 取 `hub`，以鼠标为环心，悬浮
//! 胶囊关掉也不影响）。形态：自由悬浮 = 完整圆环均分扇区围绕锚点；贴边 =
//! 只朝屏幕内展开半环（胶囊锚点读 config `app.overlayDocked`；鼠标锚点
//! 永远完整圆环，贴边由渲染层 `edgeFromRingCenter` 兜底。扇形几何在
//! `hub-geometry.ts`）。
//!
//! 窗口定位：整只窗口钳进锚点所在屏幕的工作区（[`crate::commands::OverlayFrame`]），
//! **圆环仍锚定环心**——环心相对窗口的偏移（`ringCenter`，webview CSS px）
//! 随 `hub-update` 载荷下发，渲染层据此偏移圆环 SVG。贴边时窗口不再半出屏，
//! 状态文字 / 结果卡片始终完整可见（旧布局把文字裁进屏外）。
//!
//! 时序：唤出 → 立刻哨兵捕获选区（`translate::capture_selection_text`，文本
//! 暂存 [`HUB_SELECTION`]）→ 动作点击后走 `translate::run_with_text` 输出。
//! 捕获放在打开时而不是点击时，是为了当场给出「未检测到选区」提示与选区预览；
//! 改写类输出前 `run_with_text` 会复查选区未变，选区漂移绝不误替换。
//! 捕获与动作都持有 `translate::BusyGuard`，与翻译快捷键共用同一把互斥。
//!
//! 开关时序照 `picker.rs` 的代际纪律：打开序列由 [`OPEN_LOCK`] 串行（hub
//! 打开既走鼠标 worker spawn 又走命令，tokio 多线程会并行，不串行的话两次
//! 打开会交错 place/show、环心互相覆盖）；每次打开发代际（`SESSION`），
//! 捕获迟到结果与「已替换」延迟收起都带代际条件，连按侧键的
//! 收起 → 重开交错不会被陈旧收尾误伤。
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use tauri::{AppHandle, Manager, Runtime};

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

/// hub 锚点类型：决定环心取谁、贴边半环听谁的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HubAnchor {
    /// 可见胶囊中心（物理像素）：贴边时跟随胶囊吸附边画半环。
    Capsule,
    /// 鼠标指针（物理像素）：永远完整圆环，贴边由 `edgeFromRingCenter` 兜底。
    Pointer,
}

/// hub 会话状态。一把小锁只动字段（开关 / 代际 / 锚点类型），锁内不碰
/// 窗口 / 磁盘 / Win32（[`crate::picker`] 的 `PickerSession` 同一纪律）。
///
/// **代际**（`open_gen`，0 = 关闭）让跨线程收尾只作用于自己那一代：捕获
/// 迟到结果、「已替换」延迟收起都带代际条件，连按侧键的收起 → 重开交错
/// 不会被陈旧收尾误伤（`picker.rs` 代际守卫同一回归面）。
struct HubSession {
    open_gen: u64,
    /// 跟随胶囊吸附边（仅 [`HubAnchor::Capsule`]）；鼠标锚点恒 false。
    follow_capsule_dock: bool,
}

static SESSION: Mutex<HubSession> = Mutex::new(HubSession {
    open_gen: 0,
    follow_capsule_dock: true,
});

/// 代际发号器（0 保留给「关闭」，从 1 起）。
static NEXT_GEN: AtomicU64 = AtomicU64::new(1);

/// 打开序列串行锁：hub 打开既走 `mouse.rs` worker spawn 又走命令（tokio
/// 多线程并行），不串行的话两次打开会交错 place/show、环心互相覆盖。
/// 锁内是「claim → 落位 → show」同步段（无 await）；收起不取这把锁——
/// 代际翻号 + 隐藏窗口即可，开序列尾部的代际复查负责收尾。
static OPEN_LOCK: Mutex<()> = Mutex::new(());

/// `hub-update` 事件载荷统一出口（hub 窗口渲染层监听）。
fn emit_hub<R: Runtime>(app: &AppHandle<R>, payload: Value) {
    crate::events::hub_update(app, &payload);
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
/// 渲染层据此决定完整圆环还是朝屏幕内的半环。仅 [`HubAnchor::Capsule`]
/// 跟随胶囊吸附边——鼠标锚点下发 `null`（完整圆环，贴近屏幕边由渲染层
/// `edgeFromRingCenter` 兜底），不然中屏鼠标弹出也会被吸附边砍成半环。
fn dock_edge_json<R: Runtime>(app: &AppHandle<R>) -> Value {
    let follow = SESSION
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .follow_capsule_dock;
    if !follow {
        return Value::Null;
    }
    app.try_state::<crate::state::AppState>()
        .map(|s| match s.config.load().app.overlay_docked {
            Some(edge) => json!(edge),
            None => Value::Null,
        })
        .unwrap_or(Value::Null)
}

/// hub 锚点：胶囊中心或鼠标指针（**物理像素**）。锚点缺失 / 非有限值时
/// 退回 overlay 窗口中心。命令边界不可信：非有限值一律丢弃，回退默认。
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

/// 唤出入口（右键胶囊 / 鼠标侧键）：已开则收起（toggle）；未开则定位显示
/// hub 并捕获选区。
///
/// `center` = 锚点物理像素坐标（可见胶囊中心，或鼠标指针）。命令边界不可信：
/// 非有限值回退 overlay 窗口中心。`anchor` 决定贴边半环跟不跟胶囊吸附边
/// （[`HubAnchor`]）。
pub async fn open_hub<R: Runtime>(
    app: &AppHandle<R>,
    center: Option<(f64, f64)>,
    anchor: HubAnchor,
) {
    // 打开序列串行（OPEN_LOCK 内 claim → 落位 → show 同步段，无 await）；
    // 开着再进 = 收起（toggle，与 picker.rs 同款开关语义）。
    let _open = OPEN_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let gen = {
        let mut session = SESSION.lock().unwrap_or_else(PoisonError::into_inner);
        if session.open_gen != 0 {
            drop(session);
            // 收起也持串行锁：早放锁的话另一次打开可在「读到已开」与
            // 「无条件收起」之间抢到新代际，被这次收起误关。
            close_hub(app);
            return;
        }
        session.open_gen = NEXT_GEN.fetch_add(1, Ordering::SeqCst);
        session.follow_capsule_dock = anchor == HubAnchor::Capsule;
        // 置位在 show 之前（同 PICKER_OPEN）：建窗 / 捕获期间的点外
        // 点击也要能走到收起路径。
        HUB_OPEN.store(true, Ordering::SeqCst);
        session.open_gen
    };
    *lock_hub_selection() = None;
    // 两面板互斥（对称于 `mouse.rs` 侧键路由的互斥收起）：胶囊右键等入口
    // 打开 hub 时收起还开着的速插面板，不叠两层弹窗。
    crate::picker::close_picker(app);

    let window = match crate::windowing::ensure_hub_window(app) {
        Some(window) => window,
        None => {
            log::warn!("hub: hub window unavailable");
            drop(_open);
            rollback_open(gen);
            crate::events::session_error(app, &json!({ "message": "快捷动作面板窗口不可用。" }));
            return;
        }
    };
    if let Some(anchor) = anchor_center(app, center) {
        place_hub_window(app, &window, anchor);
    }
    crate::windowing::harden_overlay_window(&window);
    if let Err(e) = window.show() {
        log::warn!("hub: show failed: {e}");
        drop(_open);
        rollback_open(gen);
        return;
    }
    // 打开序列到此结束：释放串行锁再进捕获 await 段。
    drop(_open);

    // 竞态复查：show 期间被收起 / 换代的话按代际归属收场——「已关」藏窗，
    // 「已换新一代」绝不动新会话的可见性。
    if !open_still_current(&window, gen) {
        return;
    }

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
    // 等触发按键松开稳定后再发 Ctrl+C，避免按键事件干扰前台应用选区
    // （与翻译快捷键的 HOTKEY_RELEASE_DELAY_MS 同一理由）。
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let captured = translate::capture_selection_text().await;

    // 捕获期间可能已被收起或换代（点外收起 → 侧键重开）：丢弃迟到结果。
    if current_generation() != gen {
        return;
    }

    match captured {
        Ok(Some(text)) => {
            log::info!("hub: captured selection ({} chars)", text.chars().count());
            let preview: String = text.chars().take(80).collect();
            if !commit_selection_if(gen, Some(text)) {
                return;
            }
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

/// 代际条件写入选区：仍属本代才写。检查与写入同锁（锁序 SESSION →
/// HUB_SELECTION 单向，全仓无反向嵌套）——极端交错下捕获迟到结果绝不
/// 灌进「收起 → 重开」后的新一代会话（动作会拿旧选区替换正文）。
fn commit_selection_if(gen: u64, text: Option<String>) -> bool {
    let session = SESSION.lock().unwrap_or_else(PoisonError::into_inner);
    if session.open_gen != gen {
        return false;
    }
    *lock_hub_selection() = text;
    true
}

/// 打开序列尾部的竞态复查：仍是本代 → 继续；已关 → 藏窗收场；已换新一代
/// （收起后立刻重开）→ 窗口归新一代所有，这里绝不动它的可见性。
fn open_still_current<R: Runtime>(window: &tauri::WebviewWindow<R>, gen: u64) -> bool {
    let open_gen = SESSION
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .open_gen;
    if open_gen == gen {
        return true;
    }
    if open_gen == 0 {
        let _ = window.hide();
    }
    false
}

/// 打开序列中途失败的回滚：仅当仍是本代时清会话（不误伤后来者）。
fn rollback_open(gen: u64) {
    let mut session = SESSION.lock().unwrap_or_else(PoisonError::into_inner);
    if session.open_gen == gen {
        session.open_gen = 0;
        session.follow_capsule_dock = true;
        HUB_OPEN.store(false, Ordering::SeqCst);
        drop(session);
        *lock_hub_selection() = None;
    }
}

/// 当前会话代际（0 = 关闭）。开序列与延迟收起的代际条件快照用。
fn current_generation() -> u64 {
    SESSION
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .open_gen
}

/// 动作点击入口：对已捕获的选区执行动作并输出。
pub async fn run_hub_action<R: Runtime>(app: &AppHandle<R>, action_raw: &str) {
    let gen = current_generation();
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
    let outcome = translate::run_with_text(app, action, &original, &mut guard).await;

    // 动作期间可能已被收起或换代（点外收起 → 侧键重开）：迟到结果不下发，
    // 不把陈旧状态盖到新会话头上（代际纪律同捕获尾巴）。
    if current_generation() != gen {
        return;
    }

    match outcome {
        Ok(output) => {
            if action.replaces_selection() {
                log::info!("hub: {action:?} replaced selection");
                hub_status(app, "done", json!({ "action": action_raw }));
                close_hub_later(app, gen, DONE_FLASH_MS);
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
    close_generation(app, None);
}

/// 代际条件收起（`picker.rs` 的 `close_generation` 同一纪律）：`want =
/// Some(gen)` 只收那一代（「已替换」延迟收起），`None` 无条件收。收不动时
/// （会话已关 / 已换代）什么都不做——陈旧收尾绝不动新一代会话。
fn close_generation<R: Runtime>(app: &AppHandle<R>, want: Option<u64>) {
    {
        let mut session = SESSION.lock().unwrap_or_else(PoisonError::into_inner);
        if session.open_gen == 0 {
            return;
        }
        if let Some(g) = want {
            if session.open_gen != g {
                return;
            }
        }
        session.open_gen = 0;
        session.follow_capsule_dock = true;
        HUB_OPEN.store(false, Ordering::SeqCst);
    }
    *lock_hub_selection() = None;
    if let Some(window) = app.get_webview_window(HUB_WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            if let Err(e) = window.hide() {
                log::warn!("hub: hide failed: {e}");
            }
        }
    }
}

/// 替换成功后短暂展示「已替换」再收起：带代际条件，延迟期间用户若
/// 收起 → 重开，陈旧定时器不会把新会话关掉。
fn close_hub_later<R: Runtime>(app: &AppHandle<R>, gen: u64, delay_ms: u64) {
    let app = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        close_generation(&app, Some(gen));
    });
}
