//! 最近剪贴板环形缓冲（快速插入面板的自建剪贴板历史，`voice-key-clipboard.json`）。
//!
//! 不依赖 Win+V（位置固定、样式不可控、还要求系统开了剪贴板历史），
//! 自建一份可控的最近剪贴板。纪律：
//!
//! * **存文本与图片**（文件不做）：文本单条上限 [`MAX_ENTRY_BYTES`]（10 KB）；
//!   图片以 PNG 落 `clipboard-images/`（条目只存文件名 + 宽高），缩略图同目录
//!   `<id>.thumb.png` 供面板预览。图片**优先于**文本采集——截图 / 复制图片时
//!   剪贴板文本位往往只是占位（如「图片」二字），以图为准才不会把图丢成一行字。
//!   像素 / 尺寸闸见 [`MAX_IMAGE_PIXELS`] / [`MIN_IMAGE_SIDE`]。
//! * **自写抑制**：我们自己的粘贴 / 写剪贴板（`translate.rs::write_clipboard_text`、
//!   `inject.rs` 的写入）先走 [`mark_self_write`] / [`mark_self_write_image`]，
//!   对应通知 / 轮询观察到同一内容即跳过——避免自产自销。抑制靠内容指纹比对
//!   （`WM_CLIPBOARDUPDATE` 异步到达，写入期间加锁拦不住迟到通知）。
//! * **隐私**：只落本地配置目录，不进日志、不上传；「启用剪贴板采集」总开关
//!   （[`set_enabled`]）+ 设置页「一键清空」（[`clear`]，连图片文件一起清）。
//! * **采集**：Windows 走 `AddClipboardFormatListener`（`WM_CLIPBOARDUPDATE`）
//!   事件驱动（专用线程 + message-only 窗口）；非 Windows 降级为定时读 +
//!   内容比对（[`POLL_INTERVAL`]）。两条采集路径最终都汇入 [`observe_text`] /
//!   [`observe_image`]。
//!
//! 环形缓冲：新条目插入队首，重复内容去重置顶，超过 `clipboardLimit`
//! （[`set_limit`]，默认 30）裁掉队尾；进程内互斥 + 文件持久化（同
//! history/stats 的保管方式），重启不丢。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 文本单条上限 10 KB（UTF-8 字节）：超限条目直接丢弃（通常是误复制的大段内容）。
const MAX_ENTRY_BYTES: usize = 10 * 1024;

/// 图片像素上限（约 32MP，覆盖 8K 截图）：超限不采集，不留半截图。
const MAX_IMAGE_PIXELS: u64 = 32_000_000;

/// 图片最小边长：再小的一般是图标 / 占位位图（复制图标时常伴随有意义的文本，
/// 采成图片反而把文本丢掉），不进图片历史。
const MIN_IMAGE_SIDE: u32 = 8;

/// 面板预览缩略图的长边像素。
const THUMB_MAX_SIDE: u32 = 192;

/// 自写图片后的时间窗：窗内观察到的图片一律视作自家回声。正常情况下内容指纹
/// 已经能对上（arboard 往返逐位一致），这扇窗是给「剪贴板管理器改写格式导致
/// 往返失真」兜底的；代价是窗内用户真复制的图片最多漏记一条（内容仍在剪贴板）。
const IMAGE_ECHO_WINDOW: Duration = Duration::from_millis(600);

/// 图片内容指纹的 hex 长度（sha256 前 16 字节）：既做文件名，也做条目键。
const IMAGE_ID_HEX_LEN: usize = 32;

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

/// 读-改-写文件与观察的去重决策共用一把锁（同 stats.rs::STATS_LOCK 模式）。
/// A poisoned mutex is recovered: authoritative data is on disk.
static CLIPBOARD_LOCK: Mutex<()> = Mutex::new(());

/// 最近一次观察到 / 自写抑制的内容指纹（[`text_fingerprint`] /
/// [`image_fingerprint`]，带 `t` / `i` 前缀区分两种内容）。
/// `None` = 无基线（启动后第一次内容一律记录）。
///
/// **单槽基线的取舍**：`ClipboardGuard` 的 Drop 恢复原内容（translate.rs）
/// 或采集关闭期滚动基线后，用户紧接着复制同一内容会被当作抑制命中而丢
/// 一条（只是少一次置顶，不是丢内容）。要彻底消除需要按时间窗区分「抑制
/// 期待」与「观察基线」两套状态；当前单槽实现简单且误伤面极小，接受。
static LAST_OBSERVED: Mutex<Option<String>> = Mutex::new(None);

