# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [0.17.0](https://github.com/DaweiTian/zhiruo/compare/v0.16.0...v0.17.0) (2026-11-24)

快插面板页签化改版：剪贴板 / 常用词分页签呈现，配一轮 UI 与动效打磨。

### Features

- **picker:** 顶部页签切换「剪贴板 / 常用词」（默认剪贴板页签，←/→ 可切换），
  单页签独占列表区——常用词再多也不会把剪贴板顶出可视区；落点决定初始页签
  （X1 → 常用词 / X2 → 剪贴板 / both = 默认剪贴板），目标页签为空退到有货页签
- **picker:** 面板 UI 与动效改版——段控滑块页签 + 条目数角标、卡片每次打开淡入
  放大、页签内容按切换方向滑入、条目错峰入场、动作按钮 hover / 选中时淡入、
  空状态图标化；`prefers-reduced-motion` 一律门禁
- **website:** 中英两页页脚补备案信息（ICP / 公安）并接入备案图标

### Notes

- `picker-update` 载荷新增 `gen`（打开代际）：渲染层据此区分面板重开（重播入场
  动画）与同代数据刷新（删除 / 固定触发，不重播）
- 设置项侧键落点「全部显示」文案改为「默认页签（剪贴板）」（`both` 取值不变）
- 设计文档归拢到 `docs/`（`功能方案设计.md` / `DESIGN.md`），代码注释引用同步

## [0.16.0](https://github.com/DaweiTian/zhiruo/compare/v0.15.0...v0.16.0) (2026-11-20)

快速插入面板两处体验优化：宽度可自定义且持久记忆，时间标签让位正文宽度。

### Features

- **picker:** 面板右缘拖拽把手自定义宽度（240–720 夹取），拖动中只调形、松手
  持久化到 `picker.panelWidth`，每次打开按记忆宽度弹出；贴屏边拖宽被工作区限住
  是当场几何限制，不污染记忆值
- **picker:** 最近剪贴板条目的相对时间标签（「N 分钟前」）从正文右侧移到条目
  底部自成一行，正文独占整行宽度

### Notes

- 配置新增 `picker.panelWidth`（旧配置缺键自动取默认 320，无迁移成本）；面板
  高度仍固定 380

## [0.15.0](https://github.com/DaweiTian/zhiruo/compare/v0.14.0...v0.15.0) (2026-11-18)

全库横切审计（安全隐私 / 跨模块交互 / 一致性三路，4 HIGH / 10 MEDIUM / 11 LOW）的
修复与加固版本，无新功能。

### Bug Fixes

- **session:** 并发双 stop 竞态——败者拿到 `ERR_NOT_RECORDING` 改静默，不再把胜者
  还在 Processing 的会话强制置 Idle（watchdog 同款约定补到主路径）；「取消」对
  处理中的会话此前实际无效（在途转写回来照常注入），现加取消标记 + 注入前 / 收尾前
  双闸拦截，迟到错误也抑制
- **stats:** `countCharacters` 与 Rust `char::is_whitespace` 在 U+0085 / U+FEFF 两个
  码点上分类相反，同文本字符数会漂移——TS 改 Rust White_Space 白名单口径，双端
  对拍用例锁定
- **security:** 事件定向分发（新增 `events.rs`）——`app.emit` 广播此前把转写全文 /
  最近剪贴板条目 / 选区预览送到全部 6 个窗口，现按事件路由到目标窗口；capability
  移除渲染层未用的 clipboard-manager / dialog / global-shortcut 权限；`refine_text`
  / `translate_text` / `copy_text` / `send_error` 补尺寸护栏；注入前剥控制字符
  （ESC 序列进终端是注入面）
- **config:** `userGlossary` 补宽容加载（`de_lenient_*`）——手改出坏条目此前会让整份
  配置反序列化失败、静默清空 API key；`translateOutput` 缺键默认改 false（与
  `Default` / 渲染层常量三方一致，老配置不再被静默打开翻译输出）；`app.language`
  合并补 32 字上限；`HistoryManager` 补进程级锁（add / delete / clear 并发丢写）
- **refine:** 词表段语义改「保留原样」与热词段「发音相近纠正」区分（此前两段近乎
  重复），同词条两段去重；风格段显式声明放松最小修改规则的措辞 / 语序限制（此前
  与 base 的 mandatory 规则直接打架）
- **settings:** 语言单独保存失败后 `isAppPreferencesDirty` 不认账、永不再重试——
  dirty 判定纳入 language；`mergeConfigPatch` 补 inject 段；目标语言 Select 兜底
  归一旧值 `English`、占位文案 i18n 化；LLM 默认连接与目标语言默认值双端对齐
  （mimo / 'english'）
- **hud:** 卸载清理补 `setOverlayHoverGrab(false)`（硬故障重建后整窗可能卡在可交互）
- **translate:** 选区原文改粘贴成功后才写史（失败不再留「已替换」孤条目）；渲染层
  全局错误日志截断到 200 字符（reason 可能夹带转写片段）

### Notes

- 根 README（中英）构建依赖 / 项目结构 / 贡献指南三段重写为 Tauri 现状（中文版
  顺带移除本地识别模型残段）；`tauri.conf.json` 的 `plugins.shell.open` 收紧为
  false；package-lock 根版本对齐
- 留待后续（i18n 死键清理、托盘 i18n、Electron 遗留目录处置、脱敏增强、补测清单）
  与**发布前人工冒烟清单**见《功能方案设计.md》第 7 节——0.15 的事件分发与
  capability 收权只过单测，装包后请按清单冒烟
- 版本号三处同步：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`；安装包交付到项目根 `dist/`（用户约定）

## [0.14.0](https://github.com/DaweiTian/zhiruo/compare/v0.13.0...v0.14.0) (2026-11-18)

### Features

- **stats:** 听写战绩（功能方案设计 4.1）——按小时活跃度热力图（`hourly` 24 桶，STATS_VERSION 2→3 幂等迁移，清空重算防双计）、当前 / 最长连续天数（今天或昨天锚点口径）、8 枚成就徽章（首次听写 / 累计 1 千·1 万·10 万字 / 连续 7 天·30 天 / 单日 1000 字 / 音频 1 小时，纯前端推导无独立存储）；首页累计条扩六格 + `HourHeatmap` 24 格热力图（标注最活跃时段）+ `BadgeGrid` 两态徽章墙（解锁进度）
- **hud:** 胶囊宠物「叶精灵」（功能方案设计 4.2）——`Pet.tsx` 共享内联 SVG 五态（idle 呼吸眨眼 / recording 电平张嘴弹跳 / processing 摇摆思考点 / success 雀跃 / error 耷拉轻抖），动画仅 transform/opacity、`prefers-reduced-motion` 降级静态形象；顶替待机窗 Mic 图形（热区 / 过渡 / 按压反馈不变）与会话窗状态圆章（≤36px 防挤压单行文字）
- **settings:** 「胶囊形象」二选一（经典 / 叶精灵，卡片内嵌实时预览）——`capsuleSkin` 走 localStorage（`vk-capsule-skin`）+ storage 事件跨窗口同步，与主题同级的纯外观偏好，**默认 classic 行为零变化**

### Notes

- 统计口径收严：选区动作原文（`source: "selection"`）只入史供回溯、从不走 `record_add`，总量 / 小时桶两条回填与前端回退聚合同步过滤；小时桶键严格 0..23 十进制校验（拒绝 `1e1` / `0x2` 等 Number 旁路）、非法日键不计连续天数
- 小时桶迁移重建窗口止于历史**写入即裁剪**的留存条目（90 天保留窗），此后只增不减、历史删除不缩水；缺 `version` 字段的手改文件按 0 走迁移路径，不会被当成最新版永远跳过
- 独立审查修复（2 HIGH / 3 MEDIUM / 3 LOW）：迁移过滤选区项、`version` 字段级默认 0、小时键旁路校验、streak NaN 过滤、呼吸动画挂 `pet-breath` 消除死选择器
- 版本号三处同步：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`；安装包交付到项目根 `dist/`（用户约定）

## [0.13.0](https://github.com/DaweiTian/zhiruo/compare/v0.12.0...v0.13.0) (2026-11-18)

### Features

