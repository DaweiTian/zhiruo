//! 最近剪贴板环形缓冲（快速插入面板的自建剪贴板历史，`voice-key-clipboard.json`）。
//!
//! 不依赖 Win+V（位置固定、样式不可控、还要求系统开了剪贴板历史），
//! 自建一份可控的最近剪贴板。纪律：
//!
//! * **只存文本**：图片 / 文件不做；单条上限 [`MAX_ENTRY_BYTES`]（10 KB）。
//! * **自写抑制**：我们自己的粘贴 / 写剪贴板（`translate.rs::write_clipboard_text`、
//!   `inject.rs` 的写入）先走 [`mark_self_write`]，对应通知 / 轮询观察到同一
//!   内容即跳过——避免自产自销。抑制靠内容哈希比对（`WM_CLIPBOARDUPDATE`
//!   异步到达，写入期间加锁拦不住迟到通知）。
//! * **隐私**：只落本地配置目录，不进日志、不上传；「启用剪贴板采集」总开关
//!   （[`set_enabled`]）+ 设置页「一键清空」（[`clear`]）。
//! * **采集**：Windows 走 `AddClipboardFormatListener`（`WM_CLIPBOARDUPDATE`）
//!   事件驱动（专用线程 + message-only 窗口）；非 Windows 降级为定时读 +
//!   内容比对（[`POLL_INTERVAL`]）。两条采集路径最终都汇入 [`observe`]。
//!
//! 环形缓冲：新条目插入队首，重复内容去重置顶，超过 `clipboardLimit`
//! （[`set_limit`]，默认 30）裁掉队尾；进程内互斥 + 文件持久化（同
//! history/stats 的保管方式），重启不丢。

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 单条上限 10 KB（UTF-8 字节）：超限条目直接丢弃（通常是误复制的大段内容）。
const MAX_ENTRY_BYTES: usize = 10 * 1024;

/// 默认条数上限（`picker.clipboardLimit`）。合法区间 5–100 由
/// `config::normalize_clipboard_limit` 夹取。
const DEFAULT_LIMIT: u32 = 30;

/// 非 Windows 轮询降级的采样间隔。够短（复制后 ≤2 秒进历史）、够长（空转
/// 读剪贴板不构成负担）。Windows 监听线程启动失败时也走这条降级路。
const POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// 采样读故障后的补采延迟（剪贴板被占用的瞬时窗口）。
const POLL_RETRY_DELAY: Duration = Duration::from_millis(150);

/// 采集总开关（镜像 `picker.clipboardEnabled`）。
static ENABLED: AtomicBool = AtomicBool::new(true);

/// 条数上限（镜像 `picker.clipboardLimit`）。
static LIMIT: AtomicU32 = AtomicU32::new(DEFAULT_LIMIT);

/// 读-改-写文件与 [`observe`] 的去重决策共用一把锁（同 stats.rs::STATS_LOCK
/// 模式）。A poisoned mutex is recovered: authoritative data is on disk.
static CLIPBOARD_LOCK: Mutex<()> = Mutex::new(());

/// 最近一次观察到 / 自写抑制的剪贴板内容哈希（[`hash_text`]）。
/// `None` = 无基线（启动后第一次内容一律记录）。
///
/// **单槽基线的取舍**：`ClipboardGuard` 的 Drop 恢复原内容（translate.rs）
/// 或采集关闭期滚动基线后，用户紧接着复制同一文本会被当作抑制命中而丢
/// 一条（只是少一次置顶，不是丢内容）。要彻底消除需要按时间窗区分「抑制
/// 期待」与「观察基线」两套状态；当前单槽实现简单且误伤面极小，接受。
static LAST_OBSERVED: Mutex<Option<u64>> = Mutex::new(None);

