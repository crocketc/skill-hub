# 一体化标题栏（无边框窗口 + 自绘窗口控制按钮）实施计划

记录时间：2026-09-14。来源：用户开发代办，以下规格由用户提供并拍板，"已拍板决策"与视觉规格不得更改。
状态：计划完成，未排期、未开始实施。
执行提示：原文"注意事项"中"工作区有未提交的 docs/development 文档改动"描述的是规格起草时点的状态，当前分支工作区已干净；执行时以当下 `git status` 为准，继续遵守"不覆盖、不顺手提交无关文件"。用户补充要求：本代办可能影响所有页面，需要整体设计；涉及视觉设计前先加载 frontend-design skill。

---

# 任务：一体化标题栏（无边框窗口 + 自绘窗口控制按钮）

> 若本指令与其他含较大视觉改动的功能合并执行，涉及视觉设计前先加载 frontend-design skill；
> 本任务自身的按钮样式是强约定，按下方规格实现即可。

## 背景与目标
SkillHub 桌面端是 Tauri 2 应用（apps/desktop/src-tauri）。当前使用系统原生标题栏，
Windows 上显示跟随系统强调色的蓝色标题条。目标：去掉原生标题栏，界面延伸到窗口顶部，
自绘最小化/最大化/关闭按钮，达到 VS Code / Codex 桌面版的一体化观感。

## 已拍板决策（不得更改）
1. 纯自绘窗口控制按钮，不引入 tauri-plugin-decorum 等第三方窗口插件。
2. Windows 与 macOS 同步改造：Windows 用无边框窗口；macOS 保留红绿灯按钮（Overlay 风格）。

## 范围扩展（2026-09-14 用户补充拍板）

顶栏即一体化标题栏。除窗口控制按钮外，以下控件纳入标题栏同一水平线统一设计：

1. **侧栏折叠按钮**（对应验收项 M-17-1）：大小与图标已真机确认无问题（Lucide `Panel Left`，图标 14px/按钮 28px）；位置移入标题栏区域，与最小化/最大化/关闭按钮同一水平线。
2. **子页面顶栏的返回/前进箭头按钮**。
3. **技能库页面的视图切换按钮**（卡片/表格等视图切换）。
4. **各页面顶栏整体**（页标题、通知铃铛等）在标题栏框架内统一布局。

执行要求：具体分区布局（左/中/右归属、上下文敏感控件如视图切换与返回/前进的显隐规则）在实施前用 frontend-design skill 做整体设计再动手；本计划"改动清单"中的窗口机制（配置/Rust/权限/平台封装）与窗口控制按钮视觉规格维持不变，扩展范围只影响 AppShell 顶栏布局与其余控件的迁移。
M-17-1 处置：大小/图标两项通过；"位置"随本任务落地后一并真机复验。

## 改动清单

### 1. 窗口配置 apps/desktop/src-tauri/tauri.conf.json
app.windows[0] 增加三个字段：
- "visible": false —— 窗口隐藏创建，setup 末尾再 show，避免 Windows 去边框瞬间原生标题栏闪烁
- "titleBarStyle": "Overlay" —— macOS 专用：红绿灯悬浮在内容上（Windows 忽略此字段）
- "hiddenTitle": true —— macOS 专用：隐藏原生标题文字
注意：不要在配置里设 "decorations": false —— 该字段跨平台生效，会连带去掉 macOS 红绿灯；
Windows 去边框在 Rust 运行时按平台做（见下）。

### 2. Rust 侧 apps/desktop/src-tauri/src/lib.rs
新增辅助函数并在 run_with_facade 与 run 两条启动路径的 setup 钩子开头都调用：
```rust
fn apply_main_window_chrome(app: &tauri::App) -> tauri::Result<()> {
    // label 未在配置中显式写出，默认即 "main"
    let window = app.get_webview_window("main").expect("main window is defined in tauri.conf.json");
    #[cfg(windows)]
    window.set_decorations(false)?; // shadow 保持默认开启，保留投影与 Win11 圆角
    window.show()
}
```
（需要 use tauri::Manager;）

### 3. 权限 apps/desktop/src-tauri/capabilities/default.json
permissions 追加（保持最小权限，仓库测试明确禁止 core:default）：
- core:window:allow-minimize
- core:window:allow-toggle-maximize
- core:window:allow-internal-toggle-maximize（顶栏双击最大化走系统内部处理）
- core:window:allow-is-maximized
- core:window:allow-close
- core:window:allow-start-dragging（data-tauri-drag-region 拖拽）

### 4. 平台封装 apps/desktop/src/platform/windowChrome.ts（新增）
模式参考同目录 directoryPicker.ts（非 Tauri 环境安全回退）：
- resolveWindowChrome(): WindowChrome | null —— 用 "__TAURI_INTERNALS__" in window 检测，
  非 Tauri（浏览器/e2e/单测）返回 null 且不触碰 Tauri API