- **refine:** 风格预设（功能方案设计 3.1）——口述整理 / 选区润色改写按指定文体产出：默认（最小修改）/ 正式邮件 / 小红书 / 周报 / 极简要点 / 商务书面语 / 自定义（≤500 字，带码点计数），预设文案归 Rust、提示词不散落渲染层；只改表达方式，实体保护与输出约束仍优先，翻译 / 解释不受影响；**默认档不产出风格段，输出与历史逐字一致**
- **asr:** 自定义热词表（功能方案设计 3.2）——`asr.hotwords`（100 条 × 64 字），双通道：`chat_openai_audio` 方言转写指令追加写法提示（ASR 侧）+ 精炼 prompt 热词纠正段（全方言通用），与用户词表「保留原样」独立并存；设置页帮助文案写明局限（整理工关闭 / 数据 URL 方言无 ASR 侧通道，尽力而为非强保证）
- **history:** 历史页虚拟滚动（功能方案设计 3.3）——手写窗口化 `lib/useVirtualList`（扁平行模型 + 估高 + ResizeObserver 测量修正 + 视口之上行 scrollTop 锚定补偿），万条历史 DOM 节点数稳定、快速滚动流畅；首页趋势图 `InteractiveCharts` 改 lazy + 进视口加载，recharts 拆出独立 chunk（约 386 KB）降首屏脚本量

### Notes

- 三个新配置字段均字段级宽容加载（`de_lenient_*`）：手改坏值退默认，不拖垮整份配置（API key 等不受牵连）；自动保存触发门与 patch 均已接新字段
- 独立审查修复：虚拟滚动 offsets memo 补测量版本依赖（实测高度进布局）、自定义风格超限字数提示、历史页组间距等价平移、测量缓存裁剪、ResizeObserver 首挂补观察
- 版本号三处同步：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`；安装包交付到项目根 `dist/`（用户约定）

## [0.12.0](https://github.com/DaweiTian/zhiruo/compare/v0.11.0...v0.12.0) (2026-11-17)

### Features

- **inject:** 文本注入兼容回退（功能方案设计 2.2）——`inject.mode` 四档：`paste`（现状：剪贴板 + Ctrl/V，Hyprland 为 wl-copy + Shift+Insert）/ `type`（enigo 逐字键入、不碰剪贴板，多行按真实回车逐行落地）/ `clipboard`（只写剪贴板）/ `auto`（默认，paste 失败 → type → clipboard 逐级兜底）；任何失败**尽力把文本留在剪贴板**可手动粘贴。注入只落剪贴板 / 失败时发 `inject-fallback`，HUD 待机胶囊旁软提示 4 秒自隐（按 `dockEdge` 选屏内半区，贴边「半隐」几何下也不出屏；面板内插入失败由面板 toast 承担，不重复吵）
- **settings:** 「文本注入」小节（Select 四选一，全平台）；帮助文案诚实：`auto` 只能捕获报错、检测不到「快捷键静默没粘上」，逐字键入对中文依赖输入法状态、建议用粘贴
- **picker:** 条目动作按钮改**纵向排列**（固定 / 删除上下叠，少挤正文宽度）

### Notes

- `inject` 配置段级 + 字段级双层宽容加载：手改坏配置退默认（`auto`），不拖垮整份配置（API key 等不受牵连）
- 原批次 2.1「回溯缓冲」**不做**（用户拍板）：识别准确性已足够，预卷会把按键前环境噪声带进会话
- 更正 Hyprland 注入描述的过时「wtype」文案（实际为 wl-copy + Shift+Insert）
- 版本号三处同步：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`；安装包交付到项目根 `dist/`（用户约定）

## [0.11.0](https://github.com/DaweiTian/zhiruo/compare/v0.10.0...v0.11.0) (2026-11-17)

### Features

- **picker:** 面板条目动作按钮——剪贴板条目「固定」（**移动**进常用词）与「删除」，常用词条目「取消固定」（不回填剪贴板），Delete 键删除选中项；固定 / 删除即时刷新面板（`picker-update`），长度 / 容量前端预检给本地化提示、Rust invoke 边界再兜一层
- **picker:** 常用词单条上限 64 → **256** 字符（100 条不变）——剪贴板固定要装得下整句；设置页校验、宽容加载、归一化两侧同步放宽
- **settings:** 快捷 Hub 并入 X1/X2 落点（常用词 / 最近剪贴板 / 全部显示 / **快捷 Hub** 四选一），退役独立「快捷 Hub 侧键」——消除「X2 显示剪贴板实弹 hub」的 UI 矛盾；hub 落点仍不受速插总开关影响（胶囊关闭也照用）；0.10.x `hubButton` 配置按行为等价迁移成落点 `hub`（旧路由 hub 压过落点），`mouse.rs` 侧键路由改位掩码（bit0=X1，bit1=X2）

### Bug Fixes

- **config:** 常用词命令侧读-改-写改持锁原子操作 `update_user_snippets`——面板「固定 / 删除」连点并发不再互相覆盖丢条目（后写整表替换前写、剪贴板原文已被删 → 两边都丢的高危路径）；固定先落常用词后删剪贴板，第二步失败只记日志不报错（目标已达成，残留条目仍可见可删）

### Notes

- 固定为**移动**语义（用户拍板）：进常用词即从剪贴板历史移除；「取消固定」只删常用词侧，不回填剪贴板
- TS / Rust 长度校验统一码点口径（对齐 `chars().count()`），emoji 等增补平面字符不再被 TS 先一步拒掉
- 版本号三处同步：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`；安装包交付到项目根 `dist/`（用户约定）

## [0.10.0](https://github.com/DaweiTian/zhiruo/compare/v0.9.0...v0.10.0) (2026-11-17)

### Features

- **hub:** 侧键唤出快捷 hub（设置「快捷 Hub 侧键」指定 X1/X2，另一键保持速插面板）——圆环以**鼠标为环心**展开，翻译 / 润色 / 解释三扇区围着指针；速插总开关与悬浮胶囊关闭均不影响 hub 侧键（胶囊关了照用），未认领侧键完全放行（浏览器前进/后退可恢复）；鼠标锚点不跟胶囊吸附边，贴屏边由 `edgeFromRingCenter` 兜底半环（仅 Windows，设置项非 Windows 隐藏）

### Bug Fixes

- **theme:** 侧键弹窗与左下角版本号底板不随主题变化（冒烟发现）——速插面板写死的暗色全换主题 token；`useTheme` 挂 `storage` 事件**跨窗口同步**，picker/hub 预建常驻窗口立刻追上主窗口的主题切换，不再停在启动时的主题；版本号 LED 底板改取 `--card`/`--border`、分段与标签色向 `--foreground` 混色，亮主题保对比度、暗主题保留凹陷质感
- **hub:** 面板配色随主题——信息胶囊 / 选区预览 / 结果卡片换 `popover` 系 token，扇区玻璃随主题取色并保留晕影对比度机制（扇区压任意桌面内容，下垫什么都要可读）
- **hub:** 开关时序按 picker 代际纪律加固——打开序列加 `OPEN_LOCK` 串行（tokio 并行交错 place/show 会互相覆盖环心）；捕获 / 动作迟到结果与「已替换」延迟收起带**代际条件**（连按侧键收起 → 重开不被陈旧收尾误伤、旧选区不灌进新会话）；toggle 收起持锁防连按双关；hub/速插两面板互斥（胶囊右键开 hub 也先收速插面板）
- **mouse:** 侧键吞事件按**按压锁存**（DOWN 锁存至配对 UP）——按住侧键期间配置热更新不再只吞一半、向目标应用漏孤立按键

### Notes

- 版本号三处同步：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`；安装包交付到项目根 `dist/`（用户约定）

## [0.9.0](https://github.com/DaweiTian/zhiruo/compare/v0.8.2...v0.9.0) (2026-11-17)

### Features

- **picker:** 快速插入面板（鼠标侧键 X1/X2 单击唤出）——自建最近剪贴板环形缓冲（只存文本，单条 10 KB、默认 30 条可配 5–100，自写抑制不计自产自销，本地 `voice-key-clipboard.json` 不上云不进日志，设置页一键清空）+ 常用词双来源（手动管理 100 条 × 64 字符，历史 n-gram 候选人工确认才入库，按最近使用排序）；面板贴鼠标指针弹出（约 320×380，整只钳进工作区），方向键 + Enter 键盘速选、Esc / 点外 / 再按侧键收起，点选注入到当前光标（插入前把焦点还给先前应用）
- **picker:** 侧键 X1/X2 全接管（单击即开、开关语义 toggle；浏览器前进/后退随之失效，设置可关、关掉即恢复默认行为）；X1/X2 落点可配（常用词 / 最近剪贴板 / 全部显示），设置页含剪贴板采集总开关、条数上限与常用词编辑（仅 Windows，非 Windows 侧键空桩并隐藏设置项）

### Bug Fixes

