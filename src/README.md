# src/

渲染进程目录，负责 React UI 与前端逻辑。

## 目录结构

- `components/` - 应用组件与 UI 组件库，包含后台 `AudioRecorder`、HUD、会话胶囊
  `SessionHUD`、选区快捷动作圆环面板 `Hub` 等。
- `pages/` - 路由页面：`Home`、`Settings`、`History`。
- `layouts/` - 布局组件。
- `lib/` - 工具函数，含 `hub-geometry.ts`（hub 扇形几何纯函数）与
  `tauri-api.ts`（`window.electronAPI` invoke / 事件桥）。

## 入口与全局

- `App.tsx` - 窗口 label 路由入口；按窗口类型渲染后台录音组件、HUD、会话胶囊、
  选区快捷动作 hub 或主界面。
- `main.tsx` - React 启动入口与渲染进程 i18n 初始化。
- `index.css` - Tailwind 基础样式与主题变量。
- `global.d.ts` - `window.electronAPI` 类型声明。
- `vite-env.d.ts` - Vite 环境类型声明。
