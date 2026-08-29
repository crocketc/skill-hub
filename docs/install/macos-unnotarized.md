# macOS 早期版本安装说明

SkillHub 早期 macOS 构建是包含 Intel 与 Apple silicon 的 Universal DMG，并使用 ad-hoc 签名。构建尚未完成 Apple Developer ID 签名和公证，因此首次打开时可能出现“无法验证开发者”或类似 Gatekeeper 提示。

## 安全安装路径

1. 只从项目的官方 GitHub Release 页面下载 Universal DMG。
2. 在 Release 页面核对同一版本的 `SHA256SUMS.txt`，再使用系统属性或可信的校验工具核对文件摘要。
3. 将应用拖入“应用程序”后，在 Finder 中对应用使用“右键（或 Control-点击）→打开”，确认来源后再打开。
4. 如果来源、版本或摘要不一致，或组织策略不允许未公证应用，不要继续安装。

文档不会要求用户关闭 Gatekeeper、删除隔离属性或执行绕过系统安全策略的命令。应用更新检查在早期版本只打开官方 Release 页面，不会静默安装未公证构建。

## 当前边界

- Universal DMG 由同一提交分别构建两个架构后合并产出。
- ad-hoc 签名只用于保持构建和本地验证链路完整，不等同于 Developer ID 签名或 Apple 公证。
- 后续启用受信任签名和公证时，需要重新验证安装路径、更新策略、摘要和发布清单。
