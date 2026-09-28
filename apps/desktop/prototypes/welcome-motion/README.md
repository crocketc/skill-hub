# SkillHub 欢迎页动效原型

这是欢迎页动效模块，同时保留独立预览入口。主应用在未初始化时通过 `/initialize` 懒加载此模块；点击“开始设置”后呈现现有初始化向导。欢迎页本身不连接本地数据库、Agent 目录或初始化命令。

## 运行预览

在仓库根目录执行：

```powershell
pnpm --dir apps/desktop exec vite --config vite.welcome-prototype.config.ts
```

浏览器打开 <http://127.0.0.1:5186/>。这里的“开始设置”进入原型中的初始化方式预览；正式应用中的同名按钮进入现有初始化向导。画面右上角的控件可暂停或继续动画。

## 验证

```powershell
pnpm --dir apps/desktop exec vitest run prototypes/welcome-motion/WelcomeHero.test.tsx
pnpm --dir apps/desktop exec tsc -p tsconfig.welcome-prototype.json --noEmit
pnpm --dir apps/desktop exec vite build --config vite.welcome-prototype.config.ts
```

## 动效分镜

浅色苔绿界面与 SkillHub 导航页的默认色系对齐。右侧是一幅由八个不规则工作岛组成的 Skill 生命周期地图：导入技能 → 处理冲突 → 技能图谱 → 配置到 Agent → 配置到项目 → 关系治理 → 标签配置与收回 → AI 辅助管理。同一个 Skill 标记沿曲线约 16 秒走完一轮；工作岛中的收录、扫描、连线、配置、收回和建议动作分别循环，路径与站点有相互呼应的光效。左侧标题和“开始设置”保持稳定。

欢迎页默认自动播放，右上角控件同时暂停或继续主路径和各站动效。系统启用减少动态效果时也保持自动播放，用户可手动暂停。

动画只使用 HTML、CSS 和 SVG；没有联网图片、视频或额外动画库。示例内容为虚构数据。画面表达目录识别和管理关系，不表达 Agent 已加载或一定会运行技能。

## 接入边界

欢迎页组件通过 `onStart` 回调交接给宿主。主应用按初始化快照判断：未初始化时先展示欢迎页，已初始化时保持重新发现流程；欢迎页“开始设置”只在当前页面切换到现有向导，不执行任何原生初始化操作。独立预览仍使用本目录的示例设置页。
