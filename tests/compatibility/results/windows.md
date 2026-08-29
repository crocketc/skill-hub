# Windows 兼容性验收记录

状态：部分验证，未完成 Agent 真机接入验收。

- 操作系统：Windows 11（当前开发设备）
- 验收基线：Task10 提交 `b80652f`，Task11 证据在当前工作树采集
- 记录日期：2026-08-29

## 已有证据

- Rust workspace 测试：通过。
- 前端 lint、TypeScript、307 项 Vitest 测试：通过。
- 前端生产构建：通过。
- Windows x64 Tauri release 编译：通过，生成桌面可执行文件。
- NSIS 最终打包：未完成；Tauri NSIS 工具下载受到当前网络策略限制。

## Agent 客户端

本次验收没有可确认已安装并可操作的 Agent 客户端，因此所有 profile 均记录为：**未安装—未进行真实机验证**。不能把官方目录资料或契约测试结果升级为文件接入已验证。

## 待补验证

- 至少一个实际安装的 CLI/IDE Agent：发现、项目级目录、部署、外部变化、收集、解除部署和所有权保留。
- Windows x64/ARM64 NSIS 产物、当前用户安装和卸载后的用户数据保留。
- 权限受限、符号链接和 Directory Junction 的真实文件系统结果。