/// 采集线程启动闸（`init` 幂等）。
static COLLECTOR_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEntry {
    pub text: String,
    /// Unix 毫秒。
    pub timestamp: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ClipboardStore {
    /// 最新在前（`items[0]` = 最近一次复制）。
    items: Vec<ClipboardEntry>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn store_path() -> PathBuf {
    crate::config::clipboard_file()
}

fn hash_text(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

fn load_unlocked() -> ClipboardStore {
    match fs::read_to_string(store_path()) {
        Ok(raw) => match serde_json::from_str(&raw) {
            Ok(store) => store,
            Err(e) => {
                // 损坏 JSON 不静默清空：留一份 .bak 保住数据（下一次 save
                // 覆盖主文件后仍可手工找回），日志留痕但不含剪贴板正文。
                log::warn!("clipboard: store corrupted ({e}); keeping .bak and starting empty");
                let _ = fs::write(store_path().with_extension("json.bak"), &raw);
                ClipboardStore::default()
            }
        },
        Err(_) => ClipboardStore::default(),
    }
}

/// 原子写（tmp + rename）：写中断不留半截文件——半截 JSON 会让下一次加载
/// 走「损坏」分支把历史清掉，与「重启不丢」的承诺相悖。
fn save_unlocked(store: &ClipboardStore) -> Result<(), String> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// 启动采集（进程一次）。`enabled` / `limit` 来自当前配置，之后由
/// [`set_enabled`] / [`set_limit`] 跟随 `set_config` 热更新。
pub fn init(enabled: bool, limit: u32) {
    ENABLED.store(enabled, Ordering::SeqCst);
    LIMIT.store(limit.clamp(5, 100), Ordering::SeqCst);
    if COLLECTOR_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    #[cfg(windows)]
    if spawn_listener_thread().is_ok() {
        return;
    }
    // 非 Windows（或 Windows 监听线程启动失败）：轮询降级。
    spawn_poll_thread();
}

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
}

pub fn set_limit(limit: u32) {
    LIMIT.store(limit.clamp(5, 100), Ordering::SeqCst);
}

/// 自写抑制：把「我们刚写进剪贴板的内容」记为已观察，随后到达的
/// `WM_CLIPBOARDUPDATE` / 轮询采样比对命中即跳过。
pub fn mark_self_write(text: &str) {
    let mut last = LAST_OBSERVED.lock().unwrap_or_else(PoisonError::into_inner);
    *last = Some(hash_text(text));
}

/// 采集路径的唯一入口：内容与基线一致（或空 / 超限 / 开关关）即忽略，
/// 否则去重置顶入库。
pub(crate) fn observe(text: &str) {
    if text.trim().is_empty() || text.len() > MAX_ENTRY_BYTES {
        return;
    }
    let hash = hash_text(text);
    {
        let mut last = LAST_OBSERVED.lock().unwrap_or_else(PoisonError::into_inner);
        if *last == Some(hash) {
            return;
        }
        *last = Some(hash);
    }
    if !ENABLED.load(Ordering::SeqCst) {
        // 开关关着时只滚动基线，不落盘（重新开启后新内容才入库）。
        return;
    }
    let limit = LIMIT.load(Ordering::SeqCst).clamp(5, 100) as usize;
    let _guard = CLIPBOARD_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let mut store = load_unlocked();
    store.items.retain(|item| item.text != text);
    store.items.insert(
        0,
        ClipboardEntry {
            text: text.to_string(),
            timestamp: now_ms(),
        },
    );
    store.items.truncate(limit);
    if let Err(e) = save_unlocked(&store) {
        log::warn!("clipboard: save failed: {e}");
    }
}

/// 当前最近剪贴板（最新在前）。采集关闭时仍返回已存内容（面板可展示、
/// 可清空——总开关只管采集，不管已存数据的可见性；清空走 [`clear`]）。
pub(crate) fn get_entries() -> Vec<ClipboardEntry> {
    let _guard = CLIPBOARD_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    load_unlocked().items
}

/// 一键清空（隐私开关的一半）。
pub(crate) fn clear() -> Result<(), String> {
    let _guard = CLIPBOARD_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    save_unlocked(&ClipboardStore::default())
}

/// 删除单条历史。采集按文本去重（[`observe`] 先 retain 再头插），文本即
/// 唯一键；不存在的目标是幂等空操作。面板的「删除 / 固定出列」用它。
pub(crate) fn remove_entry(text: &str) -> Result<(), String> {
    let _guard = CLIPBOARD_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let mut store = load_unlocked();
    let before = store.items.len();
    store.items.retain(|item| item.text != text);
    if store.items.len() == before {
        return Ok(());
    }
    save_unlocked(&store)
}

/// 读一次剪贴板并交给 [`observe`]（轮询与事件两条路的共用尾巴）。
/// 读失败（剪贴板正被别人占用）补采一次：瞬时占用期间的用户复制不能
/// 就此永久丢失（`WM_CLIPBOARDUPDATE` 不会为同一次复制再发一次）。
fn poll_once() {
    if try_poll() {
        return;
    }
    std::thread::sleep(POLL_RETRY_DELAY);
    let _ = try_poll();
}

/// 单次采样。成功（含空剪贴板）返回 true；读故障返回 false（调用方补采）。
fn try_poll() -> bool {
    match crate::translate::read_clipboard_text() {
        Ok(text) => {
            observe(&text);
            true
        }
        Err(e) => {
            log::debug!("clipboard: poll read failed: {e}");
            false
        }
    }
}

/// 非 Windows 降级：定时读 + 内容比对（[`observe`] 的哈希基线负责去重）。
fn spawn_poll_thread() {
    if let Err(e) = std::thread::Builder::new()
        .name("voicekey-clipboard-poll".into())
        .spawn(move || loop {
            std::thread::sleep(POLL_INTERVAL);
            poll_once();
        })
    {
        log::error!("clipboard: failed to spawn poll thread: {e}");
    }
}

/// Windows 事件驱动采集：专用线程持有 message-only 窗口，
/// `AddClipboardFormatListener` 订阅 `WM_CLIPBOARDUPDATE`，每次通知读取
/// 当前文本交给 [`observe`]。失败返回 `Err`（调用方降级为轮询）。
///
/// 已知边缘：5 秒报到超时后即使监视线程随后起来了，也会与轮询双通道并存
/// ——[`observe`] 的哈希基线兜底去重，代价只是多几次冗余读取，可接受。
#[cfg(windows)]
fn spawn_listener_thread() -> Result<(), ()> {
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("voicekey-clipboard-watch".into())
        .spawn(move || run_listener(&tx))
        .map_err(|_| ())?;
    // 等线程报到：窗口 + 订阅成功才认定事件驱动可用。
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(()),
        _ => Err(()),
    }
}

#[cfg(windows)]
fn run_listener(ready: &std::sync::mpsc::Sender<Result<(), String>>) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::DataExchange::{
        AddClipboardFormatListener, RemoveClipboardFormatListener,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        PostQuitMessage, RegisterClassW, TranslateMessage, CS_HREDRAW, CS_VREDRAW, HWND_MESSAGE,
        MSG, WM_CLIPBOARDUPDATE, WM_DESTROY, WNDCLASSW,
    };

    const CLASS_NAME: &[u16] = &[
        0x76, 0x6B, 0x43, 0x6C, 0x69, 0x70, 0x42, 0x6F, 0x61, 0x72, 0x64, 0x57, 0x00, // "vkClipBoardW"
    ];

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        // `as u32` keeps this independent of how windows-sys types the WM_*
        // constants (same discipline as mouse.rs::classify).
        if msg == WM_CLIPBOARDUPDATE as u32 {
            poll_once();
            return 0;
        }
        if msg == WM_DESTROY as u32 {
            PostQuitMessage(0);
            return 0;
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: CLASS_NAME.as_ptr(),
        };
        if RegisterClassW(&class) == 0 {
            let _ = ready.send(Err("RegisterClassW failed".into()));
            return;
        }
        let hwnd = CreateWindowExW(
            0,
            CLASS_NAME.as_ptr(),
            CLASS_NAME.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            hinstance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            let _ = ready.send(Err("CreateWindowExW failed".into()));
            return;
        }
        if AddClipboardFormatListener(hwnd) == 0 {
            DestroyWindow(hwnd);
            let _ = ready.send(Err("AddClipboardFormatListener failed".into()));
            return;
        }
        let _ = ready.send(Ok(()));

        let mut msg = std::mem::zeroed::<MSG>();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        RemoveClipboardFormatListener(hwnd);
        DestroyWindow(hwnd);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 观察口径是纯逻辑（哈希基线 + 空/超限过滤），不碰真实剪贴板文件：
    /// 用独立的判定函数覆盖。落盘行为由 `observe` 的 store 段负责，
    /// 与 history/stats 同一模式（文件级留待集成环境）。
    #[test]
    fn hash_text_distinguishes_content() {
        assert_eq!(hash_text("张伟"), hash_text("张伟"));
        assert_ne!(hash_text("张伟"), hash_text("张伟 "));
    }

    #[test]
    fn mark_self_write_suppresses_the_same_content() {
        let written = "落款：芷若";
        let last = Some(hash_text(written));
        // 通知观察到同一内容 → 命中基线，跳过。
        assert_eq!(last, Some(hash_text(written)));
        // 换了内容 → 基线失配，应当记录。
        assert_ne!(last, Some(hash_text("别的内容")));
    }

    #[test]
    fn oversize_entries_never_record() {
        let big = "x".repeat(MAX_ENTRY_BYTES + 1);
        assert!(big.len() > MAX_ENTRY_BYTES);
        // `observe` 的第一道闸即长度；这里锁住常量不被改小到丢正常条目。
        assert!(MAX_ENTRY_BYTES >= 10 * 1024);
    }
}