- **picker:** 侧键设置改动不会自动保存——自动保存触发门漏了 picker 脏检查，仅改侧键 / 常用词 / 剪贴板设置时改动被静默丢弃（高危）
- **picker:** 面板会话加代际守卫（开/关 + 前台快照 + 落点一把小锁）——插入延迟期间「点外收起 → 侧键重开」不再被陈旧收尾误藏刚重开的面板，前台快照不再串代（否则 Ctrl/V 会打进面板自己）；启动时独立线程预创建面板窗口，首次唤出不再阻塞 mouse 串行 worker（中键 PTT 弹跳窗 / Disable 立停时序回归）
- **config:** `userSnippets` / `clipboardLimit` 宽容反序列化——手工编辑出非法值（负数 / 字符串 / 坏条目）不再让整份配置解析失败被整体回退（API key 等全部设置被清的隐患）
- **clipboard:** 存储改原子写（tmp + rename）防半截文件，损坏 JSON 留 `.bak` 保数据；自写抑制改**写入前**登记（消除 `WM_CLIPBOARDUPDATE` 异步通知的抢先窗口，哨兵 / 注入文本不再可能混入历史）；剪贴板被占用期间的复制失败补采一次
- **picker:** 注入失败给出可见提示（文本已留剪贴板可手动粘贴）而非静默；清空剪贴板后面板即时刷新；历史候选确认先冲刷未保存草稿、不再覆盖正在输入的常用词；空剪贴板落点退回首条；相对时间标签走 i18n（刚刚 / N 分钟前 / …）

### Notes

- 版本号三处同步：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`；安装包交付到项目根 `dist/`（用户约定）

## [0.8.2](https://github.com/DaweiTian/zhiruo/compare/v0.8.1...v0.8.2) (2026-11-14)

### Features

- **audio:** 麦克风保温（`asr.micKeepAlive`，默认开）——启动即预热、会话结束保留麦克风与音频管线，下次按键零延迟进入最佳收音，消除开头几秒丢字（电池模式下尤其明显）；设置页可关，关闭即回到每次会话冷启动
- **audio:** getUserMedia 显式关闭 AGC / 降噪 / 回声消除（三者均有自适应爬坡，冷启动头几秒增益偏低），响度改由「低音量模式」固定增益决定，首帧即最终增益

### Bug Fixes

- **hub:** 未检测到选区不再显示「未检测到选区」字样——空态仅保留只读圆环（用户拍板）

### Notes

- 版本号三处同步：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`；安装包交付到项目根 `dist/`（用户约定）

## [0.8.1](https://github.com/DaweiTian/zhiruo/compare/v0.8.0...v0.8.1) (2026-11-07)

### Features

- **hub:** 扇区 hover 动效——绕扇区自身中心放大弹出（1.06）+ 主色提亮 + 柔和辉光，文字同步提亮；仅 ready 态可点扇区触发，`prefers-reduced-motion` 自动降级

### Bug Fixes

- **hub:** 圆环画到窗口对侧的错位（viewBox 反向偏移，贴边时只剩被裁的扇形碎片）——改为偏移圆环 SVG 定位，环心钉回胶囊中心；贴近屏幕边缘但未吸附时由 `edgeFromRingCenter` 自动推导半环朝向（吸附态仍以 `dockEdge` 为准），圆环完整围绕悬浮按钮、不再被窗口裁缺
- **overlay:** 待机胶囊去文字、恒为圆形 mic 钮（平时 36×36、贴边紧凑 32×32 并贴齐屏幕边），可访问名称保留在 `aria-label`

### Notes

- 版本号三处同步：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`；安装包交付到项目根 `dist/`（用户约定）

## [0.8.0](https://github.com/DaweiTian/zhiruo/compare/v0.7.0...v0.8.0) (2026-11-07)

### Features

- **hub:** 选区快捷动作面板（右键常驻胶囊唤出圆环：翻译 / 润色 / 解释，0.7.0 入库）交互补全——点面板外任意处（含右键）即收起，未完成操作不再滞留屏上；Windows 侧由全局鼠标钩子承接非激活面板收不到 blur 的缺口（严格按钮按下白名单，滚轮 / 抬起 / 移动不触发）

### Bug Fixes

- **hub:** 弹窗去黑底——hub 窗口改走透明窗体路径（`overlay-html`），只画半透明圆弧扇区与浮动信息（下方内容透得出来），不再压一块纯色黑底；顺带抑制 WebView2 默认右键菜单的黑底矩形面板
- **hub:** 贴边时状态文字半出屏——hub 窗口整只钳进锚点所在屏幕的工作区（复用 `OverlayFrame`），圆环改按 `ringCenter` 偏移钉回胶囊中心；状态文字 / 选区预览 / 结果卡片完整可见，长文案换行不截断；顺带修复动作中段状态载荷丢 `dockEdge` 导致贴边圆环闪回全环

### Notes

- 版本号三处同步：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`

## [0.7.0](https://github.com/DaweiTian/zhiruo/compare/v0.6.0...v0.7.0) (2026-11-07)

### Features

- **ui:** 三主题体系取代明暗二选一——**科幻**（暗色，深空蓝黑 + 青蓝霓虹）/ **清新**（亮色，浅薄荷 + 草绿）/ **商务**（亮色，冷灰白 + 藏青），各自成套的背景 / 卡片 / 主色 / 圆角；切换入口两处：侧栏底部三图标（火箭 / 叶子 / 公文包）与设置页「外观 → 界面主题」带预览色板的卡片；老的浅色 / 深色偏好自动迁移（浅色→清新、深色→科幻），首帧预置脚本同步改造避免闪白
- **ui:** 强调色新增「跟随主题」（auto）默认——各主题自带主色，显式选色时覆盖主题主色系；存储键换代（`vk-accent-v2`），默认不再被隐式写入的橄榄绿污染
- **ui:** 侧栏左下角版本号改为**七段数码管**呈现——暗底 LED 模块 + 六边形段位 + 主题色辉光 + 幽灵暗段（`SegmentDisplay`，段位映射在 `lib/segment-display.ts`），点击仍可打开更新日志

### Bug Fixes

- **theme:** `useTheme` 收敛为模块级共享 store（`useSyncExternalStore`）——此前侧栏与设置页各自持有一份状态，一处切换另一处高亮卡死、再次点击变 no-op；overlay / hub / session 等窗口此前不应用主题恒吃默认色板，现由 `main.tsx` 入口统一初始化；老存储值迁移后落盘，避免内存归一、磁盘永留旧值
- **log:** 修复 fire-and-forget `invoke` 丢弃 rejected promise 造成的 unhandledrejection 死循环——浏览器预览（dev:vite 无宿主）下经 logger 的 console 包装器无限刷 error（单次会话 console 日志可刷至 200MB+）；`log` / 音频上报 / 事件订阅等全部静默通道补齐吞错
- **security:** 更新日志 Markdown 渲染（`renderMarkdown`）注入面收紧——全文先 HTML 转义（含引号）再解析标记，围栏语言串字符集白名单，链接 href 仅放行 http(s)，下游 `dangerouslySetInnerHTML` 不再可被正文原始 HTML / `javascript:` 污染
- **security:** 渲染层权限与 CSP 收紧——移除无调用方的 `opener:default` / `shell:allow-open`（可绕过 `open_external` 的 GitHub 白名单）；CSP 补 `base-uri 'none'` / `object-src 'none'` / `frame-ancestors 'none'`
- **security:** Rust 边界加固——云端 ASR endpoint 复用 llm 的 https/localhost 守卫（防 bearer key 明文外带）；`test_refine_connection` 仅合并 `llmRefine` 段（此前可夹带 hotkey 等任意段绕过 `set_config` 守卫）；音频 chunk / 流式帧补单块与会话累计字节护栏；更新链接白名单改整段匹配（防 `/releases-evil/` 前缀绕过）；日志脱敏覆盖 `ghp_` / `AIza` 等更多 key 形态；配置合并字段（llm / hotkey / translation）统一长度上限
- **ui:** 历史详情日期分隔符误植「路」改为「·」；设置页卸载 flush 的脏判定漏 `middleClickPtt`（改动可能丢失）；语言切换失败后基线失真导致永不重试；HotkeyRecorder 回调 ref 化不再每次渲染重绑全局监听；首页 / 历史页加请求序守卫防旧响应覆盖新数据

### Notes