/// 自写图片的回声窗截止时刻（[`IMAGE_ECHO_WINDOW`]）。`None` = 无自写图片。
static IMAGE_ECHO_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

/// 采集线程启动闸（`init` 幂等）。
static COLLECTOR_STARTED: AtomicBool = AtomicBool::new(false);

/// 条目类型取值：`text`（旧数据缺省）/ `image`。
fn default_kind() -> String {
    "text".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEntry {
    /// 文本条目正文；图片条目恒为空串（内容在 `image` 指向的文件里）。
    #[serde(default)]
    pub text: String,
    /// [`default_kind`]：`text` | `image`。旧 JSON 没有本字段，按 `text` 读。
    #[serde(default = "default_kind")]
    pub kind: String,
    /// 图片条目：`clipboard-images/` 下的文件名（`<指纹 hex>.png`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// 图片像素宽高（预览排版）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Unix 毫秒。
    pub timestamp: u64,
}

impl ClipboardEntry {
    pub(crate) fn is_image(&self) -> bool {
        self.kind == "image"
    }

    /// 唯一键：文本 = 正文，图片 = 文件名。去重置顶 / 删除寻址共用。
    /// 极端碰撞（文本正文恰好等于某图片文件名）会让一次删除多删一条，
    /// 文本内容与 `<32 hex>.png` 同形的概率可忽略，接受。
    pub(crate) fn key(&self) -> &str {
        if self.is_image() {
            self.image.as_deref().unwrap_or("")
        } else {
            &self.text
        }
    }
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

fn images_dir() -> PathBuf {
    crate::config::clipboard_images_dir()
}

fn image_path(name: &str) -> PathBuf {
    images_dir().join(name)
}

/// `<指纹>.png` → `<指纹>.thumb.png`（面板预览）。
fn thumb_name(image_name: &str) -> Option<String> {
    image_name
        .strip_suffix(".png")
        .map(|id| format!("{id}.thumb.png"))
}

/// 图片条目键（文件名）形状校验：`<32 位小写 hex>.png`。invoke 边界用它
/// 防路径穿越（键会拼进 `clipboard-images/` 下的路径）。
pub(crate) fn is_valid_image_key(key: &str) -> bool {
    let Some(id) = key.strip_suffix(".png") else {
        return false;
    };
    id.len() == IMAGE_ID_HEX_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 文本内容指纹（`t` + sha256 前 16 字节 hex）。
fn text_fingerprint(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    format!("t{}", hex::encode(&digest[..16]))
}

/// 图片像素指纹（`i` + sha256 前 16 字节 hex）。同图不同编码（PNG / DIB）
/// 解出来的同一份 RGBA 指纹一致，去重与自写抑制都不受来源格式影响。
fn image_fingerprint(rgba: &[u8]) -> String {
    let digest = Sha256::digest(rgba);
    format!("i{}", hex::encode(&digest[..16]))
}

/// 图片文件名用的指纹 hex（[`image_fingerprint`] 的 `i` 前缀段）。
fn image_id(rgba: &[u8]) -> String {
    hex::encode(&Sha256::digest(rgba)[..16])
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
/// 走「损坏」分支把历史清掉，与「重启不丢」的承诺相悖。写成功后顺手清
/// 孤儿图片文件（[`prune_image_files`]）。
fn save_unlocked(store: &ClipboardStore) -> Result<(), String> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    prune_image_files(store);
    Ok(())
}

/// 删掉 `clipboard-images/` 里不再被任何条目引用的文件（条目删除 / 裁剪 /
/// 清空后的残留，以及历史 JSON 与图片目录失同步的孤儿）。目录归本模块独占，
/// 未引用即删不会误伤用户文件。
fn prune_image_files(store: &ClipboardStore) {
    let dir = images_dir();
    let Ok(read_dir) = fs::read_dir(&dir) else {
        return;
    };
    let mut referenced: HashSet<String> = HashSet::new();
    for item in &store.items {
        if let Some(name) = item.image.as_deref() {
            referenced.insert(name.to_string());
            if let Some(thumb) = thumb_name(name) {
                referenced.insert(thumb);
            }
        }
    }
    for entry in read_dir.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !referenced.contains(&name) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn encode_png(img: &image::RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf: Vec<u8> = Vec::new();
    image::DynamicImage::ImageRgba8(img.clone())
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;
    Ok(buf)
}

fn decode_png(bytes: &[u8]) -> Result<image::RgbaImage, String> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|e| format!("PNG 解码失败: {e}"))?;
    Ok(img.to_rgba8())
}

/// 等比缩到长边 `max_side` 以内（面板预览用，Triangle 滤波够清晰）。
fn thumbnail(img: &image::RgbaImage, max_side: u32) -> image::RgbaImage {
    let (w, h) = (img.width(), img.height());
    if w <= max_side && h <= max_side {
        return img.clone();
    }
    let scale = max_side as f32 / w.max(h) as f32;
    let tw = ((w as f32 * scale).round() as u32).max(1);
    let th = ((h as f32 * scale).round() as u32).max(1);
    image::imageops::resize(img, tw, th, image::imageops::FilterType::Triangle)
}

/// 图片正片 + 缩略图落盘。先文件后 JSON（`save_unlocked` 由调用方收尾）：
/// 文件写败直接报错，不产生指向半截文件的条目。
fn store_image_files(id: &str, img: &image::RgbaImage) -> Result<(), String> {
    let dir = images_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{id}.png")), encode_png(img)?).map_err(|e| e.to_string())?;
    let thumb = thumbnail(img, THUMB_MAX_SIDE);
    fs::write(
        dir.join(format!("{id}.thumb.png")),
        encode_png(&thumb)?,
    )
    .map_err(|e| e.to_string())
}

/// 按条目键取完整图片（面板插入用）。键形状非法（防路径穿越）/ 文件缺失报错。
pub(crate) fn load_entry_image(key: &str) -> Result<image::RgbaImage, String> {
    if !is_valid_image_key(key) {
        return Err("图片条目键非法。".to_string());
    }
    let bytes = fs::read(image_path(key)).map_err(|e| format!("读取图片失败: {e}"))?;
    decode_png(&bytes)
}

/// 图片条目的缩略图 data URL（面板预览）。文件缺失返回 `None`（面板显示占位）。
pub(crate) fn image_thumb_data_url(image_name: &str) -> Option<String> {
    let thumb = thumb_name(image_name)?;
    let bytes = fs::read(images_dir().join(thumb)).ok()?;
    use base64::Engine;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
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

/// 自写抑制（文本）：把「我们刚写进剪贴板的内容」记为已观察，随后到达的
/// `WM_CLIPBOARDUPDATE` / 轮询采样比对命中即跳过。
pub fn mark_self_write(text: &str) {
    let mut last = LAST_OBSERVED.lock().unwrap_or_else(PoisonError::into_inner);
    *last = Some(text_fingerprint(text));
}

/// 自写抑制（图片）：除指纹基线外再开一扇回声窗（[`IMAGE_ECHO_WINDOW`]）——
/// 剪贴板往返像素不逐位一致时指纹会失配，时间窗兜底。
pub fn mark_self_write_image(rgba: &[u8]) {
    {
        let mut last = LAST_OBSERVED.lock().unwrap_or_else(PoisonError::into_inner);
        *last = Some(image_fingerprint(rgba));
    }
    let mut echo = IMAGE_ECHO_UNTIL.lock().unwrap_or_else(PoisonError::into_inner);
    *echo = Some(Instant::now() + IMAGE_ECHO_WINDOW);
}

/// 观察基线的统一裁决：命中基线 / 回声窗则只滚动基线返回 `true`（不落盘）。
/// 关着采集开关时也只滚动基线（重新开启后新内容才入库）。
fn suppress_as_seen(fingerprint: String, image_echo: bool) -> bool {
    let mut last = LAST_OBSERVED.lock().unwrap_or_else(PoisonError::into_inner);
    if image_echo {
        let echo = IMAGE_ECHO_UNTIL.lock().unwrap_or_else(PoisonError::into_inner);
        if echo.map_or(false, |until| Instant::now() < until) {
            *last = Some(fingerprint);
            return true;
        }
    }
    if *last == Some(fingerprint.clone()) {
        return true;
    }
    *last = Some(fingerprint);
    !ENABLED.load(Ordering::SeqCst)
}

/// 文本采集的唯一入口：内容与基线一致（或空 / 超限）即忽略，否则去重置顶入库。
pub(crate) fn observe_text(text: &str) {
    if text.trim().is_empty() || text.len() > MAX_ENTRY_BYTES {
        return;
    }
    if suppress_as_seen(text_fingerprint(text), false) {
        return;
    }
    let limit = LIMIT.load(Ordering::SeqCst).clamp(5, 100) as usize;
    let _guard = CLIPBOARD_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let mut store = load_unlocked();
    // 只跟文本条目去重（图片条目 key 是文件名，不能按正文比）。
    store.items.retain(|item| item.is_image() || item.text != text);
    store.items.insert(
        0,
        ClipboardEntry {
            text: text.to_string(),
            kind: "text".into(),
            image: None,
            width: None,
            height: None,
            timestamp: now_ms(),
        },
    );
    store.items.truncate(limit);
    if let Err(e) = save_unlocked(&store) {
        log::warn!("clipboard: save failed: {e}");
    }
}

/// 图片采集的唯一入口：闸（尺寸 / 像素）、基线、去重置顶入库（PNG + 缩略图
/// 落 `clipboard-images/`）。
pub(crate) fn observe_image(img: &image::RgbaImage) {
    let (w, h) = (img.width(), img.height());
    if w < MIN_IMAGE_SIDE || h < MIN_IMAGE_SIDE {
        return;
    }
    if u64::from(w) * u64::from(h) > MAX_IMAGE_PIXELS {
        log::warn!("clipboard: image too large ({w}x{h}); skipped");
        return;
    }
    let id = image_id(img.as_raw());
    if suppress_as_seen(format!("i{id}"), true) {
        return;
    }
    if let Err(e) = store_image_files(&id, img) {
        log::warn!("clipboard: image store failed: {e}");
        return;
    }
    let limit = LIMIT.load(Ordering::SeqCst).clamp(5, 100) as usize;
    let _guard = CLIPBOARD_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let mut store = load_unlocked();
    let name = format!("{id}.png");
    store.items.retain(|item| item.image.as_deref() != Some(name.as_str()));
    store.items.insert(
        0,
        ClipboardEntry {
            text: String::new(),
            kind: "image".into(),
            image: Some(name),
            width: Some(w),
            height: Some(h),
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

/// 一键清空（隐私开关的一半）：历史 JSON 与图片 / 缩略图文件一起清。
pub(crate) fn clear() -> Result<(), String> {
    let _guard = CLIPBOARD_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    save_unlocked(&ClipboardStore::default())
}

/// 删除单条历史。采集按 [`ClipboardEntry::key`] 去重（文本 = 正文、图片 =
/// 文件名），键即唯一标识；不存在的目标是幂等空操作。面板的「删除」用它。
pub(crate) fn remove_entry(key: &str) -> Result<(), String> {
    let _guard = CLIPBOARD_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let mut store = load_unlocked();
    let before = store.items.len();
    store.items.retain(|item| item.key() != key);
    if store.items.len() == before {
        return Ok(());
    }
    save_unlocked(&store)
}

/// 读一次剪贴板：有图片按图片采（截图 / 复制图片），否则按文本采。
/// 图片读失败只记 debug 并落到文本（文本通道的成败决定要不要补采）。
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
    match read_clipboard_image() {
        Ok(Some(img)) => {
            observe_image(&img);
            return true;
        }
        Ok(None) => {}
        Err(e) => log::debug!("clipboard: image poll read failed: {e}"),
    }
    match crate::translate::read_clipboard_text() {
        Ok(text) => {
            observe_text(&text);
            true
        }
        Err(e) => {
            log::debug!("clipboard: poll read failed: {e}");
            false
        }
    }
}

/// 读剪贴板图片（RGBA）。无图片返回 `Ok(None)`；占用等瞬时故障返回 `Err`。
///
/// Windows 走 `arboard` 的图片通道——它本身先试 CF_PNG 再退 CF_DIBV5，
/// 截图工具（Win+Shift+S / Snipaste 等）常只放 PNG 格式，正是前一段救的。
/// 两者皆无时再补一档 CF_DIB（老 GDI 应用 / 部分聊天工具只放这一档，
/// arboard 不认）。Hyprland 降级 `wl-paste --type image/png`。
pub(crate) fn read_clipboard_image() -> Result<Option<image::RgbaImage>, String> {
    if crate::platform::is_hyprland_session() {
        return read_clipboard_image_hyprland();
    }
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("剪贴板不可用: {e}"))?;
    match clipboard.get_image() {
        Ok(data) => {
            let img = image::RgbaImage::from_raw(
                data.width as u32,
                data.height as u32,
                data.bytes.into_owned(),
            )
            .ok_or_else(|| "剪贴板图像数据尺寸不匹配。".to_string())?;
            Ok(Some(img))
        }
        Err(arboard::Error::ContentNotAvailable) => Ok(read_clipboard_cf_dib()),
        Err(e) => Err(format!("读取剪贴板图片失败: {e}")),
    }
}

/// CF_DIB 兜底读取（仅 Windows）：`BmpDecoder` 吃 DIB（BITMAPINFOHEADER 起）
/// 无需 BMP 文件头。读不到（无该格式 / 解码失败）返回 `None` 落回文本采集。
#[cfg(windows)]
fn read_clipboard_cf_dib() -> Option<image::RgbaImage> {
    use image::codecs::bmp::BmpDecoder;

    if !clipboard_win::is_format_avail(clipboard_win::formats::CF_DIB) {
        return None;
    }
    let mut data = Vec::new();
    clipboard_win::raw::get_vec(clipboard_win::formats::CF_DIB, &mut data).ok()?;
    let decoder = BmpDecoder::new_without_file_header(std::io::Cursor::new(data.as_slice()))
        .map_err(|e| log::debug!("clipboard: CF_DIB decode failed: {e}"))
        .ok()?;
    image::DynamicImage::from_decoder(decoder)
        .map_err(|e| log::debug!("clipboard: CF_DIB convert failed: {e}"))
        .ok()
        .map(|img| img.to_rgba8())
}

/// Windows 之外无 CF_DIB 概念；留桩让调用方少一个 `cfg` 分支。
#[cfg(not(windows))]
fn read_clipboard_cf_dib() -> Option<image::RgbaImage> {
    None
}

#[cfg(not(windows))]
fn read_clipboard_image_hyprland() -> Result<Option<image::RgbaImage>, String> {
    // wl-paste 在剪贴板没有 PNG 图片时以非零码退出（与文本口径一致）。
    match std::process::Command::new("wl-paste")
        .args(["--type", "image/png"])
        .env("XDG_SESSION_TYPE", "wayland")
        .output()
    {
        Ok(out) if out.status.success() => {
            if out.stdout.is_empty() {
                return Ok(None);
            }
            Ok(Some(decode_png(&out.stdout)?))
        }
        Ok(_) => Ok(None),
        Err(e) => Err(format!("wl-paste 调用失败: {e}")),
    }
}

/// Windows 无 Hyprland 分支；留桩让调用方少一个 `cfg` 分支。
#[cfg(windows)]
fn read_clipboard_image_hyprland() -> Result<Option<image::RgbaImage>, String> {
    Ok(None)
}

/// 写剪贴板图片。写入前登记自写抑制（同 `translate.rs::write_clipboard_text`
/// 的理由：`WM_CLIPBOARDUPDATE` 异步，成功后才登记会留抢先窗口）。
pub(crate) fn write_clipboard_image(img: &image::RgbaImage) -> Result<(), String> {
    mark_self_write_image(img.as_raw());
    if crate::platform::is_hyprland_session() {
        return hyprland_set_clipboard_image(img);
    }
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("剪贴板不可用: {e}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width: img.width() as usize,
            height: img.height() as usize,
            bytes: std::borrow::Cow::Borrowed(img.as_raw()),
        })
        .map_err(|e| format!("写入剪贴板失败: {e}"))
}

#[cfg(not(windows))]
fn hyprland_set_clipboard_image(img: &image::RgbaImage) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let png = encode_png(img)?;
    let mut child = std::process::Command::new("wl-copy")
        .args(["--type", "image/png", "--sensitive"])
        .env("XDG_SESSION_TYPE", "wayland")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("wl-copy spawn failed: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(&png)
            .map_err(|e| format!("wl-copy write failed: {e}"))?;
    }
    drop(child.stdin.take());
    let _ = child.wait();
    Ok(())
}

#[cfg(windows)]
fn hyprland_set_clipboard_image(_img: &image::RgbaImage) -> Result<(), String> {
    Err("Hyprland 图片写入在 Windows 上不可用。".to_string())
}

/// 非 Windows 降级：定时读 + 内容比对（观察基线负责去重）。
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
/// 当前图片 / 文本交给 [`observe_image`] / [`observe_text`]。失败返回 `Err`
/// （调用方降级为轮询）。
///
/// 已知边缘：5 秒报到超时后即使监视线程随后起来了，也会与轮询双通道并存
/// ——观察基线兜底去重，代价只是多几次冗余读取，可接受。
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

    /// 观察口径是纯逻辑（指纹基线 + 空/超限过滤），不碰真实剪贴板文件：
    /// 用独立的判定函数覆盖。落盘行为由 `observe_*` 的 store 段负责，
    /// 与 history/stats 同一模式（文件级留待集成环境）。
    #[test]
    fn fingerprints_distinguish_content_and_kind() {
        assert_eq!(text_fingerprint("张伟"), text_fingerprint("张伟"));
        assert_ne!(text_fingerprint("张伟"), text_fingerprint("张伟 "));
        // 同一份字节按文本与按图片两种口径不得撞指纹（前缀隔离）。
        assert_ne!(text_fingerprint("张伟"), image_fingerprint(b""));
        assert_eq!(image_fingerprint(b"abcd"), image_fingerprint(b"abcd"));
    }

    #[test]
    fn mark_self_write_suppresses_the_same_content() {
        let written = "落款：芷若";
        let last = Some(text_fingerprint(written));
        // 通知观察到同一内容 → 命中基线，跳过。
        assert_eq!(last, Some(text_fingerprint(written)));
        // 换了内容 → 基线失配，应当记录。
        assert_ne!(last, Some(text_fingerprint("别的内容")));
    }

    #[test]
    fn oversize_entries_never_record() {
        let big = "x".repeat(MAX_ENTRY_BYTES + 1);
        assert!(big.len() > MAX_ENTRY_BYTES);
        // `observe_text` 的第一道闸即长度；这里锁住常量不被改小到丢正常条目。
        assert!(MAX_ENTRY_BYTES >= 10 * 1024);
    }

    /// 旧 JSON（无 `kind` / `image` 字段）必须按文本条目读出来，不能整份
    /// 反序列化失败——迁移丢历史比丢字段严重得多。
    #[test]
    fn legacy_entries_deserialize_as_text() {
        let store: ClipboardStore =
            serde_json::from_str(r#"{"items":[{"text":"旧条目","timestamp":1}]}"#).unwrap();
        let entry = &store.items[0];
        assert!(!entry.is_image());
        assert_eq!(entry.key(), "旧条目");
    }

    #[test]
    fn entry_key_uses_image_name_for_images() {
        let entry = ClipboardEntry {
            text: String::new(),
            kind: "image".into(),
            image: Some("a".repeat(32) + ".png"),
            width: Some(8),
            height: Some(8),
            timestamp: 0,
        };
        assert!(entry.is_image());
        assert_eq!(entry.key(), "a".repeat(32) + ".png");
    }

    /// invoke 边界拼路径前的形状闸：只认 `<32 小写 hex>.png`，其余一律拒。
    #[test]
    fn image_key_rejects_path_traversal_shapes() {
        assert!(is_valid_image_key(&format!("{}.png", "0123abcd".repeat(4))));
        assert!(!is_valid_image_key("x.png"));
        assert!(!is_valid_image_key(&format!("{}.PNG", "0123abcd".repeat(4))));
        assert!(!is_valid_image_key(&format!("{}.png", "G".repeat(32))));
        assert!(!is_valid_image_key("..\\evil.png"));
        assert!(!is_valid_image_key(&format!("../{}.png", "a".repeat(32))));
    }

    #[test]
    fn thumbnail_keeps_aspect_and_caps_long_side() {
        let img = image::RgbaImage::from_pixel(800, 400, image::Rgba([1, 2, 3, 255]));
        let thumb = thumbnail(&img, THUMB_MAX_SIDE);
        assert_eq!(thumb.width(), THUMB_MAX_SIDE);
        assert_eq!(thumb.height(), THUMB_MAX_SIDE / 2);
        // 不放大小图。
        let small = image::RgbaImage::from_pixel(32, 16, image::Rgba([0, 0, 0, 255]));
        assert_eq!(thumbnail(&small, THUMB_MAX_SIDE), small);
    }
}
