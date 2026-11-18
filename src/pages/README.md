# pages/

## Microphone Selection

`SettingsPage.tsx` detects available audio-input devices in the renderer, lets
the user persist a selected microphone, and keeps the system default as the
unchanged fallback. If Chromium or the OS replaces a saved device ID,
Settings automatically rebinds it only when exactly one currently available
device has the same exposed label; ambiguous duplicate labels still require an
explicit user choice.

路由页面组件目录。

## 文件

- `HomePage.tsx` - 首页仪表台：页头（问候）→ 语音控制台（待命胶囊 + PTT 键帽 + 品牌声波，替代原「按住说话」大渐变卡）→ 今日带（英雄数字「今日字数」+ 今日录音/时长/近 7 天三格，发丝线分隔）→ 累计数据条（`StatsOverview`，设计 4.1 起六格含当前/最长连续）→ 听写战绩（`HourHeatmap` 按小时热力图 + `BadgeGrid` 成就徽章，设计 4.1）→ 趋势图。今日字数带计数动画（尊重 `prefers-reduced-motion`）；并行拉取历史与 `get_stats` 累计统计后合并计算（累计项不受历史删除/裁剪影响），趋势图仍按历史实时聚合。趋势图 `InteractiveCharts`（recharts）为 `React.lazy` + `Suspense`（设计 3.3）：`IntersectionObserver` 进视口才挂载，recharts 拆成独立 chunk 降首屏脚本量。
- `SettingsPage.tsx` - 设置页：语言切换即时生效，其余设置防抖自动保存；管理云端识别（方言/模型）、麦克风、快捷键、开机自启、Linux/Omarchy 集成，以及 DeepSeek 排在首位的共用 LLM 连接和润色、语音输入翻译、选中文本翻译快捷键三个独立开关。启用任一功能时校验连接；目标语言随时可设置。另有「文本注入」卡片（设计 2.2：`inject.mode` 四选一 `auto | paste | type | clipboard`，auto 逐级回退并在只落剪贴板 / 失败时经 `inject-fallback` 让 HUD 软提示）。润色节含「输出风格」Select（设计 3.1：默认/正式邮件/小红书/周报/极简/商务书面语/自定义，自定义展开 Textarea）；识别节含「自定义热词表」Textarea（设计 3.2：每行一词，draft 态 + 换行拆合，帮助文案写明双通道局限）。外观节含「胶囊形象」二选一（设计 4.2：经典 / 叶精灵，`useCapsuleSkin` localStorage，卡片内嵌实时预览）。Windows 下另显示「鼠标触发」卡片（中键按住说话开关，随防抖自动保存经 `set_config` 即时安装/卸载钩子）与「快速插入面板」卡片（侧键 X1/X2 开关与落点——落点含「快捷 Hub」选项（`hub`，以鼠标为中心展开选区面板，不受速插开关影响），剪贴板采集开关/上限/一键清空、常用词 Textarea 草稿、从历史学到的候选点击确认入库；非 Windows 全部隐藏）。**API Key 脱敏**：填写/粘贴阶段明文可核对，自动保存确认后值变为占位符并以密码点显示，且**不提供任何查看入口**（无眼睛按钮、无 `getConfigSecret`）。
- `settings-config.ts` - 设置页配置归一化、润色连接字段完整性判断、连接变更后的润色功能开关 reconcile（完整保留/恢复、不完整快照后关闭）、按连接指纹（provider/端点/模型/密钥）短时缓存连接检测结果（TTL 内切回不再重复实测）与保存后密钥遮罩同步（覆盖 LLM 各 provider 与 MiMo ASR 密钥）；仅替换本次已保存且未再次编辑的密钥，避免 IPC 往返覆盖并发输入。另含 `applyPersistedHotkeyState`：`set_config` 回滚快捷键（`hotkeyRolledBack`）时用持久化值覆盖渲染层 hotkey 状态并清除 dirty，防止非法值随每次自动保存反复重发、反复弹错；`normalizeRendererConfig` 同时补全 `mouse.middleClickPtt`、`picker`（`normalizePickerConfig`：落点字面量 `snippets|clipboard|both|hub`（非法退回默认）、条数上限夹取 5–100、常用词清洗与 userGlossary 同纪律、单条 256 字符）、`inject`（`normalizeInjectConfig`：模式字面量 `auto|paste|type|clipboard`，非法退回 `auto`）等新字段默认值。
- `settings-config.test.ts` - 设置页原有 ASR 模式选择兼容、润色连接完整性、Provider 切换功能开关 reconcile、连接指纹稳定性/失效与检测缓存 TTL、保存后密钥遮罩与并发编辑保留、MiMo 连接解析/归一化与 ASR 密钥遮罩回归测试。
- `HistoryPage.tsx` - 历史记录页：搜索、排序、按天分组与虚拟滚动（设计 3.3：扁平行模型 `[groupHeader, ...rows]` 交给 `lib/useVirtualList` 手写窗口化，只渲染视口 ± overscan 行，万条级历史 DOM 节点数稳定），支持复制、删除与清空；右侧详情面板不变。