- 发布前完成 **5 轮代码审查**（渲染层安全 / Rust 主进程安全 / 主题改造正确性 / 错误处理与代码质量 / 一致性终审），高危 3 项（changelog XSS、预置脚本未随主题改造、多窗口不应用主题）与全部中低危必修项落地；顺带清掉 5 个 Rust 死函数（零警告）；前端 239 + Rust 92 用例全绿
- 版本号三处同步：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`

## [0.6.0](https://github.com/DaweiTian/zhiruo/compare/v0.5.14...v0.6.0) (2026-11-03)

### Features

- **ui:** 主页 UI/UX 整体重构为「语音仪表台」——告别「按住说话 / 今日字数」两张大卡片，改为 **语音控制台条**（待命呼吸指示 + PTT 键帽 + 品牌声波 + 光晕）→ **今日带**（今日字数英雄数字带计数动画 + 今日录音 / 今日时长 / 近 7 天三格）→ **累计数据条**（识别字符总数 / 录音总时长 / 活跃天数 / 峰值日四格一体面板）→ 趋势图；指标按「今日 / 累计」两级分区，发丝线（`gap-px`）分隔替代卡片堆叠，信息密度更清晰、气质更端庄；浅 / 深色与全部六种强调色主题适配，窄窗口响应式收敛，入场动效尊重 `prefers-reduced-motion`
- **security:** API Key 全程脱敏——粘贴填写时明文可核对，**自动保存确认后即掩码显示且永久不可再查看**；彻底移除明文查看链路（眼睛按钮、`get_config_secret` 命令、`ConfigSecretRequest` / `get_secret` 全链路删除），他人打开设置页无法再复制已保存的密钥；设置页同步提示「确认保存后将自动隐藏」
- **log:** 应用日志阈值收紧为 **WARN**——`voice-key.log` 权威写入口仅接受 warn / error，debug / info 一律丢弃，日常运行不再产生无意义日志占用磁盘（真机验证：常驻运行零新增）；写入口同时做边界净化：长度截断（4096 字符）、控制字符清洗（防 ANSI 注入）、`sk-…` 密钥串脱敏，附单测锁定
- **tray:** 托盘行为修正——点击托盘图标 / 「打开芷若」/ 手动启动 / 单实例回调统一落位**主界面**（`/home`），设置快捷键与菜单「设置」落位**设置页**（`/settings`）；重建窗把路由烤进 URL fragment、存活窗经 `eval` 转向 hash（路由白名单 + JSON 字符串字面量转义），未知 hash 回落主界面
- **overlay:** 悬浮胶囊 **hover 穿透**（0.5.15 开发项随本版入库）——胶囊可见矩形经 `setOverlayHitRect` 推送、Rust `WH_MOUSE_LL` 全局钩子做悬停判定，矩形外的点击 / 滚轮穿透到下层应用；手势 / latch / 录音在途经 `setOverlayHoverGrab` 锁定交互（取消按钮必可点），取代旧「整窗恒可交互」语义，待机与会话两胶囊同机制
- **changelog:** 更新日志对话框增强——新增语义化版本解析与比较（`compareVersion`，预发布序正确处理），版本过滤不再依赖字符串序

### Notes

- 发布前完成 **5 轮代码审查**（质量 / 安全 / 性能三路独立评审 + 不变量 / 收尾两轮），必修项与加固全部落地：计数动画叶子组件化防整页重渲、`useCountUp` 中断续算不跳变、日志级别门槛前移零 I/O、路由白名单；前端 218 + Rust 92 用例全绿，真机冒烟通过（首页落位 / 新 UI / 日志零新增）
- 版本号三处同步：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`

## [0.5.14](https://github.com/DaweiTian/zhiruo/compare/v0.5.13...v0.5.14) (2026-10-17)

### Features

