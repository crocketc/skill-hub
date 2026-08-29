# macOS 兼容性验收记录

状态：未完成真实 Agent 接入验收。

- 操作系统：macOS（需在 macOS 设备上执行）
- 验收基线：Task10 提交 `b80652f`，Task11 证据在当前工作树采集
- 记录日期：2026-08-29

## 已有证据

- 先前 macOS 本地 CI 的基础 Rust/前端检查曾通过，但不是本提交的 Universal DMG 真机证据。
- macOS ad-hoc Universal DMG 工作流和配置已进入本提交，尚未在 macOS 设备上执行产物验收。

## Agent 客户端

本次没有可确认已安装并可操作的 Agent 客户端，因此所有 profile 均记录为：**未安装—未进行真实机验证**。不能把官方目录资料或 Windows 结果推断到 macOS。

## 待补验证

- 在 macOS 上执行本地 CI 和 Universal DMG 构建，确认 Intel/Apple silicon 产物信息。
- 至少一个实际安装的 CLI/IDE Agent：发现、项目级目录、部署、外部变化、收集、解除部署和所有权保留。
- 验证大小写、符号链接、权限失败和 Finder 手动打开未公证应用的实际提示。
