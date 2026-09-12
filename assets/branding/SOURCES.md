# 品牌素材来源记录（SOURCES.md）

本文件记录 `apps/desktop/public/brand/` 中引用的第三方品牌素材的官方一手来源、
许可证、获取日期与变换。规则：

- 只允许官方一手来源（官方站点、官方仓库）。禁止随机图片抓取。
- 原始下载件保存在 `assets/branding/<brand>/`，应用内副本必须与其逐字节一致
  （`BrandTag.test.tsx` 与 `tauriIconAssets.test.ts` 做逐字节校验）。
- 来源或许可证不清晰的品牌保持诚实的字母/文本回退，不伪造图标。

## pi（Pi coding agent）

- 应用内素材：`apps/desktop/public/brand/agents/lobehub/pi.svg`
- 原始下载件：`assets/branding/pi/pi-favicon.svg`（与应用内副本逐字节一致）
- 来源 URL：`https://pi.dev/favicon.svg`（2026-09-13 获取）
- 官方性依据：pi.dev 是 Pi coding agent 的官方网站（适配器 profile
  `crates/skillhub-adapters/profiles/pi.json` 的官方参考链接
  `https://pi.dev/docs/latest/skills` 即指向该域名）；官方仓库
  `badlogic/pi-mono`（MIT）的 README 以项目 Logo 名义内嵌
  `https://pi.dev/logo.svg`，与本次获取的 favicon 为同一官方站点上的同一
  品牌图形（白色 "Pi" 字形，favicon 版本带官方深色圆角底板）。
- 许可证：项目仓库 `badlogic/pi-mono` 为 MIT License（Copyright (c) 2025
  Mario Zechner，已核对 LICENSE 全文）。站点上的 SVG 未附带独立许可文件。
- 变换：无（逐字节原样拷贝；`<img>` 以 aria-hidden 装饰方式渲染，不修改图形）。
- 备注（谨慎处理）：素材来自官方网站但无逐字许可声明；SkillHub 仅在目录
  列表中如实标识真实存在的 Pi 目录（指示性使用），不暗示官方背书。若后续
  版权方提出异议，删除该素材即回退为现有颜色标签（`sh-brand-tag--pi`）。

## deepseek-harness（DeepSeek Harness）

- 应用内素材：`apps/desktop/public/brand/agents/lobehub/deepseek-harness.svg`
- 原始下载件：`assets/branding/deepseek-harness/deepseek-harness-favicon.svg`
  （与应用内副本逐字节一致）
- 来源 URL：官方仓库 `deepseek-ai/deepseek-harness`（master 分支）文件
  `apps/web/public/favicon.svg`；规范路径
  `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/apps/web/public/favicon.svg`
  （2026-09-13 经 GitHub contents API 获取；当日 raw 域名网络受限）
- 许可证：仓库 LICENSE 为 MIT License（Copyright (c) 2026 DeepSeek，已核对
  全文），覆盖包括该 SVG 在内的仓库内容。官方 `BRAND_GUIDELINES.md` 允许在
  描述性文字中如实说明与 DeepSeek Harness 的关系（"compatible with DeepSeek
  Harness"），并要求不得以造成"官方背书/合作/授权"误解的方式使用官方品牌
  素材。
- 变换：无（逐字节原样拷贝；SVG 自带的 `prefers-color-scheme` 深浅色自适应
  逻辑保持原样）。
- 备注（谨慎处理）：SkillHub 仅在目录列表中如实标识真实存在的 DeepSeek
  Harness 目录，不暗示官方背书；若版权方提出异议，删除该素材即回退为现有
  颜色标签（`sh-brand-tag--deepseek-harness`）。

## SkillHub 自有素材

- `assets/branding/tauri-icons/`：SkillHub 应用自有图标母版（非第三方素材），
  由 `apps/desktop/src-tauri/icons/` 下的受控拷贝引用（逐字节校验见
  `apps/desktop/src/app/tauriIconAssets.test.ts`）。

## 既有 lobehub 素材（历史遗留）

`public/brand/agents/lobehub/` 中其余 17 个 SVG 于 QA-014 引入，来源记录
不在本任务（T6/M-30）验收范围内，暂未补录；后续补充时按本文件格式追加。