- **config:** 存储位置可切换 + 一键迁移——`<exe_dir>\data\` 下存在 `.portable` 标记文件时数据根切到安装目录（便携模式），否则维持 `%APPDATA%\voice-key`；`config_dir()` 一处收口，config / history / stats / logs 全派生自它。设置页新增「存储位置」小节：显示当前绝对路径 + 切换按钮（按当前态显示「迁移到安装目录」/「迁移回默认位置」）+ 迁移中 loading + 成功后「迁移完成，重启应用生效」+ 错误显示。切换流程：写探测（安装目录不可写如 Program Files → 友好拒绝、留在原地）→ 逐文件复制 → 校验（config / history / stats 按 size 严格相等，logs 允许增长容忍）→ **写 / 删 `.portable` 标记（最后一笔 = 模式切换的原子门）** → 提示重启；任一步失败即回滚本轮复制、停留原模式，两份数据都完整。根路径一次进程内解析固定（`OnceLock`），切换只在下次启动生效
- **config:** 便携判定以**标记文件**为准而非裸 `data\` 目录——迁移中途失败留下的半成品 `data\` 不会被误认成便携态；切回默认位置时严格只清理 `data\` 内我们自己的迁移产物（未知用户文件保留，`remove_dir` 仅在目录空时成功）
- **ui:** 存储位置 i18n 双语全平（en / zh 393 / 393）

### Notes

- **升级幸存验收（待人工确认）**：NSIS 升级只替换安装包自身 payload，exe 旁 `data\` 与 `.portable` 应幸存——留待用户下次升级时人工核对

## [0.5.13](https://github.com/DaweiTian/zhiruo/compare/v0.5.12...v0.5.13) (2026-10-17)

### Bug Fixes

- **overlay:** 修复**新装/升级首启待机胶囊半出屏**（「一半在屏幕外面」、只有拖一下才回正）。根因是**启动竞态**：`AppState` 原本在 `tauri::Builder::setup()` 里 `manage`，而配置窗口（main / overlay / …）的 WebView 在 `setup()` **之前**就已加载并调用 `get_config` / `get_app_language`，首个调用必然失败（`state not managed`，本机 `voice-key.log` 每次启动都有该错误）。overlay HUD 挂载时靠 `get_config` 读回 `app.overlayDocked` 决定首帧形态，该读取失败后**静默回落全形**；而 Rust 启动时已把窗口按持久化坐标摆到**半隐贴边位**（窗口中线压屏幕边、一半在屏外），于是用户看到「半只胶囊在屏外」，拖一下（`setOverlayPosition` 返回值）才纠正。修法：`AppState::new()` 去掉未使用的 `AppHandle` 参数，状态改为在 **builder 链**上 `manage`（早于任何窗口 / WebView 加载），从根上消除竞态，同时消除首启 `get_app_language` 的 i18n 警告
- **overlay:** HUD 首帧形态同步——胶囊入场（`isVisible`）推迟到 `overlayDocked` 读回之后（300ms 超时兜底），首帧即已是正确形态（贴边 → 紧凑 + 贴齐；否则全形），消除「先全形半出屏、再收缩」的闪烁；新增纯函数 `resolveInitialDockEdge` 与单测锁定启动恢复契约

## [0.5.12](https://github.com/DaweiTian/zhiruo/compare/v0.5.11...v0.5.12) (2026-10-17)

### Features

- **asr:** 云端识别通用化——不再绑死 MiMo，设置页新增**服务商预设 + Base URL + API Key + 模型**，可接任意 OpenAI 兼容云 ASR。新增 `CloudDialect` 三种请求方言：`chat_asr_data_url`（MiMo / 千问：`input_audio.data` 传 data URL + 顶层 `asr_options`，与 0.5.11 载荷**逐字节一致**）、`chat_openai_audio`（OpenAI / 豆包 Ark：纯 base64 + `format:"wav"` + 转写指令 part，豆包用中文指令）、`openai_transcribe`（multipart `{base}/audio/transcriptions`，非流式）。预设四个（MiMo / 千问 DashScope / 豆包 Ark / 通用 OpenAI）+ 自定义（自选方言）；选择预设即回填 endpoint + 方言 + 示例模型，API Key 始终手填
- **asr:** 配置键通用化且**无迁移**——`mimoEndpoint/mimoApiKey/mimoModel` 重命名为 `cloudEndpoint/cloudApiKey/cloudModel` 并加 `mimo*` serde 别名，旧配置（含真实 key）读入零迁移、下次保存自然写新键；新增 `cloudPreset`（默认 `mimo`）与 `cloudDialect`（默认 `chat_asr_data_url`）。MiMo 默认路径行为零回归
- **asr:** `reqwest` 启用 `multipart` feature（`/audio/transcriptions` 方言所需）

### Notes

- SSE 流式管线 `ingest_sse_line` 四家 chat 路线全兼容，未改动；7MB 护栏与 16k 单声道 WAV 维持
- 豆包语音专用 flash 端点（openspeech，独立 `X-Api-*` 鉴权 + 头部状态码）排 v1.1，不在本轮范围

## [0.5.11](https://github.com/DaweiTian/zhiruo/compare/v0.5.10...v0.5.11) (2026-10-17)

### ⚠ BREAKING CHANGES

- **asr:** 移除本地识别（SenseVoice / X-ASR）与全部模型下载/管理，**云端 MiMo（`mimo-v2.5-asr`）成为唯一识别引擎**。设置页的「识别引擎」「标准识别」「实时识别」卡片、本地模型目录入口，以及相关桥方法 / i18n 键一并删除。旧配置里的 `asr.engine` / `asr.streamingEnabled` 键被 serde 静默忽略，无需迁移。本地推理代码在 git 历史中保留，可随时找回。

### Features

- **asr:** 彻底精简为云端 only——删除 `src-tauri/src/asr.rs` 的模型清单/下载/校验/状态（`AsrFileMeta` / `AsrStatus` / `classic_files` / `streaming_files` / `classic_dir` / `streaming_dir` / `files_for` / `dir_for` / `verify_sha256` / `status` / `get_status` / `download` / `download_one` / `delete` 及模型 URL 表），`src-tauri/src/commands.rs` 的 `get_local_asr_status` / `download_local_asr` / `delete_local_asr` / `get_streaming_asr_status` / `download_streaming_asr` / `delete_streaming_asr` / `open_asr_model_directory` 命令与 `invoke_handler` 注册，`config.rs` 的 `engine` / `streaming_enabled` 字段与 `model_storage_dir()`，以及渲染层「识别引擎 / 本地模型 / 实时识别」UI、`tauri-api.ts` 桥方法、`LOCAL_ASR` / `STREAMING_ASR` 常量、`host-capabilities` 模块与相关类型 / i18n 键
- **asr:** 移除本地识别后 `transcribe` 直接走云端（删去 `match config.asr.engine` 的 `"local"` 分支，保留 SSE 流式 + 非流式回退）；`transcribe_cloud` / `transcribe_cloud_stream` / `encode_wav_mono_f32` 与 MiMo 云端路径行为**零变化**，构建产物体积随依赖精简下降

## [0.5.10](https://github.com/DaweiTian/zhiruo/compare/v0.5.9...v0.5.10) (2026-10-17)

### Bug Fixes

- **asr:** 修正本地模型就绪检查的字节数常量，根除永远误报「未下载」——`classic_files()` 的 `size_bytes` 原为估值（`model.int8.onnx` 231_000_000 / `tokens.txt` 1_000_000），而 `status()` 就绪判定与 `download_one()` 下载后校验都用**严格相等**，于是文件放对也永远 not ready、设置页下载也永远自拒（用户「从来没下载成功」的真相）。改为经 SHA-256 验证的真实值 **239_233_841** / **315_894**，并加注释说明「修改模型版本时必须同步更新」
- **asr:** 同步修正 streaming（X-ASR）三个常量：`decoder-480ms.onnx` 40_000_000 → **11_309_084**、`joiner-480ms.onnx` 60_000_000 → **10_260_467**、`tokens.txt` 1_000_000 → **58_806**（三者均下载后 SHA-256 与代码内哈希一致，实测取值）
- **asr:** `encoder-480ms.onnx` 常量对齐**代码锁定 revision** 的真实字节数 120_000_000 → **592_968_361**（本机落盘副本全 64 位 SHA-256 = 代码 pin 的 `0c345403…abc74`；modelscope 主源 2 字节 range 请求返回 `Content-Range: bytes 0-1/592968361`，且 302 指向内容寻址 LFS 对象 `0c/34/54033d…abc74`，双证一致）。同时记录**上游漂移**：作者在同一 URL 另发布过更新的 revision（采样 487_029_601 字节 / SHA-256 `cb58274b…cf52f`，两镜像步调曾不一致）；新 revision 会被 `download_one` 的 SHA-256 校验拒绝属**预期行为**——常量永远描述被 pin 的那个修订，升级 pin 时须同步改 `sha256` + `size_bytes`

## [0.5.9](https://github.com/DaweiTian/zhiruo/compare/v0.5.8...v0.5.9) (2026-10-17)

### Bug Fixes

- **overlay:** 根除胶囊上方的**常驻「芷若」白条**（幽灵标题栏本体）——overlay + session **双胶囊窗启用 `noRedirectionBitmap`**（`WS_EX_NOREDIRECTIONBITMAP`，仅 Windows 生效；tauri 维护者推荐 + #15410 配置项）。A/B 实机收敛：session 先启用后多轮录音渲染完全正常、从未出现白条/白闪/空白；overlay 未启用时实机截图显示待机胶囊正上方一条**常驻**浅蓝白横条（条内左侧「芷若」文字，占 420×96 窗顶部区域），且 0.5.9-1 摘除可见窗轻推后该条**由「一闪而过」转为「常驻」**——病灶即窗口 redirection bitmap 缓存了带标题栏的旧帧（tauri#14831/#15490 病类）。本机运行时 155 仍复现该条，说明上游 146 的修复未覆盖此变体；0.5.7 记录的 Sciter 否决（DComp 影响 wry 的 WebView2 子窗合成）由实机证据判定不成立。一行可回退（删对应窗那一行），失败判据=该窗内容空白则立即回退
- **overlay:** 摘除焦点路径的幽灵清扫，**根除点按胶囊瞬间的「闪」**（补丁即闪烁病灶）——本机 `voice-key.log` 插桩时间戳严丝合缝：`focused label=overlay focused=true` → `ghost-sweep (focus path)` → `ghost-nudge label=overlay size=420x96`（位移的是**可见**窗）→ `session start`；focus 风暴内 10 秒 7 次可见窗位移、单次点按 3-4 次。0.5.8 的 `WS_EX_NOACTIVATE`/`focusable:false` 只挡「激活」不挡 Focused 事件（WebView2 子窗点击即取焦），而该轻推把一直存在的幽灵条每次擦掉、于是表现为「闪」——摘除后条转为常驻，再由双窗 `noRedirectionBitmap` 从源头消除。删函数（零残留 dead code）+ overlay 显示路径轻推前置到隐藏态（对 144.x 老运行时仍是廉价兜底）；**新不变量：不得对可见胶囊窗做 bounds 位移**
- **overlay:** 窗口操作全链插桩——`windowing::trace()` 直接追加 `[win]` 行到 `voice-key.log`（session start 入口、overlay/session show 全链、每次 ghost-nudge、session hide 的 park 坐标、Focused 事件），用于把白闪时间戳与窗口操作对齐定案；注意 Rust `log::*` 走 stderr 不进该文件

## [0.5.8](https://github.com/DaweiTian/zhiruo/compare/v0.5.7...v0.5.8) (2026-10-17)

### Bug Fixes

- **overlay:** 修复点击开启录音瞬间闪现「芷若」白色标题栏——根因为窗口 show() 时 tao 整字重写扩展样式，focusable 默认 true 使 WS_EX_NOACTIVATE 被抹除、SW_SHOW 激活窗口触发 WebView2 幽灵标题栏；待机与会话双胶囊窗声明为不可聚焦（配置 + 重建路径 + harden 幂等断言），顺带修复录音启动时抢走前台应用焦点
- **ui:** 开录与状态过渡动效自然化——会话大胶囊入场淡入缩放上滑（约 200ms、避开 WebView 首帧延迟）、待机胶囊按压反馈、状态圆章沿用 hud-pop 弹性衔接；纯内容层动画，窗口几何零改动

## [0.5.7](https://github.com/DaweiTian/zhiruo/compare/v0.5.6...v0.5.7) (2026-10-17)

### Bug Fixes

- **overlay:** 修复点击按住说话胶囊与首次开启录音时的白色闪烁——已可见的待机胶囊不再重复执行显示与 1px 尺寸轻推，会话大胶囊的轻推移至显示之前、隐藏前先移出屏幕外（tauri#14515 实测配方），并以环境变量将 WebView2 默认背景设为透明
- **overlay:** 修复拖动胶囊溢出屏幕边缘后松手不自动吸附——吸附判定改用带符号距离，胶囊任一边接触或溢出屏幕边缘（含远超 48px 阈值的深度溢出）均吸附，多边同时贴边时按剩余优先级选择

## [0.5.6](https://github.com/DaweiTian/zhiruo/compare/v0.5.5...v0.5.6) (2026-10-17)

### Features

- **overlay:** 录音/识别大胶囊与待机悬浮按钮解耦为独立会话窗口：大胶囊固定显示在屏幕底部居中（光标所在显示器），隐藏悬浮按钮后中键/快捷键触发录音仍正常显示，按住说话期间两胶囊同显
- **overlay:** 待机胶囊贴边吸附后收缩为 32×32 紧凑麦克风图标并完整贴齐屏幕边缘（拖出/复位自动还原带文字全形）

### Bug Fixes

- **overlay:** 胶囊上方偶现的「芷若」白条——WebView2 144.x 幽灵标题栏上游回归（焦点切换重绘），窗口获得焦点与显示时以 1px 尺寸轻推清除，DWM 属性改查返回值记录日志
- **ui:** 主窗口获得焦点时边缘蓝色系统强调边框——激活时重新应用无色边框属性（此前仅创建时设置一次）
- **ui:** 侧栏折叠按钮被主内容遮挡（侧栏 overflow 裁剪）——按钮移至独立层叠容器
- **ui:** 侧栏折叠后菜单转为 40×40 图标按钮（点击导航、悬停提示），折叠宽度 24px→48px

## [0.5.5](https://github.com/DaweiTian/zhiruo/compare/v0.5.4...v0.5.5) (2026-10-16)

### Features

- **ui:** 侧边栏支持折叠——侧栏右缘垂直中部贴边箭头按钮（展开朝左/折叠朝右），220px↔24px 平滑过渡，折叠态经本地存储持久化、重启还原
- **bundle:** NSIS 安装器与卸载器图标显式配置为应用图标（此前 bundler 不采信 bundle.icon，安装包显示 NSIS 默认图标）

### Bug Fixes

- **ui:** 删除主界面侧栏顶部与标题栏重复的应用名品牌块（BrandMark+「芷若」+slogan），仅保留自绘 TitleBar 中的标题

## [0.5.4](https://github.com/DaweiTian/zhiruo/compare/v0.5.3...v0.5.4) (2026-10-16)

### Features

- **overlay:** 贴边吸附改为半隐半现抽屉式：胶囊中线停靠屏幕边缘，一半嵌入屏幕、一半外露（拖出 ≥4px 可再次吸附；重启/托盘复开保留停靠位；双击复位仍完整显示）

### Bug Fixes

- **overlay:** 按住说话 ≥500ms 录音胶囊闪现即停——holding 阶段启动会话仍触发手势中窗口缩放被系统取消指针；渲染层删除随状态缩放窗口机制，窗口几何在手势与会话期间恒定不变
- **overlay:** 会话启动时的同坐标窗口重定位跳过，消除手势中最后一个指针取消插入点
- **overlay:** 待机胶囊悬停原生 tooltip 移除（保留 aria-label 无障碍标签）
- **overlay:** 主界面打开时胶囊下方白灰矩形残留——清除 overlay 窗口 DWM 系统背景/圆角/非客户区渲染（backdrop 采样下方内容导致仅叠自家主窗时显形）
- **overlay:** 贴边吸附参照系由窗口外框改为胶囊可视区（修复待机胶囊吸附后离屏幕边 88px），并由渲染层传递胶囊实际尺寸

## [0.5.3](https://github.com/DaweiTian/zhiruo/compare/v0.5.2...v0.5.3) (2026-10-16)

### Features

- **overlay:** 悬浮胶囊改为点按切换：轻点一下开始录音（松手后保持录音），说完再点一下停止并识别；按住超过 500ms 仍为按住说话（PTT）模式
- **overlay:** latched 录音态支持 5 秒无声音自动停止（基于音频电平判定）

### Bug Fixes

- **overlay:** 待机胶囊无法拖动——根因为按下即启动会话导致手势进行中窗口缩放重锚定、指针事件被系统取消；改为手势意图明确后才启动会话（轻点松手时开录、按住满 500ms 开录、拖拽全程不触发录音）
- **overlay:** 快速点击胶囊只闪烁不录音——松手早于麦克风就绪导致会话被丢弃；点按切换语义下会话在松手后保持，麦克风有充足就绪时间
- **ui:** 移除胶囊外部投影与 backdrop-blur（浅色背景下矩形残留），以提高背景不透明度保持对比度

## [0.5.2](https://github.com/DaweiTian/zhiruo/compare/v0.5.1...v0.5.2) (2026-10-16)

### Bug Fixes

- **overlay:** 待机胶囊无法录音——快速点击不再被误判为轻点取消（单击一律走正常停止转写链路），点击热区扩展至整个悬浮窗（修复上半部分无反应、下半部分闪烁但录不了音）
- **mouse:** 中键 PTT 松开后无法停止录音——移除低级钩子回调内不可靠的 `GetAsyncKeyState` 键态复核（该读取在钩子回调时异步键态尚未更新，导致真释放被永久误判为弹跳），改为 120ms 事件宽限窗容错（弹跳只能延迟停止、不会取消停止）
- **overlay:** 悬浮胶囊周围出现矩形边框、顶部横线与最小化/恢复/关闭三按钮——overlay 窗口显式关闭 `shadow`（非客户区帧带是 DWM 边框与原生标题栏的来源），并防御性剥离窗口 caption 风格位
- **session:** 快速误触不再弹「没有录到声音」错误——会话时长 <250ms 且无任何音频时静默回到待机态；≥250ms 无音频仍保留错误提示（真实麦克风故障）

## [0.5.1](https://github.com/DaweiTian/zhiruo/compare/v0.5.0...v0.5.1) (2026-10-16)

### Features

- **app:** 防止多实例运行，重复启动时聚焦已存在的窗口
- **overlay:** 待机胶囊支持拖拽，带边缘吸附与位置持久化；双击可复位
- **ui:** 新增版本徽章与更新日志弹窗（侧边栏 / 关于卡片）
- **ui:** 新增六种小米 SU7 风格主题色（默认橄榄绿）及设置「外观」分区
- **brand:** 应用更名为芷若 (Zhiruo)，口号「言若有声，芷若知心。」，启用新的兰叶 + 声波图标并更新官网视觉
- **session:** 新增 Rust 侧 5 分钟会话看门狗，作为渲染层计时器之外的第二道防线

### Bug Fixes

- **stats:** 首页统计与历史删除/清空完全解耦；今日/近 7 天窗口不再随删除收缩，旧统计文件无损升级
- **overlay:** 胶囊关闭后可由托盘重新打开（标志位与窗口可见性不同步，窗口缺失时从未重建）
- **ui:** 移除圆角矩形边框，仅显示胶囊主体
- **mouse:** 滚轮输入不再中断进行中的中键录音（松开时重新检测物理按键状态，容忍硬件抖动）
- **overlay:** 修复拖拽状态卡死（指针捕获 + 看门狗复位），双击复位不再误报空录音错误，拖拽调整大小后不会回弹到旧位置
- **config/tray:** 以进程级锁串行化跨线程配置写入，杜绝更新丢失；托盘菜单变更回派主线程处理

## [0.5.0] - 2026-10-16

本版本一并补记 0.4.0 未写入 changelog 的 Tauri 迁移主线，以及本轮桌面可靠性修复。

### Features

- 桌面后端从 Electron 迁移到 Tauri 2（Rust 主进程 + 系统 WebView），常驻内存显著下降
- **window:** 自定义标题栏与无装饰窗口（主窗口关闭系统装饰，由前端自绘标题栏与边框）
- **asr:** Rust 主进程重建流式转写链路（X-ASR，0.3.0 首次引入），并简化本地模型选择流程
- **overlay:** 悬浮胶囊常驻待机，鼠标按住点击即可说话，托盘可显隐（默认开启）
- **hotkey:** 支持鼠标中键触发录音（设置中可开关，默认关闭，仅 Windows）
- **stats:** 首页累计统计独立持久化（`voice-key-stats.json`），删除或清理历史不再清空累计数据，存量用户首次启动自动回填
- **translate:** 选中文字快捷键翻译落地（选区捕获 → LLM 翻译 → 原位回贴，剪贴板自动恢复）

### Bug Fixes

- **ui:** 消除 Windows 11 下 HUD 胶囊与主界面的系统蓝色焦点边框
- **hotkey:** 设置界面录入快捷键不再误触发录音（应用内聚焦或录制态自动屏蔽）
- **hotkey:** 修复右 Alt（AltGr）设置时报错并反复弹窗的问题（左右修饰键区分、非法值一次性提示并自动回滚）
- **window:** 主界面最小化到托盘 5 分钟后自动释放 WebView 进程，重开自动恢复（显著降低后台内存占用）
- **deps:** 补回缺失的 `axios` 依赖，修复测试套件加载失败

### Performance

- **overlay:** HUD 窗口随内容自适应缩放，消除胶囊四周的点击死区
- **stats:** 统计读-改-写全程持进程级锁，并发累加不再丢更新
- **session:** 代码审查加固——转写/润色期间拒绝重复启动、中键只停止自己启动的会话、剪贴板不可读时不覆写用户内容

## [0.3.0](https://github.com/DaweiTian/zhiruo/compare/v0.2.1...v0.3.0) (2026-09-01)

### Features

- migrate streaming ASR to X-ASR ([bdfc35e](https://github.com/DaweiTian/zhiruo/commit/bdfc35ea1c75dd179adff455f17e74285a75c629))
- **refine:** add TokenDance LLM provider with OAuth key authorization ([8fa9ac4](https://github.com/DaweiTian/zhiruo/commit/8fa9ac436ff2facc58483ea2a600f04047aad745))
- **settings:** simplify ASR copy and warn on weak hosts ([1a8578a](https://github.com/DaweiTian/zhiruo/commit/1a8578a6b8a84f63ef20d24c975b145c4d4632ee))
- **website:** deploy site on Cloudflare ([8271aec](https://github.com/DaweiTian/zhiruo/commit/8271aeca46859cdb24806ec83d531a17080c5dd7))

### Bug Fixes

- **release:** generate portable checksums ([56b9269](https://github.com/DaweiTian/zhiruo/commit/56b9269bf4ddae946807c099ed07a7b1c73df052))
- **settings:** rebind changed microphone device ids ([323c595](https://github.com/DaweiTian/zhiruo/commit/323c59509736dcb0ede861d994d32fbe7e8fc7a3))

### [0.2.1](https://github.com/DaweiTian/zhiruo/compare/v0.2.0...v0.2.1) (2026-08-27)

### Features

- **linux:** add Omarchy and Hyprland support ([edf2166](https://github.com/DaweiTian/zhiruo/commit/edf2166df2bc6305e7b43a3b3cfa593499d35a27))

### Bug Fixes

- **linux:** make Wayland text injection reliable ([272991e](https://github.com/DaweiTian/zhiruo/commit/272991ee43624b7b0aa4bba4b95cce70da4ab371))

## [0.2.0](https://github.com/DaweiTian/zhiruo/compare/v0.1.22...v0.2.0) (2026-08-27)

### Features

- **asr:** add local streaming transcription ([be0a4fb](https://github.com/DaweiTian/zhiruo/commit/be0a4fb3b8df0e77e37208733919893d9a9a74d6))
- **settings:** add local model management ([86ba0b0](https://github.com/DaweiTian/zhiruo/commit/86ba0b0952253d57096c80648bb0a4869c2b3170))

### Bug Fixes

- **llm:** use low reasoning_effort for official DeepSeek ([0a06a82](https://github.com/DaweiTian/zhiruo/commit/0a06a82ac51c11453cbc35e4158765fa5d0682b9))
- **settings:** restore refine toggles after LLM provider switch ([98fee38](https://github.com/DaweiTian/zhiruo/commit/98fee38fcf9ae7238a3150e5c1ffa99de4dc24f8))

### [0.1.22](https://github.com/DaweiTian/zhiruo/compare/v0.1.21...v0.1.22) (2026-08-11)

### Features

- add fallback source for local ASR downloads ([ac2f0f5](https://github.com/DaweiTian/zhiruo/commit/ac2f0f52c7dd9a56b34025022687cc6cc7c52645))
- add fixed OpenRouter model presets ([50db94d](https://github.com/DaweiTian/zhiruo/commit/50db94d21dbf52e458adad2ff4071db33bf3afdc))
- add official OpenAI provider ([7f6d045](https://github.com/DaweiTian/zhiruo/commit/7f6d0451b3afafea232bcb2d6362c89e693db8b3))
- **asr:** use local-only speech recognition ([6da5673](https://github.com/DaweiTian/zhiruo/commit/6da5673fd9c781ed348b6ff58450d789d6013acc))
- **settings:** improve API key and refinement controls ([ab6f853](https://github.com/DaweiTian/zhiruo/commit/ab6f8538e427aadd674dd0ef7cc0148f9ad25b56))

### Bug Fixes

- preserve preload during dev builds ([2573625](https://github.com/DaweiTian/zhiruo/commit/25736256c20139fb2630f500fbdd2f97f33bce15))
- prevent dev Electron auto-launch ([3474eec](https://github.com/DaweiTian/zhiruo/commit/3474eecbdd22caacbdd0e7ac0ea2c795d9d22ac4))

### [0.1.21](https://github.com/DaweiTian/zhiruo/compare/v0.1.20...v0.1.21) (2026-07-15)

### Bug Fixes

- avoid system credential store lockouts ([6d2b32e](https://github.com/DaweiTian/zhiruo/commit/6d2b32e881a7088da0d97395097326a5b8d10930))

### [0.1.20](https://github.com/DaweiTian/zhiruo/compare/v0.1.19...v0.1.20) (2026-07-11)

### Features

- add provider-aware reasoning config ([0a0ab32](https://github.com/DaweiTian/zhiruo/commit/0a0ab321c23ac69f55f1e5d24f05b3de41382be8))

### Bug Fixes

- release idle local ASR worker ([15afaa0](https://github.com/DaweiTian/zhiruo/commit/15afaa0638dcc9427e1b3a3ef8a96a87f2d19bf8))

### [0.1.19](https://github.com/DaweiTian/zhiruo/compare/v0.1.18...v0.1.19) (2026-07-07)

### Features

- add microphone input selection ([32ccc45](https://github.com/DaweiTian/zhiruo/commit/32ccc457f4b4800510c5c3a739431a9cbe06b08d))

### [0.1.18](https://github.com/DaweiTian/zhiruo/compare/v0.1.17...v0.1.18) (2026-07-07)

### Bug Fixes

- add xrandr headers for uiohook ci builds ([6e6a5e5](https://github.com/DaweiTian/zhiruo/commit/6e6a5e5b31bde3ce1e801ba4001cc3a10e0ea623))
- harden recording pipeline and builds ([ce6f379](https://github.com/DaweiTian/zhiruo/commit/ce6f379d5a03eeafa6c4cc46627e0cededb72cf3))
- install linux deps for uiohook ci builds ([f1eb7e7](https://github.com/DaweiTian/zhiruo/commit/f1eb7e701756d4c69ffad262eb29d7392c321d06))
- stabilize local asr and settings window startup ([d6edf9d](https://github.com/DaweiTian/zhiruo/commit/d6edf9dc95cff3892dac83fb5bc3d967d81f7a61))

### [0.1.17](https://github.com/DaweiTian/zhiruo/compare/v0.1.16...v0.1.17) (2026-06-27)

### Features

- add local SenseVoice ASR support ([27178cb](https://github.com/DaweiTian/zhiruo/commit/27178cb87c176828fefd2c856637eb262178d53b))
- **refine:** improve polish and translation prompts ([3d6258d](https://github.com/DaweiTian/zhiruo/commit/3d6258d1d1af5eb4f9aa33c6dda648fe146c3822))

### Bug Fixes

- harden local ASR runtime fallback ([3d4d874](https://github.com/DaweiTian/zhiruo/commit/3d4d8741136681b909267bfcae7b2efcc42e6494))

### [0.1.16](https://github.com/DaweiTian/zhiruo/compare/v0.1.15...v0.1.16) (2026-06-22)

### Features

- **settings:** consolidate refine & translation, unify target language ([99b1636](https://github.com/DaweiTian/zhiruo/commit/99b1636c1cbf66cffd25a19b41cc513974991e50))
- **ui:** redesign home, settings, and history pages ([9ef8fc4](https://github.com/DaweiTian/zhiruo/commit/9ef8fc44664dfd7d2802289ba41d1f210fcd9c74))

### Bug Fixes

- **hotkey:** prevent bare-modifier PTT from misfiring on combo hotkeys ([90483c7](https://github.com/DaweiTian/zhiruo/commit/90483c768ade582aaf9408ecca84db47a33e1d10))

### [0.1.15](https://github.com/DaweiTian/zhiruo/compare/v0.1.14...v0.1.15) (2026-06-03)

### Features

- **translation:** enhance translation system prompt for clarity and functionality ([6c2b6b0](https://github.com/DaweiTian/zhiruo/commit/6c2b6b002b8792fd0e3a16e6d44488e902fc8ab3))

### [0.1.14](https://github.com/DaweiTian/zhiruo/compare/v0.1.13...v0.1.14) (2026-06-02)

### Features

- **refine:** enhance transcript handling for empty or minimal inputs ([5b8fa68](https://github.com/DaweiTian/zhiruo/commit/5b8fa687a5272b6230b1f78a77a3c2010780485e))
- **stats:** add today's session statistics and peak day tracking ([7b1f555](https://github.com/DaweiTian/zhiruo/commit/7b1f555a517fa1f47e7eb45ee11faef0a94f854e))

### Bug Fixes

- **translation:** harden selected text replacement ([0622874](https://github.com/DaweiTian/zhiruo/commit/06228744c35dc4f8918be9379e002e14c29d5917))

### [0.1.13](https://github.com/DaweiTian/zhiruo/compare/v0.1.12...v0.1.13) (2026-04-20)

### Features

- **hud:** split processing into transcribe and refine stages ([810e512](https://github.com/DaweiTian/zhiruo/commit/810e512c6775f7ddfe54a139dbee9d134bfb05ac))
- **refine:** add remote glossary refresh ([8b77a1b](https://github.com/DaweiTian/zhiruo/commit/8b77a1b41d9496b51cf3f58d50cbec0d942942a5))
- **ui:** distinguish ASR and LLM refinement stages in HUD ([dd0b027](https://github.com/DaweiTian/zhiruo/commit/dd0b027d15bce5074be68353f679d212594f418d))

### [0.1.12](https://github.com/DaweiTian/zhiruo/compare/v0.1.11...v0.1.12) (2026-03-30)

### Features

- add optional English output mode for transcript refine ([bc658dd](https://github.com/DaweiTian/zhiruo/commit/bc658ddc64ff337dd6e3a480eae06646360f2e4f))
- **refine:** improve structured formatting and multiline injection ([466f219](https://github.com/DaweiTian/zhiruo/commit/466f219d9046264caf6a5f3cfb5686d038782907))
- simplify refine base url config ([881ae4e](https://github.com/DaweiTian/zhiruo/commit/881ae4e89b50c35d043e3e050e54de0f3f2cfa0c))

### [0.1.11](https://github.com/DaweiTian/zhiruo/compare/v0.1.10...v0.1.11) (2026-03-29)

### Features

- **audio:** support 3-minute chunked glm asr sessions ([31df453](https://github.com/DaweiTian/zhiruo/commit/31df4537e22090b7e81310eb033609811fc07d04))
- improve refine prompt guidance ([633385a](https://github.com/DaweiTian/zhiruo/commit/633385a0df49fa6ce62deb18fa72fcde055afec8))

### [0.1.10](https://github.com/DaweiTian/zhiruo/compare/v0.1.9...v0.1.10) (2026-03-29)

### Features

- **settings:** improve autosave status feedback ([d691c9f](https://github.com/DaweiTian/zhiruo/commit/d691c9f84ba8a966f8b2966f4d17ae8bbe24c55a))

### Bug Fixes

- keep auto launch startup in background ([bdd677e](https://github.com/DaweiTian/zhiruo/commit/bdd677e4243dfed15d37a3bcacba6cc31e16dea8))

### [0.1.9](https://github.com/DaweiTian/zhiruo/compare/v0.1.8...v0.1.9) (2026-03-29)

### Features

- **chart:** enhance localization for chart labels and range selector ([0137700](https://github.com/DaweiTian/zhiruo/commit/0137700f2e02ecdf0a2744a0c41ad45552734e07))
- refactor text refinement flow ([b65bae1](https://github.com/DaweiTian/zhiruo/commit/b65bae1f8f61964353e05a583303fd27d2b8cc31))

### Bug Fixes

- **security:** defer API key encryption migration to after app.ready ([59c173f](https://github.com/DaweiTian/zhiruo/commit/59c173f47be0a21476eb76f2230f40e7799a5ffd))
- **security:** encrypt API keys with safeStorage and remove keystroke logging ([1655d6f](https://github.com/DaweiTian/zhiruo/commit/1655d6f1ad57ef00e270138e1f9f6e3b2da1de24))

### [0.1.8](https://github.com/DaweiTian/zhiruo/compare/v0.1.7...v0.1.8) (2026-03-12)

### Features

- **audio:** add low-volume enhancement mode ([2aae04d](https://github.com/DaweiTian/zhiruo/commit/2aae04d07e266ba3b1dc00b21499164f3b51ea97))
- **llm:** add glm refine mvp with asr reuse ([6b094cd](https://github.com/DaweiTian/zhiruo/commit/6b094cd03774fcdb6fbb96bc0a0aab86f1cf7d0a))
- **website:** add automatic version detection from GitHub releases ([b6c756b](https://github.com/DaweiTian/zhiruo/commit/b6c756b2aa971cf3b60b8a94364a1cdf3b536427))

### Bug Fixes

- **website:** add localStorage caching to reduce GitHub API calls ([41cdf6d](https://github.com/DaweiTian/zhiruo/commit/41cdf6d43d914dcaf874db867be4ebec18bfc4f2))

### [0.1.7](https://github.com/DaweiTian/zhiruo/compare/v0.1.6...v0.1.7) (2026-01-26)

### Features

- add official website project structure ([6aa2678](https://github.com/DaweiTian/zhiruo/commit/6aa26781f06db42e57381044faf2f70fb515ca62))
- **i18n:** auto-sync system locale when language setting is 'system' ([4618ead](https://github.com/DaweiTian/zhiruo/commit/4618eadad3f247cc4db8890bf507b03da009714e))
- **i18n:** implement real-time language sync across all windows ([91a2b5b](https://github.com/DaweiTian/zhiruo/commit/91a2b5b3fa4dd4b98bead22103bac0d626cbb1ff))
- **website:** add bilingual support and deploy workflow ([f4daca9](https://github.com/DaweiTian/zhiruo/commit/f4daca91f82bded24ef0a4e12ce40c2543c4d5e2))
- **website:** add canonical URLs, hreflang, and 404 page ([d5f4773](https://github.com/DaweiTian/zhiruo/commit/d5f47735c0b7bb3dc6ec6900ebb0b1be62746c73))
- **website:** add light/dark theme toggle ([3481d18](https://github.com/DaweiTian/zhiruo/commit/3481d18978085fe413be91c7f1a6738775b7c28e))
- **website:** add sitemap generation and improve favicon setup ([bc0401b](https://github.com/DaweiTian/zhiruo/commit/bc0401b32b9b94423cf377132038c8f3a79a5384))
- **website:** redesign with geek-style aesthetic ([1a4fe84](https://github.com/DaweiTian/zhiruo/commit/1a4fe8409a3ce8052ebe8c8648acd36df06966ba))

### Bug Fixes

- **i18n:** improve fallback language resolution in renderer ([0ee7adc](https://github.com/DaweiTian/zhiruo/commit/0ee7adc1f0deab9703a053b1ecd8bb66292233ae))
- **website:** add localStorage error handling for private browsing ([4f3d72a](https://github.com/DaweiTian/zhiruo/commit/4f3d72a32252cdb0034f256ce403cd704bb9d60c))
- **website:** correct site URL and improve deployment workflow ([795ed1a](https://github.com/DaweiTian/zhiruo/commit/795ed1a5143b61cc2d1be45e271a36b3a2aae7ee))

### [0.1.6](https://github.com/DaweiTian/zhiruo/compare/v0.1.5...v0.1.6) (2026-01-25)

### Features

- **logging:** add persistent logging system with retention and UI ([05314f0](https://github.com/DaweiTian/zhiruo/commit/05314f053f700a932650576db62d81649158ac0d))
- **session:** add cancellation checks in audio processing pipeline ([5133a8a](https://github.com/DaweiTian/zhiruo/commit/5133a8a840126d6bbd0e6757ab4a0707b3ba88bf))
- **session:** implement cancel session functionality ([037f178](https://github.com/DaweiTian/zhiruo/commit/037f178cb247cda7a0285f366359ed38fe789397))

### Bug Fixes

- **logging:** correct archiveLog callback to use LogFile.path property ([47ba0af](https://github.com/DaweiTian/zhiruo/commit/47ba0afc599d707c13c6e19304365e9a8efc600a))

### [0.1.5](https://github.com/DaweiTian/zhiruo/compare/v0.1.4...v0.1.5) (2026-01-22)

### [0.1.4](https://github.com/DaweiTian/zhiruo/compare/v0.1.3...v0.1.4) (2026-01-22)

### [0.1.3](https://github.com/DaweiTian/zhiruo/compare/v0.0.6...v0.1.3) (2026-01-22)

### [0.0.6](https://github.com/DaweiTian/zhiruo/compare/v0.0.5...v0.0.6) (2026-01-22)

### 0.0.5 (2026-01-22)

### Features

- init commit ([4a9f11a](https://github.com/DaweiTian/zhiruo/commit/4a9f11a903fb65682909cd18f2f4467a43fa07db))
- **update-check:** add startup update check ([d240577](https://github.com/DaweiTian/zhiruo/commit/d2405771e3947ea6771ca4f5ea9c784f9d013d32))

## [0.1.2] - 2026-01-21

- Initial public release.

[0.1.2]: https://github.com/DaweiTian/zhiruo/releases/tag/v0.1.2