- interface WindowChrome { minimize; toggleMaximize; close; isMaximized;
  onMaximizeChange(listener: (maximized: boolean) => void): Promise<() => void> }
  onMaximizeChange 内部用 getCurrentWindow().onResized 订阅、触发时重查 isMaximized
- applyWindowChromePlatformClass()：userAgent 含 "Mac" 时给 document.documentElement
  加 sh-is-macos 类，否则确保移除

### 5. 控制按钮组件 apps/desktop/src/ui/WindowControls.tsx + WindowControls.css（新增）
- resolveWindowChrome() 为 null 时渲染 null（浏览器/e2e/单测自动无痕）
- 三个 type="button" 按钮：最小化 / 最大化-还原 / 关闭；aria-label 全部走 i18n
- 挂载时 isMaximized() 取初始态 + onMaximizeChange 订阅变化；useEffect 卸载时调用 unlisten
- 窗口最大化时该按钮切换为"还原"图标与文案，点击仍是 toggleMaximize
- 视觉规格（照做，不再另行设计）：
  - 按钮宽 2.875rem（46px），高度撑满顶栏（min-height: var(--topbar-height)=3.625rem）；
    用 margin-inline-end: calc(-1 * var(--space-5)) 抵消顶栏 padding 使按钮贴住窗口右上角
  - 图标为内联 SVG 细线风格（约 10px 见方、1px 描边，Win11 caption 风格）：
    最小化=横线；最大化=方框；还原=错叠双方框；关闭=斜十字
  - 默认色 var(--color-text-muted)；hover 背景 var(--color-accent-soft)；
    关闭按钮 hover 红底白图标（#c42b1c）；全部经 CSS 变量适配深浅主题，不硬编码文字色
- 接入 apps/desktop/src/app/AppShell.tsx：topbar-end 内 NotificationBell 之后渲染
  <WindowControls />；技能详情页共用此壳层，无需单独接入
- 拖拽区：给 header 及其子容器（topbar-start、h1、topbar-end）都加 data-tauri-drag-region。
  Tauri 只认 mousedown 目标元素自身带该属性，只放最外层会被子元素吞掉

### 6. macOS 红绿灯避让 apps/desktop/src/styles/base.css
在 sidebar 样式附近加：.sh-is-macos .sh-sidebar__header { padding-left: 5rem; }
（给红绿灯约 76px 留白，避免与 Logo 重叠）

### 7. i18n apps/desktop/src/i18n/{zh-CN,en-US}/common.json
appShell 下加 4 键：minimize/maximize/restore/close
zh-CN：最小化/最大化/还原/关闭；en-US：Minimize/Maximize/Restore/Close

## 测试（TDD：先写失败测试，再实现）
- platform/windowChrome.test.ts：vi.mock("@tauri-apps/api/window")；覆盖：非 Tauri 返回 null、
  动作映射到 window API、isMaximized 读取、resize 订阅触发与取消、macOS 类打标/移除
- ui/WindowControls.test.tsx：vi.mock("../platform/windowChrome")；覆盖：null 渲染、
  三按钮渲染与 aria/type、点击调用对应动作、最大化→Restore 切换、监听更新文案、卸载清理
- app/AppShell.test.tsx：补一条 .sh-app-shell__topbar 带 data-tauri-drag-region 的断言
- src-tauri/src/lib.rs：现有 capabilities 测试补 6 个权限断言；
  新增配置断言测试（visible=false、titleBarStyle="Overlay"、hiddenTitle=true），
  解析方式沿用现有 tauri_config_enables_signed_static_updater_artifacts 测试

## 验证命令（全部须通过）
- 根目录：pnpm test:frontend、pnpm check:frontend、pnpm build:frontend
- apps/desktop/src-tauri：cargo test（至少覆盖配置与权限断言所在的 crate）

## 已知取舍（预期行为，不要当缺陷修）
- 失去：Win11 悬停最大化按钮的贴靠布局四宫格、拖窗到屏幕边缘触发贴靠
- 保留：Win+方向键贴靠、窗口边缘拖拽调整大小、双击标题栏最大化
- e2e（playwright 纯浏览器 + __preview 路由）不受影响，不要改 e2e

## 注意事项
- 工作区当前有未提交的 docs/development 两份文档改动与归档目录，非本任务产生：
  不要覆盖、不要顺手提交（记录时注：此条描述起草时点状态，执行时以当下 git status 为准）
- run_with_facade（测试入口）与 run（生产入口）都必须接 apply_main_window_chrome

## 完成后（按仓库 AGENTS.md 执行）
- 更新三份当前文档：开发状态 / 自动化测试说明 / 功能完成度与验收状态矩阵（均 2026-09-13 版）
- 人工验收清单-2026-09-13.md 增加 Windows 真机验收项：拖拽、双击最大化、三按钮、
  最大化/还原切换、Win11 圆角与投影、深浅主题观感；标注 macOS 红绿灯位置待真机确认
- 在当前分支提交，提交信息：feat: add frameless window with custom title bar controls
  （英文动词开头；提交前 git diff --check）
注意：这个代办3可能会影响所有页面，所以需要整体设计
